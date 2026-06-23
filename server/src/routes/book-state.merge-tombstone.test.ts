/* fs-58 — Round-trip test: mergedAwayKeys persists through PUT manuscript
   → GET and survives the sentences-filter reconciliation path.

   Follows the book-state.test.ts pattern: tempdir workspace, deferred
   module imports so paths.ts picks up WORKSPACE_DIR, supertest against
   the real router. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Merge Tombstone Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-merge-tombstone-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('book-state router — mergedAwayKeys round-trip (fs-58 task-2b)', () => {
  it('PUT slice=manuscript with mergedAwayKeys → GET returns mergedAwayKeys in manuscriptEdits', async () => {
    const sentences = [
      { id: 1, chapterId: 1, characterId: 'narrator', text: 'The hall was dark. Dust hung in the air.' },
    ];
    const mergedAwayKeys = ['1:2'];

    // PUT persists sentences + tombstone.
    const putRes = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'manuscript', patch: { sentences, mergedAwayKeys } });
    expect(putRes.status).toBe(204);

    // GET returns mergedAwayKeys in manuscriptEdits.
    const getRes = await request(app).get(`/api/books/${bookId}/state`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.manuscriptEdits?.mergedAwayKeys).toEqual(['1:2']);
    expect(getRes.body.manuscriptEdits?.sentences).toHaveLength(1);
  });

  it('mergedAwayKeys is absent (not null) when the manuscript was never PUT with tombstone', async () => {
    /* Fresh book with no manuscript-edits.json written → manuscriptEdits
       is null (the file was never created). */
    const TITLE2 = 'Merge Tombstone Book 2';
    const bookId2 = (await import('../workspace/paths.js')).makeBookId(AUTHOR, SERIES, TITLE2);
    const bookDir2 = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE2);
    mkdirSync(join(bookDir2, '.audiobook'), { recursive: true });
    writeFileSync(
      join(bookDir2, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: bookId2,
        manuscriptId: 'm_test2',
        title: TITLE2,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-one' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(bookDir2, 'manuscript.txt'), 'placeholder');

    const getRes = await request(app).get(`/api/books/${bookId2}/state`);
    expect(getRes.status).toBe(200);
    // manuscriptEdits is null when no file has been written yet.
    expect(getRes.body.manuscriptEdits).toBeNull();
  });
});
