/* #3713 / PR #4004 pass 6 -- POST /api/queue/enqueue names its book in the BODY, so the path gate cannot see
   it. A stale page's Regenerate on the repaired id would leave a queue entry the dispatcher later claims and
   renders onto the twin that kept the id. Refused whole without the current repair epoch; accepted with it;
   an unrelated book is never refused. The real sweep repairs a pair in a temp workspace and the real queue
   router serves it. */
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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-queue-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  gate = await import('./repaired-book-gate.js');
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

const entry = (id: string, bookId: string) => ({ id, bookId, chapterId: 1, scope: 'this' });
const queued = async () => (await request(app).get('/api/queue')).body.entries as Array<{ id: string }>;

describe('POST /api/queue/enqueue with a repaired bookId (#3713, pass 6)', () => {
  it('no epoch: 409 book_repaired_reload and nothing is queued', async () => {
    await repaired();
    const res = await request(app).post('/api/queue/enqueue').send({ entries: [entry('e1', DUP)] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_repaired_reload');
    expect(await queued()).toEqual([]);
  });

  it('a batch naming one repaired book is refused whole', async () => {
    await repaired();
    const res = await request(app).post('/api/queue/enqueue').send({ entries: [entry('e1', OTHER), entry('e2', DUP)] });
    expect(res.status).toBe(409);
    expect(await queued()).toEqual([]);
  });

  it('a stale epoch is refused', async () => {
    await repaired();
    const res = await request(app).post('/api/queue/enqueue').set('X-Repair-Epoch', 'pre-repair').send({ entries: [entry('e1', DUP)] });
    expect(res.status).toBe(409);
  });

  it('with the current epoch the entry is queued', async () => {
    await repaired();
    const res = await request(app).post('/api/queue/enqueue').set('X-Repair-Epoch', gate.currentRepairEpoch()!).send({ entries: [entry('e1', DUP)] });
    expect(res.status).toBe(200);
    expect((await queued()).map((e) => e.id)).toEqual(['e1']);
  });

  it('CONTROL: an unrelated book needs no epoch', async () => {
    await repaired();
    const res = await request(app).post('/api/queue/enqueue').send({ entries: [entry('e1', OTHER)] });
    expect(res.status).toBe(200);
  });
});
