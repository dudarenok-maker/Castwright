/* Integration tests for POST /api/books/:bookId/generation.

   The real route walks: validate modelKey → load cast.json → load analysis
   cache → for each chapter call synthesiseChapter → encode PCM → write
   .mp3 + segments.json → emit ticks. We mock synthesiseChapter so the test
   doesn't depend on a live sidecar or Gemini API key, and we control its
   behaviour per case (happy, throws, throws same reason twice).

   Mirrors the supertest + tempdir pattern used by chapter-audio.test.ts and
   book-state.test.ts. The route emits Server-Sent Events as `data: <json>`
   frames; the parseTicks helper splits the response body back into typed
   ticks for assertions. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Mock synthesiseChapter so the route never needs a real TTS provider. The
   mock is mutable per test case via the synthesiseImpl ref. */
let synthesiseImpl: (args: unknown) => Promise<unknown>;
vi.mock('../tts/synthesise-chapter.js', () => ({
  synthesiseChapter: (args: unknown) => synthesiseImpl(args),
}));

/* Mock selectTtsProvider so the route doesn't reach for GEMINI_API_KEY or a
   live sidecar — the route only uses the provider to feed into
   synthesiseChapter, which is itself mocked above, so the value is a
   throwaway sentinel. */
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: () => ({ synthesize: vi.fn() }),
  };
});

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Generation Route Test';
const MANUSCRIPT_ID = 'm_gen_route_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

interface ParsedTick { type: string; [k: string]: unknown }

function parseTicks(body: string): ParsedTick[] {
  return body
    .split('\n\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(frame => {
      const lines = frame.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6));
      return JSON.parse(lines.join('\n')) as ParsedTick;
    });
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-generation-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ generationRouter }, { makeBookId }, cacheModule] = await Promise.all([
    import('./generation.js'),
    import('../workspace/paths.js'),
    import('../store/analysis-cache.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter 2', slug: '02-chapter-two' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'narrator', name: 'Narrator', attributes: ['observational'] },
      ],
    }),
  );

  /* Seed the analysis cache — the route reads it from server/handoff/cache,
     not from the workspace, so we have to drive it via the module's own
     saveAnalysisCache helper. */
  await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
    chapters: {
      1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
      2: [{ id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' }],
    },
  });

  app = express();
  app.use(express.json());
  app.use('/api/books', generationRouter);
});

afterAll(async () => {
  const cacheModule = await import('../store/analysis-cache.js');
  await cacheModule.clearAnalysisCache(MANUSCRIPT_ID);
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  /* Default: every synthesise call succeeds with a one-segment PCM body. */
  synthesiseImpl = async () => ({
    pcm: Buffer.alloc(2),
    sampleRate: 24000,
    durationSec: 1,
    segments: [{ characterId: 'narrator', voiceName: 'Zephyr', sampleStart: 0, sampleEnd: 1, sentenceIds: [1] }],
  });
});

describe('POST /api/books/:bookId/generation', () => {
  it('happy path: emits progress + chapter_complete + idle for every chapter', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    /* At least: progress for ch1, chapter_assembling ch1, chapter_complete ch1,
       progress for ch2, chapter_assembling ch2, chapter_complete ch2, idle. */
    expect(ticks.some(t => t.type === 'chapter_complete' && t.chapterId === 1)).toBe(true);
    expect(ticks.some(t => t.type === 'chapter_complete' && t.chapterId === 2)).toBe(true);
    expect(ticks[ticks.length - 1].type).toBe('idle');
  });

  it('rejects an unsupported modelKey with a stream-level chapter_failed and ends', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'not-a-real-model' });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].type).toBe('chapter_failed');
    expect(ticks[0].chapterId).toBeUndefined();
    expect(ticks[0].errorReason).toMatch(/modelKey/i);
  });

  /* ── Pause endpoint + sticky-across-reload contract ──────────────── */

  it('POST /generation/pause sees a registered job and reports paused:true', async () => {
    /* The route registers its RunningJob in inFlightByBook BEFORE the
       chapter loop's first synthesiseChapter call. We block synth until
       synthStarted resolves so /pause races against the loop's await.
       The fact that the pause endpoint sees the job and returns
       paused:true proves the route-to-pause coupling works. The actual
       abort delivery is exercised independently (controller.abort + the
       loop's AbortError catch are tiny mechanical pieces). */
    let resolveSynthStarted: () => void;
    const synthStarted = new Promise<void>(r => { resolveSynthStarted = r; });
    /* synth blocks until either signal aborts or the test timeout fires.
       Honouring abort is essential — without it the route's loop never
       breaks, inFlightByBook stays populated, and the next test sees a
       leftover entry (the no-op pause case below would then report
       paused:true and fail). */
    synthesiseImpl = (args: unknown) => {
      const signal = (args as { signal?: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
        if (signal?.aborted) { reject(abortErr()); return; }
        signal?.addEventListener('abort', () => reject(abortErr()), { once: true });
        resolveSynthStarted();
      });
    };

    /* Fire-and-forget — we don't await this. */
    const genReq = request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    /* swallow the (eventually-aborted) promise to avoid an unhandled
       rejection on the worker. */
    genReq.then(() => {}, () => {});

    await synthStarted;
    const pauseRes = await request(app).post(`/api/books/${bookId}/generation/pause`).send({});
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body).toEqual({ ok: true, paused: true });
  }, 8_000);

  it('POST /generation/pause when no job is running is an idempotent no-op (200, paused:false)', async () => {
    /* Double-click on Pause, or a Pause that arrives after the queue
       drained naturally, must NOT 404 — the middleware fires this
       blindly on every setPaused(true) without coordinating with the
       loop's end-of-life. */
    const res = await request(app).post(`/api/books/${bookId}/generation/pause`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, paused: false });
  });

  it('escalates to fatal on the second identical non-fatal failure (cascade kill)', async () => {
    /* This is the regression for the screenshot — chapter 1 fails with
       "index out of range in self" (which we classify as fatal directly),
       but for a non-mapped error the cascade detector kicks in on the
       second repeat. Use a generic message here so we can prove the
       cascade itself works without relying on the XTTS-specific pattern
       (that's covered in generation-error.test.ts). */
    synthesiseImpl = async () => { throw new Error('Sidecar returned 500: weird thing'); };
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    expect(res.status).toBe(200);
    const ticks = parseTicks(res.text);
    const failed = ticks.filter(t => t.type === 'chapter_failed');
    /* Chapter 1 fails non-fatally (first hit), chapter 2 escalates to fatal
       (second hit, same reason). Run must stop there — no third failure
       even though there are no more chapters; the loop break + idle is
       what matters. */
    expect(failed).toHaveLength(2);
    expect((failed[1].errorReason as string)).toMatch(/same failure repeated|stopping run/i);
    expect(ticks[ticks.length - 1].type).toBe('idle');
  });

  it('skips chapters whose excluded flag is true even with force=true / explicit chapterIds', async () => {
    /* Excluded chapters never get audio — the user opted out of narrating
       them (typically front/back-matter like Dedication, Copyright). The
       route must skip them in:
       - default mode (no requestedIds, chapterAudioExists check)
       - force=true (which would normally regenerate everything)
       - explicit chapterIds (defense-in-depth against a frontend bug
         that lets an excluded id slip into the list)
       Also: the catch-up replay must not emit a chapter_complete for an
       excluded chapter even if stale audio is still on disk. */
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const fs = await import('node:fs');
    const original = fs.readFileSync(statePath, 'utf8');
    const stateJson = JSON.parse(original) as {
      chapters: Array<{ id: number; excluded?: boolean }>;
    };
    stateJson.chapters = stateJson.chapters.map(c =>
      c.id === 1 ? { ...c, excluded: true } : c,
    );
    writeFileSync(statePath, JSON.stringify(stateJson));

    /* Clear any stale audio left by earlier tests so the assertions are
       deterministic. */
    const audioRoot = join(bookDir, 'audio');
    if (fs.existsSync(audioRoot)) fs.rmSync(audioRoot, { recursive: true, force: true });

    let synthCalls = 0;
    synthesiseImpl = async () => {
      synthCalls += 1;
      return {
        pcm: Buffer.alloc(2),
        sampleRate: 24000,
        durationSec: 1,
        segments: [{ characterId: 'narrator', voiceName: 'Zephyr', sampleStart: 0, sampleEnd: 1, sentenceIds: [1] }],
      };
    };

    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/generation`)
        .send({ modelKey: 'gemini-2.5-flash', force: true, chapterIds: [1, 2] });
      expect(res.status).toBe(200);
      const ticks = parseTicks(res.text);
      const completes = ticks.filter(t => t.type === 'chapter_complete');
      /* Exactly one chapter_complete — for the non-excluded ch2. */
      expect(completes.map(t => t.chapterId)).toEqual([2]);
      /* And synthesiseChapter must have been invoked exactly once. */
      expect(synthCalls).toBe(1);
    } finally {
      writeFileSync(statePath, original);
    }
  });

  it('classifies XTTS "index out of range in self" as fatal on first hit', async () => {
    synthesiseImpl = async () => {
      throw new Error('Local TTS sidecar returned 500: {"detail":"index out of range in self"}');
    };
    const res = await request(app)
      .post(`/api/books/${bookId}/generation`)
      .send({ modelKey: 'gemini-2.5-flash', force: true });
    const ticks = parseTicks(res.text);
    const failed = ticks.filter(t => t.type === 'chapter_failed');
    /* The error classifier maps "index out of range" directly to fatal, so
       chapter 1 fails and the run stops — chapter 2 is never attempted. */
    expect(failed).toHaveLength(1);
    expect((failed[0].errorReason as string)).toMatch(/voice catalog is out of sync/i);
    expect(ticks[ticks.length - 1].type).toBe('idle');
  });
});
