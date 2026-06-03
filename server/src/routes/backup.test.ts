/* srv-2 — route-contract test for the per-book backup API
   (GET /:bookId/backups, POST /:bookId/backups/now, POST /:bookId/backups/restore).

   Drives the real router against a real temp workspace (no fs mocks) so the
   status codes, response shapes, and findBookByBookId lookups are exercised
   end-to-end. Mirrors auto-backup.test.ts's temp-workspace pattern
   (mkdtemp + WORKSPACE_DIR + vi.resetModules so paths.ts re-reads the override,
   then a dynamic import of the router). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Express } from 'express';

let workspaceRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let backup: typeof import('../workspace/auto-backup.js');

const BOOK_ID = 'tester__myseries__demo';

function bookDir(): string {
  return join(workspaceRoot, 'books', 'tester', 'myseries', 'demo');
}

/* findBookByBookId walks each book's state.json and iterates state.chapters, so
   the seeded file must carry an (empty) chapters array + the identity fields. */
function makeState(extra: object): Record<string, unknown> {
  return {
    bookId: BOOK_ID,
    manuscriptId: BOOK_ID,
    title: 'Test Book',
    author: 'tester',
    series: 'myseries',
    seriesPosition: null,
    isStandalone: false,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: [],
    coverGradient: ['#111111', '#222222'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

async function seedBook(extra: object = { v: 1 }): Promise<void> {
  const dir = bookDir();
  await mkdir(join(dir, '.audiobook'), { recursive: true });
  await writeFile(join(dir, 'manuscript.txt'), 'chapter one', 'utf8');
  await writeFile(paths.stateJsonPath(dir), JSON.stringify(makeState(extra)), 'utf8');
}

/* A book folder with no state.json. findBookByBookId matches on a state.json
   carrying the bookId, so a folder WITHOUT one is undiscoverable → the route's
   404 path, not its 409. (The 409 "no state.json to back up" branch is a
   TOCTOU edge — state.json must exist at lookup time and vanish before
   backupBook reads it — so it isn't deterministically reachable via the HTTP
   surface; the backupBook-returns-null contract itself is pinned in
   auto-backup.test.ts.) */
async function seedBookWithoutState(): Promise<void> {
  await mkdir(bookDir(), { recursive: true });
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'backup-route-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  vi.resetModules();
  paths = await import('../workspace/paths.js');
  backup = await import('../workspace/auto-backup.js');
  const { backupRouter } = await import('./backup.js');
  app = express();
  app.use(express.json());
  app.use('/api/books', backupRouter);
});

afterEach(async () => {
  delete process.env.WORKSPACE_DIR;
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('GET /api/books/:bookId/backups', () => {
  it('returns 200 with the snapshot list (newest first) for a book that has backups', async () => {
    await seedBook();
    await backup.backupBook(
      { bookId: BOOK_ID, bookDir: bookDir() },
      { keep: 14, now: new Date(2026, 0, 1, 9, 0, 0) },
    );
    await backup.backupBook(
      { bookId: BOOK_ID, bookDir: bookDir() },
      { keep: 14, now: new Date(2026, 0, 2, 9, 0, 0) },
    );

    const res = await request(app).get(`/api/books/${BOOK_ID}/backups`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.backups)).toBe(true);
    expect(res.body.backups).toHaveLength(2);
    // Newest first.
    expect(res.body.backups[0].file > res.body.backups[1].file).toBe(true);
    expect(res.body.backups[0]).toMatchObject({
      file: expect.stringMatching(/^\d{8}-\d{6}\.json$/),
      sizeBytes: expect.any(Number),
      createdAt: expect.any(String),
    });
  });

  it('returns 200 with an empty array for a known book that has no backups yet', async () => {
    await seedBook();
    const res = await request(app).get(`/api/books/${BOOK_ID}/backups`);
    expect(res.status).toBe(200);
    expect(res.body.backups).toEqual([]);
  });

  it('returns 404 for an unknown book', async () => {
    const res = await request(app).get('/api/books/no__such__book/backups');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('book not found');
  });
});

describe('POST /api/books/:bookId/backups/now', () => {
  it('returns 200 with the created snapshot filename when state.json exists', async () => {
    await seedBook();
    const res = await request(app).post(`/api/books/${BOOK_ID}/backups/now`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.file).toMatch(/^\d{8}-\d{6}\.json$/);
    // The snapshot is now listable.
    expect(await backup.listBackups(BOOK_ID)).toHaveLength(1);
  });

  it('returns 404 for an unknown book', async () => {
    const res = await request(app).post('/api/books/no__such__book/backups/now');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('book not found');
  });

  it('returns 404 for a book folder that has no state.json (undiscoverable)', async () => {
    await seedBookWithoutState();
    const res = await request(app).post(`/api/books/${BOOK_ID}/backups/now`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('book not found');
  });
});

describe('POST /api/books/:bookId/backups/restore', () => {
  it('returns 200 on a successful restore', async () => {
    await seedBook({ v: 'original' });
    const file = await backup.backupBook(
      { bookId: BOOK_ID, bookDir: bookDir() },
      { keep: 14, now: new Date(2026, 0, 1, 9, 0, 0) },
    );
    expect(file).toBeTruthy();

    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/backups/restore`)
      .send({ backupFile: file });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 400 when the backupFile field is missing', async () => {
    await seedBook();
    const res = await request(app).post(`/api/books/${BOOK_ID}/backups/restore`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('backupFile required');
  });

  it('returns 400 for a syntactically invalid backup filename', async () => {
    await seedBook();
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/backups/restore`)
      .send({ backupFile: 'not-a-stamp' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid backup filename');
  });

  it('returns 404 for an unknown book', async () => {
    const res = await request(app)
      .post('/api/books/no__such__book/backups/restore')
      .send({ backupFile: '20260101-000000.json' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('book not found');
  });

  it('returns 404 when the named snapshot does not exist', async () => {
    await seedBook();
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/backups/restore`)
      .send({ backupFile: '20260101-000000.json' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('backup not found');
  });

  it('returns 409 for a corrupt snapshot', async () => {
    await seedBook();
    const bdir = paths.bookBackupsDir(BOOK_ID);
    await mkdir(bdir, { recursive: true });
    await writeFile(join(bdir, '20260101-000000.json'), '{ not valid json', 'utf8');
    const res = await request(app)
      .post(`/api/books/${BOOK_ID}/backups/restore`)
      .send({ backupFile: '20260101-000000.json' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('backup is corrupt');
  });
});
