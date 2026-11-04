/* #3713 / PR #4004 pass 3 (owner decision) -- the repaired-id gate outlives a restart and
   never lapses (owner decision, pass 6). The real sweep repairs a pair in a temp workspace; a "restart" is the gate's
   in-memory state being dropped and re-read from the file the sweep persisted. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-persist-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  gate = await import('./repaired-book-gate.js');
  const { bookStateRouter } = await import('../routes/book-state.js');
  app = express();
  app.use(express.json());
  app.use('/api/books/:bookId', gate.repairedBookGate);
  app.use('/api/manuscripts/:id', gate.repairedManuscriptGate);
  app.post('/api/manuscripts/:id/analysis', (_req, res) => res.status(202).end());
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
afterEach(() => {
  vi.useRealTimers();
  sweep.__resetDuplicateBookIdRepairsForTest();
});

function seed(folder: string, opts: { ms: string; rendered: boolean; rows: number }): string {
  const dir = join(paths.BOOKS_ROOT, 'Auth', 'Ser', folder);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId: 'auth__ser__book', manuscriptId: opts.ms, title: 'Book', author: 'Auth', series: 'Ser', seriesPosition: 1,
      isStandalone: false, manuscriptFile: 'manuscript.md', castConfirmed: true, language: 'en',
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one', ...(opts.rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}) },
      ],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  writeFileSync(
    paths.castJsonPath(dir),
    JSON.stringify({ characters: Array.from({ length: opts.rows }, (_, i) => ({ id: `c${i}`, name: `C${i}` })) }),
  );
  return dir;
}

async function repairedPair(sharedMs = false) {
  seed('Book', { ms: 'm_copy', rendered: false, rows: 1 });
  seed('Book original', { ms: sharedMs ? 'm_copy' : 'm_original', rendered: true, rows: 5 });
  const [repair] = await sweep.repairDuplicateBookIds();
  return repair;
}

const DAY = 24 * 3600 * 1000;
const delStatus = async () => (await request(app).delete('/api/books/auth__ser__book')).status;

describe('the repaired-id gate across a restart (#3713)', () => {
  it('survives a restart: the persisted ids are re-read and writes are refused again', async () => {
    await repairedPair();
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate();
    expect(await delStatus()).toBe(409);
  });

  it('keeps the same epoch across the restart (a page loaded before it keeps writing)', async () => {
    await repairedPair();
    const epoch = gate.currentRepairEpoch();
    expect(epoch).toBeTruthy();
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate();
    expect(gate.currentRepairEpoch()).toBe(epoch);
    const ok = await request(app).put('/api/books/auth__ser__book/state').set('X-Repair-Epoch', epoch!).send({});
    expect(ok.status).not.toBe(409);
  });

  it('a later boot that repairs again rotates the epoch: a page loaded before that boot is refused', async () => {
    await repairedPair();
    const first = gate.currentRepairEpoch()!;
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate();
    await gate.registerRepairedBook('other__id__x', null);
    const second = gate.currentRepairEpoch()!;
    expect(second).not.toBe(first);
    expect((await request(app).delete('/api/books/auth__ser__book').set('X-Repair-Epoch', first)).status).toBe(409);
  });

  it('two registrations in one boot share one epoch', async () => {
    await gate.registerRepairedBook('a__a__a', null);
    const e = gate.currentRepairEpoch();
    await gate.registerRepairedBook('b__b__b', 'm_b');
    expect(gate.currentRepairEpoch()).toBe(e);
  });

  it('persists ids, times and the epoch only: no path', async () => {
    await repairedPair(true);
    const raw = readFileSync(paths.repairedBookGateJsonPath(), 'utf8');
    expect(raw).not.toContain(root);
    const file = JSON.parse(raw);
    expect(file.epoch).toBe(gate.currentRepairEpoch());
    expect(file.entries).toHaveLength(1);
    expect(Object.keys(file.entries[0]).sort()).toEqual(['bookId', 'repairedAt']);
    expect(file.entries[0]).toMatchObject({ bookId: 'auth__ser__book' });
    expect(Date.parse(file.entries[0].repairedAt)).not.toBeNaN();
    expect(file.manuscripts[0]).toMatchObject({ manuscriptId: 'm_copy' });
  });

  it('a shared-manuscriptId scope survives the restart too', async () => {
    await repairedPair(true);
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate();
    expect((await request(app).post('/api/manuscripts/m_copy/analysis').send({})).status).toBe(409);
  });
});

describe('the gate has no expiry (#3713, owner decision)', () => {
  it('a restart 8 days after the repair still gates it, and the file still names the id', async () => {
    await repairedPair();
    const at = Date.parse(JSON.parse(readFileSync(paths.repairedBookGateJsonPath(), 'utf8')).entries[0].repairedAt);
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate(at + 8 * DAY);
    expect(await delStatus()).toBe(409);
    expect(JSON.parse(readFileSync(paths.repairedBookGateJsonPath(), 'utf8')).entries).toHaveLength(1);
  });

  it('a process that runs past 8 days keeps gating, and keeps serving the epoch', async () => {
    await repairedPair();
    const epoch = gate.currentRepairEpoch();
    expect(epoch).toBeTruthy();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * DAY + 5000);
    expect(await delStatus()).toBe(409);
    expect(gate.currentRepairEpoch()).toBe(epoch);
  });

  it('a page loaded before the repair that first writes after 8 days is still refused, and the kept twin is untouched', async () => {
    await repairedPair();
    const keptCast = paths.castJsonPath(join(paths.BOOKS_ROOT, 'Auth', 'Ser', 'Book original'));
    const before = readFileSync(keptCast, 'utf8');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 8 * DAY + 5000);
    const res = await request(app).put('/api/books/auth__ser__book/state').send({ slice: 'cast', patch: { characters: [{ id: 'c9', name: 'Stale' }] } });
    expect(res.status).toBe(409);
    expect(readFileSync(keptCast, 'utf8')).toBe(before);
  });
});

/* The owner's redesign after PR #4004 pass 5: nothing a client does ends an entry early. A read of the
   book, any number of them, leaves an old-bundle page (no epoch) refused for good. */
describe('nothing a client does ends the gate early (#3713)', () => {
  const ID = 'auth__ser__book';
  const restart = async () => {
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate();
  };
  const cast = (epoch?: string) => {
    const r = request(app).put(`/api/books/${ID}/state`);
    return (epoch === undefined ? r : r.set('X-Repair-Epoch', epoch)).send({ slice: 'cast', patch: { characters: [] } });
  };

  it('reads of the state, a restart, then an untokened cast PUT (the v1.14.0 shape): still 409', async () => {
    await repairedPair();
    for (let i = 0; i < 3; i++) expect((await request(app).get(`/api/books/${ID}/state`)).status).toBe(200);
    await restart();
    expect((await cast()).status).toBe(409);
    expect(await delStatus()).toBe(409);
  });

  it('a page carrying the current epoch writes, and the gate still refuses a page without it afterwards', async () => {
    await repairedPair();
    expect((await cast(gate.currentRepairEpoch()!)).status).not.toBe(409);
    await restart();
    expect((await cast()).status).toBe(409);
  });

  it('the ack route is gone', async () => {
    await repairedPair();
    expect((await request(app).post(`/api/repaired-books/ack/${ID}`).send({})).status).toBe(404);
  });
});

describe('a damaged gate file fails closed (#3713)', () => {
  const entry = (bookId: string) => JSON.stringify({ bookId, repairedAt: new Date().toISOString() });

  it('a file cut off mid-write keeps every entry it can still read, and its epoch', async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      paths.repairedBookGateJsonPath(),
      `{"version":2,"epoch":"ep-1","entries":[${entry('a__a__a')},${entry('b__b__b')},{"bookId":"c__c`,
    );
    await gate.loadRepairedBookGate();
    expect(gate.isRepairedBook('a__a__a')).toBe(true);
    expect(gate.isRepairedBook('b__b__b')).toBe(true);
    expect(gate.currentRepairEpoch()).toBe('ep-1');
  });

  it('an entry with a readable id but a broken time is kept gated from now', async () => {
    writeFileSync(
      paths.repairedBookGateJsonPath(),
      JSON.stringify({ version: 2, epoch: 'ep-2', entries: [{ bookId: 'x__x__x', repairedAt: 'not a date' }] }),
    );
    await gate.loadRepairedBookGate();
    expect(gate.isRepairedBook('x__x__x')).toBe(true);
    expect((await request(app).delete('/api/books/x__x__x')).status).toBe(409);
  });

  it('entries whose epoch was lost get a fresh one: no page holds it, so every page reloads once more', async () => {
    writeFileSync(paths.repairedBookGateJsonPath(), JSON.stringify({ version: 2, entries: [JSON.parse(entry('x__x__x'))] }));
    await gate.loadRepairedBookGate();
    const fresh = gate.currentRepairEpoch();
    expect(fresh).toBeTruthy();
    expect(JSON.parse(readFileSync(paths.repairedBookGateJsonPath(), 'utf8')).epoch).toBe(fresh);
  });

  it('an unparseable file does not throw and does not stop the next repair from being gated', async () => {
    writeFileSync(paths.repairedBookGateJsonPath(), '\u0000\u0000 not json at all');
    await expect(gate.loadRepairedBookGate()).resolves.toBeUndefined();
    await gate.registerRepairedBook('y__y__y', null);
    expect(gate.isRepairedBook('y__y__y')).toBe(true);
  });

  it('after a damaged load the file is rewritten whole, so the next restart reads clean', async () => {
    writeFileSync(paths.repairedBookGateJsonPath(), `{"version":2,"epoch":"ep-3","entries":[${entry('a__a__a')},{"bookId":"c`);
    await gate.loadRepairedBookGate();
    const healed = JSON.parse(readFileSync(paths.repairedBookGateJsonPath(), 'utf8'));
    expect(healed.entries.map((e: { bookId: string }) => e.bookId)).toEqual(['a__a__a']);
    expect(healed.epoch).toBe('ep-3');
  });

  it('no file is the common case: loads nothing and writes nothing', async () => {
    rmSync(paths.repairedBookGateJsonPath(), { force: true });
    await gate.loadRepairedBookGate();
    expect(existsSync(paths.repairedBookGateJsonPath())).toBe(false);
  });
});

/* PR #4004 pass 4 (minor): a gate file that cannot be READ at boot fails closed. */
describe('an unreadable gate file at boot fails closed (#3713)', () => {
  const ID = 'auth__ser__book';
  const file = () => paths.repairedBookGateJsonPath();
  const entry = (bookId: string) => ({ bookId, repairedAt: new Date().toISOString() });
  /* A directory where the file should be: readFile fails with EISDIR, not ENOENT -- the "exists but unreadable" shape. */
  const makeUnreadable = () => {
    rmSync(file(), { recursive: true, force: true });
    mkdirSync(file(), { recursive: true });
  };
  const makeReadable = (...ids: string[]) => {
    rmSync(file(), { recursive: true, force: true });
    writeFileSync(file(), JSON.stringify({ version: 2, epoch: 'ep-file', entries: ids.map(entry), manuscripts: [] }));
  };
  afterEach(() => {
    vi.useRealTimers();
    rmSync(file(), { recursive: true, force: true });
  });

  it('is never overwritten by a fresh file: a repair in the same boot persists nothing over it', async () => {
    gate.__clearRepairedBookGateMemoryForTest();
    makeUnreadable();
    await expect(gate.loadRepairedBookGate()).resolves.toBeUndefined();
    await repairedPair();
    expect(statSync(file()).isDirectory()).toBe(true); // still the thing we could not read
    expect(await delStatus()).toBe(409); // the in-memory gate for this boot's repair holds
  });

  it('a read that fails once and then succeeds is retried at boot, and the entries are loaded', async () => {
    gate.__clearRepairedBookGateMemoryForTest();
    makeUnreadable();
    setTimeout(() => makeReadable('late__x__y'), 40);
    await gate.loadRepairedBookGate();
    expect(gate.isRepairedBook('late__x__y')).toBe(true);
  });

  it('keeps refusing: once the file becomes readable the next gated write loads it, and the ids it names are refused', async () => {
    gate.__clearRepairedBookGateMemoryForTest();
    makeUnreadable();
    await gate.loadRepairedBookGate();
    expect(gate.isRepairedBook('old__x__y')).toBe(false);
    makeReadable('old__x__y');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    const res = await request(app).delete('/api/books/old__x__y');
    expect(res.status).toBe(409);
    expect(gate.isRepairedBook('old__x__y')).toBe(true);
  });

  it('a recovery made by a gated write writes the merge back: this boot\'s repair survives a restart', async () => {
    gate.__clearRepairedBookGateMemoryForTest();
    makeUnreadable();
    await gate.loadRepairedBookGate();
    await repairedPair();
    const bootEpoch = gate.currentRepairEpoch();
    makeReadable('old__x__y');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    expect((await request(app).delete('/api/books/old__x__y')).status).toBe(409);
    vi.useRealTimers();
    const onDisk = JSON.parse(readFileSync(file(), 'utf8'));
    expect(onDisk.entries.map((e: { bookId: string }) => e.bookId).sort()).toEqual([ID, 'old__x__y'].sort());
    expect(onDisk.epoch).toBe(bootEpoch); // the epoch pages loaded in this boot hold
  });

  it('a gated book deleted while the file was unreadable does not come back when it is read', async () => {
    gate.__clearRepairedBookGateMemoryForTest();
    makeUnreadable();
    await gate.loadRepairedBookGate();
    await gate.registerRepairedBook('gone__x__y', null);
    await gate.forgetRepairedBook('gone__x__y');
    makeReadable('gone__x__y', 'old__x__y');
    await gate.persistRepairedBookGate();
    expect(gate.isRepairedBook('gone__x__y')).toBe(false);
    expect(gate.isRepairedBook('old__x__y')).toBe(true);
  });

  it('a repair made while it was unreadable is merged with the file once it can be read, and both persist', async () => {
    gate.__clearRepairedBookGateMemoryForTest();
    makeUnreadable();
    await gate.loadRepairedBookGate();
    await repairedPair();
    makeReadable('old__x__y');
    await gate.persistRepairedBookGate();
    const ids = JSON.parse(readFileSync(file(), 'utf8')).entries.map((e: { bookId: string }) => e.bookId).sort();
    expect(ids).toEqual([ID, 'old__x__y'].sort());
  });
});

describe('deleting a gated book drops its gate entry (#3713)', () => {
  const ID = 'auth__ser__book';
  it('the entry is gone in memory and from the file, so a new book minted with the same id is not refused', async () => {
    await repairedPair();
    expect((await request(app).delete(`/api/books/${ID}`).set('X-Repair-Epoch', gate.currentRepairEpoch()!)).status).toBe(204);
    expect(gate.isRepairedBook(ID)).toBe(false);
    expect(JSON.parse(readFileSync(paths.repairedBookGateJsonPath(), 'utf8')).entries.map((e: { bookId: string }) => e.bookId)).not.toContain(ID);
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate();
    expect(gate.isRepairedBook(ID)).toBe(false);
  });

  it('a refused delete (no epoch) leaves the entry alone', async () => {
    await repairedPair();
    expect((await request(app).delete(`/api/books/${ID}`)).status).toBe(409);
    expect(gate.isRepairedBook(ID)).toBe(true);
  });

  it('deleting one gated book leaves another one\'s entry alone', async () => {
    await repairedPair();
    await gate.registerRepairedBook('other__id__x', null);
    await request(app).delete(`/api/books/${ID}`).set('X-Repair-Epoch', gate.currentRepairEpoch()!);
    expect(gate.isRepairedBook('other__id__x')).toBe(true);
  });
});
