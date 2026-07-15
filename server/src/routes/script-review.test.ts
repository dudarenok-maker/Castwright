/* fs-58 — integration tests for the script-review SSE route
   POST /api/books/:bookId/script-review.

   The analyzer is faked via vi.mock('../analyzer/select-analyzer.js') so no
   real LLM is hit. The route is the contract under test: it streams per-chapter
   `ops` events with the review operations, guards an unattributed book with a
   `no_attribution` error, and on mid-pass DailyQuotaExhaustedError emits a
   `quota_exhausted` error after the chapters it already streamed.
   When an optional `chapterId` is supplied in the body, only that chapter is
   reviewed (the analyzer is called exactly once). */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Analyzer } from '../analyzer/index.js';
import type { ScriptReviewOutput } from '../handoff/schemas.js';
import type {
  buildReviewSentencesInput as BuildReviewSentencesInput,
  priorChapterBoundaryExchange as PriorChapterBoundaryExchange,
  buildScriptReviewChapterInbox as BuildScriptReviewChapterInbox,
  priorChapterIdFor as PriorChapterIdFor,
} from './script-review.js';

const AUTHOR = 'Test Author';
const SERIES = 'Test Series';
const BOOK = 'Test Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let manuscriptId: string;
let buildReviewSentencesInput: typeof BuildReviewSentencesInput;
let priorChapterBoundaryExchange: typeof PriorChapterBoundaryExchange;
let buildScriptReviewChapterInbox: typeof BuildScriptReviewChapterInbox;
let priorChapterIdFor: typeof PriorChapterIdFor;

/* The fake analyzer's runScriptReviewChapter — each test swaps its implementation.
   `selectedEngine` lets a test flip the reported engine to 'local' (so the
   chunker derives a finite, num_ctx-bound budget and a large chapter splits);
   it defaults to 'gemini' so the existing single-call tests are unchanged. */
const { runReview, engineState, selectAnalyzerForPhaseMock, warmOllamaModelMock, selectAnalyzerMock } = vi.hoisted(() => ({
  runReview: vi.fn(),
  engineState: { engine: 'gemini' as 'gemini' | 'local' },
  selectAnalyzerForPhaseMock: vi.fn(),
  warmOllamaModelMock: vi.fn(),
  selectAnalyzerMock: vi.fn(),
}));

vi.mock('../analyzer/select-analyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/select-analyzer.js')>();
  const fakeAnalyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.reject(new Error('not used')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: (m, c, p, call) => runReview(m, c, p, call),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  return {
    ...actual,
    selectAnalyzerForPhase: selectAnalyzerForPhaseMock.mockImplementation(() => ({
      analyzer: fakeAnalyzer,
      engine: engineState.engine,
      model: 'test-model',
      fallbackModel: null,
    })),
  };
});

/* Task 6 — warm step + Gemini-switch. `warmOllamaModel` is mocked so tests
   control the warm outcome without a real Ollama daemon; `selectAnalyzer`
   (the RE-selection `switchToFallback` performs) is mocked too so the
   post-fallback analyzer instance is the SAME fake analyzer wired to
   `runReview`, not a real GeminiAnalyzer that would attempt a network call. */
vi.mock('./ollama-health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ollama-health.js')>();
  return {
    ...actual,
    warmOllamaModel: warmOllamaModelMock,
  };
});

vi.mock('../analyzer/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/index.js')>();
  const fakeAnalyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.reject(new Error('not used')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: (m, c, p, call) => runReview(m, c, p, call),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  return {
    ...actual,
    selectAnalyzer: selectAnalyzerMock.mockImplementation((opts?: { model?: string }) => ({
      analyzer: fakeAnalyzer,
      engine: 'gemini',
      model: opts?.model ?? 'gemini-fallback-model',
      fallbackModel: null,
    })),
  };
});

function bookDir(): string {
  return join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
}

function writeBook(sentences: unknown[] | null, chapters: unknown[] = []): void {
  const dir = bookDir();
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId,
      title: BOOK,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters,
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [{ id: 'wren', name: 'Wren', role: 'protagonist', color: '#ff0000' }],
    }),
  );
  if (sentences) {
    writeFileSync(
      join(dir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({ sentences }),
    );
  }
}

/** Parse an SSE response body into the array of JSON `data:` payloads. */
function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

/** Fires a POST immediately and returns both the in-flight request (so a
    caller can `.abort()` it) and a promise that resolves once the response
    completes. A bare `request(app).post(...).send(...)` assigned to a
    variable does NOT actually dispatch — supertest/superagent defer the
    real HTTP send until the request is awaited or `.then()`/`.end()` is
    invoked — so a "kick off request A, sleep, then send request B" test
    would otherwise send both around the same tick instead of A first. */
function firePost(path: string, body: Record<string, unknown>): { req: request.Test; done: Promise<request.Response> } {
  const req = request(app).post(path).send(body);
  const done = new Promise<request.Response>((resolve, reject) => {
    req.end((err, res) => {
      if (err && !res) reject(err);
      else resolve(res as request.Response);
    });
  });
  return { req, done };
}

const SENTENCES = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'The room was quiet.' },
  { id: 2, chapterId: 1, characterId: 'wren', text: '"Get down!"' },
  { id: 3, chapterId: 2, characterId: 'marlow', text: '"It will be okay," he whispered.' },
];

const CANNED_OPS: ScriptReviewOutput = {
  ops: [
    {
      id: 1,
      op: 'strip_tag',
      anchor: 'Get down',
      newText: '"Get down!"',
      rationale: 'Remove attribution tag',
    },
  ],
};

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-script-review-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ scriptReviewRouter, buildReviewSentencesInput: build, priorChapterBoundaryExchange: pcbe, buildScriptReviewChapterInbox: bsrci, priorChapterIdFor: pcif }, { makeBookId }] =
    await Promise.all([import('./script-review.js'), import('../workspace/paths.js')]);
  buildReviewSentencesInput = build;
  priorChapterBoundaryExchange = pcbe;
  buildScriptReviewChapterInbox = bsrci;
  priorChapterIdFor = pcif;
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  manuscriptId = `m_${bookId}`;
  app = express();
  app.use(express.json());
  app.use('/api/books', scriptReviewRouter);
});

beforeEach(() => {
  runReview.mockReset();
  engineState.engine = 'gemini';
  delete process.env.ANALYZER_NUM_CTX;
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  // Default: warm succeeds instantly so the existing local-engine tests
  // (which don't care about the warm step) are unaffected; individual
  // Task 6 tests override this per-case.
  warmOllamaModelMock.mockReset();
  warmOllamaModelMock.mockResolvedValue({ ok: true });
  selectAnalyzerMock.mockClear();
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/books/:bookId/script-review', () => {
  it('streams per-chapter ops events and a final result', async () => {
    writeBook(SENTENCES);
    runReview.mockImplementation((_m, chapterId): Promise<ScriptReviewOutput> => {
      if (chapterId === 1) return Promise.resolve(CANNED_OPS);
      return Promise.resolve({ ops: [] });
    });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    // A chunk with no owned ops emits no `ops` event (the chunker only sends
    // owned ops), so the empty chapter 2 produces no event — but is still counted.
    const opsEvents = events.filter((e) => e.kind === 'ops');
    expect(opsEvents).toHaveLength(1);
    expect(opsEvents[0]).toMatchObject({ kind: 'ops', chapterId: 1, ops: CANNED_OPS.ops });

    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ done: true, reviewedChapters: 2 });
  });

  it('skips excluded chapters on a whole-book review but honours an explicit per-chapter request', async () => {
    writeBook(SENTENCES, [
      { id: 1, title: 'One', slug: 'one' },
      { id: 2, title: 'Two', slug: 'two', excluded: true },
    ]);
    runReview.mockResolvedValue(CANNED_OPS);

    // Whole-book review: the excluded chapter 2 must be skipped.
    const whole = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    expect(whole.status).toBe(200);
    const wholeChapters = runReview.mock.calls.map((c) => c[1]);
    expect(wholeChapters).toContain(1);
    expect(wholeChapters).not.toContain(2);

    // An explicit per-chapter request for the excluded chapter is still honoured.
    runReview.mockClear();
    const single = await request(app)
      .post(`/api/books/${bookId}/script-review`)
      .send({ chapterId: 2 });
    expect(single.status).toBe(200);
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(runReview.mock.calls[0][1]).toBe(2);
  });

  it('limits the pass to one chapter when chapterId is provided', async () => {
    writeBook(SENTENCES);
    runReview.mockResolvedValue(CANNED_OPS);

    const res = await request(app)
      .post(`/api/books/${bookId}/script-review`)
      .send({ chapterId: 1 });
    expect(res.status).toBe(200);

    // Analyzer called exactly once (for chapter 1 only)
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(runReview.mock.calls[0][1]).toBe(1);

    const events = parseSse(res.text);
    const opsEvents = events.filter((e) => e.kind === 'ops');
    expect(opsEvents).toHaveLength(1);
    expect(opsEvents[0]).toMatchObject({ kind: 'ops', chapterId: 1 });
  });

  it('emits a no_attribution error when the book has no attributed sentences', async () => {
    writeBook(null); // no manuscript-edits.json, no cache
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'error' && e.code === 'no_attribution')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
    expect(runReview).not.toHaveBeenCalled();
  });

  it('emits a no_such_chapter error when a requested chapterId matches no attributed chapter', async () => {
    writeBook(SENTENCES); // book IS analysed — chapters 1 and 2 carry sentences
    const res = await request(app)
      .post(`/api/books/${bookId}/script-review`)
      .send({ chapterId: 99 }); // no such chapter
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'error' && e.code === 'no_such_chapter')).toBe(true);
    // Must NOT be conflated with the unanalysed-book code.
    expect(events.some((e) => e.kind === 'error' && e.code === 'no_attribution')).toBe(false);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
    expect(runReview).not.toHaveBeenCalled();
  });

  it('404s for an unknown book', async () => {
    const res = await request(app).post(`/api/books/does-not-exist/script-review`).send({});
    expect(res.status).toBe(404);
  });

  it('on mid-pass daily-quota exhaustion, keeps already-streamed chapters and stops with quota_exhausted', async () => {
    writeBook(SENTENCES);
    const { DailyQuotaExhaustedError } = await import('../analyzer/rate-limit.js');
    runReview.mockImplementation((_m, chapterId): Promise<ScriptReviewOutput> => {
      if (chapterId === 1) return Promise.resolve(CANNED_OPS);
      return Promise.reject(new DailyQuotaExhaustedError('test-model', new Date('2099-01-01')));
    });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);

    // Chapter 1 ops survived.
    expect(events.some((e) => e.kind === 'ops' && e.chapterId === 1)).toBe(true);
    // Quota error reported; no success result.
    expect(events.some((e) => e.kind === 'error' && e.code === 'quota_exhausted')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
  });

  /* Round-3 review Important Finding 5 — the detached job launch
     (`void runScriptReviewJob(...).finally(...)`) had no `.catch`, so a
     SYNCHRONOUS throw inside runScriptReviewJob (e.g. selectAnalyzerForPhase
     throwing on a misconfigured engine, BEFORE the analyzer is ever called)
     became an unhandled promise rejection: no error/SSE event was ever sent
     and res.end() was never called, hanging the client's request forever.
     The fix broadcasts a kind:'error' event and ends every subscriber's
     response. */
  it('when the job runner throws synchronously (e.g. a misconfigured analyzer engine), the SSE client receives a kind:"error" event instead of hanging', async () => {
    writeBook(SENTENCES);
    selectAnalyzerForPhaseMock.mockImplementationOnce(() => {
      throw new Error('misconfigured engine: missing GEMINI_API_KEY');
    });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'error' && e.code === 'internal_error')).toBe(true);
    expect(runReview).not.toHaveBeenCalled();
  });

  it('a single chapter failure does not abort the rest of the pass', async () => {
    writeBook(SENTENCES);
    runReview.mockImplementation((_m, chapterId): Promise<ScriptReviewOutput> => {
      if (chapterId === 1) return Promise.reject(new Error('flaky chapter'));
      // chapter 2 carries sentence id 3 — return an owned op so it visibly emits.
      return Promise.resolve({
        ops: [{ id: 3, op: 'strip_tag', anchor: 'okay', newText: '"It will be okay."', rationale: 'r' }],
      });
    });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'chapter-failed' && e.chapterId === 1)).toBe(true);
    expect(events.some((e) => e.kind === 'ops' && e.chapterId === 2)).toBe(true);
    // Each chapter is counted once after its chunk loop, so a chapter whose only
    // chunk failed still counts as reviewed (both chapters here = 2).
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ reviewedChapters: 2 });
  });

  it('carries chapterIndex/totalChapters on every phase event, and estRemainingMs only from the 2nd chapter onward', async () => {
    writeBook(SENTENCES); // 2 chapters
    runReview.mockImplementation(async (): Promise<ScriptReviewOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      return { ops: [] };
    });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);
    // Chapter-start phases carry chapterIndex/totalChapters; the fs-58
    // heartbeat's per-chunk progress-creep phases (also kind:'phase' with a
    // chapterId, but no pacing fields) are filtered out here.
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterIndex === 'number');

    expect(phases[0]).toMatchObject({ chapterIndex: 1, totalChapters: 2 });
    expect(phases[0].estRemainingMs).toBeUndefined();
    expect(phases[1]).toMatchObject({ chapterIndex: 2, totalChapters: 2 });
    expect(typeof phases[1].estRemainingMs).toBe('number');
  });

  it('drops the "— chapter N" suffix from the phase label', async () => {
    writeBook(SENTENCES);
    runReview.mockResolvedValue({ ops: [] });
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    expect(phases.every((e) => e.label === 'Reviewing script')).toBe(true);
  });

  it('never emits estRemainingMs for a single-chapter review', async () => {
    writeBook(SENTENCES);
    runReview.mockResolvedValue(CANNED_OPS);
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterIndex === 'number');
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatchObject({ chapterIndex: 1, totalChapters: 1 });
    expect(phases[0].estRemainingMs).toBeUndefined();
  });

  it('a failed chunk still contributes its wall-clock duration to the next chapter estimate', async () => {
    writeBook(SENTENCES);
    runReview.mockImplementation(async (_m, chapterId): Promise<ScriptReviewOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      if (chapterId === 1) throw new Error('flaky chapter');
      return { ops: [] };
    });
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterIndex === 'number');
    expect(typeof phases[1].estRemainingMs).toBe('number');
  });

  it('chunks a large chapter across calls and reviews each sentence exactly once', async () => {
    // Force the local engine + a small num_ctx so chapterChunkBudget() derives a
    // finite, sub-chapter char budget — a large chapter then splits into >=2 chunks
    // (gemini's MAX_SAFE_INTEGER budget would never split).
    engineState.engine = 'local';
    process.env.ANALYZER_NUM_CTX = '400'; // → budget Math.max(2000, min(24000, 560)) = 2000

    // ~800-char sentences: each chunk fits ~2 sentences before the 2000-char budget,
    // so 12 sentences split into several overlapping chunks.
    const longText = 'A'.repeat(800);
    const chapterSentences = Array.from({ length: 12 }, (_, i) => ({
      id: 100 + i,
      chapterId: 10,
      characterId: 'narrator',
      text: longText,
    }));
    writeBook(chapterSentences);

    // Each call returns one strip_tag op per sentenceId present in the prompt it
    // received (core + overlap context), so without ownership dedupe an overlapped
    // sentence would be emitted by >1 chunk.
    runReview.mockImplementation((_m, _c, prompt: string): Promise<ScriptReviewOutput> => {
      const ids = [...prompt.matchAll(/"sentenceId":\s*(\d+)/g)].map((m) => Number(m[1]));
      return Promise.resolve({
        ops: ids.map((id) => ({
          id,
          op: 'strip_tag' as const,
          anchor: 'x',
          newText: 'x',
          rationale: 'r',
        })),
      });
    });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    // The chapter split — the analyzer was called more than once.
    expect(runReview.mock.calls.length).toBeGreaterThan(1);

    // Zero chapter-failed events (the old 9000-char guard is gone).
    expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);

    // The union of emitted op ids equals the chapter's sentence ids, EACH EXACTLY ONCE.
    const emittedIds = events
      .filter((e) => e.kind === 'ops')
      .flatMap((e) => (e.ops as Array<{ id: number }>).map((o) => o.id));
    const expectedIds = chapterSentences.map((s) => s.id);
    expect([...emittedIds].sort((a, b) => a - b)).toEqual(expectedIds);
    expect(new Set(emittedIds).size).toBe(emittedIds.length); // no duplicates

    expect(events.some((e) => e.kind === 'result')).toBe(true);
  });

  it('stamps model/engine/activityState on the chapter-start phase, and emits per-chunk progress creep (fs-58 heartbeat)', async () => {
    // Force the local engine + a small num_ctx so the chapter splits into
    // >=2 chunks (mirrors "chunks a large chapter across calls" above) —
    // the intra-chapter creep only has something to observe when there's
    // more than one chunk.
    engineState.engine = 'local';
    process.env.ANALYZER_NUM_CTX = '400'; // → budget 2000

    const longText = 'A'.repeat(800);
    const chapterSentences = Array.from({ length: 12 }, (_, i) => ({
      id: 100 + i,
      chapterId: 10,
      characterId: 'narrator',
      text: longText,
    }));
    writeBook(chapterSentences);
    runReview.mockResolvedValue({ ops: [] });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase');
    // Task 6's warm-model phase (activityState: 'loading') now precedes the
    // chapter-start phase for a local engine — filter to the chapter-start
    // phases specifically (activityState: 'waiting') rather than assuming
    // index 0.
    const chapterStartPhases = phases.filter((e) => e.activityState === 'waiting');

    // Chapter-start phase carries model + engine + waiting.
    expect(chapterStartPhases[0]).toMatchObject({
      label: 'Reviewing script',
      activityState: 'waiting',
      model: expect.any(String),
      engine: expect.stringMatching(/local|gemini/),
    });

    // A per-chunk phase advanced progress strictly between chapter starts.
    const progresses = phases.map((p) => p.progress as number);
    expect(progresses.some((p, i) => i > 0 && p > progresses[i - 1] && p < 1)).toBe(true);
  });

  /* Task 6 — the explicit warm step ahead of the per-chapter loop, and the
     switchToFallback latch it can trigger. Three branches: no-fallback warm
     failure hard-errors; a configured Gemini fallback survives a cold/dead
     Ollama instead of aborting a setup that works today; and a cancel that
     lands DURING the warm await must not be reported as a load failure. */
  describe('warm step + Gemini-switch latch (Task 6)', () => {
    it('local engine, no Gemini fallback configured, warm fails → model_load_failed and zero chapters reviewed', async () => {
      writeBook(SENTENCES);
      selectAnalyzerForPhaseMock.mockImplementationOnce(() => ({
        analyzer: {
          runStage1: () => Promise.reject(new Error('not used')),
          runStage1Chapter: () => Promise.reject(new Error('not used')),
          runStage2Chapter: () => Promise.reject(new Error('not used')),
          runEmotionChapter: () => Promise.reject(new Error('not used')),
          runScriptReviewChapter: (m: string, c: number, p: string, call: unknown) =>
            (runReview as (...args: unknown[]) => unknown)(m, c, p, call),
          runStage3Chapter: () => Promise.reject(new Error('not used')),
          runAttributionEscalation: () => Promise.resolve(null),
        } as Analyzer,
        engine: 'local',
        model: 'qwen3.5:9b',
        fallbackModel: null,
      }));
      warmOllamaModelMock.mockResolvedValue({ ok: false, kind: 'unreachable', status: 503, error: 'connect ECONNREFUSED' });

      const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
      expect(res.status).toBe(200);
      const events = parseSse(res.text);

      expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'model_load_failed', warmKind: 'unreachable' }));
      expect(events.filter((e) => e.kind === 'ops')).toHaveLength(0);
      expect(events.some((e) => e.kind === 'result')).toBe(false);
      expect(runReview).not.toHaveBeenCalled();
    });

    it('local engine, no fallback, warm load_timeout → model_load_failed with the "took too long" copy (Part 2)', async () => {
      writeBook(SENTENCES);
      selectAnalyzerForPhaseMock.mockImplementationOnce(() => ({
        analyzer: {
          runStage1: () => Promise.reject(new Error('not used')),
          runStage1Chapter: () => Promise.reject(new Error('not used')),
          runStage2Chapter: () => Promise.reject(new Error('not used')),
          runEmotionChapter: () => Promise.reject(new Error('not used')),
          runScriptReviewChapter: (m: string, c: number, p: string, call: unknown) =>
            (runReview as (...args: unknown[]) => unknown)(m, c, p, call),
          runStage3Chapter: () => Promise.reject(new Error('not used')),
          runAttributionEscalation: () => Promise.resolve(null),
        } as Analyzer,
        engine: 'local',
        model: 'qwen3.5:9b',
        fallbackModel: null,
      }));
      warmOllamaModelMock.mockResolvedValue({ ok: false, kind: 'load_timeout', status: 504, error: 'slow' });

      const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
      const events = parseSse(res.text);

      const err = events.find((e) => e.kind === 'error' && e.code === 'model_load_failed') as
        | { message?: string; warmKind?: string }
        | undefined;
      expect(err).toBeDefined();
      expect(err?.warmKind).toBe('load_timeout');
      expect(err?.message).toMatch(/finish loading|too long|slow disk/i);
      expect(runReview).not.toHaveBeenCalled();
    });

    it('local engine, Gemini fallback configured, warm fails → no error, one gemini announcement phase, chapters still run', async () => {
      writeBook(SENTENCES);
      selectAnalyzerForPhaseMock.mockImplementationOnce(() => ({
        analyzer: {
          runStage1: () => Promise.reject(new Error('not used')),
          runStage1Chapter: () => Promise.reject(new Error('not used')),
          runStage2Chapter: () => Promise.reject(new Error('not used')),
          runEmotionChapter: () => Promise.reject(new Error('not used')),
          runScriptReviewChapter: (m: string, c: number, p: string, call: unknown) =>
            (runReview as (...args: unknown[]) => unknown)(m, c, p, call),
          runStage3Chapter: () => Promise.reject(new Error('not used')),
          runAttributionEscalation: () => Promise.resolve(null),
        } as Analyzer,
        engine: 'local',
        model: 'qwen3.5:9b',
        fallbackModel: 'gemma-4-31b-it',
      }));
      warmOllamaModelMock.mockResolvedValue({ ok: false, kind: 'unreachable', status: 503, error: 'connect ECONNREFUSED' });
      runReview.mockResolvedValue({ ops: [] });

      const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
      expect(res.status).toBe(200);
      const events = parseSse(res.text);

      expect(events.find((e) => e.kind === 'error')).toBeUndefined();
      expect(
        events.filter((e) => e.kind === 'phase' && e.engine === 'gemini' && e.fallbackReason),
      ).toHaveLength(1);
      // switchToFallback re-selected via the (mocked) selectAnalyzer, so the
      // fallback model id it was asked for is the ORIGINAL selection's
      // fallbackModel, not the dead local model.
      expect(selectAnalyzerMock).toHaveBeenCalledWith({ model: 'gemma-4-31b-it' });
      // Both chapters still get reviewed, on the switched-to analyzer.
      expect(runReview).toHaveBeenCalled();
      expect(events.find((e) => e.kind === 'result')).toMatchObject({ done: true, reviewedChapters: 2 });
    });

    it('cancel arriving during the warm await surfaces "cancelled", not "model_load_failed"', async () => {
      writeBook(SENTENCES);
      selectAnalyzerForPhaseMock.mockImplementationOnce(() => ({
        analyzer: {
          runStage1: () => Promise.reject(new Error('not used')),
          runStage1Chapter: () => Promise.reject(new Error('not used')),
          runStage2Chapter: () => Promise.reject(new Error('not used')),
          runEmotionChapter: () => Promise.reject(new Error('not used')),
          runScriptReviewChapter: (m: string, c: number, p: string, call: unknown) =>
            (runReview as (...args: unknown[]) => unknown)(m, c, p, call),
          runStage3Chapter: () => Promise.reject(new Error('not used')),
          runAttributionEscalation: () => Promise.resolve(null),
        } as Analyzer,
        engine: 'local',
        model: 'qwen3.5:9b',
        fallbackModel: null,
      }));
      let releaseWarm: ((v: { ok: false; status: number; error: string }) => void) | undefined;
      warmOllamaModelMock.mockImplementation(
        (_model: string, opts: { signal?: AbortSignal }) =>
          new Promise((resolve) => {
            releaseWarm = resolve;
            // Mirrors warmOllamaModel's real contract: an aborted signal
            // eventually resolves the pending call rather than hanging it.
            opts.signal?.addEventListener('abort', () => resolve({ ok: false, status: 0, error: 'aborted' }));
          }),
      );

      const { done } = firePost(`/api/books/${bookId}/script-review`, {});
      done.catch(() => {});
      await new Promise((r) => setTimeout(r, 20)); // let the request register and reach the gated warm call

      await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
      releaseWarm?.({ ok: false, status: 0, error: 'aborted' });
      const res = await done;

      const events = parseSse(res.text);
      expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'cancelled' }));
      expect(events.some((e) => e.kind === 'error' && e.code === 'model_load_failed')).toBe(false);
      expect(runReview).not.toHaveBeenCalled();
    });

    it('a MID-RUN fallback (warm succeeds, Ollama dies partway through the pass) announces the switch at the CURRENT progress, not 0', async () => {
      writeBook(SENTENCES); // two chapters — chapter 1 completes before the fallback fires on chapter 2
      selectAnalyzerForPhaseMock.mockImplementationOnce(() => ({
        analyzer: {
          runStage1: () => Promise.reject(new Error('not used')),
          runStage1Chapter: () => Promise.reject(new Error('not used')),
          runStage2Chapter: () => Promise.reject(new Error('not used')),
          runEmotionChapter: () => Promise.reject(new Error('not used')),
          runScriptReviewChapter: (m: string, c: number, p: string, call: unknown) =>
            (runReview as (...args: unknown[]) => unknown)(m, c, p, call),
          runStage3Chapter: () => Promise.reject(new Error('not used')),
          runAttributionEscalation: () => Promise.resolve(null),
        } as Analyzer,
        engine: 'local',
        model: 'qwen3.5:9b',
        fallbackModel: 'gemma-4-31b-it',
      }));
      // Warm succeeds (default mock: { ok: true }) — the fallback only fires
      // mid-run, via onFallback on chapter 2's call, AFTER chapter 1 has
      // already streamed a non-zero progress fraction.
      runReview.mockImplementation((_m: string, chapterId: number, _p: string, call: { onFallback: (info: { reason: string }) => void }) => {
        if (chapterId === 2) call.onFallback({ reason: 'Ollama unreachable mid-run' });
        return Promise.resolve({ ops: [] });
      });

      const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
      expect(res.status).toBe(200);
      const events = parseSse(res.text);

      // Sanity: progress DID advance past 0 before the fallback (chapter 1's
      // chapter-start/creep phases), so a hardcoded progress: 0 on the
      // announcement would be a visible regression, not a no-op.
      const preFallbackProgress = events
        .filter((e) => e.kind === 'phase' && !e.fallbackReason)
        .map((e) => e.progress as number);
      expect(Math.max(...preFallbackProgress)).toBeGreaterThan(0);

      const fallbackPhases = events.filter((e) => e.kind === 'phase' && e.engine === 'gemini' && e.fallbackReason);
      expect(fallbackPhases).toHaveLength(1);
      // The announcement must carry the LAST progress emitted before the
      // fallback (0.5 — chapter 1 of 2 fully done), not a reset to 0.
      expect(fallbackPhases[0].progress).toBe(0.5);
      expect(fallbackPhases[0].progress).toBeGreaterThan(0);
    });
  });

  it('feeds the prior chapter exchange into the next chapter, first chunk only (fs-64)', async () => {
    writeBook([
      { id: 1, chapterId: 1, characterId: 'wren', text: '"Where to?"' },
      { id: 2, chapterId: 1, characterId: 'marlow', text: '"Somewhere safe."' },
      { id: 1, chapterId: 2, characterId: 'wren', text: '"I know this place."' },
    ], [
      { id: 1, title: 'One', excluded: false },
      { id: 2, title: 'Two', excluded: false },
    ]);
    const prompts: Record<number, string> = {};
    runReview.mockImplementation((_m: string, c: number, p: string) => {
      prompts[c] = p;
      return Promise.resolve({ ops: [] });
    });

    await request(app).post(`/api/books/${bookId}/script-review`).send({}).expect(200);

    expect(prompts[2]).toContain('Prior chapter');
    // The seeded cast.json has only `wren`, so `marlow` resolves to its id via the
    // off-roster fallback — assert the fallback form `marlow (id: marlow)`.
    expect(prompts[2]).toContain('marlow (id: marlow): "Somewhere safe."');
    expect(prompts[1] ?? '').not.toContain('Prior chapter'); // chapter 1 has no predecessor
  });

  it('attaches the block to the FIRST chunk only of a multi-chunk chapter (fs-64)', async () => {
    // Force the local engine + small num_ctx so chapter 10 splits into >=2 chunks
    // (mirrors the existing "chunks a large chapter" harness). Chapter 9 ends A/B,
    // so chapter 10's FIRST chunk must carry the block and later chunks must not.
    engineState.engine = 'local';
    process.env.ANALYZER_NUM_CTX = '400'; // → budget 2000
    const big = Array.from({ length: 12 }, (_, i) => ({
      id: 100 + i, chapterId: 10, characterId: 'narrator', text: 'A'.repeat(800),
    }));
    writeBook([
      { id: 1, chapterId: 9, characterId: 'wren', text: '"Where to?"' },
      { id: 2, chapterId: 9, characterId: 'marlow', text: '"Somewhere safe."' },
      ...big,
    ], [{ id: 9, title: 'Nine', excluded: false }, { id: 10, title: 'Ten', excluded: false }]);

    const calls: Array<{ chapterId: number; prompt: string }> = [];
    runReview.mockImplementation((_m: string, c: number, p: string) => {
      calls.push({ chapterId: c, prompt: p });
      return Promise.resolve({ ops: [] });
    });

    await request(app).post(`/api/books/${bookId}/script-review`).send({}).expect(200);

    const ch10 = calls.filter((c) => c.chapterId === 10).map((c) => c.prompt);
    expect(ch10.length).toBeGreaterThan(1); // the chapter split
    expect(ch10[0]).toContain('Prior chapter'); // first chunk carries it
    expect(ch10.slice(1).every((p) => !p.includes('Prior chapter'))).toBe(true); // later chunks don't
  });

  it('emits NO block when the predecessor ends on narration — scene break (fs-64)', async () => {
    // The headline regression guard: a non-exchange ending must not feed a
    // misleading turn-taking signal into the next chapter.
    writeBook([
      { id: 1, chapterId: 1, characterId: 'wren', text: '"Anyone there?"' },
      { id: 2, chapterId: 1, characterId: 'narrator', text: 'Silence answered.' },
      { id: 1, chapterId: 2, characterId: 'wren', text: '"I knew it."' },
    ], [{ id: 1, title: 'One', excluded: false }, { id: 2, title: 'Two', excluded: false }]);
    const prompts: Record<number, string> = {};
    runReview.mockImplementation((_m: string, c: number, p: string) => {
      prompts[c] = p;
      return Promise.resolve({ ops: [] });
    });

    await request(app).post(`/api/books/${bookId}/script-review`).send({}).expect(200);

    expect(prompts[2] ?? '').not.toContain('Prior chapter'); // gate failed → no block
  });

  it('does NOT cascade past the immediately-preceding chapter (fs-64)', async () => {
    // ch1 ends A/B, ch2 ends on narration (gate fails). ch3 must NOT pick up ch1's
    // exchange — selection takes ch2 (immediate predecessor) and stops.
    writeBook([
      { id: 1, chapterId: 1, characterId: 'wren', text: '"Where to?"' },
      { id: 2, chapterId: 1, characterId: 'marlow', text: '"Somewhere safe."' },
      { id: 1, chapterId: 2, characterId: 'wren', text: '"Wait."' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'The door closed.' },
      { id: 1, chapterId: 3, characterId: 'wren', text: '"Still here."' },
    ], [
      { id: 1, title: 'One', excluded: false },
      { id: 2, title: 'Two', excluded: false },
      { id: 3, title: 'Three', excluded: false },
    ]);
    const prompts: Record<number, string> = {};
    runReview.mockImplementation((_m: string, c: number, p: string) => {
      prompts[c] = p;
      return Promise.resolve({ ops: [] });
    });

    await request(app).post(`/api/books/${bookId}/script-review`).send({}).expect(200);

    expect(prompts[2] ?? '').toContain('Prior chapter');       // ch1 ended A/B → ch2 gets it
    expect(prompts[3] ?? '').not.toContain('Prior chapter');   // ch2 ended narration → no cascade to ch1
  });
});

describe('buildReviewSentencesInput (fs-58)', () => {
  it('includes instruct only when present and vocalization only when true', () => {
    const out = buildReviewSentencesInput([
      { id: 1, characterId: 'narrator', text: 'Plain line.' },
      { id: 2, characterId: 'mira', text: 'Hhh… done.', instruct: 'a tired sigh', vocalization: true },
      { id: 3, characterId: 'mira', text: 'No instruct.', vocalization: false },
    ]);
    expect(out[0]).toEqual({ sentenceId: 1, characterId: 'narrator', text: 'Plain line.' });
    expect(out[1]).toEqual({
      sentenceId: 2, characterId: 'mira', text: 'Hhh… done.',
      instruct: 'a tired sigh', vocalization: true,
    });
    expect(out[2]).toEqual({ sentenceId: 3, characterId: 'mira', text: 'No instruct.' });
  });

  it('srv-59: appends the evidence annotation to text when present for that sentenceId', () => {
    const evidence = new Map([[2, '[structure: speech, tag→Антон]']]);
    const out = buildReviewSentencesInput(
      [
        { id: 1, characterId: 'narrator', text: 'Plain line.' },
        { id: 2, characterId: 'marina', text: 'Да' },
      ],
      evidence,
    );
    expect(out[0]).toEqual({ sentenceId: 1, characterId: 'narrator', text: 'Plain line.' });
    expect(out[1]).toEqual({
      sentenceId: 2, characterId: 'marina', text: 'Да [structure: speech, tag→Антон]',
    });
  });

  it('srv-59: no evidence arg / undefined lookup leaves text byte-identical', () => {
    const sentences = [{ id: 1, characterId: 'narrator', text: 'Plain line.' }];
    expect(buildReviewSentencesInput(sentences)).toEqual(buildReviewSentencesInput(sentences, new Map()));
    expect(buildReviewSentencesInput(sentences)).toEqual([
      { sentenceId: 1, characterId: 'narrator', text: 'Plain line.' },
    ]);
  });
});

describe('priorChapterBoundaryExchange (fs-64)', () => {
  const roster = [
    { id: 'wren', name: 'Wren' },
    { id: 'marlow', name: 'Marlow' },
  ];
  const s = (id: number, characterId: string, text: string, excludeFromSynthesis?: boolean) =>
    ({ id, characterId, text, ...(excludeFromSynthesis ? { excludeFromSynthesis } : {}) });

  it('returns both turns when the chapter ends on an A/B exchange', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'narrator', 'It was late.'), s(2, 'wren', '"Where to?"'), s(3, 'marlow', '"Somewhere safe."')],
      roster,
    );
    expect(out).toEqual({
      turns: [
        { speakerId: 'wren', speakerName: 'Wren', text: '"Where to?"' },
        { speakerId: 'marlow', speakerName: 'Marlow', text: '"Somewhere safe."' },
      ],
    });
  });

  it('returns null when the chapter ends on narration (single speaker in window)', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'wren', '"Hello?"'), s(2, 'narrator', 'No answer came.'), s(3, 'narrator', 'The hall was empty.')],
      roster,
    );
    expect(out).toBeNull();
  });

  it('returns null on a single-speaker monologue ending', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'wren', 'One.'), s(2, 'wren', 'Two.'), s(3, 'wren', 'Three.')],
      roster,
    );
    expect(out).toBeNull();
  });

  it('returns null when two speakers both folded to one id (unknown-male)', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'unknown-male', '"Run!"'), s(2, 'unknown-male', '"This way!"')],
      roster,
    );
    expect(out).toBeNull();
  });

  it('returns null when the exchange is beyond the lookback window', () => {
    const out = priorChapterBoundaryExchange(
      [
        s(1, 'wren', '"Where to?"'), s(2, 'marlow', '"Safe."'),
        s(3, 'narrator', 'a'), s(4, 'narrator', 'b'), s(5, 'narrator', 'c'),
        s(6, 'narrator', 'd'), s(7, 'narrator', 'e'), s(8, 'narrator', 'f'),
      ],
      roster,
    );
    expect(out).toBeNull();
  });

  it('filters excludeFromSynthesis residue out of the turns', () => {
    const out = priorChapterBoundaryExchange(
      [s(1, 'wren', '"Where to?"'), s(2, 'marlow', '"Safe."'), s(3, 'page-header', 'Chapter 4', true)],
      roster,
    );
    expect(out).toEqual({
      turns: [
        { speakerId: 'wren', speakerName: 'Wren', text: '"Where to?"' },
        { speakerId: 'marlow', speakerName: 'Marlow', text: '"Safe."' },
      ],
    });
  });

  it('truncates a long line to MAX_PRIOR_TURN_CHARS with an ellipsis', () => {
    const long = '"' + 'x'.repeat(400) + '"';
    const out = priorChapterBoundaryExchange([s(1, 'wren', 'short'), s(2, 'marlow', long)], roster);
    expect(out!.turns[1].text.length).toBeLessThanOrEqual(240);
    expect(out!.turns[1].text.endsWith('…')).toBe(true);
  });

  it('falls back to the id when a speaker is off-roster', () => {
    const out = priorChapterBoundaryExchange([s(1, 'wren', '"Hi."'), s(2, 'ghost', '"Boo."')], roster);
    expect(out!.turns[1]).toEqual({ speakerId: 'ghost', speakerName: 'ghost', text: '"Boo."' });
  });

  it('returns null for an empty chapter', () => {
    expect(priorChapterBoundaryExchange([], roster)).toBeNull();
  });
});

describe('buildScriptReviewChapterInbox (fs-64 priorExchange)', () => {
  const roster = [{ id: 'wren', name: 'Wren', role: 'protagonist' }];
  const sentences = [{ id: 1, characterId: 'narrator', text: 'Hi.' }] as unknown as Parameters<
    typeof buildScriptReviewChapterInbox
  >[2];

  it('is byte-identical to today when no priorExchange is given', () => {
    const expected = `---
manuscriptId: m1
task: script-review
chapterId: 2
---

## Cast roster (post-fold)

\`\`\`json
[
  {
    "id": "wren",
    "name": "Wren",
    "role": "protagonist"
  }
]
\`\`\`

## Sentences (already attributed)

\`\`\`json
[
  {
    "sentenceId": 1,
    "characterId": "narrator",
    "text": "Hi."
  }
]
\`\`\`
`;
    expect(buildScriptReviewChapterInbox('m1', 2, sentences, roster)).toBe(expected);
  });

  it('renders the labelled block above the sentences, with no sentenceId', () => {
    const out = buildScriptReviewChapterInbox('m1', 2, sentences, roster, {
      turns: [
        { speakerId: 'wren', speakerName: 'Wren', text: '"Where to?"' },
        { speakerId: 'marlow', speakerName: 'Marlow', text: '"Somewhere safe."' },
      ],
    });
    expect(out).toContain('Prior chapter');
    expect(out).toContain('do NOT emit an op');
    expect(out).toContain('Wren (id: wren): "Where to?"');
    expect(out).toContain('Marlow (id: marlow): "Somewhere safe."');
    // §4.6 read-only guard: the block region must surface NO sentenceId (so a
    // block-targeted op is unconstructible). Scan ONLY the block, not the whole
    // prompt — the legitimate sentence payload below DOES contain "sentenceId".
    const block = out.slice(out.indexOf('Prior chapter'), out.indexOf('## Sentences'));
    expect(block).not.toContain('sentenceId');
    expect(block).not.toMatch(/"id"\s*:\s*\d/); // no numeric id leaks into the block
    // block sits before the sentence list
    expect(out.indexOf('Prior chapter')).toBeLessThan(out.indexOf('## Sentences'));
  });
});

describe('buildScriptReviewChapterInbox (srv-59 structure evidence)', () => {
  const roster = [{ id: 'wren', name: 'Wren', role: 'protagonist' }];
  const sentences = [{ id: 1, characterId: 'narrator', text: 'Hi.' }] as unknown as Parameters<
    typeof buildScriptReviewChapterInbox
  >[2];

  it('(a) no evidence arg is byte-identical to an empty Map, and both equal the captured snapshot', () => {
    const expected = `---
manuscriptId: m1
task: script-review
chapterId: 2
---

## Cast roster (post-fold)

\`\`\`json
[
  {
    "id": "wren",
    "name": "Wren",
    "role": "protagonist"
  }
]
\`\`\`

## Sentences (already attributed)

\`\`\`json
[
  {
    "sentenceId": 1,
    "characterId": "narrator",
    "text": "Hi."
  }
]
\`\`\`
`;
    const noArg = buildScriptReviewChapterInbox('m1', 2, sentences, roster);
    const emptyMap = buildScriptReviewChapterInbox('m1', 2, sentences, roster, null, new Map());
    expect(noArg).toBe(expected);
    expect(emptyMap).toBe(expected);
  });

  it('(b) an evidence hit appends the annotation to only that sentence\'s text', () => {
    const twoSentences = [
      { id: 1, characterId: 'narrator', text: 'Hi.' },
      { id: 2, characterId: 'marina', text: 'Да' },
    ] as unknown as Parameters<typeof buildScriptReviewChapterInbox>[2];
    const evidence = new Map([[2, '[structure: speech, tag→Антон]']]);
    const out = buildScriptReviewChapterInbox('m1', 2, twoSentences, roster, null, evidence);
    expect(out).toContain('"text": "Hi."');
    expect(out).toContain('"text": "Да [structure: speech, tag→Антон]"');
  });

  it('(c) §4.6 cross-chapter guard: evidence keyed to ids NOT in this chunk leaves every text unchanged', () => {
    const foreignEvidence = new Map([[999, '[structure: narration]']]);
    const withForeign = buildScriptReviewChapterInbox('m1', 2, sentences, roster, null, foreignEvidence);
    const withoutEvidence = buildScriptReviewChapterInbox('m1', 2, sentences, roster);
    expect(withForeign).toBe(withoutEvidence);
  });
});

describe('priorChapterIdFor (fs-64)', () => {
  it('returns the nearest lower chapter id', () => {
    expect(priorChapterIdFor(3, [1, 2, 3, 4], new Set())).toBe(2);
  });
  it('skips excluded chapters', () => {
    expect(priorChapterIdFor(3, [1, 2, 3], new Set([2]))).toBe(1);
  });
  it('returns null for the first chapter (no lower id)', () => {
    expect(priorChapterIdFor(1, [1, 2, 3], new Set())).toBeNull();
  });
  it('returns null when every lower chapter is excluded', () => {
    expect(priorChapterIdFor(3, [1, 2, 3], new Set([1, 2]))).toBeNull();
  });
  it('handles non-contiguous ids', () => {
    expect(priorChapterIdFor(10, [2, 5, 10, 11], new Set())).toBe(5);
  });
});

describe('sticky job registry', () => {
  it('a second POST for the same chapter joins the running job and is replayed its ops', async () => {
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' },
    ]);
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    runReview.mockImplementation(async () => {
      await gate;
      return { ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] };
    });

    const first = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20)); // let the first request register the job

    // A joined SSE response only completes once the job finishes broadcasting
    // to every subscriber — so it must not be awaited before releaseFirst()
    // unblocks the gated analyzer call, or both requests deadlock waiting on
    // each other. Kick the join off, give it time to attach as a subscriber,
    // THEN release the gate and await both responses together.
    const second = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20)); // let the second request join as a subscriber

    releaseFirst?.();
    const [, secondRes] = await Promise.all([first.done, second.done]);

    expect(runReview).toHaveBeenCalledTimes(1); // joined the running job, didn't start a second analyzer call
    expect(secondRes.text).toContain('"kind":"ops"');
    expect(secondRes.text).toContain('strip_tag');
  });

  it('a whole-book POST while a single-chapter job is running for the same book is rejected with 409', async () => {
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
    ]);
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    runReview.mockImplementation(async () => { await gate; return { ops: [] }; });

    const first = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const conflict = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    expect(conflict.status).toBe(409);

    releaseFirst?.();
    await first.done;
  });

  it('res.on("close") removes only the disconnecting subscriber; the job keeps running and completes', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let resolveReview: ((v: { ops: unknown[] }) => void) | undefined;
    // Gate only the FIRST (aborted) request's analyzer call. Once the earlier
    // job has actually finished and cleaned itself out of the job map, the
    // reconnect below starts a genuinely new job with its own analyzer call —
    // that one resolves immediately so the reconnect assertion doesn't need
    // a second manual release.
    runReview.mockImplementationOnce(
      () => new Promise((resolve) => { resolveReview = resolve; }),
    );
    runReview.mockResolvedValue({ ops: [] });

    const { req, done } = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    done.catch(() => {}); // aborting rejects the promise; the test only cares about the server-side effect
    // Give the job time to actually register and reach the gated analyzer
    // call BEFORE aborting — an immediate abort() (no delay) can cancel the
    // request before the server even accepts the connection, so no job (and
    // no runReview call) is ever created, which isn't the "disconnect mid-run"
    // scenario this test means to exercise.
    await new Promise((r) => setTimeout(r, 20));
    req.abort(); // simulate client disconnect
    await new Promise((r) => setTimeout(r, 20));

    resolveReview?.({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });

    // A fresh connection should see the job either already finished or still
    // running to completion — never aborted by the earlier disconnect.
    await new Promise((r) => setTimeout(r, 50));
    const reconnect = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    expect(reconnect.status).toBe(200);
  });

  it('the requested model is threaded through to selectAnalyzerForPhase, not dropped by the detached job runner', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    runReview.mockResolvedValue({ ops: [] });
    await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1, model: 'gemini-3.5-flash' });
    expect(selectAnalyzerForPhaseMock).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'phase1', model: 'gemini-3.5-flash' }),
    );
  });

  it('regression (Bug 1): two different chapters of the same book run independently — the subset map is keyed by bookId:chapterId, not bare bookId', async () => {
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one line.' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'Chapter two line.' },
    ]);
    let releaseChapter1: (() => void) | undefined;
    const gate1 = new Promise<void>((resolve) => { releaseChapter1 = resolve; });
    runReview.mockImplementation(async (_m, chapterId): Promise<ScriptReviewOutput> => {
      if (chapterId === 1) {
        await gate1;
        return { ops: [{ id: 1, op: 'strip_tag', newText: 'Chapter one line', rationale: 'r' }] };
      }
      return { ops: [{ id: 2, op: 'strip_tag', newText: 'Chapter two line', rationale: 'r' }] };
    });

    // Start chapter 1's review — gated, not yet resolved.
    const chapter1 = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20)); // let it register into the map

    // Chapter 2 of the SAME book must NOT be treated as a conflict — before the
    // fix, the bare-bookId subset map would have (incorrectly) let this request
    // fall through to "no existing job for this scope" and then clobber chapter
    // 1's map entry on write, since both would key on the same bare bookId.
    const chapter2Res = await request(app)
      .post(`/api/books/${bookId}/script-review`)
      .send({ chapterId: 2 });
    expect(chapter2Res.status).toBe(200);
    const chapter2Events = parseSse(chapter2Res.text);
    expect(chapter2Events.some((e) => e.kind === 'ops' && e.chapterId === 2)).toBe(true);

    // Chapter 1's job must still be reachable — a third request for chapter 1
    // joins the still-running job rather than starting a brand-new (duplicate)
    // one. If Bug 1 were present, chapter 1's map entry would have been
    // orphaned by chapter 2's registration and this would start a SECOND
    // analyzer call for chapter 1 instead of joining.
    const rejoin = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    releaseChapter1?.();
    const [, rejoinRes] = await Promise.all([chapter1.done, rejoin.done]);

    // Exactly one analyzer call for chapter 1 (the original), one for chapter 2.
    const chapter1Calls = runReview.mock.calls.filter((c) => c[1] === 1);
    const chapter2Calls = runReview.mock.calls.filter((c) => c[1] === 2);
    expect(chapter1Calls).toHaveLength(1);
    expect(chapter2Calls).toHaveLength(1);

    // The rejoined response replays chapter 1's ops (from the ONE shared job).
    expect(rejoinRes.text).toContain('"kind":"ops"');
    expect(rejoinRes.text).toContain('Chapter one line');
  });

  it('regression (Bug 2): two near-simultaneous requests for the identical scope produce exactly one analyzer call, and both responses reflect the same job', async () => {
    // This pins the OBSERVABLE correctness property, not the zero-width race
    // window itself — the fix makes the conflict/join check and the new job's
    // registration happen in one synchronous block with no `await` between
    // them, so the window a black-box HTTP test could exploit to force two
    // concurrent registrations no longer exists (Node can't interleave a
    // second request's handler mid-synchronous-block). A raw fire-both-at-once
    // test is therefore structurally equivalent to the "second POST joins the
    // running job" test above; this test names the race explicitly so the
    // regression intent is documented even though it can't observe the race
    // window directly.
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runReview.mockImplementation(async (): Promise<ScriptReviewOutput> => {
      await gate;
      return { ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] };
    });

    // Fire both requests back-to-back with no await between the two firePost
    // calls, as close to simultaneous as this test harness allows.
    const first = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    const second = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    release?.();
    const [firstRes, secondRes] = await Promise.all([first.done, second.done]);

    // Exactly one analyzer call — one of the two requests always registers
    // the job and the other always joins it, never both registering.
    expect(runReview).toHaveBeenCalledTimes(1);
    // Both responses reflect the same single job's ops.
    expect(firstRes.text).toContain('"kind":"ops"');
    expect(secondRes.text).toContain('"kind":"ops"');
    expect(firstRes.text).toContain('strip_tag');
    expect(secondRes.text).toContain('strip_tag');
  });
});

describe('cancellation (fs-58 follow-up #1481)', () => {
  it('cancel aborts a running whole-book job, sends a cancelled terminal event, and skips the in-flight chapter\'s checkpoint', async () => {
    const { readLedger } = await import('../workspace/script-review-ledger.js');
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
    ]);
    let releaseChapter1: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementationOnce(
      () => new Promise<ScriptReviewOutput>((resolve) => { releaseChapter1 = resolve; }),
    );
    runReview.mockResolvedValue({ ops: [] });

    const { done } = firePost(`/api/books/${bookId}/script-review`, {});
    done.catch(() => {});
    await new Promise((r) => setTimeout(r, 20)); // let chapter 1's job register and reach the gated analyzer call

    const cancelRes = await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body).toEqual({ ok: true, cancelled: true });

    releaseChapter1?.({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });
    const res = await done;

    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'error' && e.code === 'cancelled')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
    expect(events.some((e) => e.kind === 'checkpoint')).toBe(false);
    // The intra-chapter progress-creep `phase` event (chapter 1's single
    // chunk resolves AFTER the cancel above) must not be emitted once the
    // job is aborted — it's distinguishable from the per-chapter "waiting"
    // phase by carrying `progress` + `chapterId` but no `activityState`
    // (only the chapter-start phase sets that). Guards
    // server/src/routes/script-review.ts:758.
    expect(
      events.some((e) => e.kind === 'phase' && e.progress !== undefined && 'chapterId' in e && !('activityState' in e)),
    ).toBe(false);

    const ledger = await readLedger(bookDir(), manuscriptId);
    expect(ledger.entries['1']).toBeUndefined();
  });

  it('cancel is idempotent — no job running for the book returns cancelled:false', async () => {
    const res = await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, cancelled: false });
  });

  it('cancel aborts every running subset job for a book independently of a main job', async () => {
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one.' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'Chapter two.' },
    ]);
    let releaseCh1: ((v: ScriptReviewOutput) => void) | undefined;
    let releaseCh2: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementation(async (_m, chapterId): Promise<ScriptReviewOutput> => {
      if (chapterId === 1) return new Promise((resolve) => { releaseCh1 = resolve; });
      return new Promise((resolve) => { releaseCh2 = resolve; });
    });

    const ch1 = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    ch1.done.catch(() => {});
    const ch2 = firePost(`/api/books/${bookId}/script-review`, { chapterId: 2 });
    ch2.done.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    const cancelRes = await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
    expect(cancelRes.body).toEqual({ ok: true, cancelled: true });

    releaseCh1?.({ ops: [] });
    releaseCh2?.({ ops: [] });
    const [res1, res2] = await Promise.all([ch1.done, ch2.done]);

    expect(parseSse(res1.text).some((e) => e.kind === 'error' && e.code === 'cancelled')).toBe(true);
    expect(parseSse(res2.text).some((e) => e.kind === 'error' && e.code === 'cancelled')).toBe(true);
  });

  it('a chapter fully completed before the cancel is still checkpointed and kept', async () => {
    const { readLedger } = await import('../workspace/script-review-ledger.js');
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Chapter one.' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'Chapter two.' },
    ]);
    let releaseChapter2: ((v: ScriptReviewOutput) => void) | undefined;
    runReview
      .mockResolvedValueOnce({ ops: [{ id: 1, op: 'strip_tag', newText: 'Chapter one fixed', rationale: 'r' }] })
      .mockImplementationOnce(
        () => new Promise<ScriptReviewOutput>((resolve) => { releaseChapter2 = resolve; }),
      );

    const { done } = firePost(`/api/books/${bookId}/script-review`, {});
    done.catch(() => {});
    await new Promise((r) => setTimeout(r, 20)); // let chapter 1 finish and chapter 2's gated call start

    await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
    releaseChapter2?.({ ops: [] });
    await done;

    const ledger = await readLedger(bookDir(), manuscriptId);
    expect(ledger.entries['1'].ops).toHaveLength(1); // chapter 1 (finished before cancel) survives
    expect(ledger.entries['2']).toBeUndefined(); // chapter 2 (in flight at cancel) does not
  });

  /* Regression for the code-review-workflow finding: cancel used to only
     abort the job's controller, never removing it from the registry maps
     — that only happened later, asynchronously, once the in-flight
     analyzer call actually rejected from the abort (which can take a
     real amount of time for a genuine LLM call). In that window, a
     same-scope retry would find the doomed job still registered and JOIN
     it instead of starting fresh, silently defeating the
     cancel-then-restart-immediately UX this route exists for. */
  it('cancel immediately removes the job from the registry, so a same-scope retry starts fresh instead of joining the doomed job', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let releaseFirst: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementationOnce(
      () => new Promise<ScriptReviewOutput>((resolve) => { releaseFirst = resolve; }),
    );
    runReview.mockResolvedValue({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });

    const { done: firstDone } = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    firstDone.catch(() => {});
    await new Promise((r) => setTimeout(r, 20)); // let the first job register and reach the gated call

    const cancelRes = await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});
    expect(cancelRes.body).toEqual({ ok: true, cancelled: true });

    // Retry the SAME scope immediately — WITHOUT waiting for the first
    // (still-gated, not-yet-actually-rejected) job to settle. This is the
    // exact race the finding describes.
    const second = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    // A genuinely new analyzer call was made — the second request did NOT
    // join the doomed first job.
    expect(runReview).toHaveBeenCalledTimes(2);

    releaseFirst?.({ ops: [] });
    const secondRes = await second.done;
    expect(secondRes.status).toBe(200);
    expect(secondRes.text).toContain('"kind":"ops"');
    expect(secondRes.text).not.toContain('"code":"cancelled"');
  });

  it('cancel immediately clears the conflict lock, so a cross-scope retry does not 409 against the doomed job', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let releaseFirst: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementationOnce(
      () => new Promise<ScriptReviewOutput>((resolve) => { releaseFirst = resolve; }),
    );
    runReview.mockResolvedValue({ ops: [] });

    const { done: wholeBookDone } = firePost(`/api/books/${bookId}/script-review`, {});
    wholeBookDone.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});

    const chapterRes = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    expect(chapterRes.status).toBe(200); // not 409 — the cancelled whole-book job no longer holds the lock

    releaseFirst?.({ ops: [] });
    await wholeBookDone;
  });

  it('cancel immediately clears the job from GET /state instead of still reporting it as running', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let releaseFirst: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementationOnce(
      () => new Promise<ScriptReviewOutput>((resolve) => { releaseFirst = resolve; }),
    );

    const { done } = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    done.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));

    await request(app).post(`/api/books/${bookId}/script-review/cancel`).send({});

    const state = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(state.body.kind).toBe('ledger');

    releaseFirst?.({ ops: [] });
    await done;
  });
});

describe('reattach-only endpoint (fs-58 follow-up #1481)', () => {
  it('attach joins a live job and replays its buffered events, without starting a second analyzer call', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let release: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementation(async () => new Promise<ScriptReviewOutput>((resolve) => { release = resolve; }));

    const first = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const attach = firePost(`/api/books/${bookId}/script-review/attach`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    release?.({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });
    const [, attachRes] = await Promise.all([first.done, attach.done]);

    expect(runReview).toHaveBeenCalledTimes(1); // attach joined, did not start a second analyzer call
    expect(attachRes.text).toContain('"kind":"ops"');
    expect(attachRes.text).toContain('strip_tag');
  });

  it('attach 404s when no job matches the requested chapter, and leaves the actually-running chapter untouched', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    runReview.mockResolvedValue({ ops: [] });
    const running = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const res = await request(app).post(`/api/books/${bookId}/script-review/attach`).send({ chapterId: 2 });
    expect(res.status).toBe(404);

    await running.done;
  });

  it('attach 404s when no job is running at all for the book', async () => {
    const res = await request(app).post(`/api/books/${bookId}/script-review/attach`).send({});
    expect(res.status).toBe(404);
  });

  it('attach to a whole-book job (no chapterId) joins it and replays events', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let release: ((v: ScriptReviewOutput) => void) | undefined;
    runReview.mockImplementation(async () => new Promise<ScriptReviewOutput>((resolve) => { release = resolve; }));

    const first = firePost(`/api/books/${bookId}/script-review`, {});
    await new Promise((r) => setTimeout(r, 20));

    const attach = firePost(`/api/books/${bookId}/script-review/attach`, {});
    await new Promise((r) => setTimeout(r, 20));

    release?.({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });
    const [, attachRes] = await Promise.all([first.done, attach.done]);

    expect(attachRes.text).toContain('"kind":"ops"');
  });
});

describe('ledger checkpointing', () => {
  it('checkpoints a chapter to the ledger as soon as it completes, even with zero subscribers attached', async () => {
    const { readLedger } = await import('../workspace/script-review-ledger.js');
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
    ]);
    let resolveChapter2: (() => void) | undefined;
    runReview
      .mockResolvedValueOnce({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] })
      .mockImplementationOnce(() => new Promise<{ ops: unknown[] }>((resolve) => {
        resolveChapter2 = () => resolve({ ops: [] });
      }));

    // Use firePost (not a bare `request(app)...send()`) so `.end()` actually
    // dispatches the request — per the established pattern/comment above (see
    // the "res.on('close')" sticky-registry test), an unawaited/undispatched
    // supertest Request has no underlying `req` yet, so `.abort()` on it is a
    // silent no-op and the server never even sees the POST.
    const { req, done } = firePost(`/api/books/${bookId}/script-review`, {});
    done.catch(() => {}); // aborting rejects the promise; only the server-side effect matters here
    await new Promise((r) => setTimeout(r, 20)); // let chapter 1 finish and chapter 2 start before disconnecting
    req.abort(); // disconnect before chapter 2 resolves — job keeps running
    await new Promise((r) => setTimeout(r, 30));

    const ledgerMidRun = await readLedger(bookDir(), manuscriptId);
    expect(ledgerMidRun.entries['1'].ops).toHaveLength(1);
    expect(ledgerMidRun.entries['1'].manuscriptId).toBe(manuscriptId);

    resolveChapter2?.();
    await new Promise((r) => setTimeout(r, 30));
    const ledgerAfter = await readLedger(bookDir(), manuscriptId);
    // Chapter 2 produced zero ops, so no entry is created for it.
    expect(ledgerAfter.entries['2']).toBeUndefined();
  });

  it('broadcasts a checkpoint event carrying the minted version once a chapter is upserted', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    runReview.mockResolvedValue({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
    expect(res.text).toContain('"kind":"checkpoint"');
    expect(res.text).toMatch(/"chapterId":1,"version":\d+/);
  });

  it('a checkpoint write failure for one chapter reports chapter-failed and lets the rest of the run finish', async () => {
    writeBook([
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' },
      { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
    ]);
    runReview.mockImplementation((_m, chapterId): Promise<ScriptReviewOutput> => {
      if (chapterId === 1) return Promise.resolve({ ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }] });
      return Promise.resolve({ ops: [{ id: 2, op: 'strip_tag', newText: 'World', rationale: 'r' }] });
    });

    // Not module-mocked (Task 3's other checkpointing tests need the real
    // ledger reads/writes) — spy on the live namespace object so only this
    // one call throws; vi.spyOn on a dynamically-imported ESM namespace
    // works here because the route imports `upsertChapterEntry` as a named
    // (live) binding, same pattern as generation.test.ts's configModule/
    // aggregateModule spies.
    const ledgerModule = await import('../workspace/script-review-ledger.js');
    const spy = vi.spyOn(ledgerModule, 'upsertChapterEntry').mockRejectedValueOnce(new Error('disk full'));

    try {
      const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
      const events = parseSse(res.text);

      // (a) chapter 1's checkpoint write failed -> chapter-failed reported, no checkpoint for it.
      const chapter1Failed = events.find((e) => e.kind === 'chapter-failed' && e.chapterId === 1);
      expect(chapter1Failed).toMatchObject({ message: expect.stringContaining('disk full') });
      expect(events.some((e) => e.kind === 'checkpoint' && e.chapterId === 1)).toBe(false);

      // (b) the job kept going — chapter 2 was still reviewed and checkpointed normally.
      expect(events.some((e) => e.kind === 'ops' && e.chapterId === 2)).toBe(true);
      expect(events.some((e) => e.kind === 'checkpoint' && e.chapterId === 2)).toBe(true);

      // (c) the stream still closes cleanly with a final result event, not hung.
      expect(events.find((e) => e.kind === 'result')).toMatchObject({ done: true, reviewedChapters: 2 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GET /:bookId/script-review/state', () => {
  it('returns kind:"ledger" with existing entries when no job is running', async () => {
    const { upsertChapterEntry } = await import('../workspace/script-review-ledger.js');
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    await upsertChapterEntry(bookDir(), bookId, {
      chapterId: 1,
      manuscriptId,
      ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }],
    });
    const res = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('ledger');
    expect(res.body.entries['1'].ops).toHaveLength(1);
  });

  it('returns kind:"running" with the replay buffer while a job is in flight', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let resolveReview: ((v: { ops: unknown[] }) => void) | undefined;
    runReview.mockImplementation(() => new Promise((resolve) => { resolveReview = resolve; }));

    // Use firePost, not a bare `request(app).post(...).send(...)` — per the
    // established pattern documented above (see the "res.on('close')"
    // sticky-registry test), an unawaited/undispatched supertest Request
    // never actually sends until awaited/.end()'d, so the job would not yet
    // be registered when the GET below fires.
    const { done } = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const res = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(res.body.kind).toBe('running');
    // Finding 6 (PR review round 4): `running` is now an ARRAY of running
    // jobs (two different chapters can legitimately run concurrently for
    // the same book) rather than a single {chapterId, replay} pair.
    expect(res.body.running).toHaveLength(1);
    expect(res.body.running[0].chapterId).toBe(1);

    resolveReview?.({ ops: [] });
    await done;
  });

  it('replay.lastPhase carries model/engine/activityState so a reattaching client learns them immediately', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    let resolveReview: ((v: { ops: unknown[] }) => void) | undefined;
    runReview.mockImplementation(() => new Promise((resolve) => { resolveReview = resolve; }));

    const { done } = firePost(`/api/books/${bookId}/script-review`, { chapterId: 1 });
    await new Promise((r) => setTimeout(r, 20));

    const res = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(res.body.kind).toBe('running');
    expect(res.body.running[0].replay.lastPhase).toMatchObject({
      activityState: 'waiting',
      model: expect.any(String),
      engine: expect.stringMatching(/local|gemini/),
    });

    resolveReview?.({ ops: [] });
    await done;
  });

  it('returns kind:"ledger" with empty entries for a book with neither a job nor pending findings', async () => {
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    const res = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(res.body).toEqual({ kind: 'ledger', entries: {} });
  });

  /* Round-3 review Critical Finding 2 — subsetScriptReviewJobByChapter allows
     two DIFFERENT chapters' single-chapter jobs to run concurrently for the
     same book. The `running` branch used to short-circuit before the ledger
     read ever ran, so a job running for chapter 7 completely hid chapter 3's
     already-persisted, unresolved ledger entry from any client hydrating
     while chapter 7's job was in flight. The fix reads the ledger
     unconditionally and includes it alongside a running job's own replay. */
  it('includes ledger entries for OTHER chapters alongside kind:"running" when a job is running for a different chapter', async () => {
    const { upsertChapterEntry } = await import('../workspace/script-review-ledger.js');
    writeBook([
      { id: 1, chapterId: 3, characterId: 'narrator', text: 'Chapter three line.' },
      { id: 2, chapterId: 7, characterId: 'narrator', text: 'Chapter seven line.' },
    ]);
    // Chapter 3 already has a persisted, unresolved finding from an earlier run.
    await upsertChapterEntry(bookDir(), bookId, {
      chapterId: 3,
      manuscriptId,
      ops: [{ id: 1, op: 'strip_tag', newText: 'Chapter three line', rationale: 'r' }],
    });

    let resolveReview: ((v: { ops: unknown[] }) => void) | undefined;
    runReview.mockImplementation(() => new Promise((resolve) => { resolveReview = resolve; }));

    // Start a job for chapter 7 — a DIFFERENT chapter than the one with the
    // persisted ledger entry.
    const { done } = firePost(`/api/books/${bookId}/script-review`, { chapterId: 7 });
    await new Promise((r) => setTimeout(r, 20));

    const res = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(res.body.kind).toBe('running');
    expect(res.body.running).toHaveLength(1);
    expect(res.body.running[0].chapterId).toBe(7);
    // Chapter 3's persisted finding must still be visible, not hidden by
    // chapter 7's in-flight job.
    expect(res.body.entries['3']).toBeDefined();
    expect(res.body.entries['3'].ops).toHaveLength(1);

    resolveReview?.({ ops: [] });
    await done;
  });

  /* Round-4 review Finding 6 — two different chapters' single-chapter
     reviews can legitimately run concurrently for the same book
     (subsetScriptReviewJobByChapter is keyed by bookId:chapterId — see the
     "sticky job registry" Bug-1 regression test above). GET /state used to
     report only the FIRST match (mainScriptReviewJobByBook.get(bookId) ??
     findSubsetJobForBook(bookId)), so a client reloading while two jobs were
     running only ever attached to one of them, missing the other job's live
     progress/error visibility entirely (a visibility gap, not data loss —
     the other job still completes and checkpoints correctly regardless).
     Report every currently-running job for the book. */
  it('reports BOTH running jobs when two different chapters are concurrently running for the same book', async () => {
    writeBook([
      { id: 1, chapterId: 5, characterId: 'narrator', text: 'Chapter five line.' },
      { id: 2, chapterId: 8, characterId: 'narrator', text: 'Chapter eight line.' },
    ]);
    let resolveChapter5: ((v: { ops: unknown[] }) => void) | undefined;
    let resolveChapter8: ((v: { ops: unknown[] }) => void) | undefined;
    runReview.mockImplementation((_m, chapterId): Promise<{ ops: unknown[] }> => {
      if (chapterId === 5) return new Promise((resolve) => { resolveChapter5 = resolve; });
      return new Promise((resolve) => { resolveChapter8 = resolve; });
    });

    const first = firePost(`/api/books/${bookId}/script-review`, { chapterId: 5 });
    await new Promise((r) => setTimeout(r, 20));
    const second = firePost(`/api/books/${bookId}/script-review`, { chapterId: 8 });
    await new Promise((r) => setTimeout(r, 20));

    const res = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(res.body.kind).toBe('running');
    expect(res.body.running).toHaveLength(2);
    const chapterIds = res.body.running.map((r: { chapterId: number }) => r.chapterId).sort();
    expect(chapterIds).toEqual([5, 8]);

    resolveChapter5?.({ ops: [] });
    resolveChapter8?.({ ops: [] });
    await Promise.all([first.done, second.done]);
  });
});

describe('mutation endpoints', () => {
  async function seedEntry() {
    const { upsertChapterEntry } = await import('../workspace/script-review-ledger.js');
    writeBook([{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello,' }]);
    return upsertChapterEntry(bookDir(), bookId, {
      chapterId: 1,
      manuscriptId,
      ops: [{ id: 1, op: 'strip_tag', newText: 'Hello', rationale: 'r' }],
    });
  }

  it('POST /discard removes the named chapters entirely', async () => {
    await seedEntry();
    const res = await request(app)
      .post(`/api/books/${bookId}/script-review/discard`)
      .send({ chapterIds: [1] });
    expect(res.status).toBe(200);
    const state = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(state.body.entries['1']).toBeUndefined();
  });

  it('POST /resolve removes only the named op keys and no-ops on a stale version', async () => {
    const entry = await seedEntry();
    const stale = await request(app)
      .post(`/api/books/${bookId}/script-review/resolve`)
      .send({ chapterId: 1, version: entry.version + 1, appliedOpKeys: ['1:1:strip_tag'] });
    expect(stale.body.ok).toBe(false);

    const ok = await request(app)
      .post(`/api/books/${bookId}/script-review/resolve`)
      .send({ chapterId: 1, version: entry.version, appliedOpKeys: ['1:1:strip_tag'] });
    expect(ok.body.ok).toBe(true);
    const state = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(state.body.entries['1']).toBeUndefined(); // was the only op — entry deleted
  });

  it('PATCH /selection merges overrides and no-ops on a stale version', async () => {
    const entry = await seedEntry();
    const res = await request(app)
      .patch(`/api/books/${bookId}/script-review/selection`)
      .send({ chapterId: 1, version: entry.version, selected: { '1:1:strip_tag': false } });
    expect(res.body.ok).toBe(true);
    const state = await request(app).get(`/api/books/${bookId}/script-review/state`);
    expect(state.body.entries['1'].selected).toEqual({ '1:1:strip_tag': false });
  });

  it('PATCH /selection rejects null selected payload with 400', async () => {
    const entry = await seedEntry();
    const res = await request(app)
      .patch(`/api/books/${bookId}/script-review/selection`)
      .send({ chapterId: 1, version: entry.version, selected: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('chapterId, version, and selected are required.');
  });
});
