/* #4029 item 1 -- POST /api/queue/:entryId/{start,retry,confirm-fallback} carry only an entry id, so the
   gate keys on the entry's OWN bookId. A stale tab's /start would strand a fresh page's entry for the repaired
   book in_progress; its fail+retry would requeue it. Refused without the current repair epoch, applied with
   it; an entry of an unrelated book, and an id that names no entry (idempotent), need none. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let root: string;
let app: Express;
let paths: typeof import('./paths.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');
let gate: typeof import('./repaired-book-gate.js');
let queueMigrate: typeof import('./queue-migrate.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-queue-entry-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  gate = await import('./repaired-book-gate.js');
  queueMigrate = await import('./queue-migrate.js');
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

beforeEach(() => {
  rmSync(paths.BOOKS_ROOT, { recursive: true, force: true });
  rmSync(paths.queueJsonPath(), { force: true });
  sweep.__resetDuplicateBookIdRepairsForTest();
});
afterEach(() => sweep.__resetDuplicateBookIdRepairsForTest());

function seed(folder: string, bookId: string): void {
  const dir = join(paths.BOOKS_ROOT, 'Auth', 'Ser', folder);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId, manuscriptId: `m_${folder}`, title: folder, author: 'Auth', series: 'Ser', seriesPosition: 1,
      isStandalone: false, manuscriptFile: 'manuscript.md', castConfirmed: true, language: 'en',
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  writeFileSync(paths.castJsonPath(dir), JSON.stringify({ characters: [{ id: 'c0', name: 'C0' }] }));
}

const DUP = 'auth__ser__book';
const OTHER = 'auth__ser__other';

async function repaired() {
  seed('Book', DUP);
  seed('Book original', DUP);
  seed('Other', OTHER);
  await sweep.repairDuplicateBookIds();
}

/** Put entries on disk in the given status (the routes under test start from these). */
async function seedQueue(entries: Array<{ id: string; bookId: string; status: string }>): Promise<void> {
  const before = await queueMigrate.readQueueFile(paths.queueJsonPath());
  await queueMigrate.writeQueueFile(paths.queueJsonPath(), {
    ...before,
    entries: entries.map((e, i) => ({
      id: e.id, bookId: e.bookId, chapterId: 1, scope: 'this', status: e.status, order: i, addedAt: '2026-01-01T00:00:00.000Z',
    })),
  } as never);
}
const statusOf = async (id: string) =>
  ((await request(app).get('/api/queue')).body.entries as Array<{ id: string; status: string }>).find((e) => e.id === id)?.status;

describe.each([
  ['start', 'queued', 'in_progress'],
  ['retry', 'failed', 'queued'],
  ['confirm-fallback', 'awaiting_confirm', 'queued'],
])('POST /api/queue/:entryId/%s on an entry of a repaired book (#4029)', (route, from, to) => {
  it('no epoch: 409 book_repaired_reload and the entry is unchanged', async () => {
    await repaired();
    await seedQueue([{ id: 'e1', bookId: DUP, status: from }]);
    const res = await request(app).post(`/api/queue/e1/${route}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_repaired_reload');
    expect(await statusOf('e1')).toBe(from);
  });

  it('a stale epoch is refused', async () => {
    await repaired();
    await seedQueue([{ id: 'e1', bookId: DUP, status: from }]);
    const res = await request(app).post(`/api/queue/e1/${route}`).set('X-Repair-Epoch', 'pre-repair');
    expect(res.status).toBe(409);
    expect(await statusOf('e1')).toBe(from);
  });

  it('with the current epoch the transition applies', async () => {
    await repaired();
    await seedQueue([{ id: 'e1', bookId: DUP, status: from }]);
    const res = await request(app).post(`/api/queue/e1/${route}`).set('X-Repair-Epoch', gate.currentRepairEpoch()!);
    expect(res.status).toBe(200);
    expect(await statusOf('e1')).toBe(to);
  });

  it('CONTROL: an entry of an unrelated book needs no epoch', async () => {
    await repaired();
    await seedQueue([{ id: 'e1', bookId: OTHER, status: from }]);
    const res = await request(app).post(`/api/queue/e1/${route}`);
    expect(res.status).toBe(200);
    expect(await statusOf('e1')).toBe(to);
  });

  it('CONTROL: an id that names no entry stays an idempotent 200', async () => {
    await repaired();
    const res = await request(app).post(`/api/queue/ghost/${route}`);
    expect(res.status).toBe(200);
  });
});
