/* #3713 / PR #4004 pass 3 -- the cast writers that name the book in the request BODY (or query)
   rather than the path: POST /library-cast/override, POST and DELETE /voice-library/:uuid/assign.
   The real sweep repairs a pair in a temp workspace and the real routers serve it. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-body-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  gate = await import('./repaired-book-gate.js');
  const { libraryCastOverrideRouter } = await import('../routes/library-cast-override.js');
  const { voiceLibraryRouter } = await import('../routes/voice-library.js');
  app = express();
  app.use(express.json());
  app.use('/api', libraryCastOverrideRouter);
  app.use('/api/voice-library', voiceLibraryRouter);
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
  sweep.__resetDuplicateBookIdRepairsForTest();
});
afterEach(() => sweep.__resetDuplicateBookIdRepairsForTest());

function seed(author: string, series: string, folder: string, bookId: string, opts: { rendered: boolean; rows: number; desc?: string }): string {
  const dir = join(paths.BOOKS_ROOT, author, series, folder);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId, manuscriptId: `m_${folder}`, title: folder, author, series, seriesPosition: 1,
      isStandalone: false, manuscriptFile: 'manuscript.md', castConfirmed: true, language: 'en',
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one', ...(opts.rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}) }],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  writeFileSync(
    paths.castJsonPath(dir),
    JSON.stringify({ characters: Array.from({ length: opts.rows }, (_, i) => ({ id: `c${i}`, name: `C${i}`, description: opts.desc ?? 'orig' })) }),
  );
  return dir;
}

const DUP = 'auth__ser__book';
const castOf = (dir: string) => JSON.parse(readFileSync(paths.castJsonPath(dir), 'utf8')).characters as Array<{ id: string; description?: string }>;
let kept: string;

async function repaired() {
  seed('Auth', 'Ser', 'Book', DUP, { rendered: false, rows: 1 });
  kept = seed('Auth', 'Ser', 'Book original', DUP, { rendered: true, rows: 5 });
  seed('Auth', 'Other', 'Other', 'auth__other__other', { rendered: false, rows: 1, desc: 'other book' });
  await sweep.repairDuplicateBookIds();
}

const overrideBody = { sourceBookId: 'auth__other__other', sourceCharacterId: 'c0', targetBookId: DUP, targetCharacterId: 'c0' };

describe('body-keyed cast writers are gated by the book they name (#3713)', () => {
  it('POST /library-cast/override naming a repaired book with no epoch answers 409 and writes nothing', async () => {
    await repaired();
    const before = readFileSync(paths.castJsonPath(kept), 'utf8');
    const res = await request(app).post('/api/library-cast/override').send(overrideBody);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_repaired_reload');
    expect(readFileSync(paths.castJsonPath(kept), 'utf8')).toBe(before);
  });

  it('the repaired book as the SOURCE is refused too', async () => {
    await repaired();
    const res = await request(app).post('/api/library-cast/override').send({
      sourceBookId: DUP, sourceCharacterId: 'c0', targetBookId: 'auth__other__other', targetCharacterId: 'c0',
    });
    expect(res.status).toBe(409);
  });

  it('with the current epoch it passes the gate and writes', async () => {
    await repaired();
    const res = await request(app).post('/api/library-cast/override').set('X-Repair-Epoch', gate.currentRepairEpoch()!).send(overrideBody);
    expect(res.status).toBe(200);
    expect(castOf(kept).find((c) => c.id === 'c0')?.description).toBe('other book');
  });

  it('the epoch must match exactly: a list that contains it is refused', async () => {
    await repaired();
    const epoch = gate.currentRepairEpoch()!;
    const res = await request(app).post('/api/library-cast/override').set('X-Repair-Epoch', `other,${epoch}`).send(overrideBody);
    expect(res.status).toBe(409);
  });

  it('a stale epoch is refused like none', async () => {
    await repaired();
    const res = await request(app).post('/api/library-cast/override').set('X-Repair-Epoch', 'nope').send(overrideBody);
    expect(res.status).toBe(409);
  });

  it('books that were not repaired are untouched by the gate', async () => {
    seed('Auth', 'Ser', 'Solo', 'auth__ser__solo', { rendered: false, rows: 1 });
    seed('Auth', 'Other', 'Other', 'auth__other__other', { rendered: false, rows: 1, desc: 'other book' });
    const res = await request(app).post('/api/library-cast/override').send({
      sourceBookId: 'auth__other__other', sourceCharacterId: 'c0', targetBookId: 'auth__ser__solo', targetCharacterId: 'c0',
    });
    expect(res.status).toBe(200);
  });

  it('POST /voice-library/:uuid/assign for a repaired bookId with no epoch is refused before anything else', async () => {
    await repaired();
    const res = await request(app).post('/api/voice-library/no-such-voice/assign').send({ bookId: DUP, characterId: 'c0' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_repaired_reload');
  });

  it('with the current epoch the assign gets past the gate (and fails later on the unknown voice, not 409)', async () => {
    await repaired();
    const res = await request(app).post('/api/voice-library/no-such-voice/assign').set('X-Repair-Epoch', gate.currentRepairEpoch()!).send({ bookId: DUP, characterId: 'c0' });
    expect(res.status).not.toBe(409);
  });

  it('DELETE /voice-library/:uuid/assign (book in the query) is gated the same way', async () => {
    await repaired();
    const res = await request(app).delete(`/api/voice-library/no-such-voice/assign?bookId=${DUP}&characterId=c0`);
    expect(res.status).toBe(409);
    const ok = await request(app).delete(`/api/voice-library/no-such-voice/assign?bookId=${DUP}&characterId=c0`).set('X-Repair-Epoch', gate.currentRepairEpoch()!);
    expect(ok.status).not.toBe(409);
  });

  it('a malformed body (no bookId) is not turned into a 409 by the gate', async () => {
    await repaired();
    const res = await request(app).post('/api/voice-library/x/assign').send({});
    expect(res.status).not.toBe(409);
  });
});
