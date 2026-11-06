/* PR #4007 pass 13 (owner decision: a voice "Don't reuse" created is never shared
   with anyone outside the chain that moved with it), on the real design (REST,
   preview), promote and decline routes, against real cast.json files.

   A first design is shared only when the voice being designed is an ordinary
   never-designed series voice. A separation records the uuid it mints
   (separated-voices.ts), so a first design by ANY row on that uuid (the decliner,
   a follower that moved with it, a same-book row on the key) never reaches the
   share step: the rows still on the legacy key are the side it was separated from.

   A fresh series, nobody designed, all on the legacy key `qwen-v_wren` with no
   `.pt`. The sidecar mock writes distinct bytes for each call; `failCastWrite`
   fails one cast.json write. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { withCapacityRetry } from '../gpu/capacity-retry.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: vi.fn(() => ({ synthesize })) };
});
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {
    code = 'GPU_BUSY';
  },
}));
vi.mock('../gpu/sidecar-vram-sample.js', () => ({ maybeSampleSidecarEngine: async () => {} }));
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));
/* The next cast.json write whose path contains `failCastWrite.match` throws. */
const failCastWrite = vi.hoisted(() => ({ match: null as string | null }));
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  const writeJsonAtomic: typeof actual.writeJsonAtomic = async (path, data) => {
    if (failCastWrite.match && path.endsWith('cast.json') && path.includes(failCastWrite.match)) {
      failCastWrite.match = null;
      throw Object.assign(new Error('injected cast.json write failure'), { code: 'EIO' });
    }
    return actual.writeJsonAtomic(path, data);
  };
  return { ...actual, writeJsonAtomic };
});

/* Every withBookOps call's ids: a design of a separated voice never even takes the
   other books' book-ops (the share step is never planned). */
const bookOpsCalls = vi.hoisted(() => [] as string[][]);
vi.mock('../workspace/book-op-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/book-op-lock.js')>();
  const withBookOps: typeof actual.withBookOps = (ids, fn, opts) => {
    bookOpsCalls.push([...ids]);
    return actual.withBookOps(ids, fn, opts);
  };
  return { ...actual, withBookOps };
});

/* Run once, just before the next withCastLocks over more than one book (promote's
   share span, which is a second span after the promote's own). */
const beforeShareLocks = vi.hoisted(() => ({ fn: null as (() => void) | null }));
vi.mock('../workspace/cast-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/cast-lock.js')>();
  const withCastLocks: typeof actual.withCastLocks = (dirs, fn) => {
    if (beforeShareLocks.fn && dirs.length > 1) {
      const run = beforeShareLocks.fn;
      beforeShareLocks.fn = null;
      run();
    }
    return actual.withCastLocks(dirs, fn);
  };
  return { ...actual, withCastLocks };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';
const TITLES = ['Book One', 'Book Two', 'Book Three', 'Book Four'] as const;
type Title = (typeof TITLES)[number];

let workspaceRoot: string;
let audioDir: string;
let app: Express;
const ids = {} as Record<Title, string>;
let counter = 0;
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const separatedDir = () => join(workspaceRoot, 'voices', 'separated');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const rowOf = (t: string, id = 'wren'): Record<string, any> =>
  JSON.parse(readFileSync(castPath(t), 'utf8')).characters.find((c: { id: string }) => c.id === id);
const castBytes = (t: Title) => readFileSync(castPath(t), 'utf8');
const castOf = (t: Title) => JSON.parse(castBytes(t));
function writeBook(t: Title, rows: Array<Record<string, unknown>>, castConfirmed = true) {
  const dir = bookDir(t);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: ids[t],
      manuscriptId: `m_${ids[t]}`,
      title: t,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: TITLES.indexOf(t) + 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed,
      chapters: [],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(castPath(t), JSON.stringify({ characters: rows }));
}
const legacy = {
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
  gender: 'female',
  ageRange: 'adult',
};
const alias = { ...legacy, id: 'wren-young', name: 'Young Wren' };
const linkTo = (t: Title, characterId = 'wren') => ({
  matchedFrom: { bookId: ids[t], characterId, bookTitle: t, confidence: 1 },
});
const pt = (k: string) => join(qwenDir(), `${k}.pt`);
const design = (t: Title, extra: Record<string, unknown> = {}, cid = 'wren') =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/${cid}/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });
const decline = (t: Title, from: Title, cid = 'wren') =>
  request(app).post(`/api/books/${ids[t]}/cast/${cid}/decline-voice-link`).send({ fromBookId: ids[from] });
const promote = (t: Title, previewVoiceId: string, cid = 'wren') =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/${cid}/promote-voice`)
    .send({ previewVoiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
const reset = () => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
};
const recorded = (): string[] => (existsSync(separatedDir()) ? readdirSync(separatedDir()) : []);

/* Two and Three link to One, Four links to Two (a follower of Two). */
function seedChain() {
  reset();
  writeBook('Book One', [{ ...legacy }]);
  writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
  writeBook('Book Three', [{ ...legacy, ...linkTo('Book One') }]);
  writeBook('Book Four', [{ ...legacy, ...linkTo('Book Two') }]);
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-separated-share-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-separated-share-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
});

beforeEach(() => {
  failCastWrite.match = null;
  beforeShareLocks.fn = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* not JSON */
    }
    if (voiceId && String(url).includes('/qwen/') && !String(url).includes('evict')) {
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), Buffer.from(`DESIGN-${++counter}`));
    }
    const bytes = new Uint8Array(24_000 * 2 * 0.3);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
      arrayBuffer: async () => bytes.buffer,
      json: async () => ({}),
    };
  });
  synthesize.mockReset();
  vi.mocked(withCapacityRetry).mockReset();
  vi.mocked(withCapacityRetry).mockImplementation((doPost, opts) => doPost(opts.signal));
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
});

describe('P13-1 — a first design by a row that moved with the decliner is never shared', () => {
  it("Don't reuse on Two (from One) moves Two and its follower Four onto X and records X as separated; only Two carries the marker", async () => {
    seedChain();
    const d = await decline('Book Two', 'Book One');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const x = rowOf('Book Two').voiceUuid as string;
    expect(x).toBeTruthy();
    expect(rowOf('Book Four').voiceUuid).toBe(x);
    expect(rowOf('Book Four').declinedVoiceFrom).toBeUndefined();
    expect(rowOf('Book Two').declinedVoiceFrom).toEqual([ids['Book One']]);
    expect(existsSync(pt(`qwen-${x}`))).toBe(false);
    expect(recorded()).toEqual([x]);
  });

  it('(a) first design of Four (a follower): One (the declined book) and Three keep their own key, their cast.json untouched', async () => {
    seedChain();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = rowOf('Book Two').voiceUuid as string;
    const oneBefore = castBytes('Book One');
    const threeBefore = castBytes('Book Three');
    bookOpsCalls.length = 0;
    const res = await design('Book Four');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.voiceId).toBe(`qwen-${x}`);
    expect(rowOf('Book One').voiceUuid, "the declined book One was stamped with the decliner's voice").toBeUndefined();
    expect(rowOf('Book Three').voiceUuid, "Three (One's character) was stamped with the decliner's voice").toBeUndefined();
    /* The share step never ran: neither book was written at all. */
    expect(castBytes('Book One')).toBe(oneBefore);
    expect(castBytes('Book Three')).toBe(threeBefore);
    expect(bookOpsCalls.filter((c) => c.includes(ids['Book One']) || c.includes(ids['Book Three'])), 'the share step was planned').toEqual([]);
    expect(rowOf('Book Two').voiceUuid).toBe(x);
  });

  it("(a2) ...then designing One does not rewrite the qwen-<X>.pt Two and Four hold", async () => {
    seedChain();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = rowOf('Book Two').voiceUuid as string;
    expect((await design('Book Four')).status).toBe(200);
    const twoBytes = readFileSync(pt(`qwen-${x}`));
    const one = await design('Book One');
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(one.body.voiceId).not.toBe(`qwen-${x}`);
    expect(rowOf('Book Two').voiceUuid).toBe(x);
    expect(rowOf('Book Four').voiceUuid).toBe(x);
    expect(readFileSync(pt(`qwen-${x}`)).equals(twoBytes), `One's design (${one.body.voiceId}) rewrote the voice Two declined One for`).toBe(true);
  });

  it('(b) Design & compare -> Keep on Four: One and Three are not stamped', async () => {
    seedChain();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = rowOf('Book Two').voiceUuid as string;
    const oneBefore = castBytes('Book One');
    bookOpsCalls.length = 0;
    const preview = await design('Book Four', { preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const kept = await promote('Book Four', preview.body.voiceId);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.voiceId).toBe(`qwen-${x}`);
    expect(rowOf('Book One').voiceUuid, "the declined book One took the decliner's kept voice").toBeUndefined();
    expect(rowOf('Book Three').voiceUuid).toBeUndefined();
    expect(castBytes('Book One')).toBe(oneBefore);
    expect(bookOpsCalls.filter((c) => c.includes(ids['Book One']) || c.includes(ids['Book Three'])), 'the share step was planned').toEqual([]);
  });

  it('(c) a same-book row that moved with the decliner: its first design does not reach One', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }, { ...alias }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book One') }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = rowOf('Book Two').voiceUuid as string;
    expect(rowOf('Book Two', 'wren-young').voiceUuid).toBe(x);
    expect(rowOf('Book Two', 'wren-young').declinedVoiceFrom).toBeUndefined();
    const res = await design('Book Two', {}, 'wren-young');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.voiceId).toBe(`qwen-${x}`);
    expect(rowOf('Book One').voiceUuid, "One took the decliner's voice through a same-book row").toBeUndefined();
    expect(rowOf('Book Three').voiceUuid).toBeUndefined();
  });

  it("(c2) a decline that needed no separation (Two's rows already on a uuid only Two holds) records that uuid: a same-book row's first design does not reach One", async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [
      { ...legacy, ...linkTo('Book One'), voiceUuid: 'uTwoOwn' },
      { ...alias, voiceUuid: 'uTwoOwn' },
    ]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book One') }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect(rowOf('Book Two').voiceUuid).toBe('uTwoOwn');
    expect(recorded()).toEqual(['uTwoOwn']);
    const res = await design('Book Two', {}, 'wren-young');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.voiceId).toBe('qwen-uTwoOwn');
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book Three').voiceUuid).toBeUndefined();
  });

  it("(d) the linker's default chain One <- Two <- Three: Don't reuse on Two, design Three, then design One", async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two') }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = rowOf('Book Two').voiceUuid as string;
    expect(rowOf('Book Three').voiceUuid).toBe(x); // Three follows Two
    bookOpsCalls.length = 0;
    const three = await design('Book Three');
    expect(three.status, JSON.stringify(three.body)).toBe(200);
    expect(three.body.voiceId).toBe(`qwen-${x}`);
    expect(bookOpsCalls.filter((c) => c.includes(ids['Book One'])), 'the share step was planned').toEqual([]);
    expect(rowOf('Book One').voiceUuid, 'the declined book One was stamped with the voice Two and Three hold').toBeUndefined();
    const twoBytes = readFileSync(pt(`qwen-${x}`));
    const one = await design('Book One');
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    expect(readFileSync(pt(`qwen-${x}`)).equals(twoBytes), `One's design (${one.body.voiceId}) rewrote the voice Two holds`).toBe(true);
    expect(rowOf('Book Two').voiceUuid).toBe(x);
    expect(rowOf('Book Three').voiceUuid).toBe(x);
  });

  it('(e) the record survives a restart: a separation a previous run made (rows on X, X recorded on disk) is never shared', async () => {
    reset();
    mkdirSync(separatedDir(), { recursive: true });
    writeFileSync(join(separatedDir(), 'uPrevRun'), '');
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One'), voiceUuid: 'uPrevRun', declinedVoiceFrom: [ids['Book One']] }]);
    writeBook('Book Four', [{ ...legacy, ...linkTo('Book Two'), voiceUuid: 'uPrevRun' }]);
    const res = await design('Book Four');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.voiceId).toBe('qwen-uPrevRun');
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
  });

  it('control for (e): the same rows WITHOUT the record are an ordinary series voice, and the first design is shared', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Four', [{ ...legacy, ...linkTo('Book One'), voiceUuid: 'uOrdinary' }]);
    const res = await design('Book Four');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rowOf('Book One').voiceUuid).toBe('uOrdinary');
  });

  it("the decliner's own first design is still never shared (P12-1 unchanged)", async () => {
    seedChain();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = rowOf('Book Two').voiceUuid as string;
    const res = await design('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.voiceId).toBe(`qwen-${x}`);
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
    expect(rowOf('Book Three').voiceUuid).toBeUndefined();
    expect(rowOf('Book Four').voiceUuid).toBe(x);
  });
});

describe('P13-1 controls — an ordinary never-designed series voice is still shared', () => {
  it("landing: no decline, Four's first design is shared with One, Two and Three", async () => {
    seedChain();
    bookOpsCalls.length = 0;
    const res = await design('Book Four');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    /* The spy the separated cases assert on does see an ordinary share's book-ops. */
    expect(bookOpsCalls.some((c) => c.includes(ids['Book One']))).toBe(true);
    const n = rowOf('Book Four').voiceUuid;
    expect(n).toBeTruthy();
    for (const t of ['Book One', 'Book Two', 'Book Three'] as const) expect(rowOf(t).voiceUuid, t).toBe(n);
    expect(recorded()).toEqual([]);
  });

  it("promote: no decline, Design & compare -> Keep on Four is shared with One, Two and Three", async () => {
    seedChain();
    const preview = await design('Book Four', { preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const kept = await promote('Book Four', preview.body.voiceId);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    const n = rowOf('Book Four').voiceUuid;
    expect(n).toBeTruthy();
    for (const t of ['Book One', 'Book Two', 'Book Three'] as const) expect(rowOf(t).voiceUuid, t).toBe(n);
  });

  it('promote re-checks the record under the share locks: a uuid recorded after the promote decided is not shared', async () => {
    seedChain();
    const preview = await design('Book Four', { preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const n = rowOf('Book Four').voiceUuid as string;
    expect(n).toBeTruthy();
    let fired = false;
    beforeShareLocks.fn = () => {
      fired = true;
      mkdirSync(separatedDir(), { recursive: true });
      writeFileSync(join(separatedDir(), n), '');
    };
    const kept = await promote('Book Four', preview.body.voiceId);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(fired, 'the share span was never reached').toBe(true);
    for (const t of ['Book One', 'Book Two', 'Book Three'] as const) expect(rowOf(t).voiceUuid, t).toBeUndefined();
  });

  it("a separation elsewhere in the series does not stop another character's ordinary share", async () => {
    reset();
    const rook = { ...legacy, id: 'rook', name: 'Rook', voiceId: 'v_rook' };
    writeBook('Book One', [{ ...legacy }, { ...rook }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }, { ...rook, ...linkTo('Book One', 'rook') }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const res = await design('Book Two', {}, 'rook');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const n = rowOf('Book Two', 'rook').voiceUuid;
    expect(n).toBeTruthy();
    expect(rowOf('Book One', 'rook').voiceUuid).toBe(n);
  });
});

describe('P13-1 failure paths — the record and the rows move together', () => {
  it("a separation whose last cast.json write fails: nothing moves, and nothing is recorded", async () => {
    seedChain();
    const before = TITLES.map(castOf);
    failCastWrite.match = 'Book Two';
    const d = await decline('Book Two', 'Book One');
    expect(d.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(d.body)).not.toMatch(/[A-Z]:\\|\/tmp\//);
    expect(TITLES.map(castOf)).toEqual(before);
    expect(recorded()).toEqual([]);
    expect(readdirSync(qwenDir())).toEqual([]);
  });

  it('...and a retry after the failure separates and records once', async () => {
    seedChain();
    failCastWrite.match = 'Book Two';
    expect((await decline('Book Two', 'Book One')).status).toBeGreaterThanOrEqual(500);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = rowOf('Book Two').voiceUuid as string;
    expect(recorded()).toEqual([x]);
    expect((await design('Book Four')).status).toBe(200);
    expect(rowOf('Book One').voiceUuid).toBeUndefined();
  });

  it('a record that cannot be written fails the decline before any row moves', async () => {
    seedChain();
    mkdirSync(join(workspaceRoot, 'voices'), { recursive: true });
    writeFileSync(separatedDir(), 'not a directory'); // the record's folder cannot be created
    const before = TITLES.map(castOf);
    const d = await decline('Book Two', 'Book One');
    expect(d.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(d.body)).not.toMatch(/[A-Z]:\\|\/tmp\//);
    expect(TITLES.map(castOf)).toEqual(before);
  });

  it("a decline that needed no separation and whose cast.json write fails records nothing", async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One'), voiceUuid: 'uTwoOwn' }]);
    failCastWrite.match = 'Book Two';
    expect((await decline('Book Two', 'Book One')).status).toBeGreaterThanOrEqual(500);
    expect(rowOf('Book Two').declinedVoiceFrom).toBeUndefined();
    expect(recorded()).toEqual([]);
  });
});

describe("Y1 — promote shares only the key's FIRST file", () => {
  it('a Keep that replaces an existing file stamps nothing (Three was unconfirmed at the first design, confirmed since)', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book One') }], false);
    expect((await design('Book Two')).status).toBe(200);
    const n = rowOf('Book Two').voiceUuid as string;
    expect(n).toBeTruthy();
    expect(rowOf('Book One').voiceUuid).toBe(n);
    expect(rowOf('Book Three').voiceUuid).toBeUndefined(); // unconfirmed: skipped
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book One') }], true); // confirmed later
    const preview = await design('Book Two', { preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const kept = await promote('Book Two', preview.body.voiceId);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.voiceId).toBe(`qwen-${n}`);
    expect(rowOf('Book Three').voiceUuid, 'a redesign Keep was shared as a first design').toBeUndefined();
  });
});