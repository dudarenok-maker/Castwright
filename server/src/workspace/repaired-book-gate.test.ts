/* #3713 / PR #4004 pass 2 (owner decision) -- the write gate on a repaired bookId.
   The real sweep repairs a duplicate pair in a temp workspace, the real
   `bookStateRouter` serves it behind the gate, and a request is a "client":
   one that has not read the book since the repair (no token) and one that has. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

let root: string;
let app: Express;
let paths: typeof import('./paths.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');
let gate: typeof import('./repaired-book-gate.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-'));
  process.env.WORKSPACE_DIR = root;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  gate = await import('./repaired-book-gate.js');
  const { bookStateRouter } = await import('../routes/book-state.js');
  app = express();
  app.use(express.json());
  app.use('/api/books/:bookId', gate.repairedBookGate);
  app.use('/api/manuscripts/:id', gate.repairedManuscriptGate);
  app.post('/api/manuscripts/:id/analysis', (_req, res) => res.status(202).end());
  app.use('/api/books', bookStateRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  rmSync(paths.BOOKS_ROOT, { recursive: true, force: true });
  sweep.__resetDuplicateBookIdRepairsForTest();
});
afterEach(() => sweep.__resetDuplicateBookIdRepairsForTest());

function seed(folder: string, opts: { ms: string; rendered: boolean; rows: number }): string {
  const dir = join(paths.BOOKS_ROOT, 'Auth', 'Ser', folder);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId: 'auth__ser__book', manuscriptId: opts.ms, title: 'Book', author: 'Auth', series: 'Ser', seriesPosition: 1,
      isStandalone: false, manuscriptFile: 'manuscript.md', castConfirmed: true, language: 'en',
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one', ...(opts.rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}) },
      ],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  writeFileSync(
    paths.castJsonPath(dir),
    JSON.stringify({ characters: Array.from({ length: opts.rows }, (_, i) => ({ id: `c${i}`, name: `C${i}` })) }),
  );
  return dir;
}

/** `copy` sorts first (the walk-first match); `original` has the work, so it keeps the id. */
async function repairedPair(sharedMs: boolean) {
  const copy = seed('Book', { ms: 'm_copy', rendered: false, rows: 1 });
  const original = seed('Book original', { ms: sharedMs ? 'm_copy' : 'm_original', rendered: true, rows: 5 });
  const [repair] = await sweep.repairDuplicateBookIds();
  return { copy, original, repair };
}

describe('the repaired-id write gate (#3713)', () => {
  it('a DELETE from a client that has not read the book since the repair answers 409 and deletes nothing', async () => {
    const { original, copy, repair } = await repairedPair(false);
    const res = await request(app).delete('/api/books/auth__ser__book');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_repaired_reload');
    expect(existsSync(original)).toBe(true);
    expect(existsSync(copy)).toBe(true);
    expect(repair.newBookId).not.toBe('auth__ser__book');
  });

  it('the 409 body names no path', async () => {
    await repairedPair(false);
    const res = await request(app).delete('/api/books/auth__ser__book');
    expect(JSON.stringify(res.body)).not.toContain(root);
    expect(JSON.stringify(res.body)).not.toMatch(/[\\/]Auth[\\/]/);
  });

  it('a PUT, POST and the listen writes are refused the same way', async () => {
    await repairedPair(false);
    for (const [method, url] of [
      ['put', '/api/books/auth__ser__book/state'],
      ['put', '/api/books/auth__ser__book/listen-progress'],
      ['post', '/api/books/auth__ser__book/shelf-status'],
      ['post', '/api/books/auth__ser__book/reparse'],
    ] as const) {
      const res = await request(app)[method](url).send({ slice: 'cast', patch: {} });
      expect(res.status, `${method} ${url}`).toBe(409);
      expect(res.body.code).toBe('book_repaired_reload');
    }
  });

  it('a wrong token is refused like no token', async () => {
    await repairedPair(false);
    const res = await request(app).delete('/api/books/auth__ser__book').set('X-Book-Read-Token', 'not-the-token');
    expect(res.status).toBe(409);
  });

  it('a client that has read the book can still write: GET /state returns the token, and echoing it passes', async () => {
    await repairedPair(false);
    const read = await request(app).get('/api/books/auth__ser__book/state');
    expect(read.status).toBe(200);
    const token = read.headers['x-book-read-token'];
    expect(typeof token).toBe('string');
    const write = await request(app)
      .put('/api/books/auth__ser__book/listen-progress')
      .set('X-Book-Read-Token', token)
      .send({ chapterId: 1, currentSec: 3 });
    expect(write.status).toBe(200);
  });

  it('the read itself is never gated, and carries no token for an id that was not repaired', async () => {
    const dir = seed('Solo', { ms: 'm_solo', rendered: false, rows: 1 });
    expect(existsSync(dir)).toBe(true);
    const read = await request(app).get('/api/books/auth__ser__book/state');
    expect(read.status).toBe(200);
    expect(read.headers['x-book-read-token']).toBeUndefined();
  });

  it('the re-minted twin under its NEW id is not gated', async () => {
    const { repair } = await repairedPair(false);
    const res = await request(app)
      .put(`/api/books/${repair.newBookId}/listen-progress`)
      .send({ chapterId: 1, currentSec: 2 });
    expect(res.status).toBe(200);
  });

  it('the gate ends with the process: after a reset the old id is writable again', async () => {
    await repairedPair(false);
    sweep.__resetDuplicateBookIdRepairsForTest();
    const res = await request(app).put('/api/books/auth__ser__book/listen-progress').send({ chapterId: 1, currentSec: 1 });
    expect(res.status).toBe(200);
  });

  it('an id the sweep did not repair is writable without a token', async () => {
    seed('Solo', { ms: 'm_solo', rendered: false, rows: 1 });
    const res = await request(app).put('/api/books/auth__ser__book/listen-progress').send({ chapterId: 1, currentSec: 1 });
    expect(res.status).toBe(200);
  });
});

describe('the repaired manuscriptId gate (#3713)', () => {
  it('a shared manuscriptId the sweep re-minted gates the manuscript-keyed analysis write, with the book token', async () => {
    await repairedPair(true);
    const refused = await request(app).post('/api/manuscripts/m_copy/analysis').send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('book_repaired_reload');
    const token = gate.repairedReadToken('auth__ser__book')!;
    const ok = await request(app).post('/api/manuscripts/m_copy/analysis').set('X-Book-Read-Token', token).send({});
    expect(ok.status).toBe(202);
  });

  it('distinct manuscriptIds gate nothing on the manuscripts side', async () => {
    await repairedPair(false);
    for (const ms of ['m_copy', 'm_original']) {
      const res = await request(app).post(`/api/manuscripts/${ms}/analysis`).send({});
      expect(res.status, ms).toBe(202);
    }
  });

  it('reads of a gated manuscriptId pass', async () => {
    gate.registerRepairedBook('b', 'm_x');
    app.get('/api/manuscripts/:id/analysis', (_req, res) => res.status(200).end());
    expect((await request(app).get('/api/manuscripts/m_x/analysis')).status).toBe(200);
  });
});

describe('where the gate is mounted (#3713)', () => {
  it('app.ts mounts both gates before the first router under their paths', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts'), 'utf8');
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const booksGate = at("app.use('/api/books/:bookId', repairedBookGate)");
    const msGate = at("app.use('/api/manuscripts/:id', repairedManuscriptGate)");
    expect(booksGate).toBeLessThan(at("app.use('/api/books', bookStateRouter)"));
    expect(booksGate).toBeLessThan(at("app.use('/api', importRouter)"));
    expect(msGate).toBeLessThan(at("app.use('/api/manuscripts', manuscriptsRouter)"));
    expect(msGate).toBeLessThan(at("app.use('/api/manuscripts', analysisRouter)"));
    /* Every router mounted under /api/books comes after the gate. */
    for (const m of src.matchAll(/app\.use\('\/api\/books', \w+\)/g)) {
      expect(m.index!, m[0]).toBeGreaterThan(booksGate);
    }
  });
});
