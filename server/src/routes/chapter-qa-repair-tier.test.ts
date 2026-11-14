/* #3518 — the qa-repair centroid filter must compare a centroid row's recorded
   Qwen tier against the model key the character will CURRENTLY re-render under
   (cast + requested tier, elevate-only per-character pin), never against the
   previous render's snapshot. An 'audition' row recorded at another tier, and an
   'in-book' row whose chapter was last rendered at another tier, are dropped
   ("no centroid" -> acoustic-only candidate skipped, reported in stillSuspect). */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
let synthesiseChapter: any;

const PINNED_MAX_RERECORDS = 2;
vi.mock('../config/resolver.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config/resolver.js')>();
  return {
    ...real,
    configValue: vi.fn((key: string) => {
      if (key === 'qa.speaker.autoRepair') return true;
      if (key === 'qa.speaker.enabled') return true;
      if (key === 'qa.seg.maxRerecords') return PINNED_MAX_RERECORDS;
      return real.configValue(key);
    }),
  };
});
// Qwen must report installed or the repair skips it as engine-unavailable (as chapter-qa-repair.test.ts:65-68).
vi.mock('../workspace/user-settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/user-settings.js')>()),
  getLastKnownQwenInstallState: () => 'ready',
}));
const SR = 24_000;
function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  return buf;
}
vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return { ...real, synthesiseChapter: vi.fn(async () => ({ pcm: tone(2.0, 12000), sampleRate: SR, embeddings: [] })) };
});
vi.mock('../store/analysis-cache.js', () => ({
  loadAnalysisCache: vi.fn(async () => ({
    chapters: { 1: [{ id: 20, chapterId: 1, characterId: 'castor', text: 'Castor sentence.' }] },
  })),
}));
vi.mock('../tts/hydrate-reused-voice-workspace.js', () => ({ hydrateCastReusedVoices: vi.fn(async (c: unknown[]) => c) }));
vi.mock('../store/analysis-cache-rebuild.js', () => ({ refreshCacheFromEdits: vi.fn(async () => 'rebuilt') }));
vi.mock('../audio/finalize-chapter-write.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audio/finalize-chapter-write.js')>();
  return { ...real, finalizeChapterAudioWrite: vi.fn(async () => ({ durationSec: 2.0, segmentCount: 1, audioPath: '/fake.mp3' })) };
});
vi.mock('../audio/splice-chapter.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audio/splice-chapter.js')>();
  return { ...real, spliceChapterSegments: vi.fn(() => ({ pcm: tone(2.0, 12000), sampleRate: SR, durationSec: 2.0, segments: [] })) };
});
vi.mock('../audio/build-synth-replacement.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audio/build-synth-replacement.js')>();
  return {
    ...real,
    buildSynthReplacements: vi.fn(async (opts: { segments: unknown[]; targetIndices: number[]; synth: (s: unknown) => Promise<{ pcm: Buffer; sampleRate: number }> }) => {
      const out = [];
      for (const idx of opts.targetIndices) out.push({ segmentIndex: idx, ...(await opts.synth(opts.segments[idx])) });
      return out;
    }),
  };
});
// low = wrong voice (orthogonal to the centroid), high = right voice
let embedCosine: 'high' | 'low' = 'low';
vi.mock('../tts/embed-client.js', () => ({
  embedSegment: vi.fn(async () => { const v = new Float32Array(192).fill(0); v[embedCosine === 'high' ? 0 : 1] = 1.0; return v; }),
}));
vi.mock('./chapter-job-coordination.js', () => ({ registerSplice: vi.fn(() => () => {}) }));
vi.mock('./generation.js', () => ({ abortInFlightChapterJob: vi.fn() }));

const AUTHOR = 'Tier Author', SERIES = 'Standalones', TITLE = 'Tier Story', SLUG = 'chapter-one';
const T06 = 'qwen3-tts-0.6b', T17 = 'qwen3-tts-1.7b';
let workspaceRoot: string, audioRoot: string, bookDir: string, bookId: string, app: Express;
const parseSse = (b: string) => b.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
const unitVec = () => { const v = new Array<number>(192).fill(0); v[0] = 1; return v; };

interface Case {
  pin?: string;                 // per-character ttsModelKey
  oldTier: string;              // segments.json modelKey + snapshot modelKey
  rowKind: 'audition' | 'in-book';
  rowTier?: string;             // audition row's recorded modelKey
  renderedModelKey?: string;    // snapshot.renderedModelKey (in-book proxy)
  requestKey: string;
  embed: 'high' | 'low';
}

async function runCase(c: Case) {
  const { encodePcmToAudio } = await import('../tts/mp3.js');
  const { currentCastVoiceName } = await import('../audio/render-integrity/current-voice.js');
  const character = {
    id: 'castor', name: 'Castor', gender: 'female', attributes: [], ttsEngine: 'qwen',
    ...(c.pin ? { ttsModelKey: c.pin } : {}),
    overrideTtsVoices: { qwen: { name: 'castor-alden-B', libraryUuid: 'b' } },
  };
  // Do not trust the brief: confirm the voice name the filter will compare against.
  expect(currentCastVoiceName(character as any, 'qwen')).toBe('qwen-b');
  const pcm = tone(2.0, 12000);
  writeFileSync(join(audioRoot, `${SLUG}.mp3`), await encodePcmToAudio(pcm, SR, { format: 'mp3', quality: 2 }));
  writeFileSync(join(audioRoot, `${SLUG}.segments.json`), JSON.stringify({
    bookId, chapterId: 1, chapterTitle: 'Chapter 1', durationSec: 2.0, sampleRate: SR, modelKey: c.oldTier,
    synthesizedAt: new Date().toISOString(),
    segments: [{ groupIndex: 0, characterId: 'castor', sentenceIds: [20], startSec: 0, endSec: 2.0 }],
    characterSnapshots: {
      castor: {
        voiceEngine: 'qwen', resolvedVoiceName: 'qwen-b', modelKey: c.oldTier,
        ...(c.renderedModelKey ? { renderedModelKey: c.renderedModelKey } : {}),
      },
    },
  }));
  writeFileSync(join(audioRoot, `${SLUG}.render-integrity.json`), JSON.stringify([{
    characterId: 'castor', sentenceIds: [20], verdict: 'voice-mismatch', cosine: 0.3, severity: 'severe', fixable: true,
    expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: c.rowKind, windowed: false, segmentIndex: 0,
  }]));
  writeFileSync(join(audioRoot, 'render-integrity.centroids.json'), JSON.stringify({
    castor: {
      characterId: 'castor', centroid: unitVec(), cleanMean: 0.7, pSevere: 0.45, pBand: 0.6, referenceKind: c.rowKind,
      ...(c.rowKind === 'audition'
        ? { bandMethod: 'synthetic-sigma', auditionVoice: { voiceName: 'qwen-b', modelKey: c.rowTier } }
        : { inBookVoiceName: 'qwen-b' }),
    },
  }));
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [character] }));
  embedCosine = c.embed;
  vi.mocked(synthesiseChapter).mockClear();
  const res = await request(app).post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`).send({ dryRun: false, modelKey: c.requestKey });
  const done = parseSse(res.text).find((e) => e.type === 'qa_repair_complete');
  expect(done, res.text).toBeTruthy();
  return done as { repaired: number[]; stillSuspect: number[] };
}

beforeAll(async () => {
  process.env.SEG_SPK_AUTO_REPAIR = '1';
  process.env.SEG_QA_MAX_RERECORDS = String(PINNED_MAX_RERECORDS);
  workspaceRoot = mkdtempSync(join(tmpdir(), 'tier3518-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { chapterQaRepairRouter } = await import('./chapter-qa-repair.js');
  synthesiseChapter = (await import('../tts/synthesise-chapter.js')).synthesiseChapter;
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify({
    bookId, manuscriptId: 'm_tier', title: TITLE, author: AUTHOR, series: SERIES, seriesPosition: null, isStandalone: true,
    manuscriptFile: 'manuscript.txt', castConfirmed: true, language: 'en',
    chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:02' }], coverGradient: ['#000', '#fff'],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  app = express(); app.use(express.json()); app.use('/api/books', chapterQaRepairRouter);
});
afterAll(() => { delete process.env.SEG_SPK_AUTO_REPAIR; delete process.env.SEG_QA_MAX_RERECORDS; rmSync(workspaceRoot, { recursive: true, force: true }); });

describe('#3518 qa-repair centroid filter — Qwen tier', () => {
  it('T1 per-character elevation: audition row at 0.6B dropped when the character is pinned to 1.7B', async () => {
    const done = await runCase({ pin: T17, oldTier: T06, rowKind: 'audition', rowTier: T06, requestKey: T06, embed: 'high' });
    expect(synthesiseChapter).not.toHaveBeenCalled();
    expect(done.stillSuspect).toContain(0);
  });

  it('T2 repair at another tier: audition row at 0.6B dropped when the request is 1.7B', async () => {
    const done = await runCase({ oldTier: T06, rowKind: 'audition', rowTier: T06, requestKey: T17, embed: 'high' });
    expect(synthesiseChapter).not.toHaveBeenCalled();
    expect(done.stillSuspect).toContain(0);
  });

  it('T3 stale snapshot, matching row: audition row at 1.7B kept for a 1.7B-pinned character', async () => {
    const done = await runCase({ pin: T17, oldTier: T06, rowKind: 'audition', rowTier: T17, requestKey: T06, embed: 'high' });
    expect(synthesiseChapter).toHaveBeenCalled();
    expect(done.repaired).toContain(0);
  });

  it('T4 control: everything at 0.6B, row kept and repaired', async () => {
    const done = await runCase({ oldTier: T06, rowKind: 'audition', rowTier: T06, requestKey: T06, embed: 'high' });
    expect(synthesiseChapter).toHaveBeenCalled();
    expect(done.repaired).toContain(0);
  });

  it('T5 in-book tier mismatch: in-book row dropped when the chapter was last rendered at 0.6B but the request is 1.7B', async () => {
    const done = await runCase({ oldTier: T06, rowKind: 'in-book', renderedModelKey: T06, requestKey: T17, embed: 'high' });
    expect(synthesiseChapter).not.toHaveBeenCalled();
    expect(done.stillSuspect).toContain(0);
  });

  it('T6 in-book same tier: in-book row kept and repaired', async () => {
    const done = await runCase({ oldTier: T06, rowKind: 'in-book', renderedModelKey: T06, requestKey: T06, embed: 'high' });
    expect(synthesiseChapter).toHaveBeenCalled();
    expect(done.repaired).toContain(0);
  });
});
