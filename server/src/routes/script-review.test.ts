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
import type { buildReviewSentencesInput as BuildReviewSentencesInput } from './script-review.js';

const AUTHOR = 'Test Author';
const SERIES = 'Test Series';
const BOOK = 'Test Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let manuscriptId: string;
let buildReviewSentencesInput: typeof BuildReviewSentencesInput;

/* The fake analyzer's runScriptReviewChapter — each test swaps its implementation.
   `selectedEngine` lets a test flip the reported engine to 'local' (so the
   chunker derives a finite, num_ctx-bound budget and a large chapter splits);
   it defaults to 'gemini' so the existing single-call tests are unchanged. */
const { runReview, engineState } = vi.hoisted(() => ({
  runReview: vi.fn(),
  engineState: { engine: 'gemini' as 'gemini' | 'local' },
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
  };
  return {
    ...actual,
    selectAnalyzerForPhase: () => ({
      analyzer: fakeAnalyzer,
      engine: engineState.engine,
      model: 'test-model',
      fallbackModel: null,
    }),
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
  const [{ scriptReviewRouter, buildReviewSentencesInput: build }, { makeBookId }] =
    await Promise.all([import('./script-review.js'), import('../workspace/paths.js')]);
  buildReviewSentencesInput = build;
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
});
