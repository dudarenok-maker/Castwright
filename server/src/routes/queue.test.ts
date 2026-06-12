/* Integration tests for the /api/queue routes (plan 102).
 *
 * Uses an isolated WORKSPACE_DIR per test run so the routes hit a real
 * (.queue.json) on disk via writeJsonAtomic. supertest drives the routes
 * the same way the chapter-audio / book-state test files do. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, afterEach } from 'vitest';
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
        { id: 'maerin', name: 'Maerin', ttsEngine: 'qwen' },
      ],
    }),
  );
  await saveAnalysisCache(STAMP_MANUSCRIPT_ID, {
    chapters: {
      1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
      2: [
        { id: 2, chapterId: 2, characterId: 'narrator', text: 'World.' },
        { id: 3, chapterId: 2, characterId: 'maerin', text: 'Hi there.' },
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
    expect(res.body).toEqual({ entries: [], paused: false, recycling: false });
  });

  describe('recycling flag', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns recycling:false when there is no active supervisor (autoStart off)', async () => {
      const supervisor = await import('../tts/sidecar-supervisor.js');
      vi.spyOn(supervisor, 'getActiveSupervisor').mockReturnValue(null);

      const res = await request(app).get('/api/queue');
      expect(res.status).toBe(200);
      expect(res.body.recycling).toBe(false);
    });

    it('returns recycling:true when the active supervisor reports recycling:true (child dead/respawning)', async () => {
      const supervisor = await import('../tts/sidecar-supervisor.js');
      vi.spyOn(supervisor, 'getActiveSupervisor').mockReturnValue({
        start: async () => {},
        stop: async () => {},
        current: () => null,
        recycling: () => true,
      });

      const res = await request(app).get('/api/queue');
      expect(res.status).toBe(200);
      expect(res.body.recycling).toBe(true);
    });

    it('returns recycling:false when the active supervisor reports recycling:false (sidecar ready, even if adopted)', async () => {
      const supervisor = await import('../tts/sidecar-supervisor.js');
      vi.spyOn(supervisor, 'getActiveSupervisor').mockReturnValue({
        start: async () => {},
        stop: async () => {},
        current: () => null, // null handle = adopted sidecar, but still ready
        recycling: () => false,
      });

      const res = await request(app).get('/api/queue');
      expect(res.status).toBe(200);
      expect(res.body.recycling).toBe(false);
    });
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
    const res = await request(app)
      .post('/api/queue/reorder')
      .send({ order: ['e3', 'e1', 'e2'] });
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
    const res = await request(app)
      .post('/api/queue/reorder')
      .send({ order: ['unknown'] });
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

describe('POST /api/queue/clear', () => {
  it('drops queued + failed but keeps in_progress by default', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({
        entries: [
          { id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' },
          { id: 'e2', bookId: 'book-A', chapterId: 2, scope: 'this' },
        ],
      });
    await request(app).post('/api/queue/e2/start'); // e2 → in_progress
    const res = await request(app).post('/api/queue/clear').send({});
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { id: string; status: string }) => [e.id, e.status])).toEqual([
      ['e2', 'in_progress'],
    ]);
  });

  it('drops everything with force (including in_progress)', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    await request(app).post('/api/queue/e1/start');
    const res = await request(app).post('/api/queue/clear').send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  it('leaves the paused flag untouched', async () => {
    await request(app).post('/api/queue/pause').send({ paused: true });
    const res = await request(app).post('/api/queue/clear').send({ force: true });
    expect(res.status).toBe(200);
    expect(res.body.paused).toBe(true);
  });
});

describe('POST /api/queue/:entryId/start', () => {
  it('marks the entry in_progress WITHOUT reordering (no order=0 pin)', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({
        entries: [
          { id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' },
          { id: 'e2', bookId: 'book-A', chapterId: 2, scope: 'this' },
        ],
      });
    /* Start the SECOND entry — under queue-sole concurrency we don't pin it to
       order 0, so e1 stays at order 0 and e2 stays at order 1. */
    const res = await request(app).post('/api/queue/e2/start');
    expect(res.status).toBe(200);
    expect(
      res.body.entries.map((e: { id: string; status: string; order: number }) => [
        e.id,
        e.status,
        e.order,
      ]),
    ).toEqual([
      ['e1', 'queued', 0],
      ['e2', 'in_progress', 1],
    ]);
  });

  it('allows MULTIPLE entries to be in_progress at once (no single-in-flight throw)', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({
        entries: [
          { id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' },
          { id: 'e2', bookId: 'book-B', chapterId: 1, scope: 'this' },
        ],
      });
    await request(app).post('/api/queue/e1/start');
    const res = await request(app).post('/api/queue/e2/start');
    expect(res.status).toBe(200);
    expect(
      res.body.entries.filter((e: { status: string }) => e.status === 'in_progress'),
    ).toHaveLength(2);
  });

  it('is idempotent for an already-in_progress entry', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    await request(app).post('/api/queue/e1/start');
    const res = await request(app).post('/api/queue/e1/start');
    expect(res.status).toBe(200);
    expect(res.body.entries[0].status).toBe('in_progress');
  });

  it('is a no-op for a missing entry id', async () => {
    const res = await request(app).post('/api/queue/missing/start');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });
});

describe('POST /api/queue/:entryId/complete', () => {
  it('drops an in_progress entry on completion (status-agnostic done-prune)', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({
        entries: [
          { id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' },
          { id: 'e2', bookId: 'book-A', chapterId: 2, scope: 'this' },
        ],
      });
    await request(app).post('/api/queue/e1/start');
    const res = await request(app).post('/api/queue/e1/complete');
    expect(res.status).toBe(200);
    /* e1 removed even though it was in_progress (unlike DELETE which 409s). */
    expect(res.body.entries.map((e: { id: string; order: number }) => [e.id, e.order])).toEqual([
      ['e2', 0],
    ]);
  });

  it('is idempotent for a missing entry id', async () => {
    const res = await request(app).post('/api/queue/missing/complete');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  it('outcome:failed keeps the entry as failed with the errorReason (lingers)', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    await request(app).post('/api/queue/e1/start');
    const res = await request(app)
      .post('/api/queue/e1/complete')
      .send({ outcome: 'failed', errorReason: 'sidecar 500' });
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({
      id: 'e1',
      status: 'failed',
      errorReason: 'sidecar 500',
    });
  });
});

describe('POST /api/queue/:entryId/retry', () => {
  it('re-queues a failed entry (status → queued, clears errorReason)', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    await request(app).post('/api/queue/e1/start');
    await request(app).post('/api/queue/e1/complete').send({ outcome: 'failed', errorReason: 'x' });
    const res = await request(app).post('/api/queue/e1/retry');
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({ id: 'e1', status: 'queued', errorReason: null });
  });

  it('is a no-op for a non-failed entry', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    const res = await request(app).post('/api/queue/e1/retry');
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({ id: 'e1', status: 'queued' });
  });
});

describe('loud-fallback gate endpoints', () => {
  /* Seed a parked (awaiting_confirm) entry directly on disk — the worker is the
     only thing that parks an entry in real life, so the routes are tested
     against a hand-seeded file. */
  async function seedParked(): Promise<void> {
    const { queueJsonPath } = await import('../workspace/paths.js');
    const { writeQueueFile } = await import('../workspace/queue-migrate.js');
    await writeQueueFile(queueJsonPath(), {
      entries: [
        {
          id: 'p1',
          bookId: 'book-A',
          chapterId: 1,
          scope: 'this',
          addedAt: '2026-05-23T00:00:00.000Z',
          status: 'awaiting_confirm',
          order: 0,
          fallbackCharacters: [{ id: 'wren', name: 'Wren' }],
        },
      ],
      paused: false,
    });
  }

  it('confirm-fallback flips awaiting_confirm → queued with fallbackConfirmed', async () => {
    await seedParked();
    const res = await request(app).post('/api/queue/p1/confirm-fallback');
    expect(res.status).toBe(200);
    expect(res.body.entries[0]).toMatchObject({
      id: 'p1',
      status: 'queued',
      fallbackConfirmed: true,
    });
  });

  it('skip-fallback removes the parked entry', async () => {
    await seedParked();
    const res = await request(app).post('/api/queue/p1/skip-fallback');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
  });

  it('confirm/skip are idempotent no-ops for a non-parked entry', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    const confirm = await request(app).post('/api/queue/e1/confirm-fallback');
    expect(confirm.status).toBe(200);
    expect(confirm.body.entries[0]).toMatchObject({ id: 'e1', status: 'queued' });
    const skip = await request(app).post('/api/queue/e1/skip-fallback');
    expect(skip.status).toBe(200);
    expect(skip.body.entries[0]).toMatchObject({ id: 'e1', status: 'queued' });
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

  it('409s when DELETE-ing an in_progress entry (user must pause first)', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] });
    await request(app).post('/api/queue/e1/start');
    const res = await request(app).delete('/api/queue/e1');
    expect(res.status).toBe(409);
  });

  it('force-removes a stuck in_progress entry with ?force=true (200)', async () => {
    await request(app)
      .post('/api/queue/enqueue')
      .send({
        entries: [
          { id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' },
          { id: 'e2', bookId: 'book-A', chapterId: 2, scope: 'this' },
        ],
      });
    await request(app).post('/api/queue/e1/start'); // e1 in_progress
    const res = await request(app).delete('/api/queue/e1?force=true');
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { id: string }) => e.id)).toEqual(['e2']);
  });

  it('is idempotent (cancelling a missing entry returns 200 with current snapshot)', async () => {
    const res = await request(app).delete('/api/queue/missing-id');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });
});
