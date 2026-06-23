/* fs-33 — integration tests for the emotion-only backfill route
   POST /api/books/:bookId/annotate-emotion.

   The analyzer is faked via vi.mock('../analyzer/select-analyzer.js') so no
   real LLM is hit. The route is the contract under test: it streams per-chapter
   `annotation` events with {sentenceId, emotion}, NEVER returns characterId
   (re-attribution is out of scope), guards an unattributed book with a
   `no_attribution` error, and on mid-pass DailyQuotaExhaustedError emits a
   `quota_exhausted` error after the chapters it already streamed. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Analyzer } from '../analyzer/index.js';
import type { EmotionAnnotationOutput } from '../handoff/schemas.js';

const AUTHOR = 'Test Author';
const SERIES = 'Test Series';
const BOOK = 'Test Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let manuscriptId: string;

/* The fake analyzer's runEmotionChapter — each test swaps its implementation. */
const { runEmotion } = vi.hoisted(() => ({ runEmotion: vi.fn() }));

vi.mock('../analyzer/select-analyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/select-analyzer.js')>();
  const fakeAnalyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.reject(new Error('not used')),
    runEmotionChapter: (m, c, p, call) => runEmotion(m, c, p, call),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
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
  { id: 2, chapterId: 1, characterId: 'wren', text: '“Get down!”' },
  { id: 3, chapterId: 2, characterId: 'marlow', text: '“It will be okay,” he whispered.' },
];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-annotate-emotion-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ annotateEmotionRouter }, { makeBookId }] = await Promise.all([
    import('./annotate-emotion.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  manuscriptId = `m_${bookId}`;
  app = express();
  app.use(express.json());
  app.use('/api/books', annotateEmotionRouter);
});

beforeEach(() => {
  runEmotion.mockReset();
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/books/:bookId/annotate-emotion', () => {
  it('streams per-chapter annotation events with {sentenceId, emotion} and a final result', async () => {
    writeBook(SENTENCES);
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> => {
      if (chapterId === 1) return Promise.resolve({ annotations: [{ sentenceId: 2, emotion: 'angry' }] });
      return Promise.resolve({ annotations: [{ sentenceId: 3, emotion: 'whisper' }] });
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    const annotations = events.filter((e) => e.kind === 'annotation');
    expect(annotations).toEqual([
      { kind: 'annotation', chapterId: 1, annotations: [{ sentenceId: 2, emotion: 'angry' }] },
      { kind: 'annotation', chapterId: 2, annotations: [{ sentenceId: 3, emotion: 'whisper' }] },
    ]);

    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ done: true, annotatedChapters: 2, totalAnnotations: 2 });
  });

  it('sends the already-attributed sentences (id/characterId/text) and never asks for re-attribution', async () => {
    writeBook(SENTENCES);
    runEmotion.mockResolvedValue({ annotations: [] });

    await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});

    // Chapter 1 call should carry both ch-1 sentences in the prompt.
    const ch1Call = runEmotion.mock.calls.find((c) => c[1] === 1);
    expect(ch1Call).toBeTruthy();
    const prompt = ch1Call![2] as string;
    expect(prompt).toContain('"sentenceId": 1');
    expect(prompt).toContain('"sentenceId": 2');
    expect(prompt).toContain('"characterId": "wren"');
    // The output contract carries no characterId — re-attribution is impossible.
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    for (const e of parseSse(res.text).filter((e) => e.kind === 'annotation')) {
      for (const a of e.annotations as Array<Record<string, unknown>>) {
        expect(a).not.toHaveProperty('characterId');
        expect(a).not.toHaveProperty('text');
      }
    }
  });

  it('emits a no_attribution error when the book has no attributed sentences', async () => {
    writeBook(null); // no manuscript-edits.json, no cache
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'error' && e.code === 'no_attribution')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
    expect(runEmotion).not.toHaveBeenCalled();
  });

  it('404s for an unknown book', async () => {
    const res = await request(app).post(`/api/books/does-not-exist/annotate-emotion`).send({});
    expect(res.status).toBe(404);
  });

  it('on mid-pass daily-quota exhaustion, keeps already-streamed chapters and stops with quota_exhausted', async () => {
    writeBook(SENTENCES);
    const { DailyQuotaExhaustedError } = await import('../analyzer/rate-limit.js');
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> => {
      if (chapterId === 1) return Promise.resolve({ annotations: [{ sentenceId: 2, emotion: 'angry' }] });
      return Promise.reject(new DailyQuotaExhaustedError('test-model', new Date('2099-01-01')));
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);

    // Chapter 1 annotation survived.
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(true);
    // Quota error reported; no success result.
    expect(events.some((e) => e.kind === 'error' && e.code === 'quota_exhausted')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
  });

  it('a single chapter failure does not abort the rest of the pass', async () => {
    writeBook(SENTENCES);
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> => {
      if (chapterId === 1) return Promise.reject(new Error('flaky chapter'));
      return Promise.resolve({ annotations: [{ sentenceId: 3, emotion: 'sad' }] });
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'chapter-failed' && e.chapterId === 1)).toBe(true);
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 2)).toBe(true);
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ annotatedChapters: 1 });
  });
});
