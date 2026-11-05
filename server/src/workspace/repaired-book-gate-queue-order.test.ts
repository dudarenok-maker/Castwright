/* #4029 pass 1 -- the queue routes that gate on an entry's own bookId must settle the gate-file retry BEFORE they
   read queue.json. The retry can span a gate-file read plus an fsync'd persist; an await between the queue read and
   its write would let a concurrent queue write be reverted by the stale snapshot. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const events: string[] = [];
vi.mock('./repaired-book-gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./repaired-book-gate.js')>();
  return {
    ...real,
    retryUnreadableGate: async () => {
      events.push('retry:start');
      await real.retryUnreadableGate();
      events.push('retry:end');
    },
  };
});
vi.mock('./queue-migrate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./queue-migrate.js')>();
  return {
    ...real,
    readQueueFile: async (p: string) => {
      events.push('read');
      return real.readQueueFile(p);
    },
  };
});

let root: string;
let app: Express;
let paths: typeof import('./paths.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-queue-order-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  const { queueRouter } = await import('../routes/queue.js');
  app = express();
  app.use(express.json());
  app.use('/api/queue', queueRouter);
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  events.length = 0;
  rmSync(paths.queueJsonPath(), { force: true });
});

it('POST /api/queue/clear settles the gate retry before it reads the queue file', async () => {
  await request(app).post('/api/queue/clear').send({});
  expect(events.indexOf('retry:end')).toBeGreaterThanOrEqual(0);
  expect(events.indexOf('read')).toBeGreaterThan(events.indexOf('retry:end'));
});

describe.each(['start', 'retry', 'confirm-fallback', 'complete', 'skip-fallback'])('POST /api/queue/:entryId/%s (#4029)', (route) => {
  it('settles the gate retry before it reads the queue file', async () => {
    await request(app).post(`/api/queue/e1/${route}`);
    expect(events.indexOf('read')).toBeGreaterThan(events.indexOf('retry:end'));
    expect(events.indexOf('retry:end')).toBeGreaterThanOrEqual(0);
  });
});

it('DELETE /api/queue/:entryId settles the gate retry before it reads the queue file', async () => {
  await request(app).delete('/api/queue/e1');
  expect(events.indexOf('retry:end')).toBeGreaterThanOrEqual(0);
  expect(events.indexOf('read')).toBeGreaterThan(events.indexOf('retry:end'));
});
