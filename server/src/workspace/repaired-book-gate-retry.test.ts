/* #4029 pass 1 -- the retry of an unreadable gate file. (1) Concurrent gated requests that arrive while the first
   retry's read is in flight must AWAIT it, not pass ungated. (2) The retry inside refuseUnreadRepairedBooks is
   pinned through a route that reaches only that check (POST /api/queue/enqueue). */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import type { Request, Response } from 'express';
import request from 'supertest';

let root: string;
let app: Express;
let paths: typeof import('./paths.js');
let gate: typeof import('./repaired-book-gate.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-retry-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  gate = await import('./repaired-book-gate.js');
  const { queueRouter } = await import('../routes/queue.js');
  app = express();
  app.use(express.json());
  app.use('/api/books/:bookId', gate.repairedBookGate);
  app.post('/api/books/:bookId/x', (_req, res) => res.json({ ok: true }));
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
  vi.useRealTimers();
  gate.__clearRepairedBookGateMemoryForTest();
  rmSync(paths.repairedBookGateJsonPath(), { recursive: true, force: true });
  rmSync(paths.queueJsonPath(), { force: true });
});

/* A directory where the file should be: readFile fails with EISDIR -- the "exists but unreadable" shape. */
async function unreadableThenRestored(...ids: string[]): Promise<void> {
  const file = paths.repairedBookGateJsonPath();
  gate.__clearRepairedBookGateMemoryForTest();
  rmSync(file, { recursive: true, force: true });
  mkdirSync(file, { recursive: true });
  await gate.loadRepairedBookGate();
  expect(gate.gatedBookIds()).toEqual([]);
  rmSync(file, { recursive: true, force: true });
  writeFileSync(
    file,
    JSON.stringify({ version: 2, epoch: 'ep-file', entries: ids.map((bookId) => ({ bookId, repairedAt: new Date().toISOString() })), manuscripts: [] }),
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);
}

const noEpoch = { get: () => undefined } as unknown as Request;
const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as Response & typeof res;
};
const enqueueBody = (id: string) => ({ entries: [{ id, bookId: 'kept', chapterId: 1, scope: 'this' }] });

describe('concurrent gated requests during the retry read (#4029)', () => {
  it('two simultaneous refuseUnreadRepairedBooks calls both refuse', async () => {
    await unreadableThenRestored('kept');
    const [a, b] = await Promise.all([
      gate.refuseUnreadRepairedBooks(['kept'], noEpoch, makeRes()),
      gate.refuseUnreadRepairedBooks(['kept'], noEpoch, makeRes()),
    ]);
    expect({ a, b }).toEqual({ a: true, b: true });
  });

  it('two simultaneous no-epoch POST /api/queue/enqueue both answer 409', async () => {
    await unreadableThenRestored('kept');
    const [x, y] = await Promise.all([
      request(app).post('/api/queue/enqueue').send(enqueueBody('q1')),
      request(app).post('/api/queue/enqueue').send(enqueueBody('q2')),
    ]);
    expect([x.status, y.status]).toEqual([409, 409]);
  });

  it('two simultaneous writes through the mounted /api/books/:bookId gate both answer 409', async () => {
    await unreadableThenRestored('kept');
    const [x, y] = await Promise.all([request(app).post('/api/books/kept/x'), request(app).post('/api/books/kept/x')]);
    expect([x.status, y.status]).toEqual([409, 409]);
  });
});
