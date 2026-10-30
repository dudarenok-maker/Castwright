/* #3711 task 4 -- the script-review run is a registered `script-review` job: while it
   runs, a folder rename and a DELETE are refused with 409 `book_busy` and the folder is
   untouched. The registration is released on EVERY exit path -- including the early
   returns that used to be able to leak a busy flag (409 not-analysed, 409 conflicting
   scope, a join of the running job, `no_attribution`, `no_such_chapter`) -- and a start
   for a deleted book registers nothing.

   Driven through the real POST /script-review with the analyzer call held by a gate (the
   seam script-review.test.ts uses). Event-based, no sleeps. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Analyzer } from '../analyzer/index.js';

const AUTHOR = 'Test Author';
const SERIES = 'Test Series';
const BOOK = 'Test Book';
const NEW_BOOK = 'Test Book Renamed';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let manuscriptId: string;
let bookJobKinds: typeof import('../workspace/book-op-lock.js').bookJobKinds;

const { runReview, selectAnalyzerForPhaseMock, warmOllamaModelMock, unloadResidentOllamaMock } = vi.hoisted(() => ({
  runReview: vi.fn(),
  selectAnalyzerForPhaseMock: vi.fn(),
  warmOllamaModelMock: vi.fn(),
  unloadResidentOllamaMock: vi.fn(async () => {}),
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
      engine: 'gemini',
      model: 'test-model',
      fallbackModel: null,
    })),
  };
});
vi.mock('./ollama-health.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ollama-health.js')>();
  return { ...actual, warmOllamaModel: warmOllamaModelMock, unloadResidentOllama: unloadResidentOllamaMock };
});

const SENTENCES = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'The room was quiet.' },
  { id: 2, chapterId: 1, characterId: 'wren', text: '"Get down!"' },
];

function bookDir(): string {
  return join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
}
const newDir = () => join(workspaceRoot, 'books', AUTHOR, SERIES, NEW_BOOK);

function writeBook(opts: { sentences?: unknown[] | null; manuscriptId?: string | null } = {}): void {
  const dir = bookDir();
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  const msId = opts.manuscriptId === null ? undefined : (opts.manuscriptId ?? manuscriptId);
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      ...(msId ? { manuscriptId: msId } : {}),
      title: BOOK,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: false,
      language: 'en',
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
    JSON.stringify({ characters: [{ id: 'wren', name: 'Wren', role: 'protagonist', color: '#ff0000' }] }),
  );
  const sentences = opts.sentences === undefined ? SENTENCES : opts.sentences;
  if (sentences) {
    writeFileSync(join(dir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences }));
  }
}

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-script-review-job-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { scriptReviewRouter } = await import('./script-review.js');
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookJobKinds = (await import('../workspace/book-op-lock.js')).bookJobKinds;
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  manuscriptId = `m_${bookId}`;
  app = express();
  app.use(express.json());
  app.use('/api/books', scriptReviewRouter);
  app.use('/api/books', bookStateRouter);
});

beforeEach(() => {
  runReview.mockReset();
  runReview.mockResolvedValue({ ops: [] });
  warmOllamaModelMock.mockReset();
  warmOllamaModelMock.mockResolvedValue({ ok: true });
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const renameRequest = () =>
  request(app)
    .put(`/api/books/${bookId}/state`)
    .set('Content-Type', 'application/json')
    .send({ slice: 'state', patch: { title: NEW_BOOK } });

describe('POST /script-review is a registered script-review job (#3711)', () => {
  it('refuses rename and DELETE with 409 while the review runs, then allows them', async () => {
    writeBook();
    const entered = gate();
    const release = gate();
    runReview.mockImplementation(async () => {
      entered.open();
      await release.promise;
      return { ops: [] };
    });
    const run = request(app)
      .post(`/api/books/${bookId}/script-review`)
      .send({})
      .then((r) => r);
    await entered.promise;
    expect(bookJobKinds(bookId)).toEqual(['script-review']);

    const rename = await renameRequest();
    expect(rename.status).toBe(409);
    expect(rename.body.code).toBe('book_busy');
    expect(rename.body.error).toMatch(/reviewing the script/i);
    const del = await request(app).delete(`/api/books/${bookId}`);
    expect(del.status).toBe(409);
    expect(del.body.code).toBe('book_busy');
    expect(existsSync(bookDir())).toBe(true);
    expect(existsSync(newDir())).toBe(false);
    expect(JSON.parse(readFileSync(join(bookDir(), '.audiobook', 'state.json'), 'utf8')).title).toBe(BOOK);

    release.open();
    const res = await run;
    expect(parseSse(res.text).find((e) => e.kind === 'result')).toMatchObject({ done: true });
    await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual([]));
    expect((await renameRequest()).status).toBe(200);
    expect(existsSync(newDir())).toBe(true);
  });

  it('releases the registration when the analyzer throws', async () => {
    writeBook();
    runReview.mockRejectedValue(new Error('analyzer exploded'));
    await request(app).post(`/api/books/${bookId}/script-review`).send({});
    await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual([]));
    expect((await renameRequest()).status).toBe(200);
  });

  describe('early returns release the registration', () => {
    it('409 when the book has not been analysed yet (no manuscriptId)', async () => {
      writeBook({ manuscriptId: null });
      const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
      expect(res.status).toBe(409);
      expect(bookJobKinds(bookId)).toEqual([]);
      expect((await renameRequest()).status).toBe(200);
    });

    it('the no_attribution terminal (nothing attributed to review)', async () => {
      writeBook({ sentences: null });
      const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
      expect(parseSse(res.text).find((e) => e.kind === 'error')).toMatchObject({ code: 'no_attribution' });
      expect(bookJobKinds(bookId)).toEqual([]);
      expect((await renameRequest()).status).toBe(200);
    });

    it('the no_such_chapter terminal (a chapter with no attributed sentences)', async () => {
      writeBook();
      const res = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 99 });
      expect(parseSse(res.text).find((e) => e.kind === 'error')).toMatchObject({ code: 'no_such_chapter' });
      expect(bookJobKinds(bookId)).toEqual([]);
    });

    it('a join of the running job, and a conflicting scope, leave only the running job registered', async () => {
      writeBook();
      const entered = gate();
      const release = gate();
      runReview.mockImplementation(async () => {
        entered.open();
        await release.promise;
        return { ops: [] };
      });
      const first = request(app)
        .post(`/api/books/${bookId}/script-review`)
        .send({})
        .then((r) => r);
      await entered.promise;
      expect(bookJobKinds(bookId)).toEqual(['script-review']);

      /* A single-chapter request conflicts with the running whole-book review. */
      const conflict = await request(app).post(`/api/books/${bookId}/script-review`).send({ chapterId: 1 });
      expect(conflict.status).toBe(409);
      expect(bookJobKinds(bookId)).toEqual(['script-review']);

      /* A second whole-book request joins; it must not add (or leak) a registration of
         its own once its handler has returned. */
      const joined = request(app)
        .post(`/api/books/${bookId}/script-review`)
        .send({})
        .then((r) => r);
      await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual(['script-review']));

      release.open();
      await Promise.all([first, joined]);
      await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual([]));
    });
  });

  it('a start for a deleted book answers 404 and registers nothing', async () => {
    const res = await request(app).post(`/api/books/${bookId}/script-review`).send({});
    expect(res.status).toBe(404);
    expect(bookJobKinds(bookId)).toEqual([]);
  });
});
