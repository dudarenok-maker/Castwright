/* fs-15/fs-16 — integration tests for GET /api/library/stats and
   GET /api/library/continue-listening.
 *
 * Tempdir workspace, deferred imports so paths.ts picks up WORKSPACE_DIR,
 * supertest against the real libraryRouter. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let bookId1: string;
let listenProgressPath1: string;

function seedBook(
  author: string,
  title: string,
  bookId: string,
  opts: {
    chapters: Array<{
      id: number;
      uuid?: string;
      slug: string;
      title: string;
      duration?: string;
      excluded?: boolean;
      held?: boolean;
    }>;
  },
  stateJsonPathFn: (dir: string) => string,
): { bookDir: string } {
  const bookDir = join(workspaceRoot, 'books', author, 'Standalones', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    stateJsonPathFn(bookDir),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${title}`,
      title,
      author,
      series: null,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: opts.chapters,
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  return { bookDir };
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-librarystats-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ libraryRouter }, { makeBookId }, paths] = await Promise.all([
    import('./library.js'),
    import('../workspace/paths.js'),
    import('../workspace/paths.js'),
  ]);

  bookId1 = makeBookId('Test Author', 'Standalones', 'Test Book');
  const stateJsonPathFn = paths.stateJsonPath;
  const { bookDir: bd1 } = seedBook(
    'Test Author',
    'Test Book',
    bookId1,
    {
      chapters: [
        { id: 1, uuid: 'uuid-t1', slug: '01-one', title: 'Chapter One', duration: '00:10:00' },
        { id: 2, uuid: 'uuid-t2', slug: '02-two', title: 'Chapter Two', duration: '00:20:00' },
      ],
    },
    stateJsonPathFn,
  );
  listenProgressPath1 = paths.listenProgressJsonPath(bd1);

  app = express();
  app.use('/api/library', libraryRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('GET /api/library/stats', () => {
  it('returns zeros on a fresh workspace (no NaN, no listen-stats)', async () => {
    const res = await request(app).get('/api/library/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalListenedSec: 0, booksFinished: 0 });
    expect(Array.isArray(res.body.byDay)).toBe(true);
    expect(Array.isArray(res.body.perBook)).toBe(true);
    // Confirm no NaN leaked into the response
    expect(JSON.stringify(res.body)).not.toContain('NaN');
  });

  it('perBook entry exists for the seeded book with zero completion', async () => {
    const res = await request(app).get('/api/library/stats');
    expect(res.status).toBe(200);
    const entry = res.body.perBook.find((b: { bookId: string }) => b.bookId === bookId1);
    expect(entry).toBeDefined();
    expect(entry.completionPct).toBe(0);
    expect(entry.finished).toBe(false);
  });
});

describe('GET /api/library/continue-listening', () => {
  it('returns empty list when no resume bookmark exists', async () => {
    const res = await request(app).get('/api/library/continue-listening');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it('lists an in-progress book after a resume bookmark is written', async () => {
    writeFileSync(
      listenProgressPath1,
      JSON.stringify({
        chapterId: 1,
        chapterUuid: 'uuid-t1',
        currentSec: 120,
        updatedAt: new Date().toISOString(),
      }),
    );

    const res = await request(app).get('/api/library/continue-listening');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((x: { currentSec: number }) => x.currentSec === 120)).toBe(true);
    const item = res.body.find((x: { currentSec: number }) => x.currentSec === 120);
    expect(item.bookId).toBe(bookId1);
    expect(item.chapterId).toBe(1);
  });
});
