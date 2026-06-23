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

const AUTHOR = 'Test Author';
const SERIES = 'Test Series';
const BOOK = 'Test Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let manuscriptId: string;

/* The fake analyzer's runScriptReviewChapter — each test swaps its implementation. */
const { runReview } = vi.hoisted(() => ({ runReview: vi.fn() }));

vi.mock('../analyzer/select-analyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/select-analyzer.js')>();
  const fakeAnalyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.reject(new Error('not used')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: (m, c, p, call) => runReview(m, c, p, call),
  };
  return {
    ...actual,
    selectAnalyzerForPhase: () => ({
      analyzer: fakeAnalyzer,
      engine: 'gemini' as const,
      model: 'test-model',
      fallbackModel: null,
    }),
  };
});

function bookDir(): string {
  return join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
}

function writeBook(sentences: unknown[] | null): void {
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
      chapters: [],
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
  const [{ scriptReviewRouter }, { makeBookId }] = await Promise.all([
    import('./script-review.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  manuscriptId = `m_${bookId}`;
  app = express();
  app.use(express.json());
  app.use('/api/books', scriptReviewRouter);
});

beforeEach(() => {
  runReview.mockReset();
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

    const opsEvents = events.filter((e) => e.kind === 'ops');
    expect(opsEvents).toHaveLength(2);
    expect(opsEvents[0]).toMatchObject({ kind: 'ops', chapterId: 1, ops: CANNED_OPS.ops });
    expect(opsEvents[1]).toMatchObject({ kind: 'ops', chapterId: 2, ops: [] });

    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ done: true, reviewedChapters: 2 });
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
      return Promise.resolve({ ops: [] });
    });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'chapter-failed' && e.chapterId === 1)).toBe(true);
    expect(events.some((e) => e.kind === 'ops' && e.chapterId === 2)).toBe(true);
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ reviewedChapters: 1 });
  });

  it('emits chapter-failed for an oversized chapter and continues to the next', async () => {
    // Build a chapter whose serialised prompt exceeds DEFAULT_STAGE2_CHUNK_CHAR_BUDGET (9000).
    // buildScriptReviewChapterInbox produces a ~150-char header + JSON-stringified sentences.
    // Each sentence object serialises to ~{"sentenceId":N,"characterId":"narrator","text":"..."}.
    // 12 sentences × ~800-char text each ≈ 9600 chars of sentence JSON alone — comfortably over
    // the 9000-char budget even before the header/roster are added.
    const longText = 'A'.repeat(800);
    const bigChapterSentences = Array.from({ length: 12 }, (_, i) => ({
      id: 100 + i,
      chapterId: 10,
      characterId: 'narrator',
      text: longText,
    }));
    const normalSentence = { id: 200, chapterId: 11, characterId: 'wren', text: 'Short line.' };
    writeBook([...bigChapterSentences, normalSentence]);
    runReview.mockResolvedValue({ ops: [] });

    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    // (a) Oversized chapter emits chapter-failed with a message about being too large.
    const failedEvent = events.find((e) => e.kind === 'chapter-failed' && e.chapterId === 10);
    expect(failedEvent).toBeDefined();
    expect(typeof failedEvent!.message).toBe('string');
    expect((failedEvent!.message as string).toLowerCase()).toContain('too large');

    // (b) The normal chapter still produces an ops event — the overflow `continue` did not abort.
    expect(events.some((e) => e.kind === 'ops' && e.chapterId === 11)).toBe(true);

    // (c) A final result event arrives.
    expect(events.some((e) => e.kind === 'result')).toBe(true);
  });
});
