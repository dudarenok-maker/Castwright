/* fs-57 — integration tests for the instruct-annotation route
   POST /api/books/:bookId/instruct-annotation.

   The analyzer is faked via vi.mock('../analyzer/select-analyzer.js') so no
   real LLM is hit. The route is the contract under test: it streams per-chapter
   `annotation` events with {sentenceId, text?, instruct?, vocalization?}, NEVER
   returns characterId (re-attribution is out of scope), guards an unattributed
   book with a `no_attribution` error, and on mid-pass DailyQuotaExhaustedError
   emits a `quota_exhausted` error after the chapters it already streamed. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Analyzer } from '../analyzer/index.js';
import type { Stage3ChapterOutput } from '../handoff/schemas.js';

const AUTHOR = 'Test Author';
const SERIES = 'Test Series';
const BOOK = 'Test Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let manuscriptId: string;

/* The fake analyzer's runStage3Chapter — each test swaps its implementation.
   `engineState` lets a test flip the reported engine to 'local' so the chunker
   derives a finite, num_ctx-bound budget and a large chapter splits. */
const { runStage3, engineState: instructEngineState } = vi.hoisted(() => ({
  runStage3: vi.fn(),
  engineState: { engine: 'gemini' as 'gemini' | 'local' },
}));

vi.mock('../analyzer/select-analyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/select-analyzer.js')>();
  const fakeAnalyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.reject(new Error('not used')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: (m, c, p, call) => runStage3(m, c, p, call),
  };
  return {
    ...actual,
    selectAnalyzerForPhase: () => ({
      analyzer: fakeAnalyzer,
      engine: instructEngineState.engine,
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
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [] }));
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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-instruct-annotation-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ instructAnnotationRouter }, { makeBookId }] = await Promise.all([
    import('./instruct-annotation.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  manuscriptId = `m_${bookId}`;
  app = express();
  app.use(express.json());
  app.use('/api/books', instructAnnotationRouter);
});

beforeEach(() => {
  runStage3.mockReset();
  instructEngineState.engine = 'gemini';
  delete process.env.ANALYZER_NUM_CTX;
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/books/:bookId/instruct-annotation', () => {
  it('streams per-chapter annotation events with Stage-3 fields and a final result', async () => {
    writeBook(SENTENCES);
    runStage3.mockImplementation((_m, chapterId): Promise<Stage3ChapterOutput> => {
      if (chapterId === 1)
        return Promise.resolve({
          annotations: [{ sentenceId: 2, instruct: 'urgent, sharp', vocalization: false }],
        });
      return Promise.resolve({
        annotations: [{ sentenceId: 3, text: '[whispers]', instruct: 'whisper softly', vocalization: true }],
      });
    });

    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    const annotations = events.filter((e) => e.kind === 'annotation');
    expect(annotations).toEqual([
      {
        kind: 'annotation',
        chapterId: 1,
        annotations: [{ sentenceId: 2, instruct: 'urgent, sharp', vocalization: false }],
      },
      {
        kind: 'annotation',
        chapterId: 2,
        annotations: [{ sentenceId: 3, text: '[whispers]', instruct: 'whisper softly', vocalization: true }],
      },
    ]);

    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ done: true, annotatedChapters: 2, totalAnnotations: 2 });
  });

  it('sends the already-attributed sentences in the prompt and never asks for re-attribution', async () => {
    writeBook(SENTENCES);
    runStage3.mockResolvedValue({ annotations: [] });

    await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});

    // Chapter 1 call should carry both ch-1 sentences in the prompt.
    const ch1Call = runStage3.mock.calls.find((c) => c[1] === 1);
    expect(ch1Call).toBeTruthy();
    const prompt = ch1Call![2] as string;
    expect(prompt).toContain('"sentenceId": 1');
    expect(prompt).toContain('"sentenceId": 2');
    expect(prompt).toContain('"characterId": "wren"');
    // The output contract carries no characterId — re-attribution is impossible.
    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    for (const e of parseSse(res.text).filter((e) => e.kind === 'annotation')) {
      for (const a of e.annotations as Array<Record<string, unknown>>) {
        expect(a).not.toHaveProperty('characterId');
      }
    }
  });

  it('emits a no_attribution error when the book has no attributed sentences', async () => {
    writeBook(null); // no manuscript-edits.json, no cache
    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'error' && e.code === 'no_attribution')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
    expect(runStage3).not.toHaveBeenCalled();
  });

  it('404s for an unknown book', async () => {
    const res = await request(app).post(`/api/books/does-not-exist/instruct-annotation`).send({});
    expect(res.status).toBe(404);
  });

  it('skips chapters the user excluded from narration', async () => {
    writeBook(SENTENCES, [
      { id: 1, title: 'One', slug: 'one' },
      { id: 2, title: 'Two', slug: 'two', excluded: true },
    ]);
    runStage3.mockImplementation((_m, chapterId): Promise<Stage3ChapterOutput> =>
      Promise.resolve({
        annotations:
          chapterId === 1
            ? [{ sentenceId: 2, instruct: 'sharp' }]
            : [{ sentenceId: 3, vocalization: true }],
      }),
    );

    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    expect(res.status).toBe(200);

    // The analyzer is only called for the included chapter, never the excluded one.
    const calledChapters = runStage3.mock.calls.map((c) => c[1]);
    expect(calledChapters).toContain(1);
    expect(calledChapters).not.toContain(2);

    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(true);
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 2)).toBe(false);
  });

  it('on mid-pass daily-quota exhaustion, keeps already-streamed chapters and stops with quota_exhausted', async () => {
    writeBook(SENTENCES);
    const { DailyQuotaExhaustedError } = await import('../analyzer/rate-limit.js');
    runStage3.mockImplementation((_m, chapterId): Promise<Stage3ChapterOutput> => {
      if (chapterId === 1) return Promise.resolve({ annotations: [{ sentenceId: 2, instruct: 'urgent' }] });
      return Promise.reject(new DailyQuotaExhaustedError('test-model', new Date('2099-01-01')));
    });

    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    const events = parseSse(res.text);

    // Chapter 1 annotation survived.
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(true);
    // Quota error reported; no success result.
    expect(events.some((e) => e.kind === 'error' && e.code === 'quota_exhausted')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
  });

  it('a single chapter failure does not abort the rest of the pass', async () => {
    writeBook(SENTENCES);
    runStage3.mockImplementation((_m, chapterId): Promise<Stage3ChapterOutput> => {
      if (chapterId === 1) return Promise.reject(new Error('flaky chapter'));
      return Promise.resolve({ annotations: [{ sentenceId: 3, vocalization: true }] });
    });

    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'chapter-failed' && e.chapterId === 1)).toBe(true);
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 2)).toBe(true);
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ annotatedChapters: 1 });
  });

  it('chunks a large chapter across calls and emits each sentence annotation exactly once', async () => {
    // Force local engine + small num_ctx → chapterChunkBudget derives a finite budget
    // that splits a large chapter into ≥2 chunks (gemini's MAX_SAFE_INTEGER never splits).
    instructEngineState.engine = 'local';
    process.env.ANALYZER_NUM_CTX = '400'; // → budget Math.max(2000, min(24000, 560)) = 2000

    // ~800-char sentences: 2 per chunk under the 2000-char budget.
    const longText = 'B'.repeat(800);
    const chapterSentences = Array.from({ length: 12 }, (_, i) => ({
      id: 300 + i,
      chapterId: 30,
      characterId: 'narrator',
      text: longText,
    }));
    writeBook(chapterSentences);

    // Each call returns one annotation per sentenceId present in the prompt (core + context),
    // so without ownership filtering an overlapped sentence would be emitted by >1 chunk.
    runStage3.mockImplementation((_m, _c, prompt: string): Promise<Stage3ChapterOutput> => {
      const ids = [...prompt.matchAll(/"sentenceId":\s*(\d+)/g)].map((m) => Number(m[1]));
      return Promise.resolve({
        annotations: ids.map((sentenceId) => ({ sentenceId, instruct: 'test' })),
      });
    });

    const res = await request(app).post(`/api/books/${bookId}/instruct-annotation`).send({});
    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    // The chapter split → analyzer was called more than once.
    expect(runStage3.mock.calls.length).toBeGreaterThan(1);

    // Zero chapter-failed events (no truncation).
    expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);

    // Union of emitted sentenceIds == chapter sentence ids, each exactly once.
    const emittedIds = events
      .filter((e) => e.kind === 'annotation')
      .flatMap((e) => (e.annotations as Array<{ sentenceId: number }>).map((a) => a.sentenceId));
    const expectedIds = chapterSentences.map((s) => s.id);
    expect([...emittedIds].sort((a, b) => a - b)).toEqual(expectedIds);
    expect(new Set(emittedIds).size).toBe(emittedIds.length); // no duplicates

    expect(events.some((e) => e.kind === 'result')).toBe(true);
  });
});
