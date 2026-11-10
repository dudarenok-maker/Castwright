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
/* #4072 — holds the FIRST cast-lock acquisition of `dir` until a second one has
   run (or `ms` pass), so one mint's walk stamps Book One and then waits at Book Two
   while the other mint's walk reaches Book Two first: the interleaving that split
   the link before the fix. */
const holdLock = vi.hoisted(() => ({ dir: null as string | null, ms: 400, waiting: null as null | (() => void) }));
vi.mock('../workspace/cast-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/cast-lock.js')>();
  const withCastLock: typeof actual.withCastLock = async (dir, fn) => {
    if (holdLock.dir && resolve(dir) === holdLock.dir) {
      if (!holdLock.waiting) {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        holdLock.waiting = release;
        await Promise.race([gate, new Promise((r) => setTimeout(r, holdLock.ms))]);
        holdLock.dir = null;
      } else {
        const release = holdLock.waiting;
        try {
          return await actual.withCastLock(dir, fn);
        } finally {
          release();
        }
      }
    }
    return actual.withCastLock(dir, fn);
  };
  return { ...actual, withCastLock };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';
const TITLES = ['Book One', 'Book Two', 'Book Three'] as const;
type Title = (typeof TITLES)[number];

let workspaceRoot: string;
let audioDir: string;
let app: Express;
const ids = {} as Record<Title, string>;
let counter = 0;
const fetchMock = vi.fn();
/* #4072 — when set, every design render waits here until `n` renders arrived. */
const barrier = { n: 0, arrived: 0, open: null as null | (() => void), gate: null as Promise<void> | null };

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
  holdLock.dir = null;
  holdLock.waiting = null;
  barrier.n = 0;
  barrier.arrived = 0;
  barrier.gate = null;
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
      if (barrier.n) {
        if (!barrier.gate) barrier.gate = new Promise<void>((r) => (barrier.open = r));
        if (++barrier.arrived >= barrier.n) {
          if (holdLock.dir === 'arm') holdLock.dir = resolve(bookDir('Book Two'));
          barrier.open?.();
        }
        await barrier.gate;
      }
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

describe('#4072 — two concurrent base mints of one legacy series link end on one uuid', () => {
  it('a mint that starts while another of the same link is in flight adopts its uuid: one voiceUuid, one family', async () => {
    seedLegacyDesigned(true);
    writeBook('Book Three', [{ id: 'other', name: 'Other', role: 'supporting', color: 'sky' }]);
    barrier.n = 2;
    holdLock.dir = 'arm';
    const [a, b] = await Promise.all([design('Book One'), design('Book Two')]);
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
    barrier.n = 2;
    const [two, three] = await Promise.all([design('Book Two'), design('Book Three')]);
    expect(two.status, JSON.stringify(two.body)).toBe(200);
    expect(three.status, JSON.stringify(three.body)).toBe(200);
    const shared = row('Book Two').voiceUuid as string;
    expect(row('Book One').voiceUuid).toBe(shared);
    expect(row('Book Three').voiceUuid).toBeTruthy();
    expect(row('Book Three').voiceUuid).not.toBe(shared);
  });
});
