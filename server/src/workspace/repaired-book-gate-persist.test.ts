/* #3713 / PR #4004 pass 3 (owner decision) -- the repaired-id gate outlives a restart for
   7 days. The real sweep repairs a pair in a temp workspace; a "restart" is the gate's
   in-memory state being dropped and re-read from the file the sweep persisted. */
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
  const { repairedBookAckRouter } = await import('../routes/repaired-book-ack.js');
  app.use('/api/repaired-books', repairedBookAckRouter);
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

  it('keeps the same token across the restart (a tab that read before it keeps writing)', async () => {
    await repairedPair();
    const token = gate.repairedReadToken('auth__ser__book');
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate();
    expect(gate.repairedReadToken('auth__ser__book')).toBe(token);
    const ok = await request(app).put('/api/books/auth__ser__book/state').set('X-Book-Read-Token', token!).send({});
    expect(ok.status).not.toBe(409);
  });

  it('persists ids, tokens and times only: no path', async () => {
    await repairedPair(true);
    const raw = readFileSync(paths.repairedBookGateJsonPath(), 'utf8');
    expect(raw).not.toContain(root);
    const file = JSON.parse(raw);
    expect(file.entries).toHaveLength(1);
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

describe('the 7-day lifetime (#3713)', () => {
  it('a restart 7 days after the repair no longer gates it, and one just inside still does', async () => {
    await repairedPair();
    const at = Date.parse(JSON.parse(readFileSync(paths.repairedBookGateJsonPath(), 'utf8')).entries[0].repairedAt);
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate(at + 7 * DAY - 1000);
    expect(await delStatus()).toBe(409);
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate(at + 7 * DAY + 1000);
    expect(await delStatus()).not.toBe(409);
  });

  it('a process that runs past 7 days stops gating without a restart', async () => {
    await repairedPair();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 7 * DAY + 5000);
    expect(await delStatus()).not.toBe(409);
  });
});

/* PR #4004 pass 4, finding 5: only a client that APPLIED a full read clears the persisted gate, by
   acknowledging it (`POST /api/repaired-books/ack/:bookId`, sent when it commits the token). A bare
   `GET /state` is most of the endpoint's traffic and applies nothing. */
describe('cleared early only by a client that applied a full read (#3713)', () => {
  const ID = 'auth__ser__book';
  const restart = async () => {
    gate.__clearRepairedBookGateMemoryForTest();
    await gate.loadRepairedBookGate();
  };
  const ack = (token?: string) => {
    const r = request(app).post(`/api/repaired-books/ack/${ID}`);
    return (token === undefined ? r : r.set('X-Book-Read-Token', token)).send({});
  };
  const cast = (token?: string) => {
    const r = request(app).put(`/api/books/${ID}/state`);
    return (token === undefined ? r : r.set('X-Book-Read-Token', token)).send({ slice: 'cast', patch: { characters: [] } });
  };

  it('ONE plain GET of the state, a restart, then an untokened cast PUT (the v1.14.0 shape): still 409', async () => {
    await repairedPair();
    expect((await request(app).get(`/api/books/${ID}/state`)).status).toBe(200);
    await restart();
    expect((await cast()).status).toBe(409);
    expect(await delStatus()).toBe(409);
  });

  it('the client\'s ack stops the gate surviving the NEXT restart, but this process keeps refusing a tab with no token', async () => {
    await repairedPair();
    const token = (await request(app).get(`/api/books/${ID}/state`)).headers['x-book-read-token'];
    expect((await ack(token)).status).toBe(204);
    expect(await delStatus()).toBe(409);
    await restart();
    expect(await delStatus()).not.toBe(409);
  });

  it('an ack without the token is refused and clears nothing', async () => {
    await repairedPair();
    const res = await ack();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('book_repaired_reload');
    await restart();
    expect(await delStatus()).toBe(409);
  });

  it('an ack carrying another book\'s token clears nothing', async () => {
    await repairedPair();
    await gate.registerRepairedBook('other__id__x', null);
    expect((await ack(gate.repairedReadToken('other__id__x')!)).status).toBe(409);
    await restart();
    expect(await delStatus()).toBe(409);
  });

  it('an ack for an id that is not gated is a quiet 204', async () => {
    expect((await request(app).post('/api/repaired-books/ack/never__repaired__x').send({})).status).toBe(204);
  });

  it('an ack of one repaired book leaves another one\'s persisted gate alone', async () => {
    await repairedPair();
    await gate.registerRepairedBook('other__id__x', null);
    await ack(gate.repairedReadToken(ID)!);
    await restart();
    expect(gate.repairedReadToken('other__id__x')).toBeTruthy();
    expect(gate.repairedReadToken(ID)).toBeUndefined();
  });

  it('a shared-manuscriptId scope is forgotten with the book\'s ack', async () => {
    await repairedPair(true);
    await ack(gate.repairedReadToken(ID)!);
    await restart();
    expect((await request(app).post('/api/manuscripts/m_copy/analysis').send({})).status).toBe(202);
  });
});

describe('a damaged gate file fails closed (#3713)', () => {
  const entry = (bookId: string) =>
    JSON.stringify({ bookId, token: 'tok-' + bookId, repairedAt: new Date().toISOString() });

  it('a file cut off mid-write keeps every entry it can still read', async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(paths.repairedBookGateJsonPath(), `{"version":1,"entries":[${entry('a__a__a')},${entry('b__b__b')},{"bookId":"c__c`);
    await gate.loadRepairedBookGate();
    expect(gate.repairedReadToken('a__a__a')).toBe('tok-a__a__a');
    expect(gate.repairedReadToken('b__b__b')).toBe('tok-b__b__b');
  });

  it('an entry with a readable id but a broken token or time is kept gated with a fresh token and clock', async () => {
    writeFileSync(
      paths.repairedBookGateJsonPath(),
      JSON.stringify({ version: 1, entries: [{ bookId: 'x__x__x', token: 7, repairedAt: 'not a date' }] }),
    );
    await gate.loadRepairedBookGate();
    const token = gate.repairedReadToken('x__x__x');
    expect(typeof token).toBe('string');
    expect(token!.length).toBeGreaterThan(8);
  });

  it('an unparseable file does not throw and does not stop the next repair from being gated', async () => {
    writeFileSync(paths.repairedBookGateJsonPath(), '\u0000\u0000 not json at all');
    await expect(gate.loadRepairedBookGate()).resolves.toBeUndefined();
    await gate.registerRepairedBook('y__y__y', null);
    expect(gate.repairedReadToken('y__y__y')).toBeTruthy();
  });

  it('after a damaged load the file is rewritten whole, so the next restart reads clean', async () => {
    writeFileSync(paths.repairedBookGateJsonPath(), `{"version":1,"entries":[${entry('a__a__a')},{"bookId":"c`);
    await gate.loadRepairedBookGate();
    const healed = JSON.parse(readFileSync(paths.repairedBookGateJsonPath(), 'utf8'));
    expect(healed.entries.map((e: { bookId: string }) => e.bookId)).toEqual(['a__a__a']);
  });

  it('no file is the common case: loads nothing and writes nothing', async () => {
    rmSync(paths.repairedBookGateJsonPath(), { force: true });
    await gate.loadRepairedBookGate();
    expect(existsSync(paths.repairedBookGateJsonPath())).toBe(false);
  });
});
