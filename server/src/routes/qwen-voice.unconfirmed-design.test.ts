/* F8 (A120 run 2, owner decision: "not until confirmed") and #4072 (owner
   decision: a concurrent second mint adopts the first one's uuid), on the real
   design (REST) and promote routes against real cast.json files.

   F8: in a book whose cast is NOT confirmed, an auto-proposed match can be wrong,
   so a base design there stays on that row: it mints the row's own uuid and never
   stamps it (or shares a first design) onto the linked rows of earlier books. Once
   the cast is confirmed, sharing works as before. Step 17 still holds: a design
   before Confirm goes through and Book One's key keeps Book One's voice.

   #4072: two base designs of one uuid-less series character running at once (the
   design lock is per book) each minted a uuid; their walks raced and could leave
   the link split across two uuids. A mint that starts while another mint of the
   same link is in flight adopts its uuid.

   The sidecar mock writes distinct bytes for each design. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
/* #4072 — pauses the FIRST series-mint walk at Book Two (its state.json read, made
   outside any lock) until Book Two's row carries a uuid, or `ms` pass: the walk
   has stamped Book One and waits while a second mint's walk reaches Book Two first.
   That is the interleaving that split the link before the fix. */
const holdWalk = vi.hoisted(() => ({ statePath: null as string | null, castPath: '', ms: 1500 }));
/* Review pass 1, 🟠5 — the design core's own read of the book's castConfirmed fails
   (a transient EBUSY) while every other read of state.json works. */
const failConfirmedRead = vi.hoisted(() => ({ on: false }));
vi.mock('../workspace/state-migrate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-migrate.js')>();
  const { readFileSync: read } = await import('node:fs');
  const twoHasUuid = (): boolean => {
    try {
      return !!JSON.parse(read(holdWalk.castPath, 'utf8')).characters[0].voiceUuid;
    } catch {
      return false;
    }
  };
  const readStateJsonWithRecovery: typeof actual.readStateJsonWithRecovery = async (path) => {
    if (failConfirmedRead.on && (new Error().stack ?? '').includes('readBookCastConfirmed')) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), { code: 'EBUSY', syscall: 'open', path });
    }
    if (holdWalk.statePath && path === holdWalk.statePath && (new Error().stack ?? '').includes('forEachMatchingCastCharacter')) {
      holdWalk.statePath = null;
      const until = Date.now() + holdWalk.ms;
      while (!twoHasUuid() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    }
    return actual.readStateJsonWithRecovery(path);
  };
  return { ...actual, readStateJsonWithRecovery };
});

/* Review pass 4, 🟠3 — when armed, the next rename onto a non-preview name fails (the
   promote's own move, after a Keep's isolation has already carried the preview). */
const failPromoteRename = vi.hoisted(() => ({ armed: false }));
vi.mock('../workspace/atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/atomic-rename.js')>();
  const renameWithRetry: typeof actual.renameWithRetry = async (from, to, ...rest) => {
    if (failPromoteRename.armed && String(from).includes('-preview-') && !String(to).includes('-preview-')) {
      failPromoteRename.armed = false;
      throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' });
    }
    return actual.renameWithRetry(from, to, ...rest);
  };
  return { ...actual, renameWithRetry };
});

/* #4072 — when armed, the next series walk stamps its first book and then throws
   (a lock timeout partway through a walk). */
const failWalk = vi.hoisted(() => ({ armed: false }));
vi.mock('./voices.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voices.js')>();
  const forEachMatchingCastCharacter: typeof actual.forEachMatchingCastCharacter = async (voiceId, series, mutate, only, onWritten) => {
    if (!failWalk.armed || !series) return actual.forEachMatchingCastCharacter(voiceId, series, mutate, only, onWritten);
    failWalk.armed = false;
    return actual.forEachMatchingCastCharacter(voiceId, series, mutate, only, (dir) => {
      onWritten?.(dir);
      throw new Error('walk failed after its first book');
    });
  };
  return { ...actual, forEachMatchingCastCharacter };
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
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const statePath = (t: string) => join(bookDir(t), '.audiobook', 'state.json');
const row = (t: string): Record<string, any> => JSON.parse(readFileSync(castPath(t), 'utf8')).characters[0];
function writeBook(t: Title, rows: Array<Record<string, unknown>>, confirmed = true) {
  mkdirSync(join(bookDir(t), '.audiobook'), { recursive: true });
  writeFileSync(
    statePath(t),
    JSON.stringify({
      bookId: ids[t],
      manuscriptId: `m_${ids[t]}`,
      title: t,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: TITLES.indexOf(t) + 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: confirmed,
      chapters: [],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir(t), 'manuscript.txt'), 'placeholder');
  writeFileSync(castPath(t), JSON.stringify({ characters: rows }));
}
const confirm = (t: Title) => {
  const s = JSON.parse(readFileSync(statePath(t), 'utf8'));
  writeFileSync(statePath(t), JSON.stringify({ ...s, castConfirmed: true }));
};
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
const linkTo = (t: Title) => ({ matchedFrom: { bookId: ids[t], characterId: 'wren', bookTitle: t, confidence: 0.85 } });
const pt = (k: string) => join(qwenDir(), `${k}.pt`);
const design = (t: Title, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });
const promote = (t: Title, previewVoiceId: string) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/wren/promote-voice`)
    .send({ previewVoiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
/* The base `.pt` files of every uuid key (the legacy key and staging excluded). */
const uuidBases = () =>
  readdirSync(qwenDir()).filter((f) => /^qwen-.+\.pt$/.test(f) && !f.startsWith('qwen-v_wren') && !f.includes('__') && !f.includes('-preview'));

function reset() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
}
/* A legacy series whose Book One designed the voice: `qwen-v_wren.pt` exists. */
const LEGACY_PT = Buffer.from('BOOK-ONE-LEGACY-PT');
function seedLegacyDesigned(threeConfirmed: boolean) {
  reset();
  writeFileSync(pt('qwen-v_wren'), LEGACY_PT);
  writeFileSync(join(qwenDir(), 'qwen-v_wren.json'), '{"instruct":"book one"}');
  writeBook('Book One', [{ ...legacy, overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } }]);
  writeBook('Book Two', [{ ...legacy, ...linkTo('Book One'), overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } }]);
  writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two') }], threeConfirmed);
}
/* A never-designed series: nobody has a `.pt` yet. */
function seedNeverDesigned(threeConfirmed: boolean) {
  reset();
  writeBook('Book One', [{ ...legacy }]);
  writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
  writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two') }], threeConfirmed);
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-unconfirmed-design-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-unconfirmed-design-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
});

beforeEach(() => {
  holdWalk.statePath = null;
  holdWalk.ms = 1500;
  failWalk.armed = false;
  failPromoteRename.armed = false;
  failConfirmedRead.on = false;
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

describe('F8 — a design in a book whose cast is not confirmed stays on that row', () => {
  it('never-designed series: the first design gives Book Three its own uuid and shares it with no earlier book', async () => {
    seedNeverDesigned(false);
    const one = readFileSync(castPath('Book One'), 'utf8');
    const two = readFileSync(castPath('Book Two'), 'utf8');
    const res = await design('Book Three');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const u = row('Book Three').voiceUuid as string;
    expect(u).toBeTruthy();
    expect(res.body.voiceId).toBe(`qwen-${u}`);
    expect(existsSync(pt(`qwen-${u}`))).toBe(true);
    expect(readFileSync(castPath('Book One'), 'utf8')).toBe(one);
    expect(readFileSync(castPath('Book Two'), 'utf8')).toBe(two);
  });

  it('step 17 — legacy, designed Book One: Book Three gets its own uuid with a copy; Book One\'s key keeps Book One\'s voice and its row is not stamped', async () => {
    seedLegacyDesigned(false);
    const res = await design('Book Three');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const u = row('Book Three').voiceUuid as string;
    expect(u).toBeTruthy();
    expect(row('Book One').voiceUuid).toBeUndefined();
    expect(row('Book Two').voiceUuid).toBeUndefined();
    expect(readFileSync(pt('qwen-v_wren')).equals(LEGACY_PT)).toBe(true);
    expect(readFileSync(pt(`qwen-${u}`)).equals(LEGACY_PT)).toBe(false); // the design landed on its own key
  });

  it('Design & compare then Keep in the unconfirmed book shares nothing either', async () => {
    seedNeverDesigned(false);
    const one = readFileSync(castPath('Book One'), 'utf8');
    const prev = await design('Book Three', { preview: true });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const keep = await promote('Book Three', prev.body.voiceId);
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    expect(existsSync(pt(`qwen-${row('Book Three').voiceUuid}`))).toBe(true);
    expect(readFileSync(castPath('Book One'), 'utf8')).toBe(one);
    expect(row('Book Two').voiceUuid).toBeUndefined();
  });

  it('control: the same design in a CONFIRMED Book Three shares as before (never-designed and legacy)', async () => {
    seedNeverDesigned(true);
    expect((await design('Book Three')).status).toBe(200);
    const u = row('Book Three').voiceUuid;
    expect(row('Book One').voiceUuid).toBe(u);
    expect(row('Book Two').voiceUuid).toBe(u);

    seedLegacyDesigned(true);
    expect((await design('Book Three')).status).toBe(200);
    const v = row('Book Three').voiceUuid;
    expect(row('Book One').voiceUuid).toBe(v);
    expect(row('Book Two').voiceUuid).toBe(v);
  });

  it('after Confirm with the link kept, the row keeps the voice it designed; a confirmed book\'s later first design is shared with the others as before', async () => {
    seedNeverDesigned(false);
    expect((await design('Book Three')).status).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    confirm('Book Three');
    expect((await design('Book One')).status).toBe(200);
    const shared = row('Book One').voiceUuid as string;
    expect(shared).toBeTruthy();
    expect(shared).not.toBe(own);
    expect(row('Book Two').voiceUuid).toBe(shared);
    expect(row('Book Three').voiceUuid).toBe(own);
  });
});

/* Review pass 1, blocker — the analysis-time linker stamps an earlier book's uuid
   onto a freshly analysed (so unconfirmed) row (series-reuse-link.ts). A design of
   that row wrote straight to the shared key, Book One's file. */
const BOOK_ONE_PT = Buffer.from('BOOK-ONE-UUID-PT');
const BOOK_ONE_ANGRY = Buffer.from('BOOK-ONE-UUID-ANGRY');
function seedUuidDesigned() {
  reset();
  writeFileSync(pt('qwen-u1'), BOOK_ONE_PT);
  writeFileSync(join(qwenDir(), 'qwen-u1.json'), '{"instruct":"book one"}');
  writeFileSync(pt('qwen-u1__angry'), BOOK_ONE_ANGRY);
  writeFileSync(join(qwenDir(), 'qwen-u1__angry.json'), '{"instruct":"book one angry"}');
  const s = { overrideTtsVoices: { qwen: { name: 'qwen-u1', variants: { angry: { name: 'qwen-u1__angry' } } } } };
  writeBook('Book One', [{ ...legacy, voiceUuid: 'u1', ...s }]);
  writeBook('Book Two', [{ ...legacy, voiceUuid: 'u1', ...linkTo('Book One'), ...s }]);
  /* Book Three: unconfirmed, auto-linked by the analysis linker (a wrong match). */
  writeBook('Book Three', [{ ...legacy, voiceUuid: 'u1', voiceState: 'reused', ...linkTo('Book Two'), ...s }], false);
}

describe('F8 — an unconfirmed row already on an earlier book\'s uuid moves onto its own before it is designed', () => {
  it('a BASE design: Book Three gets its own uuid (a copy of the family), Book One\'s and Book Two\'s files and rows are unchanged', async () => {
    seedUuidDesigned();
    const one = readFileSync(castPath('Book One'), 'utf8');
    const two = readFileSync(castPath('Book Two'), 'utf8');
    const res = await design('Book Three');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).not.toBe('u1');
    expect(res.body.voiceId).toBe(`qwen-${own}`);
    expect(readFileSync(pt('qwen-u1')).equals(BOOK_ONE_PT)).toBe(true);
    expect(readFileSync(pt('qwen-u1__angry')).equals(BOOK_ONE_ANGRY)).toBe(true);
    expect(readFileSync(castPath('Book One'), 'utf8')).toBe(one);
    expect(readFileSync(castPath('Book Two'), 'utf8')).toBe(two);
    expect(row('Book Three').overrideTtsVoices.qwen.variants).toBeUndefined();
  });

  it('a VARIANT design: lands on Book Three\'s own key; Book One\'s angry take is unchanged', async () => {
    seedUuidDesigned();
    const res = await design('Book Three', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).not.toBe('u1');
    expect(res.body.voiceId).toBe(`qwen-${own}__angry`);
    expect(readFileSync(pt('qwen-u1__angry')).equals(BOOK_ONE_ANGRY)).toBe(true);
    expect(readFileSync(pt(`qwen-${own}`)).equals(BOOK_ONE_PT)).toBe(true); // its base is the copy
    expect(row('Book Two').overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-u1__angry');
  });

  it('a legacy row\'s VARIANT in an unconfirmed book no longer writes the shared legacy key', async () => {
    seedLegacyDesigned(false);
    const LEGACY_ANGRY = Buffer.from('BOOK-ONE-LEGACY-ANGRY');
    writeFileSync(pt('qwen-v_wren__angry'), LEGACY_ANGRY);
    const res = await design('Book Three', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt('qwen-v_wren__angry')).equals(LEGACY_ANGRY)).toBe(true);
    expect(row('Book One').voiceUuid).toBeUndefined();
    expect(row('Book Three').voiceUuid).toBeTruthy();
  });

  it('a state.json that cannot be read is not "unconfirmed": the design answers "try again." and writes nothing', async () => {
    seedLegacyDesigned(true);
    const casts = TITLES.slice(0, 3).map((t) => readFileSync(castPath(t), 'utf8'));
    failConfirmedRead.on = true;
    const res = await design('Book Three');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/try again\.$/);
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    expect(TITLES.slice(0, 3).map((t) => readFileSync(castPath(t), 'utf8'))).toEqual(casts);
    expect(uuidBases()).toEqual([]);
  });
});

/* Review pass 1, owner decision (a): the design-time separation of a row declined
   before the decline route existed refuses too while a book in its chain cannot be
   read (F1's rule), instead of leaving the chain on Book One's voice. */
describe('F1 — the design-time separation refuses while a chain member is unreadable', () => {
  it('Book Three unreadable: the design of the marked Book Two answers "try again." and nothing moves; once it reads, the chain moves', async () => {
    reset();
    const ONE_PT = Buffer.from('BOOK-ONE-PT');
    writeFileSync(pt('qwen-u_shared'), ONE_PT);
    writeFileSync(join(qwenDir(), 'qwen-u_shared.json'), '{"instruct":"book one"}');
    const s = { overrideTtsVoices: { qwen: { name: 'qwen-u_shared' } } };
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_shared', ...s }]);
    writeBook('Book Two', [{ ...legacy, voiceUuid: 'u_shared', declinedVoiceFrom: [ids['Book One']], ...s }]);
    writeBook('Book Three', [{ ...legacy, voiceUuid: 'u_shared', ...linkTo('Book Two'), ...s }]);
    writeBook('Book Four', [{ ...legacy, voiceUuid: 'u_shared', ...linkTo('Book Three'), ...s }]);
    const three = readFileSync(castPath('Book Three'), 'utf8');
    writeFileSync(castPath('Book Three'), '{"characters":[');
    const res = await design('Book Two');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/try again\.$/);
    expect(row('Book Two').voiceUuid).toBe('u_shared');
    expect(row('Book Four').voiceUuid).toBe('u_shared');
    expect(readFileSync(pt('qwen-u_shared')).equals(ONE_PT)).toBe(true);
    writeFileSync(castPath('Book Three'), three);
    expect((await design('Book Two')).status).toBe(200);
    const own = row('Book Two').voiceUuid;
    expect(own).not.toBe('u_shared');
    expect(row('Book Three').voiceUuid).toBe(own);
    expect(row('Book Four').voiceUuid).toBe(own);
    expect(readFileSync(pt('qwen-u_shared')).equals(ONE_PT)).toBe(true);
  });
});

describe('#4072 — two concurrent base mints of one legacy series link end on one uuid', () => {
  it('a first mint that stamped a book and then failed: the waiting mint adopts the uuid it stamped, never one of its own', async () => {
    seedLegacyDesigned(true);
    writeBook('Book Three', [{ id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
    /* Hold the first walk (before Book One) long enough for Book Two's design to
       reach its mint and wait; then that walk stamps Book One and throws. */
    holdWalk.statePath = resolve(statePath('Book One'));
    holdWalk.castPath = join(workspaceRoot, 'never-there.json');
    holdWalk.ms = 800;
    failWalk.armed = true;
    const first = design('Book One');
    await new Promise((r) => setTimeout(r, 100));
    const [a, b] = await Promise.all([first, design('Book Two')]);
    expect(a.status).toBeGreaterThanOrEqual(500);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const u = row('Book One').voiceUuid as string;
    expect(u).toBeTruthy();
    expect(row('Book Two').voiceUuid).toBe(u);
  });

  it('a mint that starts while another of the same link is in flight adopts its uuid: one voiceUuid, one family', async () => {
    seedLegacyDesigned(true);
    writeBook('Book Three', [{ id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
    holdWalk.statePath = resolve(statePath('Book Two'));
    holdWalk.castPath = castPath('Book Two');
    /* Book One's design mints first; Book Two's starts once that mint's walk has
       stamped Book One (and is paused before Book Two). */
    const first = design('Book One').then((r) => r);
    const until = Date.now() + 5000;
    while (!row('Book One').voiceUuid && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    const [a, b] = await Promise.all([first, design('Book Two')]);
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const u = row('Book One').voiceUuid as string;
    expect(u).toBeTruthy();
    expect(row('Book Two').voiceUuid).toBe(u);
    expect(uuidBases()).toEqual([`qwen-${u}.pt`]);
    expect(readFileSync(pt('qwen-v_wren')).equals(LEGACY_PT)).toBe(true);
  });

  it('a design in an UNCONFIRMED book never registers a series mint: a concurrent confirmed mint does not adopt its uuid', async () => {
    seedLegacyDesigned(false);
    const [two, three] = await Promise.all([design('Book Two'), design('Book Three')]);
    expect(two.status, JSON.stringify(two.body)).toBe(200);
    expect(three.status, JSON.stringify(three.body)).toBe(200);
    const shared = row('Book Two').voiceUuid as string;
    expect(row('Book One').voiceUuid).toBe(shared);
    expect(row('Book Three').voiceUuid).toBeTruthy();
    expect(row('Book Three').voiceUuid).not.toBe(shared);
  });
});

/* Review pass 2, blocker — the isolation of an unconfirmed row moves ONLY the
   designing book's rows. A later book that follows it (a confirmed Book Three
   linked to the unconfirmed Book Two) was carried onto the new uuid with it,
   losing its variant takes and playing a design nobody confirmed. */
describe('F8 (review pass 2) — isolating an unconfirmed row writes no other book', () => {
  const oneUuidFiles = () => ({
    base: readFileSync(pt('qwen-u1')),
    angry: readFileSync(pt('qwen-u1__angry')),
  });
  /* Book One confirmed on u1 (with an angry take); Book Two re-analysed (unconfirmed)
     and re-stamped onto u1 by the linker; Book Three confirmed and linked to Two. */
  function seedFollowed() {
    seedUuidDesigned();
    const s = { overrideTtsVoices: { qwen: { name: 'qwen-u1', variants: { angry: { name: 'qwen-u1__angry' } } } } };
    writeBook('Book Two', [{ ...legacy, voiceUuid: 'u1', voiceState: 'reused', ...linkTo('Book One'), ...s }], false);
    writeBook('Book Three', [{ ...legacy, voiceUuid: 'u1', voiceState: 'reused', ...linkTo('Book Two'), ...s }], true);
  }
  const bytes = (t: Title) => readFileSync(castPath(t), 'utf8');

  it('a BASE design: Book Two moves onto its own uuid; Book Three cast.json, the key and its takes are byte-identical', async () => {
    seedFollowed();
    const before = { one: bytes('Book One'), three: bytes('Book Three'), files: oneUuidFiles() };
    const res = await design('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const own = row('Book Two').voiceUuid as string;
    expect(own).not.toBe('u1');
    expect(res.body.voiceId).toBe(`qwen-${own}`);
    expect(bytes('Book Three')).toBe(before.three);
    expect(bytes('Book One')).toBe(before.one);
    expect(row('Book Three').voiceUuid).toBe('u1');
    expect(oneUuidFiles()).toEqual(before.files);
    expect(existsSync(pt(`qwen-${own}`))).toBe(true);
    /* An isolation records no "Don't reuse" marker (the declined uuid is for a decline). */
    expect(row('Book Two').declinedVoiceUuids).toBeUndefined();
    expect(row('Book Two').declinedVoiceFrom).toBeUndefined();
  });

  it('a VARIANT design: lands on Book Two own key and records its own slot; Book Three is untouched', async () => {
    seedFollowed();
    const before = { three: bytes('Book Three'), files: oneUuidFiles() };
    const res = await design('Book Two', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const own = row('Book Two').voiceUuid as string;
    expect(own).not.toBe('u1');
    expect(res.body.voiceId).toBe(`qwen-${own}__angry`);
    /* The take is recorded in the unconfirmed book itself (the series walk skips an
       unconfirmed book, so a series-scoped write would lose it). */
    expect(row('Book Two').overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${own}__angry`);
    expect(bytes('Book Three')).toBe(before.three);
    expect(oneUuidFiles()).toEqual(before.files);
  });

  it('only followers hold the key (no earlier book does): the row still moves off it and the follower is untouched', async () => {
    seedFollowed();
    writeBook('Book One', [{ id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
    const three = bytes('Book Three');
    const files = oneUuidFiles();
    const res = await design('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(row('Book Two').voiceUuid).not.toBe('u1');
    expect(bytes('Book Three')).toBe(three);
    expect(oneUuidFiles()).toEqual(files);
  });

  const seedLegacyFollowed = () => {
    reset();
    writeFileSync(pt('qwen-v_wren'), LEGACY_PT);
    writeFileSync(join(qwenDir(), 'qwen-v_wren.json'), '{"instruct":"book one"}');
    const s = { overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
    writeBook('Book One', [{ ...legacy, ...s }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One'), ...s }], false);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two'), ...s }], true);
  };

  it('register step 17 shape (legacy key): Book Three cast.json is not rewritten and its row stays on the legacy key', async () => {
    seedLegacyFollowed();
    const three = bytes('Book Three');
    const res = await design('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(row('Book Two').voiceUuid).toBeTruthy();
    expect(bytes('Book Three')).toBe(three);
    expect(row('Book Three').voiceUuid).toBeUndefined();
    expect(readFileSync(pt('qwen-v_wren')).equals(LEGACY_PT)).toBe(true);
  });

  it('legacy key VARIANT: the shared legacy take and Book Three are untouched', async () => {
    seedLegacyFollowed();
    const LEGACY_ANGRY = Buffer.from('BOOK-ONE-LEGACY-ANGRY');
    writeFileSync(pt('qwen-v_wren__angry'), LEGACY_ANGRY);
    const three = bytes('Book Three');
    const res = await design('Book Two', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt('qwen-v_wren__angry')).equals(LEGACY_ANGRY)).toBe(true);
    expect(bytes('Book Three')).toBe(three);
    expect(row('Book Two').voiceUuid).toBeTruthy();
  });

  it('P7: a never-linked character base design is not refused because an unrelated book cast.json is torn', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Three', [{ ...legacy, voiceId: 'v_mira' }], false);
    writeBook('Book Four', [{ id: 'zed', name: 'Zed', role: 'supporting', color: 'sky' }]);
    writeFileSync(castPath('Book Four'), '{"characters":[');
    const res = await design('Book Three');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(row('Book Three').voiceUuid).toBeTruthy();
  });

  it('P7b: the row IS held elsewhere and an unrelated same-series book is torn: it still moves onto its own uuid', async () => {
    seedUuidDesigned();
    writeBook('Book Four', [{ id: 'zed', name: 'Zed', role: 'supporting', color: 'sky' }]);
    writeFileSync(castPath('Book Four'), '{"characters":[');
    const res = await design('Book Three');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(row('Book Three').voiceUuid).not.toBe('u1');
    expect(readFileSync(pt('qwen-u1')).equals(BOOK_ONE_PT)).toBe(true);
  });

  it('a book-op held on another book does not stall an unconfirmed design (it locks and writes only its own book)', async () => {
    /* Book Three already has a uuid of its own, never designed; Book One has a legacy
       row on the same voiceId (a book a first design would share with, if it shared). */
    seedNeverDesigned(false);
    const three = JSON.parse(readFileSync(castPath('Book Three'), 'utf8'));
    three.characters[0].voiceUuid = 'u3';
    writeFileSync(castPath('Book Three'), JSON.stringify(three));
    const { withBookOp } = await import('../workspace/book-op-lock.js');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const holder = withBookOp(ids['Book One'], async () => {
      entered();
      await held;
    });
    await inside;
    try {
      const res = await Promise.race([
        design('Book Three'),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the design waited on another book')), 3000)),
      ]);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      release();
      await holder;
    }
  });
});

/* Review pass 2 — a preview alone changes nothing; the isolation happens when the
   design is kept. */
describe('F8 (review pass 2) — Design & compare isolates only when kept', () => {
  it('a preview then Cancel leaves the row on the series uuid with its variants', async () => {
    seedUuidDesigned();
    const three = readFileSync(castPath('Book Three'), 'utf8');
    const prev = await design('Book Three', { preview: true });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    expect(row('Book Three').voiceUuid).toBe('u1');
    expect(row('Book Three').overrideTtsVoices.qwen.variants.angry.name).toBe('qwen-u1__angry');
    const cancel = await request(app)
      .post(`/api/books/${ids['Book Three']}/cast/wren/discard-voice`)
      .send({ previewVoiceId: prev.body.voiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(cancel.status).toBe(200);
    expect(readFileSync(castPath('Book Three'), 'utf8')).toBe(three);
    expect(readFileSync(pt('qwen-u1')).equals(BOOK_ONE_PT)).toBe(true);
  });

  it('a preview then Keep moves the row onto its own uuid carrying the previewed design; the series voice is unchanged', async () => {
    seedUuidDesigned();
    const prev = await design('Book Three', { preview: true });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const previewed = readFileSync(pt(prev.body.voiceId));
    const one = readFileSync(castPath('Book One'), 'utf8');
    const two = readFileSync(castPath('Book Two'), 'utf8');
    const keep = await promote('Book Three', prev.body.voiceId);
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).not.toBe('u1');
    expect(keep.body.voiceId).toBe(`qwen-${own}`);
    expect(readFileSync(pt(`qwen-${own}`)).equals(previewed)).toBe(true);
    expect(readFileSync(pt('qwen-u1')).equals(BOOK_ONE_PT)).toBe(true);
    expect(readFileSync(pt('qwen-u1__angry')).equals(BOOK_ONE_ANGRY)).toBe(true);
    expect(row('Book Three').overrideTtsVoices.qwen.variants).toBeUndefined();
    expect(readFileSync(castPath('Book One'), 'utf8')).toBe(one);
    expect(readFileSync(castPath('Book Two'), 'utf8')).toBe(two);
  });
});

/* Review pass 3 (findings C, D, E, F) — an unreadable holder, a legacy preview, the
   drawer's series Save and a failing Keep, in an unconfirmed book. */
describe('F8 (review pass 3)', () => {
  const bytes = (t: Title) => readFileSync(castPath(t), 'utf8');
  let vapp: Express;
  const saveSeries = async (voiceId: string, name: string, t: Title) => {
    if (!vapp) {
      const { voicesRouter } = await import('./voices.js');
      vapp = express();
      vapp.use(express.json());
      vapp.use('/api/voices', voicesRouter);
    }
    return request(vapp).put(`/api/voices/${voiceId}/override`).send({ override: { engine: 'qwen', name }, scope: 'series', bookId: ids[t] });
  };
  const discard = (t: Title, previewVoiceId: string) =>
    request(app).post(`/api/books/${ids[t]}/cast/wren/discard-voice`).send({ previewVoiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
  const tearOneAndTwo = () => {
    writeFileSync(castPath('Book One'), '{"characters":[');
    writeFileSync(castPath('Book Two'), '{"characters":[');
  };

  it('C / R1: Book One and Two hold u1 but cannot be read; a base design in unconfirmed Book Three leaves qwen-u1 alone and isolates', async () => {
    seedUuidDesigned();
    tearOneAndTwo();
    const res = await design('Book Three');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).not.toBe('u1');
    expect(readFileSync(pt('qwen-u1')).equals(BOOK_ONE_PT)).toBe(true);
    expect(readFileSync(pt('qwen-u1__angry')).equals(BOOK_ONE_ANGRY)).toBe(true);
    expect(res.body.voiceId).toBe(`qwen-${own}`);
  });

  it('C / R1v: the same for an emotion take: qwen-u1__angry is untouched (the holder is an unreadable UNCONFIRMED book, which the variant clone-consent scan does not read)', async () => {
    seedUuidDesigned();
    writeBook('Book One', [{ id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
    const s = { overrideTtsVoices: { qwen: { name: 'qwen-u1' } } };
    writeBook('Book Two', [{ ...legacy, voiceUuid: 'u1', ...s }], false);
    writeFileSync(castPath('Book Two'), '{"characters":[');
    const res = await design('Book Three', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).not.toBe('u1');
    expect(readFileSync(pt('qwen-u1__angry')).equals(BOOK_ONE_ANGRY)).toBe(true);
    expect(res.body.voiceId).toBe(`qwen-${own}__angry`);
  });

  it('C: an unreadable same-series book does not refuse a row nobody else holds (isolation, never a refusal)', async () => {
    seedUuidDesigned();
    writeBook('Book Three', [{ ...legacy, voiceUuid: 'u3' }], false);
    tearOneAndTwo();
    expect((await design('Book Three')).status).toBe(200);
  });

  it('C: the mint is recorded as separated, so a second design does not isolate again', async () => {
    seedUuidDesigned();
    tearOneAndTwo();
    expect((await design('Book Three')).status).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    const files = uuidBases();
    expect((await design('Book Three')).status).toBe(200);
    expect(row('Book Three').voiceUuid).toBe(own);
    expect(uuidBases()).toEqual(files);
  });

  it('D / R2: a legacy preview then Cancel leaves the row exactly as it was', async () => {
    seedLegacyDesigned(false);
    const three = bytes('Book Three');
    const prev = await design('Book Three', { preview: true });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    expect(bytes('Book Three')).toBe(three);
    expect((await discard('Book Three', prev.body.voiceId)).status).toBe(200);
    expect(bytes('Book Three')).toBe(three);
    expect(readFileSync(pt('qwen-v_wren')).equals(LEGACY_PT)).toBe(true);
  });

  it('D: a legacy preview then Keep gives the row its own uuid, carries the previewed design, and leaves the legacy key and the other books alone', async () => {
    seedLegacyDesigned(false);
    const one = bytes('Book One');
    const two = bytes('Book Two');
    const prev = await design('Book Three', { preview: true });
    const previewed = readFileSync(pt(prev.body.voiceId));
    const keep = await promote('Book Three', prev.body.voiceId);
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).toBeTruthy();
    expect(keep.body.voiceId).toBe(`qwen-${own}`);
    expect(readFileSync(pt(`qwen-${own}`)).equals(previewed)).toBe(true);
    expect(readFileSync(pt('qwen-v_wren')).equals(LEGACY_PT)).toBe(true);
    expect(bytes('Book One')).toBe(one);
    expect(bytes('Book Two')).toBe(two);
  });

  it('D: a legacy row nobody else holds: Keep mints it a uuid (a preview mints none) and carries the preview', async () => {
    reset();
    writeBook('Book One', [{ id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
    writeBook('Book Three', [{ ...legacy }], false);
    const prev = await design('Book Three', { preview: true });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    expect(row('Book Three').voiceUuid).toBeUndefined();
    const previewed = readFileSync(pt(prev.body.voiceId));
    const keep = await promote('Book Three', prev.body.voiceId);
    expect(keep.status, JSON.stringify(keep.body)).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).toBeTruthy();
    expect(keep.body.voiceId).toBe(`qwen-${own}`);
    expect(readFileSync(pt(`qwen-${own}`)).equals(previewed)).toBe(true);
  });

  it('E / R3: the drawer Save (series override) after a legacy Keep rewrites no other book', async () => {
    seedLegacyDesigned(false);
    const one = bytes('Book One');
    const two = bytes('Book Two');
    const prev = await design('Book Three', { preview: true });
    const keep = await promote('Book Three', prev.body.voiceId);
    expect(keep.status).toBe(200);
    const save = await saveSeries('v_wren', keep.body.voiceId, 'Book Three');
    expect(save.status, JSON.stringify(save.body)).toBeLessThan(300);
    expect(bytes('Book One')).toBe(one);
    expect(bytes('Book Two')).toBe(two);
    expect(row('Book Three').overrideTtsVoices.qwen.name).toBe(keep.body.voiceId);
  });

  it('E / R4: Book One library-assigned slot keeps its libraryUuid when unconfirmed Book Three designs and Saves', async () => {
    reset();
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u1', overrideTtsVoices: { qwen: { name: 'qwen-lib1', libraryUuid: 'lib1', provenance: 'designed' } } }]);
    writeBook('Book Two', [{ ...legacy, overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } }]);
    writeBook('Book Three', [{ ...legacy, voiceUuid: 'u3' }], false);
    const one = bytes('Book One');
    const two = bytes('Book Two');
    const res = await design('Book Three');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const save = await saveSeries('v_wren', res.body.voiceId, 'Book Three');
    expect(save.status, JSON.stringify(save.body)).toBeLessThan(300);
    expect(bytes('Book One')).toBe(one);
    expect(bytes('Book Two')).toBe(two);
    expect(row('Book One').overrideTtsVoices.qwen.libraryUuid).toBe('lib1');
  });

  it('E: control: the same Save from a CONFIRMED book still propagates across the series', async () => {
    seedNeverDesigned(true);
    expect((await design('Book Three')).status).toBe(200);
    const u = row('Book Three').voiceUuid as string;
    const save = await saveSeries('v_wren', `qwen-${u}`, 'Book Three');
    expect(save.status, JSON.stringify(save.body)).toBeLessThan(300);
    expect(row('Book One').overrideTtsVoices.qwen.name).toBe(`qwen-${u}`);
  });

  it('F / R5: a Keep the promote refuses (bad modelKey) isolates nothing; the retry then carries the preview', async () => {
    seedUuidDesigned();
    const three = bytes('Book Three');
    const prev = await design('Book Three', { preview: true });
    const bad = await request(app)
      .post(`/api/books/${ids['Book Three']}/cast/wren/promote-voice`)
      .send({ previewVoiceId: prev.body.voiceId, sampleVoiceId: 'v_wren', modelKey: 'nope' });
    expect(bad.status).toBe(400);
    expect(bytes('Book Three')).toBe(three);
    const retry = await promote('Book Three', prev.body.voiceId);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).not.toBe('u1');
    expect(retry.body.voiceId).toBe(`qwen-${own}`);
  });

  /* Review pass 4, 🟠3 — the row reaches its new key by a REAL isolation: a Keep whose
     promote then fails after the isolation carried the preview (the retry sends the
     preview id the client still holds). The old test moved the key with a raw write. */
  it('F / pass 4: a Keep that failed after its isolation carried the preview: the retry with the old preview id lands', async () => {
    seedUuidDesigned();
    const prev = await design('Book Three', { preview: true });
    const previewed = readFileSync(pt(prev.body.voiceId));
    failPromoteRename.armed = true;
    const first = await promote('Book Three', prev.body.voiceId);
    expect(first.status, JSON.stringify(first.body)).toBeGreaterThanOrEqual(500);
    const own = row('Book Three').voiceUuid as string;
    expect(own).not.toBe('u1'); // the isolation landed
    expect(existsSync(pt(prev.body.voiceId))).toBe(false); // and carried the preview
    const retry = await promote('Book Three', prev.body.voiceId);
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.voiceId).toBe(`qwen-${own}`);
    expect(readFileSync(pt(`qwen-${own}`)).equals(previewed)).toBe(true);
    expect(readFileSync(pt('qwen-u1')).equals(BOOK_ONE_PT)).toBe(true);
  });
});

/* Review pass 4 (final) -- 🟠1: an "own" record names the book and the moment. */
describe('F8 (review pass 4) -- a separation record is proof of ownership only for its own book and generation', () => {
  /* What Re-parse and Start fresh do to state.json: un-confirm and rotate the epoch. */
  const reparse = (t: Title) => {
    const s = JSON.parse(readFileSync(statePath(t), 'utf8'));
    writeFileSync(statePath(t), JSON.stringify({ ...s, castConfirmed: false, editEpoch: `epoch-${++counter}` }));
  };
  const tear = (t: Title) => writeFileSync(castPath(t), '{"characters":[');
  const NEW_PT = Buffer.from('SHARED-NEW-PT');
  const NEW_ANGRY = Buffer.from('SHARED-NEW-ANGRY');

  it('S1: an unconfirmed mint, Confirm, a later book links onto it, the minting book is re-parsed, the later book is torn: the design leaves the uuid alone', async () => {
    seedNeverDesigned(false);
    expect((await design('Book Three')).status).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    const ownBytes = readFileSync(pt(`qwen-${own}`));
    confirm('Book Three');
    writeBook('Book Four', [{ ...legacy, voiceUuid: own, ...linkTo('Book Three'), overrideTtsVoices: { qwen: { name: `qwen-${own}` } } }]);
    reparse('Book Three');
    tear('Book Four');
    const res = await design('Book Three');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt(`qwen-${own}`)).equals(ownBytes)).toBe(true);
    expect(row('Book Three').voiceUuid).not.toBe(own);
  });

  async function seedDeclineChainThenReparse(tearThree: boolean) {
    reset();
    writeFileSync(pt('qwen-u_shared'), BOOK_ONE_PT);
    writeFileSync(join(qwenDir(), 'qwen-u_shared.json'), '{"instruct":"one"}');
    writeFileSync(pt('qwen-u_new'), NEW_PT);
    writeFileSync(join(qwenDir(), 'qwen-u_new.json'), '{"instruct":"two after decline"}');
    writeFileSync(pt('qwen-u_new__angry'), NEW_ANGRY);
    writeFileSync(join(qwenDir(), 'qwen-u_new__angry.json'), '{"instruct":"angry"}');
    const { recordSeparatedVoice } = await import('../workspace/separated-voices.js');
    await recordSeparatedVoice('u_new'); // what the decline's separation records
    writeBook('Book One', [{ ...legacy, voiceUuid: 'u_shared', overrideTtsVoices: { qwen: { name: 'qwen-u_shared' } } }]);
    writeBook('Book Two', [{ ...legacy, voiceUuid: 'u_new', declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'], overrideTtsVoices: { qwen: { name: 'qwen-u_new' } } }], false);
    writeBook('Book Three', [{ ...legacy, voiceUuid: 'u_new', ...linkTo('Book Two'), overrideTtsVoices: { qwen: { name: 'qwen-u_new', variants: { angry: { name: 'qwen-u_new__angry' } } } } }]);
    if (tearThree) tear('Book Three');
  }

  it('S2: a "Don\'t reuse" record is no proof of ownership: a follower that moved with the decline is torn, the re-parsed decliner designs: qwen-u_new is untouched', async () => {
    await seedDeclineChainThenReparse(true);
    const res = await design('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt('qwen-u_new')).equals(NEW_PT)).toBe(true);
    expect(readFileSync(pt('qwen-u_new__angry')).equals(NEW_ANGRY)).toBe(true);
    expect(row('Book Two').voiceUuid).not.toBe('u_new');
  });

  it('S2 control: the follower readable: the decliner still isolates and the voice is untouched', async () => {
    await seedDeclineChainThenReparse(false);
    expect((await design('Book Two')).status).toBe(200);
    expect(readFileSync(pt('qwen-u_new')).equals(NEW_PT)).toBe(true);
  });

  it('S3: Book Two mints before Confirm; a new Book Three links onto it; Book Two is torn: Book Three leaves the uuid alone', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }], false);
    expect((await design('Book Two')).status).toBe(200);
    const u2 = row('Book Two').voiceUuid as string;
    const twoBytes = readFileSync(pt(`qwen-${u2}`));
    confirm('Book Two');
    writeBook('Book Three', [{ ...legacy, voiceUuid: u2, voiceState: 'reused', ...linkTo('Book Two'), overrideTtsVoices: { qwen: { name: `qwen-${u2}` } } }], false);
    tear('Book Two');
    const res = await design('Book Three');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt(`qwen-${u2}`)).equals(twoBytes)).toBe(true);
    expect(row('Book Three').voiceUuid).not.toBe(u2);
  });

  it('control (isolation record): a second design in the same book and generation does not isolate again', async () => {
    seedUuidDesigned();
    tear('Book One');
    tear('Book Two');
    expect((await design('Book Three')).status).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    const files = uuidBases();
    expect((await design('Book Three')).status).toBe(200);
    expect(row('Book Three').voiceUuid).toBe(own);
    expect(uuidBases()).toEqual(files);
  });

  it('control (mint record): a book that appears torn after the row minted its own uuid does not make the next design isolate', async () => {
    reset();
    writeBook('Book One', [{ id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
    writeBook('Book Three', [{ ...legacy, voiceId: 'v_mira' }], false);
    expect((await design('Book Three')).status).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).toBeTruthy();
    tear('Book One'); // a same-series book that cannot be read: it may hold the voice
    expect((await design('Book Three')).status).toBe(200);
    expect(row('Book Three').voiceUuid).toBe(own);
  });

  it('control: a re-parse of the minting book itself, the book torn: the row is not its own any more and isolates', async () => {
    reset();
    writeBook('Book One', [{ id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
    writeBook('Book Three', [{ ...legacy, voiceId: 'v_mira' }], false);
    expect((await design('Book Three')).status).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    reparse('Book Three');
    tear('Book One');
    expect((await design('Book Three')).status).toBe(200);
    expect(row('Book Three').voiceUuid).not.toBe(own);
  });
});

/* Review pass 4 -- 🟡4: the variant pre-check scans only this book while it is unconfirmed. */
describe('F8 (review pass 4) -- the emotion-take clone pre-check in an unconfirmed book', () => {
  it('R1v: a torn confirmed Book One no longer refuses an emotion take in unconfirmed Book Three, and only Book Three is written', async () => {
    seedUuidDesigned();
    writeFileSync(castPath('Book One'), '{"characters":[');
    const torn = readFileSync(castPath('Book One'), 'utf8');
    const two = readFileSync(castPath('Book Two'), 'utf8');
    const res = await design('Book Three', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const own = row('Book Three').voiceUuid as string;
    expect(own).not.toBe('u1');
    expect(res.body.voiceId).toBe(`qwen-${own}__angry`);
    expect(readFileSync(castPath('Book One'), 'utf8')).toBe(torn);
    expect(readFileSync(castPath('Book Two'), 'utf8')).toBe(two);
    expect(readFileSync(pt('qwen-u1__angry')).equals(BOOK_ONE_ANGRY)).toBe(true);
  });

  it('control: a CONFIRMED Book Three still refuses on a clone anywhere in the series (the pre-check is only narrowed for an unconfirmed book)', async () => {
    seedUuidDesigned();
    confirm('Book Three');
    const one = JSON.parse(readFileSync(castPath('Book One'), 'utf8'));
    one.characters[0].overrideTtsVoices = { qwen: { name: 'qwen-u1', provenance: 'cloned', consent: { attested: true } } };
    writeFileSync(castPath('Book One'), JSON.stringify(one));
    const res = await design('Book Three', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
  });
});

/* Review pass 4 -- 🟠3: Keep's stale-id carry. */
describe('F8 (review pass 4) -- Keep carries only a base preview of the key the row was isolated from', () => {
  it('K1: an emotion preview id sent to Keep in an unconfirmed book is refused and promotes nothing', async () => {
    seedUuidDesigned();
    const prev = await design('Book Three', { preview: true, emotion: 'angry' });
    expect(prev.status, JSON.stringify(prev.body)).toBe(200);
    const three = readFileSync(castPath('Book Three'), 'utf8');
    const keep = await promote('Book Three', prev.body.voiceId);
    expect(keep.status, JSON.stringify(keep.body)).toBe(400);
    expect(readFileSync(castPath('Book Three'), 'utf8')).toBe(three);
    expect(readFileSync(pt('qwen-u1')).equals(BOOK_ONE_PT)).toBe(true);
    expect(uuidBases()).toEqual(['qwen-u1.pt']);
  });

  it('L1: a preview staged for Ash then a re-point: Keep with the old preview id is refused', async () => {
    seedUuidDesigned();
    const ASH_PT = Buffer.from('BOOK-ONE-ASH-PT');
    writeFileSync(pt('qwen-u_ash'), ASH_PT);
    writeFileSync(join(qwenDir(), 'qwen-u_ash.json'), '{"instruct":"ash"}');
    const one = JSON.parse(readFileSync(castPath('Book One'), 'utf8'));
    one.characters.push({ id: 'ash', name: 'Ash', role: 'supporting', color: 'sky', voiceId: 'v_ash', voiceUuid: 'u_ash', overrideTtsVoices: { qwen: { name: 'qwen-u_ash' } } });
    writeFileSync(castPath('Book One'), JSON.stringify(one));
    const prev = await design('Book Three', { preview: true });
    expect(prev.status).toBe(200);
    /* A re-point (link-prior) adopts the target row's voice: the row now sits on Ash's key. */
    const three = JSON.parse(readFileSync(castPath('Book Three'), 'utf8'));
    three.characters[0] = { ...three.characters[0], voiceUuid: 'u_ash', voiceId: 'v_ash', overrideTtsVoices: { qwen: { name: 'qwen-u_ash' } }, matchedFrom: { bookId: ids['Book One'], characterId: 'ash', bookTitle: 'Book One', confidence: 0.9 } };
    writeFileSync(castPath('Book Three'), JSON.stringify(three));
    const keep = await promote('Book Three', prev.body.voiceId);
    expect(keep.status, JSON.stringify(keep.body)).toBe(400);
    expect(readFileSync(pt('qwen-u_ash')).equals(ASH_PT)).toBe(true);
  });
});
