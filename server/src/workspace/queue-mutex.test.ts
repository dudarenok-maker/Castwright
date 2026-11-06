/* #4029 pass 3 -- every `.queue.json` read-modify-write goes through one chain. Before, the queue routes did
   read -> (await) -> write on their own, so two near-simultaneous requests each read the same snapshot and the later
   write dropped the earlier one: two concurrent /start lost a flip, and a clear erased a fresh enqueue (past the gate). */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let root: string;
let app: Express;
let paths: typeof import('./paths.js');
let gate: typeof import('./repaired-book-gate.js');
let qm: typeof import('./queue-migrate.js');
let mutex: typeof import('./queue-mutex.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-queue-mutex-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  gate = await import('./repaired-book-gate.js');
  qm = await import('./queue-migrate.js');
  mutex = await import('./queue-mutex.js');
  const { queueRouter } = await import('../routes/queue.js');
  app = express();
  app.use(express.json());
  app.use('/api/queue', queueRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  gate.__clearRepairedBookGateMemoryForTest();
  rmSync(paths.repairedBookGateJsonPath(), { recursive: true, force: true });
  rmSync(paths.queueJsonPath(), { force: true });
});

const entry = (id: string, bookId: string, status: string, order: number) => ({
  id, bookId, chapterId: order + 1, scope: 'this', status, order, addedAt: '2026-01-01T00:00:00.000Z',
});
async function seed(entries: Array<ReturnType<typeof entry>>): Promise<void> {
  await qm.writeQueueFile(paths.queueJsonPath(), { entries, paused: false } as never);
}
const onDisk = () => (JSON.parse(readFileSync(paths.queueJsonPath(), 'utf8')) as { entries: Array<{ id: string; status: string }> }).entries;
const enqueueBody = (id: string, bookId: string) => ({ entries: [{ id, bookId, chapterId: 1, scope: 'this' }] });

async function gateKept(): Promise<string> {
  gate.__clearRepairedBookGateMemoryForTest();
  writeFileSync(
    paths.repairedBookGateJsonPath(),
    JSON.stringify({ version: 2, epoch: 'ep-file', entries: [{ bookId: 'kept', repairedAt: new Date().toISOString() }], manuscripts: [] }),
  );
  await gate.loadRepairedBookGate();
  expect(gate.gatedBookIds()).toEqual(['kept']);
  return gate.currentRepairEpoch()!;
}

describe('serializeQueueMutation', () => {
  it('runs overlapping mutations one after the other, in call order, and returns each result', async () => {
    const events: string[] = [];
    const slow = mutex.serializeQueueMutation(async () => {
      events.push('a:start');
      await new Promise((r) => setTimeout(r, 20));
      events.push('a:end');
      return 'a';
    });
    const fast = mutex.serializeQueueMutation(async () => {
      events.push('b:start');
      return 'b';
    });
    expect(await Promise.all([slow, fast])).toEqual(['a', 'b']);
    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
  });

  it('a mutation that throws rejects its own caller but does not wedge the next', async () => {
    await expect(mutex.serializeQueueMutation(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(mutex.serializeQueueMutation(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('queue routes are serialised (#4029 pass 3)', () => {
  it('two concurrent /start calls both land (the dispatcher fires both claims in one tick)', async () => {
    for (let round = 0; round < 15; round++) {
      await seed([entry('e1', 'other', 'queued', 0), entry('e2', 'other', 'queued', 1)]);
      await Promise.all([request(app).post('/api/queue/e1/start'), request(app).post('/api/queue/e2/start')]);
      expect(onDisk().map((e) => `${e.id}:${e.status}`)).toEqual(['e1:in_progress', 'e2:in_progress']);
    }
  });

  it('a clear and an enqueue in the same tick resolve to one of the two serial outcomes', async () => {
    for (let round = 0; round < 15; round++) {
      await seed([entry('e3', 'other', 'queued', 0)]);
      const [c, q] = await Promise.all([
        request(app).post('/api/queue/clear').send({ force: true }),
        request(app).post('/api/queue/enqueue').send(enqueueBody('n', 'other')),
      ]);
      expect([c.status, q.status]).toEqual([200, 200]);
      // clear-then-enqueue leaves [n]; enqueue-then-clear leaves []. Never the old e3.
      const left = onDisk().map((e) => e.id);
      expect([[], ['n']]).toContainEqual(left);
    }
  });

  it('a fresh page\'s enqueue for a repaired book is never silently erased by a stale no-epoch clear', async () => {
    const epoch = await gateKept();
    for (let delay = 0; delay <= 4; delay++) {
      for (let round = 0; round < 6; round++) {
        await seed([entry('e3', 'other', 'queued', 0)]);
        const q = request(app).post('/api/queue/enqueue').set('X-Repair-Epoch', epoch).send(enqueueBody('n', 'kept')).then((r) => r);
        await new Promise((r) => setTimeout(r, delay));
        const c = await request(app).post('/api/queue/clear').send({ force: true });
        const qq = await q;
        expect(qq.status).toBe(200);
        const left = onDisk().map((e) => e.id);
        // Serial outcomes only: enqueue first -> the clear sees a repaired entry and is refused (409, both stay);
        // clear first -> it drops e3, then the enqueue lands. An accepted enqueue is never lost.
        expect(left).toContain('n');
        if (c.status === 200) expect(left).toEqual(['n']);
        else {
          expect(c.status).toBe(409);
          expect(left).toEqual(['e3', 'n']);
        }
      }
    }
  });
});

describe('every serialised queue site holds its read inside the span (#4034)', () => {
  /* One tick, one entry per site. Moving any handler's `readQueueFile` above its `serializeQueueMutation` makes
     that handler work from a snapshot taken before the others wrote, so its write drops their change. The
     distinct-entry design means every serial order ends in the same final file, so a lost update is unambiguous. */
  it('start / complete / retry / confirm-fallback / skip-fallback / DELETE / enqueue / pause in one tick all land', async () => {
    for (let round = 0; round < 10; round++) {
      await seed([
        entry('s1', 'other', 'queued', 0),
        entry('c1', 'other', 'in_progress', 1),
        entry('f1', 'other', 'failed', 2),
        entry('a1', 'other', 'awaiting_confirm', 3),
        entry('a2', 'other', 'awaiting_confirm', 4),
        entry('d1', 'other', 'queued', 5),
      ]);
      const rs = await Promise.all([
        request(app).post('/api/queue/s1/start'),
        request(app).post('/api/queue/c1/complete'),
        request(app).post('/api/queue/f1/retry'),
        request(app).post('/api/queue/a1/confirm-fallback'),
        request(app).post('/api/queue/a2/skip-fallback'),
        request(app).delete('/api/queue/d1'),
        request(app).post('/api/queue/enqueue').send(enqueueBody(`n${round}`, 'other')),
        request(app).post('/api/queue/pause').send({ paused: true }),
      ]);
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
      const file = JSON.parse(readFileSync(paths.queueJsonPath(), 'utf8')) as { paused: boolean };
      expect(file.paused).toBe(true);
      expect(onDisk().map((e) => `${e.id}:${e.status}`).sort()).toEqual(
        ['a1:queued', 'f1:queued', `n${round}:queued`, 's1:in_progress'].sort(),
      );
    }
  });

  it('reorder and a start in the same tick both land', async () => {
    for (let round = 0; round < 10; round++) {
      await seed([entry('r1', 'other', 'queued', 0), entry('r2', 'other', 'queued', 1), entry('r3', 'other', 'queued', 2)]);
      const rs = await Promise.all([
        request(app).post('/api/queue/reorder').send({ order: ['r3', 'r1', 'r2'] }),
        request(app).post('/api/queue/r2/start'),
      ]);
      /* Either serial order is legal: reorder first lands both changes; start first makes reorder refuse (409) because
         an in_progress entry may not move, and then only the start lands. A hoisted read loses one of them either way. */
      expect(rs[1].status).toBe(200);
      expect([200, 409]).toContain(rs[0].status);
      expect(onDisk().map((e) => `${e.id}:${e.status}`)).toEqual(
        rs[0].status === 200 ? ['r3:queued', 'r1:queued', 'r2:in_progress'] : ['r1:queued', 'r2:in_progress', 'r3:queued'],
      );
    }
  });
});
