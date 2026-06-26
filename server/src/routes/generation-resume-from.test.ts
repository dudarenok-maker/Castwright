/* Plan 102 — focused test for the resume_from SSE ack on
 * POST /api/books/:bookId/generation. Asserts (a) resume_from is the
 * FIRST event a new subscriber sees, (b) it carries the snapshot of
 * already-completed chapter ids in the book, (c) it propagates the
 * queueEntryId from the request body when present.
 *
 * Re-uses the supertest + tempdir + mocked synthesiseChapter pattern from
 * generation.test.ts. */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let synthesiseImpl: (args: unknown) => Promise<unknown>;
vi.mock('../tts/synthesise-chapter.js', () => ({
  synthesiseChapter: (args: unknown) => synthesiseImpl(args),
}));
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: () => ({ synthesize: vi.fn() }),
  };
});
/* No sidecar in the test. The preload gate now POLLS through a respawn (plan
   147) — for a kokoro/qwen run with nothing at :9000 it would wait out its full
   readiness budget and hang the run. Stub it to a no-op so these resume_from
   SSE tests exercise the route, not the (separately-tested) readiness gate. */
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  ensureSidecarEngineReady: async () => undefined,
  reconcileResidentQwenTiers: async () => undefined,
  /* Empty so the side-11 boundary-recycle check (the only SIDECAR_ENGINES
     consumer) is a no-op here. */
  SIDECAR_ENGINES: new Set(),
}));

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Queue Resume Test';
const MANUSCRIPT_ID = 'm_queue_resume_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

interface ParsedTick {
  type: string;
  [k: string]: unknown;
}

function parseTicks(body: string): ParsedTick[] {
  return body
    .split('\n\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((frame) => {
      const lines = frame
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6));
      return JSON.parse(lines.join('\n')) as ParsedTick;
    });
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'queue-resume-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.GEN_WORKERS = '1';

  const [{ generationRouter }, { makeBookId }, cacheModule] = await Promise.all([
    import('./generation.js'),
    import('../workspace/paths.js'),
    import('../store/analysis-cache.js'),
  ]);

  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });

  /* Two-chapter book; chapter 1 is "done" (audio file exists), chapter 2 is
     queued. resume_from should emit completedChapterIds: [1] before the
     catch-up replay walks state.chapters. */
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      author: AUTHOR,
      title: TITLE,
      series: SERIES,
      updatedAt: '2026-05-23T00:00:00.000Z',
      schema: 1,
      chapters: [
        { id: 1, title: 'Chapter 1', slug: 'chapter-1' },
        { id: 2, title: 'Chapter 2', slug: 'chapter-2' },
      ],
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [{ id: 'narrator', name: 'Narrator', voiceId: 'af_alloy' }],
    }),
  );
  /* Make chapter 1 look done on disk so it lands in resume_from's snapshot. */
  writeFileSync(join(bookDir, 'audio', 'chapter-1.mp3'), Buffer.from('fake mp3 bytes'));

  /* Seed the analysis cache so the route doesn't bail with "no sentences". */
  await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
    chapters: {
      1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
      2: [{ id: 2, chapterId: 2, characterId: 'narrator', text: 'Goodbye.' }],
    },
  });

  app = express();
  app.use(express.json());
  app.use('/api/books', generationRouter);
});

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspaceRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  /* Reset on-disk state per test: chapter 1 stays "done" (always has audio),
     chapter 2 starts un-rendered so the synth loop runs in tests that need
     live broadcast ticks. Without this, test 1 leaks chapter-2.mp3 for
     tests 2 + 3 to find. */
  const { rm } = await import('node:fs/promises');
  await rm(join(bookDir, 'audio', 'chapter-2.mp3'), { force: true });
  await rm(join(bookDir, 'audio', 'chapter-2.segments.json'), { force: true });
  await rm(join(bookDir, 'audio', 'chapter-2.peaks.json'), { force: true });
  await rm(join(bookDir, 'audio', 'chapter-2.lufs.json'), { force: true });

  /* Default synthesise mock — instantly resolves with a one-segment PCM
     so the route can finish without a real sidecar. The PCM must be a
     Buffer (Int16 LE) so encodePcmToAudio + writeChapterPeaksFile can
     read it via readInt16LE — Float32Array fails that path. 24kHz × 2s
     × 2 bytes/sample = 96000 bytes. */
  synthesiseImpl = vi.fn().mockResolvedValue({
    pcm: Buffer.alloc(96000),
    sampleRate: 24000,
    durationSec: 2,
    segments: [{ characterId: 'narrator', sentenceIds: [2], startSec: 0, endSec: 2 }],
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('resume_from ack', () => {
  it('is emitted FIRST on a new subscriber, carrying completed chapter ids', async () => {
    const res = await request(app).post(`/api/books/${bookId}/generation`).send({
      modelKey: 'kokoro-v1',
      chapterIds: [2],
      queueEntryId: 'queue-entry-abc',
    });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    expect(ticks.length).toBeGreaterThan(0);
    /* First event MUST be resume_from. */
    expect(ticks[0].type).toBe('resume_from');
    expect(ticks[0].queueEntryId).toBe('queue-entry-abc');
    /* Chapter 1 has audio on disk and isn't in scope (chapterIds=[2]), so
       it lands in the resume snapshot. Chapter 2 IS in scope so it's
       excluded from the snapshot (the synth loop will emit live ticks
       for it). */
    expect(ticks[0].resumeFromCompletedChapterIds).toEqual([1]);
  });

  it('omits queueEntryId when the request did not carry one (back-compat)', async () => {
    const res = await request(app).post(`/api/books/${bookId}/generation`).send({
      modelKey: 'kokoro-v1',
      chapterIds: [2],
    });
    const ticks = parseTicks(res.text);
    expect(ticks[0].type).toBe('resume_from');
    expect(ticks[0].queueEntryId).toBeUndefined();
    expect(ticks[0].resumeFromCompletedChapterIds).toEqual([1]);
  });

  it('stamps queueEntryId on every broadcast tick (progress, chapter_complete) when provided', async () => {
    const res = await request(app).post(`/api/books/${bookId}/generation`).send({
      modelKey: 'kokoro-v1',
      chapterIds: [2],
      queueEntryId: 'queue-entry-xyz',
    });
    const ticks = parseTicks(res.text);
    /* Every tick after resume_from carries the queueEntryId (broadcast
       enricher stamps it). The catch-up replay's chapter_complete for
       chapter 1 is sent directly via `send()` (no enricher path), so it
       does NOT carry queueEntryId — that's intentional: the catch-up is
       book-wide state, not queue-entry-specific. Per-entry ticks (the
       live progress + the live chapter_complete for chapter 2) come from
       broadcast() and DO carry it. */
    const liveTicks = ticks.filter(
      (t) =>
        t.type === 'progress' || (t.type === 'chapter_complete' && t.chapterId === 2),
    );
    expect(liveTicks.length).toBeGreaterThan(0);
    for (const t of liveTicks) {
      expect(t.queueEntryId).toBe('queue-entry-xyz');
    }
  });
});
