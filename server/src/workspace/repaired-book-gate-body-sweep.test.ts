/* #3713 / PR #4004 pass 4 -- the remaining writes that name a book in the request BODY (or query) rather
   than the path: POST /books/:id/cast/add-from-roster and /cast/link-prior (body `targetBookId`) and
   PUT /voices/:id/override (series scope, `bookId`). Each answers 409 with no token on a repaired book and
   changes nothing on disk; with the book's token it succeeds. The real sweep repairs a pair in a temp
   workspace and the real routers serve it. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let root: string;
let app: Express;
let paths: typeof import('./paths.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');
let gate: typeof import('./repaired-book-gate.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-body-sweep-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  gate = await import('./repaired-book-gate.js');
  const { castAddFromRosterRouter } = await import('../routes/cast-add-from-roster.js');
  const { castLinkPriorRouter } = await import('../routes/cast-link-prior.js');
  const { voicesRouter } = await import('../routes/voices.js');
  app = express();
  app.use(express.json());
  app.use('/api/books/:bookId', gate.repairedBookGate);
  app.use('/api/books', castAddFromRosterRouter);
  app.use('/api/books', castLinkPriorRouter);
  app.use('/api/voices', voicesRouter);
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

function seed(folder: string, bookId: string, opts: { rendered: boolean; rows: number }): string {
  const dir = join(paths.BOOKS_ROOT, 'Auth', 'Ser', folder);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId, manuscriptId: `m_${folder}`, title: folder, author: 'Auth', series: 'Ser', seriesPosition: 1,
      isStandalone: false, manuscriptFile: 'manuscript.md', castConfirmed: true, language: 'en',
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one', ...(opts.rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}) }],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  writeFileSync(
    paths.castJsonPath(dir),
    JSON.stringify({ characters: Array.from({ length: opts.rows }, (_, i) => ({ id: `c${i}`, name: `C${i}`, description: 'orig' })) }),
  );
  return dir;
}

const DUP = 'auth__ser__book';
const SRC = 'auth__ser__src';
let kept: string;
let src: string;

async function repaired() {
  seed('Book', DUP, { rendered: false, rows: 1 });
  kept = seed('Book original', DUP, { rendered: true, rows: 5 });
  src = seed('Src', SRC, { rendered: false, rows: 2 });
  await sweep.repairDuplicateBookIds();
}

const read = (dir: string) => readFileSync(paths.castJsonPath(dir), 'utf8');

describe('POST /books/:id/cast/add-from-roster with a repaired targetBookId (#3713)', () => {
  const body = { targetBookId: DUP, targetCharacterId: 'c0' };

  it('no token: 409 book_repaired_reload naming the target, and nothing is written', async () => {
    await repaired();
    const before = read(src);
    const res = await request(app).post(`/api/books/${SRC}/cast/add-from-roster`).send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_repaired_reload');
    expect(res.body.bookId).toBe(DUP);
    expect(read(src)).toBe(before);
  });

  it('with the target\'s token the row is added', async () => {
    await repaired();
    const res = await request(app).post(`/api/books/${SRC}/cast/add-from-roster`).set('X-Book-Read-Token', gate.repairedReadToken(DUP)!).send(body);
    expect(res.status).toBe(200);
    expect(JSON.parse(read(src)).characters).toHaveLength(3);
  });
});

describe('POST /books/:id/cast/link-prior with a repaired targetBookId (#3713)', () => {
  const body = { sourceCharacterId: 'c0', targetBookId: DUP, targetCharacterId: 'c1' };

  it('no token: 409 and neither cast.json changes', async () => {
    await repaired();
    const before = [read(src), read(kept)];
    const res = await request(app).post(`/api/books/${SRC}/cast/link-prior`).send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_repaired_reload');
    expect(res.body.bookId).toBe(DUP);
    expect([read(src), read(kept)]).toEqual(before);
  });

  it('with the target\'s token the link is written to the target', async () => {
    await repaired();
    const before = read(kept);
    const res = await request(app).post(`/api/books/${SRC}/cast/link-prior`).set('X-Book-Read-Token', gate.repairedReadToken(DUP)!).send(body);
    expect(res.status).toBe(200);
    expect(read(kept)).not.toBe(before);
  });
});

describe('PUT /voices/:id/override (series scope) with a repaired bookId (#3713)', () => {
  const body = { override: { engine: 'kokoro', name: 'af_heart' }, scope: 'series', bookId: DUP };

  it('no token: 409 and no cast.json in the series changes', async () => {
    await repaired();
    const before = [read(src), read(kept)];
    const res = await request(app).put('/api/voices/c0/override').send(body);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_repaired_reload');
    expect(res.body.bookId).toBe(DUP);
    expect([read(src), read(kept)]).toEqual(before);
  });

  it('the bookId in the query is gated the same way', async () => {
    await repaired();
    const res = await request(app).put(`/api/voices/c0/override?scope=series&bookId=${DUP}`).send({ override: { engine: 'kokoro', name: 'af_heart' } });
    expect(res.status).toBe(409);
  });

  it('with the token it writes the override across the series', async () => {
    await repaired();
    const res = await request(app).put('/api/voices/c0/override').set('X-Book-Read-Token', gate.repairedReadToken(DUP)!).send(body);
    expect(res.status).toBe(204);
    expect(read(kept)).toContain('af_heart');
  });

  it('the workspace scope names no book and is not gated', async () => {
    await repaired();
    const res = await request(app).put('/api/voices/c0/override').send({ override: { engine: 'kokoro', name: 'af_heart' } });
    expect(res.status).not.toBe(409);
  });
});
