/* Integration tests for the /api/queue routes (plan 102).
 *
 * Uses an isolated WORKSPACE_DIR per test run so the routes hit a real
 * (.queue.json) on disk via writeJsonAtomic. supertest drives the routes
 * the same way the chapter-audio / book-state test files do. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;

/* A real book on disk so the Wave-3 engine-stamp resolver (cast + analysis
   cache + book default) has something to resolve. */
const STAMP_AUTHOR = 'Queue Stamp Author';
const STAMP_SERIES = 'Standalones';
const STAMP_TITLE = 'Queue Stamp Book';
const STAMP_MANUSCRIPT_ID = 'm_queue_stamp_test';
let stampBookId: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'queue-route-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Import AFTER WORKSPACE_DIR is set so paths.ts captures the override. */
  const { queueRouter } = await import('./queue.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const { saveAnalysisCache } = await import('../store/analysis-cache.js');

  /* Book on disk: narrator speaks chapter 1 (single-engine, book default);
     narrator + a qwen-override character speak chapter 2 (multi-TTS). */
  stampBookId = makeBookId(STAMP_AUTHOR, STAMP_SERIES, STAMP_TITLE);
  const bookDir = join(workspaceRoot, 'books', STAMP_AUTHOR, STAMP_SERIES, STAMP_TITLE);
  await mkdir(join(bookDir, '.audiobook'), { recursive: true });
  await writeFile(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: stampBookId,
      manuscriptId: STAMP_MANUSCRIPT_ID,
      title: STAMP_TITLE,
      author: STAMP_AUTHOR,
      series: STAMP_SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter 1', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter 2', slug: '02-chapter-two' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  await writeFile(join(bookDir, 'manuscript.txt'), 'placeholder');
  await writeFile(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'narrator', name: 'Narrator' },
        { id: 'biana', name: 'Biana', ttsEngine: 'qwen' },
      ],
    }),
  );
  await saveAnalysisCache(STAMP_MANUSCRIPT_ID, {
    chapters: {
      1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
      2: [
        { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
        { id: 3, chapterId: 2, characterId: 'biana', text: 'Hi there.' },
      ],
    },
  });

  app = express();
  app.use(express.json());
  app.use('/api/queue', queueRouter);
});

afterAll(async () => {
  const { clearAnalysisCache } = await import('../store/analysis-cache.js');
  await clearAnalysisCache(STAMP_MANUSCRIPT_ID);
  await rm(workspaceRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  /* Fresh queue per test — clear the file so test order doesn't matter. */
  const { queueJsonPath } = await import('../workspace/paths.js');
  const { writeQueueFile } = await import('../workspace/queue-migrate.js');
  await writeQueueFile(queueJsonPath(), { entries: [], paused: false });
});

describe('GET /api/queue', () => {
  it('returns an empty queue on first read', async () => {
    const res = await request(app).get('/api/queue');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ entries: [], paused: false });
  });
});

describe('POST /api/queue/enqueue', () => {
  it('appends entries and returns the updated snapshot', async () => {
    const res = await request(app)
      .post('/api/queue/enqueue')
      .send({
        entries: [
          {
            id: 'e1',
            bookId: 'book-A',
            chapterId: 3,
            scope: 'this',
            addedAt: '2026-05-23T00:00:00.000Z',
          },
          {
            id: 'e2',
            bookId: 'book-B',
            chapterId: 1,
            scope: 'this',
            addedAt: '2026-05-23T00:00:01.000Z',
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { id: string; order: number }) => [e.id, e.order])).toEqual([
      ['e1', 0],
      ['e2', 1],
    ]);
  });

  it('rejects missing entries[]', async () => {
    const res = await request(app).post('/api/queue/enqueue').send({});
    expect(res.status).toBe(400);
  });

  it('rejects malformed entries', async () => {
    const res = await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A' /* missing chapterId */ }] });
    expect(res.status).toBe(400);
  });

  it('rejects scope=character without characterId', async () => {
    const res = await request(app)
      .post('/api/queue/enqueue')
      .send({
        entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'character' }],
      });
    expect(res.status).toBe(400);
  });

  it('409s on duplicate entry id', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    const dup = await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 2, scope: 'this' }] });
    expect(dup.status).toBe(409);
  });

  it('omits engine fields when the book is not on disk (legacy / unknown)', async () => {
    const res = await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    expect(res.status).toBe(200);
    const [entry] = res.body.entries;
    expect(entry.requiredEngines).toBeUndefined();
    expect(entry.multiTts).toBeUndefined();
  });

  it('stamps requiredEngines + multiTts=false for a single-engine chapter', async () => {
    const res = await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e-single', bookId: stampBookId, chapterId: 1, scope: 'this' }] });
    expect(res.status).toBe(200);
    const [entry] = res.body.entries;
    expect(entry.requiredEngines).toEqual(['kokoro']);
    expect(entry.multiTts).toBe(false);
  });

  it('stamps requiredEngines + multiTts=true for a mixed-engine chapter', async () => {
    const res = await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e-multi', bookId: stampBookId, chapterId: 2, scope: 'this' }] });
    expect(res.status).toBe(200);
    const [entry] = res.body.entries;
    expect(entry.requiredEngines).toEqual(['kokoro', 'qwen']);
    expect(entry.multiTts).toBe(true);
  });
});

describe('POST /api/queue/reorder', () => {
  it('reorders entries to match the desired order', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({
        entries: [
          { id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' },
          { id: 'e2', bookId: 'book-A', chapterId: 2, scope: 'this' },
          { id: 'e3', bookId: 'book-A', chapterId: 3, scope: 'this' },
        ],
      });
    const res = await request(app).post('/api/queue/reorder').send({ order: ['e3', 'e1', 'e2'] });
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { id: string }) => e.id)).toEqual(['e3', 'e1', 'e2']);
  });

  it('rejects a non-array body', async () => {
    const res = await request(app).post('/api/queue/reorder').send({ order: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  it('409s when the desired list does not match the current entries', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    const res = await request(app).post('/api/queue/reorder').send({ order: ['unknown'] });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/queue/pause', () => {
  it('flips the global paused flag', async () => {
    const r1 = await request(app).post('/api/queue/pause').send({ paused: true });
    expect(r1.status).toBe(200);
    expect(r1.body.paused).toBe(true);

    const r2 = await request(app).post('/api/queue/pause').send({ paused: false });
    expect(r2.status).toBe(200);
    expect(r2.body.paused).toBe(false);
  });

  it('rejects non-boolean payloads', async () => {
    const res = await request(app).post('/api/queue/pause').send({ paused: 'maybe' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/queue/:entryId', () => {
  it('removes a queued entry', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({
        entries: [
          { id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' },
          { id: 'e2', bookId: 'book-A', chapterId: 2, scope: 'this' },
        ],
      });
    const res = await request(app).delete('/api/queue/e1');
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { id: string }) => e.id)).toEqual(['e2']);
  });

  it('is idempotent (cancelling a missing entry returns 200 with current snapshot)', async () => {
    const res = await request(app).delete('/api/queue/missing-id');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });
});
