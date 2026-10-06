/* #3414 / PR #3501 review: a character renamed (retireCharacterId: mairin ->
   mairin-oakes) since the chapter's last render, whose AUDITION centroid +
   snapshot are keyed by the render-time id 'mairin' and whose voice is
   UNCHANGED ('mairin-voice'). The #3449 audition-centroid filter must resolve
   that key through the cast resolver (#2040), not a raw cast-id lookup;
   otherwise the centroid is dropped and a wrong-voice take is accepted. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { embedSegment } from '../tts/embed-client.js';
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
    chapters: { 1: [
      { id: 10, chapterId: 1, characterId: 'hero', text: 'Hero sentence.' },
      { id: 20, chapterId: 1, characterId: 'mairin', text: 'Mairin sentence.' },
    ] },
  })),
}));
vi.mock('../tts/hydrate-reused-voice-workspace.js', () => ({ hydrateCastReusedVoices: vi.fn(async (c: unknown[]) => c) }));
vi.mock('../store/analysis-cache-rebuild.js', () => ({ rebuildCacheFromEdits: vi.fn(async () => {}) }));
vi.mock('../audio/finalize-chapter-write.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audio/finalize-chapter-write.js')>();
  return { ...real, finalizeChapterAudioWrite: vi.fn(async () => ({ durationSec: 2.0, segmentCount: 2, audioPath: '/fake.mp3' })) };
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

const AUTHOR = 'Rev Author', SERIES = 'Standalones', TITLE = 'Rev Story', SLUG = 'chapter-one';
let workspaceRoot: string, audioRoot: string, bookDir: string, bookId: string, app: Express;
const parseSse = (b: string) => b.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
const unitVec = () => { const v = new Array<number>(192).fill(0); v[0] = 1; return v; };

async function scaffold(seg1Silent: boolean) {
  const { encodePcmToAudio } = await import('../tts/mp3.js');
  const pcm = Buffer.concat([tone(2.0, 12000), seg1Silent ? Buffer.alloc(2 * SR * 2) : tone(2.0, 12000)]);
  writeFileSync(join(audioRoot, `${SLUG}.mp3`), await encodePcmToAudio(pcm, SR, { format: 'mp3', quality: 2 }));
  writeFileSync(join(audioRoot, `${SLUG}.segments.json`), JSON.stringify({
    bookId, chapterId: 1, chapterTitle: 'Chapter 1', durationSec: 4.0, sampleRate: SR, modelKey: 'kokoro-v1',
    synthesizedAt: new Date().toISOString(),
    segments: [
      { groupIndex: 0, characterId: 'hero', sentenceIds: [10], startSec: 0, endSec: 2.0 },
      { groupIndex: 1, characterId: 'mairin', resolvedCharacterId: 'mairin', sentenceIds: [20], startSec: 2.0, endSec: 4.0 },
    ],
    characterSnapshots: {
      hero: { voiceEngine: 'kokoro', resolvedVoiceName: 'hero-voice', modelKey: 'kokoro-v1' },
      mairin: { voiceEngine: 'kokoro', resolvedVoiceName: 'mairin-voice', modelKey: 'kokoro-v1' },
    },
  }));
  const row = (characterId: string, sid: number, segmentIndex: number) => ({ characterId, sentenceIds: [sid], verdict: 'voice-mismatch', cosine: 0.3, severity: 'severe', fixable: true, expectedEngine: 'kokoro', renderedEngine: 'kokoro', referenceKind: 'audition', windowed: false, segmentIndex });
  writeFileSync(join(audioRoot, `${SLUG}.render-integrity.json`), JSON.stringify([row('hero', 10, 0), row('mairin', 20, 1)]));
  const cent = (characterId: string, voiceName: string) => ({ characterId, centroid: unitVec(), cleanMean: 0.7, pSevere: 0.45, pBand: 0.6, referenceKind: 'audition', bandMethod: 'synthetic-sigma', auditionVoice: { voiceName, modelKey: 'kokoro-v1' } });
  writeFileSync(join(audioRoot, 'render-integrity.centroids.json'), JSON.stringify({ hero: cent('hero', 'hero-voice'), mairin: cent('mairin', 'mairin-voice') }));
  // AFTER the render: mairin renamed to mairin-oakes (voice unchanged).
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [
    { id: 'hero', name: 'Hero', gender: 'male', attributes: [], ttsEngine: 'kokoro', overrideTtsVoices: { kokoro: { name: 'hero-voice' } } },
    { id: 'mairin-oakes', name: 'Mairin Oakes', gender: 'female', attributes: [], ttsEngine: 'kokoro', overrideTtsVoices: { kokoro: { name: 'mairin-voice' } } },
  ] }));
  writeFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), JSON.stringify({ schema: 1, supersededBy: { mairin: 'mairin-oakes' } }));
}

beforeAll(async () => {
  process.env.SEG_SPK_AUTO_REPAIR = '1';
  process.env.SEG_QA_MAX_RERECORDS = String(PINNED_MAX_RERECORDS);
  workspaceRoot = mkdtempSync(join(tmpdir(), 'rev3501-'));
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
    bookId, manuscriptId: 'm_rev', title: TITLE, author: AUTHOR, series: SERIES, seriesPosition: null, isStandalone: true,
    manuscriptFile: 'manuscript.txt', castConfirmed: true, language: 'en',
    chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:04' }], coverGradient: ['#000', '#fff'],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));
  app = express(); app.use(express.json()); app.use('/api/books', chapterQaRepairRouter);
});
afterAll(() => { delete process.env.SEG_SPK_AUTO_REPAIR; delete process.env.SEG_QA_MAX_RERECORDS; rmSync(workspaceRoot, { recursive: true, force: true }); });

describe('#3414 qa-repair audition centroid — renamed character, unchanged voice, audition centroid', () => {
  it('ACOUSTIC-ONLY: the renamed character is re-rendered and gated like the control', async () => {
    await scaffold(false);
    embedCosine = 'low';
    vi.mocked(embedSegment).mockClear(); vi.mocked(synthesiseChapter).mockClear();
    const res = await request(app).post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`).send({ dryRun: false, modelKey: 'kokoro-v1' });
    const done = parseSse(res.text).find((e) => e.type === 'qa_repair_complete');
    expect(done, res.text).toBeTruthy();
    // control (hero) = 2 attempts; renamed mairin must ALSO be re-rendered + embedded
    expect(vi.mocked(synthesiseChapter).mock.calls.length).toBe(2 * PINNED_MAX_RERECORDS);
  });

  it('UNION (signal-flagged + acoustic): a WRONG-voice take for the renamed character is rejected, not accepted on signal grounds', async () => {
    await scaffold(true);
    embedCosine = 'low';
    vi.mocked(embedSegment).mockClear(); vi.mocked(synthesiseChapter).mockClear();
    const res = await request(app).post(`/api/books/${encodeURIComponent(bookId)}/chapters/1/audio-qa-repair`).send({ dryRun: false, modelKey: 'kokoro-v1' });
    const done = parseSse(res.text).find((e) => e.type === 'qa_repair_complete');
    expect(done, res.text).toBeTruthy();
    expect(done.repaired as number[]).not.toContain(1);
    expect(done.stillSuspect as number[]).toContain(1);
  });
});
