/* #3518 — the qa-repair centroid filter must compare a centroid row's recorded
   Qwen tier against the model key the character will CURRENTLY re-render under
   (cast + requested tier, elevate-only per-character pin), never against the
   previous render's snapshot. An 'audition' row recorded at another tier, and an
   'in-book' row whose pooled anchors' stamped tier (inBookModelKey) differs, is mixed or is missing, are dropped
   ("no centroid" -> acoustic-only candidate skipped, reported in stillSuspect). */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
  rowTier?: string;             // audition row's auditionVoice.modelKey / in-book row's inBookModelKey stamp (absent = legacy row)
  renderedModelKey?: string;    // snapshot.renderedModelKey (must NOT influence the in-book decision)
  snapModelKey?: string;        // snapshot.modelKey when it differs from oldTier (a partial write rebuilds it)
  noSnapshot?: boolean;         // omit characterSnapshots entirely
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
    ...(c.noSnapshot ? {} : {
      characterSnapshots: {
        castor: {
          voiceEngine: 'qwen', resolvedVoiceName: 'qwen-b', modelKey: c.snapModelKey ?? c.oldTier,
          ...(c.renderedModelKey ? { renderedModelKey: c.renderedModelKey } : {}),
        },
      },
    }),
  }));
  writeFileSync(join(audioRoot, `${SLUG}.render-integrity.json`), JSON.stringify([{
    characterId: 'castor', sentenceIds: [20], verdict: 'voice-mismatch', cosine: 0.3, severity: 'severe', fixable: true,
    expectedEngine: 'qwen', renderedEngine: 'qwen', referenceKind: c.rowKind, windowed: false, segmentIndex: 0,
  }]));
  writeFileSync(join(audioRoot, 'render-integrity.centroids.json'), JSON.stringify({
    castor: {
      characterId: 'castor', centroid: unitVec(), cleanMean: 0.7, pSevere: 0.45, pBand: 0.6, referenceKind: c.rowKind,
      ...(c.rowKind === 'audition'
        ? { bandMethod: 'synthetic-sigma', auditionAnchorModelKey: 'none', auditionVoice: { voiceName: 'qwen-b', modelKey: c.rowTier } }
        : { inBookVoiceName: 'qwen-b', ...(c.rowTier ? { inBookModelKey: c.rowTier } : {}) }),
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

  /* In-book rows carry the tier of the anchors scoreBook pooled (inBookModelKey); the route compares
     the CURRENT key to it and never infers a tier from this chapter's snapshot. */
  it('T5 in-book tier mismatch: row stamped 0.6B is dropped when the request is 1.7B', async () => {
    const done = await runCase({ oldTier: T06, rowKind: 'in-book', rowTier: T06, requestKey: T17, embed: 'high' });
    expect(synthesiseChapter).not.toHaveBeenCalled();
    expect(done.stillSuspect).toContain(0);
  });

  it('T6 in-book same tier: row stamped 0.6B is kept and repaired at 0.6B', async () => {
    const done = await runCase({ oldTier: T06, rowKind: 'in-book', rowTier: T06, requestKey: T06, embed: 'high' });
    expect(synthesiseChapter).toHaveBeenCalled();
    expect(done.repaired).toContain(0);
  });

  it('T7 the review repro: ch10 was re-rendered at 1.7B (snapshot says 1.7B) but the pooled row is 0.6B-stamped, so it is dropped', async () => {
    const done = await runCase({ oldTier: T17, snapModelKey: T17, renderedModelKey: T17, rowKind: 'in-book', rowTier: T06, requestKey: T17, embed: 'high' });
    expect(synthesiseChapter).not.toHaveBeenCalled();
    expect(done.stillSuspect).toContain(0);
  });

  it('T7b a mixed-tier row is dropped even though this chapter\'s snapshot matches the request', async () => {
    const done = await runCase({ oldTier: T17, snapModelKey: T17, renderedModelKey: T17, rowKind: 'in-book', rowTier: 'mixed', requestKey: T17, embed: 'high' });
    expect(synthesiseChapter).not.toHaveBeenCalled();
    expect(done.stillSuspect).toContain(0);
  });

  it('T8 the mirror case: a row stamped 1.7B is kept at 1.7B although this chapter was last rendered at 0.6B', async () => {
    const done = await runCase({ oldTier: T06, renderedModelKey: T06, rowKind: 'in-book', rowTier: T17, requestKey: T17, embed: 'high' });
    expect(synthesiseChapter).toHaveBeenCalled();
    expect(done.repaired).toContain(0);
  });

  it('T9 legacy in-book row with no tier stamp is dropped (fail closed) even when everything else reads 0.6B', async () => {
    const done = await runCase({ oldTier: T06, renderedModelKey: T06, rowKind: 'in-book', requestKey: T06, embed: 'high' });
    expect(synthesiseChapter).not.toHaveBeenCalled();
    expect(done.stillSuspect).toContain(0);
  });

  it('T10 no snapshot at all: a stamped row matching the request is still kept (the route reads no snapshot for it)', async () => {
    const done = await runCase({ oldTier: T06, noSnapshot: true, rowKind: 'in-book', rowTier: T06, requestKey: T06, embed: 'high' });
    expect(synthesiseChapter).toHaveBeenCalled();
    expect(done.repaired).toContain(0);
  });
});

/* #4225 — the per-segment tier stamp through a repair. The build, splice and finalize fakes above are
   swapped for the real ones for this one write; only the synth stays fake. */
describe('#4225 qa-repair carries the per-segment rendered model key through the real finalize', () => {
  it('stamps the re-recorded segment with the repair key and leaves every other entry byte-identical', async () => {
    const { buildSynthReplacements: realBuild } = await vi.importActual<typeof import('../audio/build-synth-replacement.js')>('../audio/build-synth-replacement.js');
    const { spliceChapterSegments: realSplice } = await vi.importActual<typeof import('../audio/splice-chapter.js')>('../audio/splice-chapter.js');
    const { finalizeChapterAudioWrite: realFinalize } = await vi.importActual<typeof import('../audio/finalize-chapter-write.js')>('../audio/finalize-chapter-write.js');
    vi.mocked((await import('../audio/build-synth-replacement.js')).buildSynthReplacements).mockImplementationOnce(realBuild);
    vi.mocked((await import('../audio/splice-chapter.js')).spliceChapterSegments).mockImplementationOnce(realSplice);
    vi.mocked((await import('../audio/finalize-chapter-write.js')).finalizeChapterAudioWrite).mockImplementationOnce(realFinalize);
    const { loadAnalysisCache } = await import('../store/analysis-cache.js');
    const analysis = { chapters: { 1: [30, 31, 32].map((id) => ({ id, chapterId: 1, characterId: 'castor', text: 'Yes.' })) } };
    /* The route reads the cache twice: for the scan's line text, then for the re-record. */
    vi.mocked(loadAnalysisCache).mockResolvedValueOnce(analysis).mockResolvedValueOnce(analysis);
    /* The replacement is as long as the line it replaces, so no later line is retimed. */
    vi.mocked(synthesiseChapter).mockClear();
    synthesiseChapter.mockResolvedValueOnce({ pcm: tone(1.0, 12000), sampleRate: SR, embeddings: [] });

    /* Line 1 is dead silence, so the signal scan flags it alone; the half second of tail keeps the
       decoded length clear of the last segment's end. */
    const { encodePcmToAudio } = await import('../tts/mp3.js');
    const pcm = Buffer.concat([tone(1.0, 12000), Buffer.alloc(SR * 2), tone(1.5, 12000)]);
    writeFileSync(join(audioRoot, `${SLUG}.mp3`), await encodePcmToAudio(pcm, SR, { format: 'mp3', quality: 2 }));
    rmSync(join(audioRoot, `${SLUG}.render-integrity.json`), { force: true });
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({
      characters: [{ id: 'castor', name: 'Castor', gender: 'female', attributes: [], ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'castor-alden-B', libraryUuid: 'b' } } }],
    }));
    const line = (i: number, extra: object) => ({
      groupIndex: i, characterId: 'castor', sentenceIds: [30 + i], startSec: i, endSec: i + 1,
      voiceName: 'qwen-b', resolvedCharacterId: 'castor', ...extra,
    });
    /* Line 2 is a legacy entry: no stamp. */
    const prior = [line(0, { renderedModelKey: T06 }), line(1, { renderedModelKey: T06 }), line(2, {})];
    const segPath = join(audioRoot, `${SLUG}.segments.json`);
    writeFileSync(segPath, JSON.stringify({
      bookId, chapterId: 1, chapterTitle: 'Chapter 1', durationSec: 3.5, sampleRate: SR, modelKey: T06,
      synthesizedAt: new Date().toISOString(), segments: prior,
      characterSnapshots: { castor: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-b', modelKey: T06 } },
    }));

    const res = await request(app).post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`).send({ dryRun: false, modelKey: T17 });

    const done = parseSse(res.text).find((e) => e.type === 'qa_repair_complete');
    expect(done, res.text).toBeTruthy();
    expect(done.repaired).toEqual([1]);
    expect(synthesiseChapter).toHaveBeenCalledTimes(1);
    const after = JSON.parse(readFileSync(segPath, 'utf8')).segments;
    expect(after).toHaveLength(3);
    expect(after[1].renderedModelKey).toBe(T17);
    expect(JSON.stringify(after[0])).toBe(JSON.stringify(prior[0]));
    expect(JSON.stringify(after[2])).toBe(JSON.stringify(prior[2]));
    expect(after[2]).not.toHaveProperty('renderedModelKey');
  });
});
