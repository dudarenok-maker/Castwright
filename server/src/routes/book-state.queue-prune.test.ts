/* Plan 102 — book-delete prunes matching queue entries atomically.
 *
 * Standalone test for the queue-prune hook on DELETE /api/books/:bookId
 * (book-state.ts:910-927 + new hook). Other book-state tests live in
 * book-state.test.ts / book-state.hydrate.test.ts / etc. — this one is
 * isolated so the plan-102 contract has its own focused regression. */

import { describe, it, expect, beforeAll, afterAll, onTestFinished } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE_A = 'Delete Me';
const TITLE_B = 'Keep Me';

let workspaceRoot: string;
let app: Express;
let bookIdA: string;
let bookIdB: string;

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'queue-prune-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ bookStateRouter }, { makeBookId }] = await Promise.all([
    import('./book-state.js'),
    import('../workspace/paths.js'),
  ]);
  bookIdA = makeBookId(AUTHOR, SERIES, TITLE_A);
  bookIdB = makeBookId(AUTHOR, SERIES, TITLE_B);

  for (const title of [TITLE_A, TITLE_B]) {
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: makeBookId(AUTHOR, SERIES, title),
        manuscriptId: `m_${title.toLowerCase().replace(/\s+/g, '_')}`,
        title,
        author: AUTHOR,
        series: SERIES,
        updatedAt: '2026-05-23T00:00:00.000Z',
        schema: 1,
        chapters: [],
      }),
    );
  }

  app = express();
  app.use(express.json());
  app.use('/api/books', bookStateRouter);
});

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('DELETE /api/books/:bookId prunes queue entries', () => {
  it('drops every entry matching the deleted bookId, leaves other books alone', async () => {
    const { queueJsonPath } = await import('../workspace/paths.js');
    const { writeQueueFile, readQueueFile } = await import('../workspace/queue-migrate.js');

    /* Seed the workspace queue with three entries: 2 from book A, 1 from
       book B. */
    await writeQueueFile(queueJsonPath(), {
      entries: [
        {
          id: 'a1',
          bookId: bookIdA,
          chapterId: 1,
          scope: 'this',
          addedAt: '2026-05-23T00:00:00.000Z',
          status: 'queued',
          order: 0,
        },
        {
          id: 'b1',
          bookId: bookIdB,
          chapterId: 1,
          scope: 'this',
          addedAt: '2026-05-23T00:00:01.000Z',
          status: 'queued',
          order: 1,
        },
        {
          id: 'a2',
          bookId: bookIdA,
          chapterId: 2,
          scope: 'this',
          addedAt: '2026-05-23T00:00:02.000Z',
          status: 'queued',
          order: 2,
        },
      ],
      paused: false,
    });

    /* Delete book A. */
    const res = await request(app).delete(`/api/books/${bookIdA}`);
    expect(res.status).toBe(204);

    /* Book A's directory is gone. */
    expect(existsSync(join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE_A))).toBe(false);
    /* Book B's directory remains. */
    expect(existsSync(join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE_B))).toBe(true);

    /* Queue has only b1 left, renumbered to order 0. */
    const queue = await readQueueFile(queueJsonPath());
    expect(queue.entries).toHaveLength(1);
    expect(queue.entries[0]).toMatchObject({ id: 'b1', bookId: bookIdB, order: 0 });
  });

  it('does not error when the queue file is empty or absent on delete', async () => {
    const { queueJsonPath } = await import('../workspace/paths.js');
    const { rm } = await import('node:fs/promises');
    await rm(queueJsonPath(), { force: true });

    /* Re-seed book B so the delete actually finds something to drop. */
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE_B);
    if (!existsSync(bookDir)) {
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      const { makeBookId } = await import('../workspace/paths.js');
      writeFileSync(
        join(bookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: makeBookId(AUTHOR, SERIES, TITLE_B),
          manuscriptId: 'm_keep_me_2',
          title: TITLE_B,
          author: AUTHOR,
          series: SERIES,
          updatedAt: '2026-05-23T00:00:00.000Z',
          schema: 1,
          chapters: [],
        }),
      );
    }

    /* Should succeed with no queue file present. */
    const res = await request(app).delete(`/api/books/${bookIdB}`);
    expect(res.status).toBe(204);
  });
});

/* #4244 -- a timed-out attempt is not cancelled by vitest: its loop keeps running and its in-flight requests land after
   the retry's queue reset (a foreign "n8:queued" in the retry's round 0). Each attempt therefore carries a stop flag and
   the promise of its current round, and onTestFinished drains it, so a finished attempt leaves nothing behind. */
interface PruneAttempt { stopped: boolean; inFlight: Promise<unknown>; roundsStarted: number }

function runPruneRound(attempt: PruneAttempt, round: number): Promise<void> {
  attempt.roundsStarted++;
  /* The WHOLE round is tracked (set synchronously, before the first await), so a reset parked behind the queue lock is
     already in inFlight when the attempt is stopped. */
  const roundPromise = (async (): Promise<void> => {
    const { queueJsonPath, makeBookId } = await import('../workspace/paths.js');
    const { writeQueueFile, readQueueFile } = await import('../workspace/queue-migrate.js');
    const { serializeQueueMutation } = await import('../workspace/queue-mutex.js');
    const { queueRouter } = await import('./queue.js');
    const queueApp = express();
    queueApp.use(express.json());
    queueApp.use('/api/queue', queueRouter);
    const title = 'Prune Race';
    const bookId = makeBookId(AUTHOR, SERIES, title);
    const e = (id: string, bid: string, order: number) => ({
      id, bookId: bid, chapterId: order + 1, scope: 'this' as const, addedAt: '2026-05-23T00:00:00.000Z', status: 'queued' as const, order,
    });
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId, manuscriptId: 'm_prune_race', title, author: AUTHOR, series: SERIES,
        updatedAt: '2026-05-23T00:00:00.000Z', schema: 1, chapters: [],
      }),
    );
    /* Serialised so the reset orders behind any mutation already in the queue chain. This is the SECOND layer: it is
       reached only when the drain in stopAttempt gives up (a stale round outliving hookTimeout), the drain being the
       layer that also covers a stale request still in its pre-lock prep. No test pins it: making this a bare
       writeQueueFile keeps the suite green. */
    await serializeQueueMutation(() => writeQueueFile(queueJsonPath(), {
      entries: [e('p1', bookId, 0), e('k1', 'keep-book', 1), e('k2', 'keep-book', 2)],
      paused: false,
    }));
    /* A stopped attempt must not start new requests. */
    if (attempt.stopped) return;
    /* allSettled, not all: the drain must wait for EVERY request, and Promise.all gives up on the first rejection. */
    const rs = await Promise.allSettled([
      request(app).delete(`/api/books/${bookId}`),
      request(queueApp).post('/api/queue/k1/start'),
      request(queueApp).post('/api/queue/pause').send({ paused: true }),
      request(queueApp).post('/api/queue/enqueue').send({ entries: [{ id: `n${round}`, bookId: 'keep-book', chapterId: 9, scope: 'this' }] }),
    ]);
    /* A stopped attempt is already reported by vitest; its assertions must not throw into nothing. */
    if (attempt.stopped) return;
    expect(rs.map((r) => (r.status === 'fulfilled' ? r.value.status : String(r.reason)))).toEqual([204, 200, 200, 200]);
    const q = await readQueueFile(queueJsonPath());
    expect(q.paused).toBe(true);
    expect(q.entries.map((x) => `${x.id}:${x.status}`).sort()).toEqual(['k1:in_progress', 'k2:queued', `n${round}:queued`].sort());
  })();
  attempt.inFlight = roundPromise;
  return roundPromise;
}

async function stopAttempt(attempt: PruneAttempt): Promise<void> {
  attempt.stopped = true;
  await attempt.inFlight.catch(() => undefined);
}

/* The loop and the onTestFinished registration, shared by the same-tick case and the gating A/B pair. Each
   line of the stop/drain wiring is pinned by its own test: deleting `if (attempt.stopped) return;` fails "a
   stopped attempt starts no further round", and deleting the onTestFinished registration fails test B. */
function runPruneAttempt(rounds: number): { attempt: PruneAttempt; done: Promise<void> } {
  const attempt: PruneAttempt = { stopped: false, inFlight: Promise.resolve(), roundsStarted: 0 };
  onTestFinished(() => stopAttempt(attempt));
  const done = (async (): Promise<void> => {
    for (let round = 0; round < rounds; round++) {
      if (attempt.stopped) return;
      await runPruneRound(attempt, round);
    }
  })();
  return { attempt, done };
}

/* #4034 -- the prune is a read -> write on the shared queue file, so it goes through serializeQueueMutation. Moving
   its read above the span would let a same-tick queue write land between that read and the prune's write and be
   erased by it. */
describe('DELETE /api/books/:bookId prune is serialised against other queue writes (#4034)', () => {
  it('a same-tick /start, /pause and enqueue all survive the prune', async () => {
    await runPruneAttempt(10).done;
  });

  /* #4244 -- the gating A/B pair for the leak, with no timeout and no retry. A ends with its round still parked behind
     the queue lock, standing in for an attempt that timed out mid-round; onTestFinished must drain it before B starts.
     B then runs a clean attempt: without the stop/drain wiring A's stale round lands in B's queue (a foreign
     "n0:queued"), which B's round assertions reject. B therefore depends on A having run immediately before it, which
     is why the two tests must stay adjacent and in this order (tests in a file run in declaration order). */
  describe('A/B pair', () => {
    it('A: an attempt ends with its round parked behind the queue lock (#4244)', async () => {
      const { serializeQueueMutation } = await import('../workspace/queue-mutex.js');
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      void serializeQueueMutation(() => gate);
      /* Not awaited: the attempt is still running when this test ends. The gate frees while its drain waits. */
      runPruneAttempt(2);
      setTimeout(release, 50);
    });

    it('B: the next test sees nothing the previous attempt started (#4244)', async () => {
      const { queueJsonPath } = await import('../workspace/paths.js');
      const { rm } = await import('node:fs/promises');
      onTestFinished(() => rm(queueJsonPath(), { force: true }));
      await runPruneAttempt(2).done;
    });
  });

  /* #4244 -- timer-free pin on the loop's stop check: a stopped attempt starts no further round. */
  it('a stopped attempt starts no further round (#4244)', async () => {
    const { queueJsonPath } = await import('../workspace/paths.js');
    const { serializeQueueMutation } = await import('../workspace/queue-mutex.js');
    const { rm } = await import('node:fs/promises');
    onTestFinished(() => rm(queueJsonPath(), { force: true }));

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const held = serializeQueueMutation(() => gate);
    const { attempt, done } = runPruneAttempt(10);
    const drained = stopAttempt(attempt);
    release();
    await held;
    await drained;
    await done;
    expect(attempt.roundsStarted).toBe(1);
  });
});

/* #4244 -- deterministic proof that a stopped attempt drains. The queue lock is held open with a gate, so the round's
   serialised reset parks behind it: the stand-in for "an attempt timed out while its requests were in flight". */
describe('a stopped prune-race attempt drains (#4244)', () => {
  it('a stopped attempt drains: nothing it started lands after stopAttempt resolves (#4244)', async () => {
    const { queueJsonPath } = await import('../workspace/paths.js');
    const { readQueueFile } = await import('../workspace/queue-migrate.js');
    const { serializeQueueMutation } = await import('../workspace/queue-mutex.js');
    const { rm } = await import('node:fs/promises');
    onTestFinished(() => rm(queueJsonPath(), { force: true }));

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    /* Released on failure too: a failed assertion before release() would leave the module queue chain blocked and hang
       the tests after this one. A second release() is a no-op. */
    onTestFinished(() => release());
    const held = serializeQueueMutation(() => gate);

    const attempt: PruneAttempt = { stopped: false, inFlight: Promise.resolve(), roundsStarted: 0 };
    const stale = runPruneRound(attempt, 0);
    const drained = stopAttempt(attempt);
    let drainedEarly = false;
    void drained.then(() => { drainedEarly = true; });
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    expect(drainedEarly).toBe(false);

    release();
    await held;
    await drained;
    await expect(stale).resolves.toBeUndefined();

    const snapshot = await readQueueFile(queueJsonPath());
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    const after = await readQueueFile(queueJsonPath());
    expect(after).toEqual(snapshot);
    expect(snapshot.entries.map((x) => `${x.id}:${x.status}`).filter((s) => s.startsWith('n0'))).toEqual([]);
  });

  /* A request that fails at socket level must not end the drain early: the other requests are still running, and the
     drain has to wait for every one of them to settle. */
  it('does not resolve while the other requests are in flight when one rejects at socket level (#4244)', async () => {
    const { queueJsonPath } = await import('../workspace/paths.js');
    const { readQueueFile } = await import('../workspace/queue-migrate.js');
    const { serializeQueueMutation } = await import('../workspace/queue-mutex.js');
    const { rm } = await import('node:fs/promises');
    onTestFinished(() => rm(queueJsonPath(), { force: true }));

    /* The DELETE alone is answered by a router that kills the socket; the three queue requests hit the real router. */
    const realApp = app;
    let deleteHit!: () => void;
    const deleteSeen = new Promise<void>((r) => { deleteHit = r; });
    const failingApp = express();
    failingApp.delete('/api/books/:bookId', (req) => {
      deleteHit();
      req.socket.destroy();
    });
    app = failingApp;
    onTestFinished(() => { app = realApp; });

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const held = serializeQueueMutation(() => gate);

    const attempt: PruneAttempt = { stopped: false, inFlight: Promise.resolve(), roundsStarted: 0 };
    const round = runPruneRound(attempt, 0);
    release();
    await held;
    /* The round's four requests are now in flight; stop the attempt while they are. */
    await deleteSeen;
    await stopAttempt(attempt);
    await round.catch(() => undefined);

    const atDrain = await readQueueFile(queueJsonPath());
    await new Promise((r) => setTimeout(r, 300));
    const later = await readQueueFile(queueJsonPath());
    expect(later).toEqual(atDrain);
    /* The enqueue ran to completion before the drain resolved. */
    expect(atDrain.entries.map((x) => x.id)).toContain('n0');
  });
});
