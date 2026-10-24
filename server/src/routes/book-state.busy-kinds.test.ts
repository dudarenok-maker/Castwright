import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { BookJobKind } from '../workspace/book-op-lock.js';

/* #3774 — the Generate view disables "Include in book" while any long job
   holds the book, so it needs to read the registered kinds. GET
   /api/books/:bookId/busy reports `bookJobKinds(bookId)`: lock-free, read-only,
   and always a 200 (an unknown book is simply not busy). Jobs are registered
   the real way (`runBookJob`), never via `__addBookJobToken`. */

let workspaceRoot: string;
let app: Express;
let bookId: string;
let bookOp: typeof import('../workspace/book-op-lock.js');
let bookJobs: typeof import('../workspace/book-jobs.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-busy-kinds-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { bookStateRouter } = await import('./book-state.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOp = await import('../workspace/book-op-lock.js');
  bookJobs = await import('../workspace/book-jobs.js');
  bookId = makeBookId('Busy Kinds', 'Standalones', 'Busy Kinds Book');
  const bookDir = join(workspaceRoot, 'books', 'Busy Kinds', 'Standalones', 'Busy Kinds Book');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_busy_kinds_test',
      title: 'Busy Kinds Book',
      author: 'Busy Kinds',
      series: 'Standalones',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

async function holdJob(id: string, kind: BookJobKind): Promise<{ finish: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const reg = await bookJobs.runBookJob(id, kind, () => gate);
  if (reg === bookOp.BOOK_GONE) throw new Error('test setup: book not found');
  return {
    finish: async () => {
      open();
      await reg.done;
    },
  };
}

describe('GET /api/books/:bookId/busy (#3774)', () => {
  it('reports no kinds when nothing is registered', async () => {
    const res = await request(app).get(`/api/books/${encodeURIComponent(bookId)}/busy`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kinds: [] });
  });

  it('reports every registered kind, and clears once the jobs settle', async () => {
    const render = await holdJob(bookId, 'render');
    const analysis = await holdJob(bookId, 'analysis');
    const res = await request(app).get(`/api/books/${encodeURIComponent(bookId)}/busy`);
    expect(res.status).toBe(200);
    expect([...res.body.kinds].sort()).toEqual(['analysis', 'render']);
    await render.finish();
    await analysis.finish();
    const after = await request(app).get(`/api/books/${encodeURIComponent(bookId)}/busy`);
    expect(after.body).toEqual({ kinds: [] });
  });

  it('reports an unknown book as not busy (200, empty)', async () => {
    const res = await request(app).get('/api/books/no-such-book/busy');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kinds: [] });
  });
});
