/* Integration test for the book-state router's change-log slice.

   Asserts that:
     1. PUT /:bookId/state with slice='changeLog' writes
        .audiobook/change-log.json atomically.
     2. GET /:bookId/state surfaces those events at `body.changeLog`.
     3. The same PUT validates required fields and 400s when slice / patch
        are missing.

   Mirrors the chapter-audio.test.ts setup: tempdir workspace, deferred
   module imports so paths.ts picks up WORKSPACE_DIR, supertest against
   the real router. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Change Log Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-changelog-test-'));
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

describe('book-state router — changeLog slice', () => {
  it('GET returns changeLog: null when no log has been written yet', async () => {
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(res.body.changeLog).toBeNull();
  });

  it('PUT slice=changeLog writes .audiobook/change-log.json', async () => {
    const events = [
      { id: 1, at: '2026-05-13T15:00:00.000Z', ts: 'Just now', date: 'today',
        type: 'regenerate', title: 'Regenerated Chapter 1', note: 'Reason: voice tuning updated.',
        actor: 'you', chapterId: 1, revertible: true },
    ];
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'changeLog', patch: { events } });
    expect(res.status).toBe(204);

    const onDisk = join(bookDir, '.audiobook', 'change-log.json');
    expect(existsSync(onDisk)).toBe(true);
    const parsed = JSON.parse(readFileSync(onDisk, 'utf8'));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].title).toBe('Regenerated Chapter 1');
  });

  it('GET surfaces the persisted events at body.changeLog', async () => {
    /* Depends on the PUT in the previous case — the disk file is shared
       across the test cases inside this describe block, mirroring how the
       frontend persistence middleware writes then reloads. */
    const res = await request(app).get(`/api/books/${bookId}/state`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.changeLog)).toBe(true);
    expect(res.body.changeLog).toHaveLength(1);
    expect(res.body.changeLog[0].chapterId).toBe(1);
  });

  it('PUT 400s when slice or patch is missing', async () => {
    const res = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'changeLog' });
    expect(res.status).toBe(400);
  });
});

describe('book-state router — state slice editable metadata', () => {
  it('PUT slice=state round-trips title/author/series/narratorCredit/genre/publicationDate', async () => {
    const patch = {
      title: 'Renamed Title',
      author: 'Different Author',
      series: 'Renamed Series',
      narratorCredit: 'New Narrator',
      genre: 'Sci-fi',
      publicationDate: '2026-12-25',
    };
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch });
    expect(put.status).toBe(204);

    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.title).toBe('Renamed Title');
    expect(onDisk.author).toBe('Different Author');
    expect(onDisk.series).toBe('Renamed Series');
    expect(onDisk.narratorCredit).toBe('New Narrator');
    expect(onDisk.genre).toBe('Sci-fi');
    expect(onDisk.publicationDate).toBe('2026-12-25');
    /* Should NOT have mutated identity / paths. */
    expect(onDisk.bookId).toBe(bookId);
    expect(onDisk.manuscriptId).toBe('m_test');
    expect(onDisk.manuscriptFile).toBe('manuscript.txt');
  });

  it('PUT slice=state preserves prior values when patch fields are absent', async () => {
    /* Touch only narratorCredit; the title from the previous test should stick. */
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { narratorCredit: 'Yet Another' } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.title).toBe('Renamed Title');
    expect(onDisk.narratorCredit).toBe('Yet Another');
  });

  it('PUT slice=state stores explicit null for cleared optional fields', async () => {
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { genre: null, publicationDate: null } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.genre).toBeNull();
    expect(onDisk.publicationDate).toBeNull();
  });

  it('PUT slice=state ignores attempts to overwrite bookId/manuscriptId', async () => {
    const put = await request(app)
      .put(`/api/books/${bookId}/state`)
      .set('Content-Type', 'application/json')
      .send({ slice: 'state', patch: { bookId: 'hacked', manuscriptId: 'hacked' } });
    expect(put.status).toBe(204);
    const onDisk = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(onDisk.bookId).toBe(bookId);
    expect(onDisk.manuscriptId).toBe('m_test');
  });
});
