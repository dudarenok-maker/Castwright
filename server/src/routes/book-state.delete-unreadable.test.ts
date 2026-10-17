/* #3625 review 2 (🟠4) - DELETE /api/books/:bookId on an `unreadable` row. The
   row's bookId is derived from its folder path (no state parses), and the delete
   used to look books up by parseable state only, so it answered 204 and removed
   nothing while the card kept offering "Delete book". */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Torn Author';
const SERIES = 'Standalones';
const TORN = 'Torn Book';
const HEALTHY = 'Healthy Book';

let workspaceRoot: string;
let app: Express;
let tornDir: string;
let healthyDir: string;
let tornId: string;
let healthyId: string;

const listed = async () => {
  const { scanLibrary } = await import('../workspace/scan.js');
  const lib = await scanLibrary();
  return lib.authors.flatMap((a) => a.series.flatMap((s) => s.books));
};

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'delete-unreadable-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  tornId = makeBookId(AUTHOR, SERIES, TORN);
  healthyId = makeBookId(AUTHOR, SERIES, HEALTHY);
  tornDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TORN);
  healthyDir = join(workspaceRoot, 'books', AUTHOR, SERIES, HEALTHY);
  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  await rm(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(tornDir, '.audiobook'), { recursive: true });
  writeFileSync(join(tornDir, 'manuscript.txt'), 'x');
  writeFileSync(join(tornDir, '.audiobook', 'state.json'), '{ torn');
  writeFileSync(join(tornDir, '.audiobook', 'state.json.bak.1'), '{ torn');
  mkdirSync(join(healthyDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(healthyDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: healthyId,
      manuscriptId: 'm_healthy',
      title: HEALTHY,
      author: AUTHOR,
      series: SERIES,
      updatedAt: '2026-05-23T00:00:00.000Z',
      schema: 1,
      chapters: [],
    }),
  );
});

describe('DELETE /api/books/:bookId on an unreadable book', () => {
  it('precondition: the torn book is listed as unreadable', async () => {
    const b = (await listed()).find((x) => x.bookId === tornId);
    expect(b?.status).toBe('unreadable');
  });

  it('removes the folder and the row, and leaves other books alone', async () => {
    const res = await request(app).delete(`/api/books/${tornId}`);
    expect(res.status).toBe(204);
    expect(existsSync(tornDir)).toBe(false);
    expect((await listed()).map((b) => b.bookId)).toEqual([healthyId]);
    expect(existsSync(healthyDir)).toBe(true);
  });

  it('an unknown id is still an idempotent 204 that deletes nothing', async () => {
    const res = await request(app).delete('/api/books/no-such-book');
    expect(res.status).toBe(204);
    expect(existsSync(tornDir)).toBe(true);
    expect(existsSync(healthyDir)).toBe(true);
  });

  it('a path-traversal id resolves to no folder and deletes nothing', async () => {
    const res = await request(app).delete(`/api/books/${encodeURIComponent('..%2F..%2Fbooks')}`);
    expect(res.status).toBe(204);
    expect(existsSync(tornDir)).toBe(true);
    expect(existsSync(healthyDir)).toBe(true);
  });
});
