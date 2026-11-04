/* #3713 / PR #4004 -- the reviewers' repros from passes 3 to 5, server half, against the blunt gate. Each one was
   a stale page (loaded before the repair) that some client-side step armed to write the other twin's snapshot
   over the twin that kept the id: a Library edit then a reopen (pass 4), a Voices Compare save retried after a
   read (pass 5), a kept save re-sent after the mini-player's keepalive flush (pass 3), a manuscript save queued
   during a full read (pass 4). Under the epoch rule no step the page can take earns it the right to write: it
   held no epoch (or a stale one) when it loaded, and nothing short of a reload gives it the current one. So
   every write is refused however many reads, keepalives and retries come first, and the kept twin's files stay
   byte-identical. The client half (it reloads once and sends nothing more) is `src/lib/repair-epoch.test.ts`.

   The real sweep, gate, `bookStateRouter` and `castSeriesPatchRouter` run in a temp workspace. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-stale-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  gate = await import('./repaired-book-gate.js');
  const { bookStateRouter } = await import('../routes/book-state.js');
  const { castSeriesPatchRouter } = await import('../routes/cast-series-patch.js');
  app = express();
  app.use(express.json());
  app.use('/api/books/:bookId', gate.repairedBookGate);
  app.use('/api/books', castSeriesPatchRouter);
  app.use('/api/books', bookStateRouter);
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

const ID = 'auth__ser__book';

/** `copy` sorts first (what a pre-repair page loaded under the id); `original` has the work and keeps it. */
function seed(folder: string, opts: { rendered: boolean; ageRange: string; warmth: number; rows: number }): string {
  const dir = join(paths.BOOKS_ROOT, 'Auth', 'Ser', folder);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId: ID, manuscriptId: `m_${folder.replace(/\s/g, '_')}`, title: folder, author: 'Auth', series: 'Ser', seriesPosition: 1,
      isStandalone: false, manuscriptFile: 'manuscript.md', castConfirmed: false, language: 'en',
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one', ...(opts.rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}) }],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  writeFileSync(
    paths.castJsonPath(dir),
    JSON.stringify({
      characters: Array.from({ length: opts.rows }, (_, i) => ({
        id: `c${i}`, name: `Winner ${i}`, gender: 'female', ageRange: opts.ageRange, tone: { warmth: opts.warmth, pace: 50 },
      })),
    }),
  );
  return dir;
}

let kept: string;

/** Every file a stale write could reach in the twin that kept the id. */
function keptFiles(): Record<string, string | null> {
  const edits = join(kept, '.audiobook', 'manuscript-edits.json');
  return {
    state: readFileSync(paths.stateJsonPath(kept), 'utf8'),
    cast: readFileSync(paths.castJsonPath(kept), 'utf8'),
    edits: existsSync(edits) ? readFileSync(edits, 'utf8') : null,
  };
}

/** The pre-repair page reads the id while it still names the copy, then the restart's sweep runs. */
async function stalePage(): Promise<{ copyState: Record<string, unknown> }> {
  seed('Book', { rendered: false, ageRange: 'teen', warmth: 10, rows: 1 });
  kept = seed('Book original', { rendered: true, ageRange: 'adult', warmth: 80, rows: 3 });
  const before = await request(app).get(`/api/books/${ID}/state`);
  expect(before.status).toBe(200);
  await sweep.repairDuplicateBookIds();
  expect(gate.isRepairedBook(ID)).toBe(true);
  /* A first read of the kept twin runs its lazy state.json migrations (titles, chapter uuids): a read's own
     housekeeping, not a write the page made. Settle it before the files are snapshotted. */
  expect((await request(app).get(`/api/books/${ID}/state`)).status).toBe(200);
  return { copyState: before.body };
}

/** What the pre-repair page does after the repair, short of a reload: it reads the book again (any number of
 *  times), and its mini-player sends the keepalive listen-stats flush. None of it changes what it may write. */
async function everythingButReload(): Promise<void> {
  for (let i = 0; i < 2; i++) expect((await request(app).get(`/api/books/${ID}/state`)).status).toBe(200);
  const keepalive = await request(app).put(`/api/books/${ID}/listen-stats`).send({ days: { '2026-11-01': 30 } });
  expect(keepalive.status).not.toBe(409); // a listener write is exempt...
}

for (const epoch of [undefined, 'epoch-of-an-earlier-boot']) {
  const label = epoch === undefined ? 'no epoch (an old bundle, or a page loaded before any repair)' : 'a stale epoch';
  const send = (r: request.Test): request.Test => (epoch === undefined ? r : r.set('X-Repair-Epoch', epoch));

  describe(`a page loaded before the repair, ${label} (#3713)`, () => {
    it('Library edit, then reopen and edit a character: every write refused, the kept twin byte-identical (pass 4)', async () => {
      await stalePage();
      const before = keptFiles();
      for (let i = 0; i < 4; i++) {
        const rename = await send(request(app).put(`/api/books/${ID}/state`)).send({ slice: 'state', patch: { title: 'Renamed original' } });
        expect(rename.status).toBe(409);
        expect(rename.body.code).toBe('book_repaired_reload');
      }
      await everythingButReload();
      const castEdit = await send(request(app).put(`/api/books/${ID}/state`)).send({
        slice: 'cast', patch: { characters: [{ id: 'c0', name: 'Edited' }] },
      });
      expect(castEdit.status).toBe(409);
      expect(keptFiles()).toEqual(before);
    });

    it('Voices Compare save, retried after a read: refused both times, ageRange and tone stay the kept twin\'s (pass 5)', async () => {
      await stalePage();
      const before = keptFiles();
      const compare = { gender: 'male', ageRange: 'teen', tone: { warmth: 10, pace: 50 } };
      expect((await send(request(app).post(`/api/books/${ID}/cast/c0/series-patch`)).send(compare)).status).toBe(409);
      await everythingButReload();
      expect((await send(request(app).post(`/api/books/${ID}/cast/c0/series-patch`)).send(compare)).status).toBe(409);
      expect(keptFiles()).toEqual(before);
      expect(JSON.parse(before.cast!).characters[0]).toMatchObject({ ageRange: 'adult', tone: { warmth: 80 } });
    });

    it('a save kept from before the restart, re-sent after the keepalive flush: refused (pass 3)', async () => {
      const { copyState } = await stalePage();
      const before = keptFiles();
      await everythingButReload();
      const base = (copyState as { sliceRevisions?: { state?: Record<string, string> } }).sliceRevisions?.state ?? {};
      const kept1 = await send(request(app).put(`/api/books/${ID}/state`)).send({
        slice: 'state', patch: { castConfirmed: true }, ...(base.castConfirmed ? { baseRevision: { castConfirmed: base.castConfirmed } } : {}),
      });
      expect(kept1.status).toBe(409);
      expect(kept1.body.code).toBe('book_repaired_reload');
      expect(keptFiles()).toEqual(before);
    });

    it('a manuscript save queued during a full read: refused, manuscript-edits untouched (pass 4)', async () => {
      await stalePage();
      const before = keptFiles();
      await everythingButReload();
      const ms = await send(request(app).put(`/api/books/${ID}/state`)).send({
        slice: 'manuscript', patch: { sentences: [{ id: 's1', chapterId: 1, characterId: 'c0', text: 'Text.' }] },
      });
      expect(ms.status).toBe(409);
      expect(keptFiles()).toEqual(before);
    });
  });
}

describe('the same writes from a page loaded after the repair pass the gate (#3713)', () => {
  it('the rename lands on the twin that kept the id', async () => {
    await stalePage();
    const res = await request(app)
      .put(`/api/books/${ID}/state`)
      .set('X-Repair-Epoch', gate.currentRepairEpoch()!)
      .send({ slice: 'state', patch: { castConfirmed: true } });
    expect(res.body.code).not.toBe('book_repaired_reload');
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    expect(JSON.parse(readFileSync(paths.stateJsonPath(kept), 'utf8')).castConfirmed).toBe(true);
  });
});
