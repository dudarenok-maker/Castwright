/* #3992 — every earlier-book overwrite the PR #4007 review passes found (3-9),
   re-run on the decline-time design: "Don't reuse" separates the row at once, so
   a design never decides anything about a shared voice. Each test ends with
   every voice file another book holds byte-identical (`othersIntact`): only the
   designed row's own key may change.

   Real routes (design-voice, promote-voice, decline-voice-link, link-prior),
   real cast.json files. The sidecar mock writes NEW bytes for whatever voice it
   is asked for, so an overwrite shows up as bytes. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { withCapacityRetry } from '../gpu/capacity-retry.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) => (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
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
/* Runs once, just before a separation takes its book-ops (the window between the
   lock-free plan and the locked step). */
const beforeLocks = vi.hoisted(() => ({ fn: null as (() => void) | null }));
/* Pass 11 — runs (and is awaited) once, just before a design's landing takes the
   row's book-op: the landing is the only single-book book-op taken with no opts
   (the series walk passes `hintDir`). */
const beforeLanding = vi.hoisted(() => ({ bookId: null as string | null, fn: null as (() => Promise<void>) | null }));
vi.mock('../workspace/book-op-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/book-op-lock.js')>();
  const withBookOps: typeof actual.withBookOps = (ids, fn, opts) => {
    if (beforeLocks.fn) {
      const run = beforeLocks.fn;
      beforeLocks.fn = null;
      run();
    }
    return actual.withBookOps(ids, fn, opts);
  };
  const withBookOp = (async (id: string, fn: never, opts?: never) => {
    if (beforeLanding.fn && !opts && id === beforeLanding.bookId) {
      const run = beforeLanding.fn;
      beforeLanding.fn = null;
      await run();
    }
    return (actual.withBookOp as (...a: unknown[]) => unknown)(id, fn, opts);
  }) as typeof actual.withBookOp;
  return { ...actual, withBookOps, withBookOp };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';
const ORIG = Buffer.from('BOOK-ONE-ORIGINAL');
const NEW_PT = Buffer.from('REDESIGNED-BY-SIDECAR');
const TITLES = ['Book One', 'Book Two', 'Book Three', 'Book Four', 'Book Five'] as const;
type Title = (typeof TITLES)[number];

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let previewVoiceIdFor: typeof import('./qwen-voice.js').previewVoiceIdFor;
const ids = {} as Record<Title, string>;
let requested: string[];
const fetchMock = vi.fn();
/* Holds the next design/mint sidecar call until `release` (pass 10, #4028). */
const gate = { hold: false, entered: null as null | (() => void), release: null as null | (() => void) };
/* Pass 11, Y1 — runs (and is awaited) once, inside the first sidecar evict a
   design makes after its landing released the locks. */
const afterLanding = { fn: null as null | (() => Promise<void>) };
const holdNextDesign = (): Promise<void> => {
  gate.hold = true;
  return new Promise<void>((r) => (gate.entered = r));
};

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const row = (t: string): Record<string, any> => JSON.parse(readFileSync(castPath(t), 'utf8')).characters[0];
const writeRows = (t: string, rows: Array<Record<string, unknown>>) =>
  writeFileSync(castPath(t), JSON.stringify({ characters: rows }));
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
  writeRows(t, rows);
}
const baseRow = {
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceUuid: 'u_shared',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
  gender: 'female',
  ageRange: 'adult',
};
const legacy = { ...baseRow, voiceUuid: undefined };
const linkTo = (t: Title) => ({
  matchedFrom: { bookId: ids[t], characterId: 'wren', bookTitle: t, confidence: 1 },
});
const slot = (u: string, variants?: string[]) => ({
  overrideTtsVoices: {
    qwen: {
      name: `qwen-${u}`,
      ...(variants ? { variants: Object.fromEntries(variants.map((e) => [e, { name: `qwen-${u}__${e}` }])) } : {}),
    },
  },
});
const pt = (k: string) => join(qwenDir(), `${k}.pt`);
const design = (t: Title, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });
const decline = (t: Title, from: Title) =>
  request(app).post(`/api/books/${ids[t]}/cast/wren/decline-voice-link`).send({ fromBookId: ids[from] });
const linkPrior = (t: Title, target: Title) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/link-prior`)
    .send({ sourceCharacterId: 'wren', targetBookId: ids[target], targetCharacterId: 'wren' });
const reset = () => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
};
const variantsOf = (t: Title): string[] => Object.keys(row(t).overrideTtsVoices?.qwen?.variants ?? {}).sort();
const torn = (t: Title) => writeFileSync(castPath(t), '{"characters":[');

/* Every voice file on disk, by name. */
function snapshot(): Map<string, Buffer> {
  return new Map(readdirSync(qwenDir()).map((f) => [f, readFileSync(join(qwenDir(), f))]));
}
/* After designing `t`: every file that existed before is byte-identical, except
   the ones keyed by `t`'s own voice (its uuid now). */
function othersIntact(before: Map<string, Buffer>, t: Title) {
  const own = `qwen-${row(t).voiceUuid}`;
  for (const [name, bytes] of before) {
    if (name === `${own}.pt` || name.startsWith(`${own}__`) || name.startsWith(`${own}-`) || name === `${own}.json`) continue;
    expect(readFileSync(join(qwenDir(), name)).equals(bytes), `${name} was rewritten`).toBe(true);
  }
  /* #4028 — every render goes to a private staging key, and nothing staged is left. */
  expect(requested.every((k) => k.startsWith('qwen-staging-')), `the sidecar was asked for ${requested.join(', ')}`).toBe(true);
  expect(readdirSync(qwenDir()).filter((f) => f.startsWith('qwen-staging-'))).toEqual([]);
}
/* Design `t` (base or variant) and check nothing another book holds changed, and
   that the design landed on `t`'s own key. */
async function designSafely(t: Title, extra: Record<string, unknown> = {}) {
  const before = snapshot();
  requested = [];
  const res = await design(t, extra);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  othersIntact(before, t);
  const own = `qwen-${row(t).voiceUuid}${extra.emotion ? `__${extra.emotion}` : ''}`;
  expect(res.body.voiceId).toBe(own);
  expect(readFileSync(pt(own))).toEqual(NEW_PT);
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-3992ow-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-3992ow-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('../routes/qwen-voice.js');
  ({ previewVoiceIdFor } = await import('./qwen-voice.js'));
  const { castDeclineVoiceLinkRouter } = await import('../routes/cast-decline-voice-link.js');
  const { castLinkPriorRouter } = await import('../routes/cast-link-prior.js');
  const { singleDesignRouter } = await import('../routes/single-design.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
  app.use('/api/books', castLinkPriorRouter);
  app.use('/api/books', singleDesignRouter);
});
beforeEach(() => {
  requested = [];
  beforeLocks.fn = null;
  beforeLanding.fn = null;
  beforeLanding.bookId = null;
  afterLanding.fn = null;
  gate.release?.(); // a test that failed while holding a render must not wedge the next
  gate.hold = false;
  gate.entered = null;
  gate.release = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: unknown, init: { body?: string } | undefined) => {
    if (String(_url).includes('evict-voice') && afterLanding.fn) {
      const run = afterLanding.fn;
      afterLanding.fn = null;
      await run();
    }
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* */
    }
    if (voiceId && String(_url).includes('/qwen/') && !String(_url).includes('evict')) {
      if (gate.hold) {
        gate.hold = false;
        await new Promise<void>((r) => {
          gate.release = r;
          gate.entered?.();
        });
      }
      requested.push(voiceId);
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), NEW_PT);
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
  vi.mocked(withCapacityRetry).mockImplementation((doPost: any, opts: any) => doPost(opts.signal));
});
afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
});

/* One <- Two <- Three, all on u_shared (the linker's output), One designed with angry. */
function seedChain() {
  reset();
  writeBook('Book One', [{ ...baseRow, ...slot('u_shared', ['angry']) }]);
  writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared', ['angry']) }]);
  writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two'), ...slot('u_shared', ['angry']) }]);
  writeFileSync(pt('qwen-u_shared'), ORIG);
  writeFileSync(pt('qwen-u_shared__angry'), Buffer.from('ONE-ANGRY'));
}
const oneIntact = () => {
  expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  expect(readFileSync(pt('qwen-u_shared__angry')).toString()).toBe('ONE-ANGRY');
};

describe('the ordinary cases: a design decides nothing', () => {
  it('a series voice nobody declined is redesigned together, from any book, as before', async () => {
    seedChain();
    expect((await design('Book Three')).status).toBe(200);
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(NEW_PT); // the shared voice, for all three
    expect(row('Book One').voiceUuid).toBe('u_shared');
  });

  it("after Don't reuse the decliner designs its own voice at once: no refusal, no fork at design time", async () => {
    seedChain();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const two = row('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(row('Book Three').voiceUuid).toBe(two); // its follower moved with it
    await designSafely('Book Two');
    await designSafely('Book Three');
    await designSafely('Book Two', { emotion: 'sad' });
    expect(row('Book Two').voiceUuid).toBe(two);
    oneIntact();
  });
});

describe('owner decision: a decline moves the whole chain', () => {
  it("One <- Two <- Three <- Four: decline Two moves Two, Three and Four; designing Four leaves One's files byte-identical", async () => {
    seedChain();
    writeBook('Book Four', [{ ...baseRow, ...linkTo('Book Three'), ...slot('u_shared', ['angry']) }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const two = row('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(row('Book Three').voiceUuid).toBe(two);
    expect(row('Book Four').voiceUuid).toBe(two);
    expect(row('Book One')).toEqual({ ...baseRow, ...slot('u_shared', ['angry']) });
    await designSafely('Book Four');
    await designSafely('Book Four', { emotion: 'angry' });
    oneIntact();
    expect(row('Book One').voiceUuid).toBe('u_shared');
  });

  it('the same rule on a design of a row declined before the route separated it: Four moves with Two', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared', ['angry']) }]);
    writeBook('Book Two', [
      { ...baseRow, declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'], ...slot('u_shared', ['angry']) },
    ]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two'), ...slot('u_shared', ['angry']) }]);
    writeBook('Book Four', [{ ...baseRow, ...linkTo('Book Three'), ...slot('u_shared', ['angry']) }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    writeFileSync(pt('qwen-u_shared__angry'), Buffer.from('ONE-ANGRY'));
    await designSafely('Book Two');
    const two = row('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(row('Book Four').voiceUuid).toBe(two);
    await designSafely('Book Four');
    oneIntact();
  });
});

describe('pass 9', () => {
  it("P9-1 (a): Don't reuse on Three, then on Two, then design both: One's files are untouched", async () => {
    seedChain();
    expect((await decline('Book Three', 'Book Two')).status).toBe(200);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect(row('Book Two').voiceUuid).not.toBe('u_shared');
    expect(row('Book Three').voiceUuid).not.toBe('u_shared');
    expect(row('Book Three').voiceUuid).not.toBe(row('Book Two').voiceUuid);
    await designSafely('Book Two');
    await designSafely('Book Three');
    await designSafely('Book Three', { emotion: 'angry' });
    oneIntact();
  });

  it("P9-1 (b): Don't reuse on Three, delete Book Two, design Three: One's files are untouched", async () => {
    seedChain();
    expect((await decline('Book Three', 'Book Two')).status).toBe(200);
    rmSync(bookDir('Book Two'), { recursive: true, force: true });
    await designSafely('Book Three');
    oneIntact();
  });

  it('P9-1 (b), a row declined before the route separated it: its next design separates it first', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Three', [
      { ...baseRow, declinedVoiceFrom: [ids['Book Two']], declinedVoiceUuids: ['u_shared'], ...slot('u_shared') },
    ]); // Book Two, the book it declined, has since been deleted
    writeFileSync(pt('qwen-u_shared'), ORIG);
    await designSafely('Book Three');
    expect(row('Book Three').voiceUuid).not.toBe('u_shared');
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it("P9-1 (b'): Two declines One, Book One is deleted, Three (linked to the deleted One) still holds the voice: designing Two leaves Three's file alone", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    rmSync(bookDir('Book One'), { recursive: true, force: true });
    await designSafely('Book Two');
    expect(row('Book Three').voiceUuid).toBe('u_shared');
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it("P9-1 (b'), seeded before the route separated it: Two's next design separates it, Three's file is untouched", async () => {
    reset();
    writeBook('Book Two', [
      { ...baseRow, declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'], ...slot('u_shared') },
    ]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    await designSafely('Book Two');
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it("P9-1 (c): a follower stranded on One's voice presses Don't reuse and designs (base and angry): One's files are untouched", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared', ['angry']) }]);
    writeBook('Book Two', [
      { ...baseRow, voiceUuid: 'u_two', declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'], ...slot('u_two') },
    ]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two'), ...slot('u_shared', ['angry']) }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    writeFileSync(pt('qwen-u_shared__angry'), Buffer.from('ONE-ANGRY'));
    writeFileSync(pt('qwen-u_two'), Buffer.from('TWO-OWN'));
    const dec = await decline('Book Three', 'Book Two');
    expect(dec.status).toBe(200);
    expect(dec.body.voiceUuid).not.toBe('u_shared');
    await designSafely('Book Three');
    await designSafely('Book Three', { emotion: 'angry' });
    oneIntact();
    expect(readFileSync(pt('qwen-u_two')).toString()).toBe('TWO-OWN');
  });

  it("P9-2: Book One becomes unreadable between the decline's plan and its locks: Two is still separated, One's file untouched", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    beforeLocks.fn = () => torn('Book One');
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect(row('Book Two').voiceUuid).not.toBe('u_shared');
    await designSafely('Book Two');
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it('P9-2, seeded before the route separated it: One unreadable in the window, the design still separates first', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [
      { ...baseRow, declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'], ...slot('u_shared') },
    ]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    beforeLocks.fn = () => torn('Book One');
    await designSafely('Book Two');
    expect(row('Book Two').voiceUuid).not.toBe('u_shared');
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it('R1: a separated row with a torn book elsewhere designs (200) and is never refused', async () => {
    seedChain();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    rmSync(bookDir('Book One'), { recursive: true, force: true });
    const other = join(workspaceRoot, 'books', 'Other Author', 'Other Series', 'Other Book', '.audiobook');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'state.json'), '{"bookId":');
    writeFileSync(join(other, 'cast.json'), JSON.stringify({ characters: [{ id: 'zed' }] }));
    const two = row('Book Two').voiceUuid;
    await designSafely('Book Two');
    await designSafely('Book Two');
    expect(row('Book Two').voiceUuid).toBe(two);
  });
});

describe('pass 8', () => {
  /* Two declined One and was separated onto u_two; Three links to Two, Four to Three. */
  function seedForked() {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [
      { ...baseRow, voiceUuid: 'u_two', declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'], ...slot('u_two', ['angry']) },
    ]);
    writeBook('Book Three', [{ ...baseRow, voiceUuid: 'u_two', ...linkTo('Book Two'), ...slot('u_two', ['angry']) }]);
    writeBook('Book Four', [{ ...baseRow, voiceUuid: 'u_two', ...linkTo('Book Three'), ...slot('u_two', ['angry']) }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    writeFileSync(pt('qwen-u_two'), Buffer.from('TWO-OWN'));
    writeFileSync(pt('qwen-u_two__angry'), Buffer.from('TWO-ANGRY'));
  }

  it('P8-1 stale tab: declining again changes nothing; designing sad keeps u_two and {angry, sad}, and Four stays with Three', async () => {
    seedForked();
    const r = await decline('Book Two', 'Book One');
    expect(r.status).toBe(200);
    expect(r.body.voiceUuid).toBe('u_two');
    await designSafely('Book Two', { emotion: 'sad' });
    expect(row('Book Two').voiceUuid).toBe('u_two');
    expect(variantsOf('Book Two')).toEqual(['angry', 'sad']);
    expect(row('Book Four').voiceUuid).toBe('u_two');
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it("P8-1 link back to One, then Don't reuse again: no other book's file is written", async () => {
    seedForked();
    writeRows('Book Two', [{ ...row('Book Two'), ...linkTo('Book One') }]);
    expect((await linkPrior('Book Two', 'Book One')).status).toBe(200);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    await designSafely('Book Two', { emotion: 'sad' });
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
    expect(readFileSync(pt('qwen-u_two')).toString()).toBe('TWO-OWN');
    expect(readFileSync(pt('qwen-u_two__angry')).toString()).toBe('TWO-ANGRY');
  });

  it('P8-2: a legacy decliner, separated at decline time, redesigns with a torn book elsewhere without a new uuid', async () => {
    reset();
    const legacySlot = { overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
    writeBook('Book One', [{ ...legacy, ...legacySlot }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One'), ...legacySlot }]);
    writeFileSync(pt('qwen-v_wren'), Buffer.from('LEGACY'));
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const t = row('Book Two').voiceUuid as string;
    expect(t).toBeTruthy();
    expect((await design('Book One')).status).toBe(200); // the series mint never restamps Two
    expect(row('Book Two').voiceUuid).toBe(t);
    torn('Book One');
    await designSafely('Book Two');
    await designSafely('Book Two');
    expect(row('Book Two').voiceUuid).toBe(t);
  });
});

describe('pass 7', () => {
  it('P7-A: a separated decliner whose chain grows a second hop keeps its uuid and variants; One is untouched', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const two = row('Book Two').voiceUuid as string;
    await designSafely('Book Two');
    await designSafely('Book Two', { emotion: 'angry' });
    // later books analysed: Three links to Two, Four to Three, all on Two's voice
    writeBook('Book Three', [{ ...baseRow, voiceUuid: two, ...linkTo('Book Two'), ...slot(two, ['angry']) }]);
    writeBook('Book Four', [{ ...baseRow, voiceUuid: two, ...linkTo('Book Three'), ...slot(two, ['angry']) }]);
    await designSafely('Book Two', { emotion: 'sad' });
    await designSafely('Book Two');
    expect(row('Book Two').voiceUuid).toBe(two);
    expect(variantsOf('Book Two')).toEqual(['angry', 'sad']);
    expect(row('Book Four').voiceUuid).toBe(two);
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it('P7-F: a decline made while the row had no uuid, then the earlier book designed: Two never writes the earlier voice', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect((await design('Book One')).status).toBe(200);
    const n = row('Book One').voiceUuid as string;
    expect(row('Book Two').voiceUuid).not.toBe(n);
    writeFileSync(pt(`qwen-${n}`), ORIG);
    torn('Book One');
    await designSafely('Book Two');
    expect(readFileSync(pt(`qwen-${n}`))).toEqual(ORIG);
  });

  it('#4027 (pass 7 C): a preview staged before the decline cannot be promoted onto the earlier book’s voice', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    expect((await design('Book Two', { preview: true })).status).toBe(200);
    expect(requested).toHaveLength(1);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const res = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/promote-voice`)
      .send({ previewVoiceId: 'qwen-u_shared-preview', sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(res.status).toBe(400); // the row's key moved: the stale preview id no longer matches it
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
    const own = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/promote-voice`)
      .send({
        previewVoiceId: previewVoiceIdFor(`qwen-${row('Book Two').voiceUuid}`, ids['Book Two'], 'wren'),
        sampleVoiceId: 'v_wren',
        modelKey: QWEN_KEY,
      });
    expect(own.status).toBe(409); // nothing staged under its own key
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });
});

describe('passes 5 and 6', () => {
  it('P5-1: design One, decline Two, confirm Three (legacy, linked to Two) and design it: no other book’s voice is written', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two') }], false);
    expect((await design('Book One')).status).toBe(200);
    const u = row('Book One').voiceUuid as string;
    writeFileSync(pt(`qwen-${u}`), ORIG);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect(row('Book Two').voiceUuid).not.toBe(u);
    writeBook('Book Three', [{ ...row('Book Three') }], true);
    await designSafely('Book Three');
    await designSafely('Book Two');
    expect(row('Book One').voiceUuid).toBe(u);
    expect(readFileSync(pt(`qwen-${u}`))).toEqual(ORIG);
  });

  it('P6-A: design One, decline Two, design Two, decline Five, re-link Three to Two, design Four: Book Five keeps its voice', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book One') }]);
    writeBook('Book Five', [{ ...legacy, ...linkTo('Book Two') }]);
    writeBook('Book Four', [{ ...legacy, ...linkTo('Book Three') }], false);
    expect((await design('Book One')).status).toBe(200);
    const u = row('Book One').voiceUuid as string;
    writeFileSync(pt(`qwen-${u}`), ORIG);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = row('Book Two').voiceUuid as string;
    expect(row('Book Five').voiceUuid).toBe(x); // its follower moved with it
    await designSafely('Book Two');
    expect((await decline('Book Five', 'Book Two')).status).toBe(200);
    const five = row('Book Five').voiceUuid as string;
    expect(five).not.toBe(x);
    writeFileSync(pt(`qwen-${five}`), Buffer.from('BOOK-FIVE-OWN'));
    expect((await linkPrior('Book Three', 'Book Two')).status).toBe(200);
    writeBook('Book Four', [{ ...row('Book Four') }], true);
    await designSafely('Book Four');
    expect(readFileSync(pt(`qwen-${five}`)).toString()).toBe('BOOK-FIVE-OWN');
    expect(readFileSync(pt(`qwen-${u}`))).toEqual(ORIG);
  });

  it('P6-B: a link cycle where each row declines the other answers promptly, and each designs only its own voice', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, voiceUuid: 'u_s', ...slot('u_s') }]);
    writeBook('Book Two', [{ ...baseRow, voiceUuid: 'u_s', ...linkTo('Book Three'), ...slot('u_s') }]);
    writeBook('Book Three', [{ ...baseRow, voiceUuid: 'u_s', ...linkTo('Book Two'), ...slot('u_s') }]);
    writeFileSync(pt('qwen-u_s'), ORIG);
    const started = Date.now();
    expect((await decline('Book Two', 'Book Three')).status).toBe(200);
    expect((await decline('Book Three', 'Book Two')).status).toBe(200);
    await designSafely('Book Two');
    await designSafely('Book Three');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(row('Book Two').voiceUuid).not.toBe(row('Book Three').voiceUuid);
    expect(readFileSync(pt('qwen-u_s'))).toEqual(ORIG);
  });

  it('P6-C: a chain hanging off the decliner never separates it twice; the decliner and its follower never write the earlier voice', async () => {
    seedChain();
    writeBook('Book Four', [{ ...baseRow, ...linkTo('Book Three'), ...slot('u_shared') }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const two = row('Book Two').voiceUuid;
    expect(row('Book Three').voiceUuid).toBe(two);
    await designSafely('Book Two');
    await designSafely('Book Three');
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    await designSafely('Book Two');
    expect(row('Book Two').voiceUuid).toBe(two); // separated exactly once
    oneIntact();
  });

  it('P6-D: a follower re-linked to Book One between the decline’s plan and its locks fails the step; the retry leaves it with Book One', async () => {
    seedChain();
    beforeLocks.fn = () => writeRows('Book Three', [{ ...row('Book Three'), ...linkTo('Book One') }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(500);
    expect(row('Book Two').voiceUuid).toBe('u_shared');
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect(row('Book Three').voiceUuid).toBe('u_shared');
    await designSafely('Book Two');
    oneIntact();
  });
});

describe('passes 3 and 4', () => {
  it('a follower unreadable at the decline is not left behind silently: the decline fails, and the retry carries it', async () => {
    seedChain();
    beforeLocks.fn = () => torn('Book Three');
    const res = await decline('Book Two', 'Book One');
    expect(res.status).toBe(500);
    expect(row('Book Two').voiceUuid).toBe('u_shared');
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two'), ...slot('u_shared', ['angry']) }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect(row('Book Three').voiceUuid).toBe(row('Book Two').voiceUuid);
    await designSafely('Book Three');
    oneIntact();
  });

  it('the legacy key in three books: the decliner and its real follower take a uuid together; Book One keeps its legacy key', async () => {
    reset();
    const legacySlot = { overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
    writeBook('Book One', [{ ...legacy, ...legacySlot }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One'), ...legacySlot }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two'), ...legacySlot }]);
    writeFileSync(pt('qwen-v_wren'), ORIG);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const two = row('Book Two').voiceUuid;
    expect(two).toBeTruthy();
    expect(row('Book Three').voiceUuid).toBe(two);
    expect(row('Book One').voiceUuid).toBeUndefined();
    await designSafely('Book Three');
    await designSafely('Book Two');
    expect(readFileSync(pt('qwen-v_wren'))).toEqual(ORIG);
    expect(row('Book One').voiceUuid).toBeUndefined();
  });
});

describe('pass 10, P10-1 (owner decision: stop at the declined book)', () => {
  /* Confirm's auto-match links an earlier book to a later one too, so a link
     cycle through the declined book is ordinary. A row in the declined book is
     never a follower: it cuts the chain and holds the voice. The declined book's
     cast.json is compared by content: a series walk that changes nothing still
     rewrites it (an idempotent write, voices.ts forEachMatchingCastCharacter). */
  const raw = (t: Title) => JSON.parse(readFileSync(castPath(t), 'utf8'));

  it("(a) One <-> Two on one uuid: Don't reuse on Two leaves Book One's voice file byte-identical and its cast.json unchanged, and designs never re-separate", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...linkTo('Book Two'), ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    const oneCast = raw('Book One');
    const res = await decline('Book Two', 'Book One');
    expect(res.status).toBe(200);
    const two = row('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(res.body.voiceUuid).toBe(two);
    await designSafely('Book Two');
    await designSafely('Book Two', { emotion: 'angry' });
    await designSafely('Book Two');
    expect(row('Book Two').voiceUuid).toBe(two); // never re-separated
    expect(variantsOf('Book Two')).toEqual(['angry']);
    expect(raw('Book One'), "Book One's cast.json was rewritten").toEqual(oneCast);
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it("(b) Two <-> Three with One an unlinked holder: Don't reuse on Two (from Three) moves Two alone; Three's voice and cast are unchanged and Two keeps its variants", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book Three'), ...slot('u_shared') }]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    const threeCast = raw('Book Three');
    expect((await decline('Book Two', 'Book Three')).status).toBe(200);
    const two = row('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(row('Book Three').voiceUuid).toBe('u_shared');
    await designSafely('Book Two', { emotion: 'angry' });
    await designSafely('Book Two');
    await designSafely('Book Two');
    expect(row('Book Two').voiceUuid).toBe(two);
    expect(variantsOf('Book Two')).toEqual(['angry']);
    expect(raw('Book Three'), "Book Three's cast.json was rewritten").toEqual(threeCast);
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it("(c) the cycle One -> Three -> Two -> One: Don't reuse on Two (from One) moves Two and Three; One's voice and cast are unchanged", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...linkTo('Book Three'), ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    const oneCast = raw('Book One');
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const two = row('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(row('Book Three').voiceUuid).toBe(two); // Three follows Two
    await designSafely('Book Two');
    await designSafely('Book Three');
    await designSafely('Book Two');
    expect(row('Book Two').voiceUuid).toBe(two);
    expect(raw('Book One'), "Book One's cast.json was rewritten").toEqual(oneCast);
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });
});

describe('pass 10, P10-2: a legacy book and a separated one never share a variant', () => {
  /* One and Two are legacy (`v_wren`) and linked; "Don't reuse" gives Two a uuid
     of its own while One stays legacy. A variant slot only signals presence:
     render re-derives `<row's key>__<emotion>`, so a slot on a row whose key
     differs from the variant's base asks for a file that does not exist. */
  const legacySlot = { overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
  const ONE_ANGRY = Buffer.from('ONE-ANGRY');
  function seedLegacyPair() {
    reset();
    writeBook('Book One', [{ ...legacy, ...legacySlot }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One'), ...legacySlot }]);
    writeFileSync(pt('qwen-v_wren'), ORIG);
  }
  /* Every variant slot a row carries names a file under the row's own key. */
  function rendersOnlyOwnVariants(t: Title) {
    const r = row(t);
    const key = r.voiceUuid ? `qwen-${r.voiceUuid}` : `qwen-${r.voiceId ?? r.id}`;
    for (const e of Object.keys(r.overrideTtsVoices?.qwen?.variants ?? {})) {
      expect(readdirSync(qwenDir()).includes(`${key}__${e}.pt`), `${t}'s ${e} slot asks for a missing ${key}__${e}`).toBe(true);
    }
  }
  /* Two still carries One's angry slot: the state a design made before this fix. */
  function plantOnesSlotOnTwo() {
    writeRows('Book Two', [
      {
        ...row('Book Two'),
        overrideTtsVoices: { qwen: { ...row('Book Two').overrideTtsVoices.qwen, variants: { angry: { name: 'qwen-v_wren__angry' } } } },
      },
    ]);
  }

  it("One (legacy) designs angry after Two declined: Two gains no slot, and both books render only their own variants", async () => {
    seedLegacyPair();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect(row('Book Two').voiceUuid).toBeTruthy();
    expect(row('Book One').voiceUuid).toBeUndefined();
    expect((await design('Book One', { emotion: 'angry' })).status).toBe(200);
    expect(readdirSync(qwenDir())).toContain('qwen-v_wren__angry.pt');
    expect(variantsOf('Book One')).toEqual(['angry']);
    expect(variantsOf('Book Two')).toEqual([]);
    rendersOnlyOwnVariants('Book One');
    rendersOnlyOwnVariants('Book Two');
  });

  it('the reverse: Two (separated) designs angry, and legacy One gains no slot', async () => {
    seedLegacyPair();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect((await design('Book Two', { emotion: 'angry' })).status).toBe(200);
    expect(variantsOf('Book Two')).toEqual(['angry']);
    expect(variantsOf('Book One')).toEqual([]);
    rendersOnlyOwnVariants('Book One');
    rendersOnlyOwnVariants('Book Two');
  });

  it("Two's DELETE of a slot naming One's legacy variant keeps One's file", async () => {
    seedLegacyPair();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    writeRows('Book One', [{ ...row('Book One'), overrideTtsVoices: { qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } } } }]);
    writeFileSync(pt('qwen-v_wren__angry'), ONE_ANGRY);
    plantOnesSlotOnTwo();
    const del = await request(app).delete(`/api/books/${ids['Book Two']}/cast/wren/emotion-variant/angry`);
    expect(del.status).toBe(200);
    expect(variantsOf('Book Two')).toEqual([]);
    expect(readFileSync(pt('qwen-v_wren__angry'))).toEqual(ONE_ANGRY);
  });

  it("Two's redesign and promote keep One's legacy variant file", async () => {
    seedLegacyPair();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    writeRows('Book One', [{ ...row('Book One'), overrideTtsVoices: { qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } } } }]);
    writeFileSync(pt('qwen-v_wren__angry'), ONE_ANGRY);
    plantOnesSlotOnTwo();
    const p = await design('Book Two', { preview: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    const promote = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/promote-voice`)
      .send({ previewVoiceId: p.body.voiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(promote.status, JSON.stringify(promote.body)).toBe(200);
    expect(readFileSync(pt('qwen-v_wren__angry'))).toEqual(ONE_ANGRY);
    expect(readFileSync(pt('qwen-v_wren'))).toEqual(ORIG);
  });
});

describe('pass 10, #4028 (owner decision: stage, then re-check under the locks)', () => {
  /* A design renders to a private staging key and moves it onto the row's
     CURRENT key only at the end, under the book-op and cast lock a decline also
     holds. So a decline that lands mid-render sends the design to the row's new
     voice, and the declined book's file is never written. */
  const staged = () => readdirSync(qwenDir()).filter((f) => f.startsWith('qwen-staging-'));

  it('(a) cross-book: Three is mid-render when Two declines One; Three moves, and its design lands on its new voice', async () => {
    seedChain();
    const entered = holdNextDesign();
    const designing = design('Book Three').then((r) => r);
    await entered;
    const dec = await decline('Book Two', 'Book One');
    expect(dec.status).toBe(200);
    const x = row('Book Three').voiceUuid;
    expect(x).not.toBe('u_shared');
    gate.release!();
    const d = await designing;
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.voiceUuid).toBe(x);
    expect(d.body.voiceId).toBe(`qwen-${x}`);
    expect(readFileSync(pt(`qwen-${x}`))).toEqual(NEW_PT);
    oneIntact();
    expect(staged()).toEqual([]);
  });

  it("(b) same book: Two's own design is mid-render when Two declines; the decline does not wait, and the design lands on Two's new voice", async () => {
    seedChain();
    const entered = holdNextDesign();
    const designing = design('Book Two').then((r) => r);
    await entered;
    const dec = await decline('Book Two', 'Book One'); // answers while the render is held
    expect(dec.status).toBe(200);
    const x = row('Book Two').voiceUuid;
    expect(x).not.toBe('u_shared');
    gate.release!();
    const d = await designing;
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.voiceUuid).toBe(x);
    expect(readFileSync(pt(`qwen-${x}`))).toEqual(NEW_PT);
    oneIntact();
    expect(staged()).toEqual([]);
  });

  it("(b) same book, the review's shape: Wren's design queued behind Tamsin's, Don't reuse on Wren pressed meanwhile", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    const tamsin = { ...baseRow, id: 'tamsin', name: 'Tamsin', voiceId: 'v_tamsin', voiceUuid: 'u_tamsin', ...slot('u_tamsin') };
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }, tamsin]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    const entered = holdNextDesign();
    const tamsinDone = request(app)
      .post(`/api/books/${ids['Book Two']}/cast/tamsin/design-voice`)
      .send({ sampleVoiceId: 'v_tamsin', modelKey: QWEN_KEY })
      .then((r) => r);
    await entered;
    const wren = design('Book Two').then((r) => r);
    const dec = await decline('Book Two', 'Book One');
    expect(dec.status).toBe(200);
    const x = row('Book Two').voiceUuid;
    gate.release!();
    const [a, b] = await Promise.all([tamsinDone, wren]);
    expect(a.status).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.voiceUuid).toBe(x);
    expect(readFileSync(pt(`qwen-${x}`))).toEqual(NEW_PT);
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
    expect(staged()).toEqual([]);
  });

  it('(c) legacy series mint: legacy Three is mid-render when Two declines One; Three lands on its new voice and Book One is untouched', async () => {
    reset();
    const legacySlot = { overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
    writeBook('Book One', [{ ...legacy, ...legacySlot }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One'), ...legacySlot }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two'), ...legacySlot }]);
    writeFileSync(pt('qwen-v_wren'), ORIG);
    const oneBefore = row('Book One');
    const entered = holdNextDesign();
    const designing = design('Book Three').then((r) => r);
    await entered;
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = row('Book Three').voiceUuid;
    expect(x).toBeTruthy();
    expect(row('Book Two').voiceUuid).toBe(x);
    gate.release!();
    const d = await designing;
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.voiceUuid).toBe(x);
    expect(readFileSync(pt(`qwen-${x}`))).toEqual(NEW_PT);
    expect(readFileSync(pt('qwen-v_wren'))).toEqual(ORIG);
    expect(row('Book One')).toEqual(oneBefore); // no series mint reached it
    expect(staged()).toEqual([]);
  });

  it("a variant mid-render when the row declines lands on the new voice, never on the earlier book's variant", async () => {
    seedChain();
    const entered = holdNextDesign();
    const designing = design('Book Two', { emotion: 'sad' }).then((r) => r);
    await entered;
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = row('Book Two').voiceUuid;
    gate.release!();
    const d = await designing;
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.voiceId).toBe(`qwen-${x}__sad`);
    expect(readFileSync(pt(`qwen-${x}__sad`))).toEqual(NEW_PT);
    expect(readdirSync(qwenDir())).not.toContain('qwen-u_shared__sad.pt');
    oneIntact();
    expect(variantsOf('Book One')).toEqual(['angry']);
    expect(staged()).toEqual([]);
  });

  it('a sidecar failure after a partial write leaves no staged files and writes no voice', async () => {
    seedChain();
    const before = snapshot();
    fetchMock.mockImplementationOnce(async (_url: unknown, init: { body?: string } | undefined) => {
      const voiceId = JSON.parse(init?.body ?? '{}').voiceId;
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), NEW_PT); // a partial write, then the failure
      return {
        ok: false,
        status: 500,
        statusText: 'boom',
        headers: new Headers(),
        json: async () => ({ detail: 'boom' }),
        text: async () => 'boom',
      };
    });
    const d = await design('Book Two');
    expect(d.status).toBeGreaterThanOrEqual(500);
    expect(staged()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('a row deleted mid-render answers 404 and leaves no staged files', async () => {
    seedChain();
    const entered = holdNextDesign();
    const designing = design('Book Two').then((r) => r);
    await entered;
    writeRows('Book Two', []);
    gate.release!();
    const d = await designing;
    expect(d.status).toBe(404);
    expect(staged()).toEqual([]);
    oneIntact();
  });

  it("the stale preview: Don't reuse drops the decliner's staged preview, keeps Book One's own, and Cancel still answers 200", async () => {
    seedChain();
    const two = await design('Book Two', { preview: true });
    const one = await design('Book One', { preview: true });
    expect(two.status).toBe(200);
    expect(one.status).toBe(200);
    expect(two.body.voiceId).not.toBe(one.body.voiceId); // each row stages its own preview
    expect(readdirSync(qwenDir())).toContain(`${two.body.voiceId}.pt`);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect(readdirSync(qwenDir())).not.toContain(`${two.body.voiceId}.pt`);
    expect(readdirSync(qwenDir())).toContain(`${one.body.voiceId}.pt`);
    const promoteStale = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/promote-voice`)
      .send({ previewVoiceId: two.body.voiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(promoteStale.status).toBe(400);
    const cancel = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/discard-voice`)
      .send({ previewVoiceId: two.body.voiceId });
    expect(cancel.status).toBe(200);
    /* Book One cannot promote Book Two's preview: it is not One's own. */
    const onePromotesTwo = await request(app)
      .post(`/api/books/${ids['Book One']}/cast/wren/promote-voice`)
      .send({ previewVoiceId: two.body.voiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(onePromotesTwo.status).toBe(400);
    oneIntact();
  });
});

describe('pass 11, P11-3 / P11-2 (owner decision: the series mint copies before it stamps)', () => {
  const legacySlot = { overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
  /* Legacy One <- Two (<- Three), One designed; nobody has a uuid yet. */
  const seedLegacyChain = (three = false) => {
    reset();
    writeBook('Book One', [{ ...legacy, ...legacySlot }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One'), ...legacySlot }]);
    if (three) writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two'), ...legacySlot }]);
    writeFileSync(pt('qwen-v_wren'), ORIG);
  };
  const keyFile = (t: Title) => pt(row(t).voiceUuid ? `qwen-${row(t).voiceUuid}` : 'qwen-v_wren');

  it('P11-3: Design & compare on Two, then Cancel: both books still speak One’s voice', async () => {
    seedLegacyChain();
    const d = await design('Book Two', { preview: true });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const n = row('Book Two').voiceUuid;
    expect(n).toBeTruthy();
    expect(row('Book One').voiceUuid).toBe(n); // the mint still unifies the series voice
    const cancel = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/discard-voice`)
      .send({ previewVoiceId: d.body.voiceId });
    expect(cancel.status).toBe(200);
    expect(readFileSync(keyFile('Book One'))).toEqual(ORIG);
    expect(readFileSync(keyFile('Book Two'))).toEqual(ORIG);
    expect(readFileSync(pt('qwen-v_wren'))).toEqual(ORIG);
  });

  /* Owner decision (share a first design): nothing to copy, so the mint stamps
     only Two; the landing then shares the landed file with One. */
  it('P11-3: a never-designed legacy key: the first design lands, then One shares it', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    const d = await design('Book Two');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const n = row('Book Two').voiceUuid;
    expect(n).toBeTruthy();
    expect(row('Book One').voiceUuid).toBe(n);
    expect(readdirSync(qwenDir()).sort()).toEqual([`qwen-${n}.pt`]);
    expect(readFileSync(pt(`qwen-${n}`))).toEqual(NEW_PT);
  });

  it('first design shared: Design & compare shares nothing (no file lands on the real key)', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    const d = await design('Book Two', { preview: true });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(row('Book Two').voiceUuid).toBeTruthy();
    expect(row('Book One').voiceUuid).toBeUndefined();
  });

  it('first design shared through the SSE job: One gets the uuid and the slot', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    const res = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/design-voice/stream`)
      .send({ persona: 'a bright voice', sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(res.status).toBe(200);
    const n = row('Book Two').voiceUuid;
    expect(n).toBeTruthy();
    expect(row('Book One').voiceUuid).toBe(n);
    expect(row('Book One').overrideTtsVoices?.qwen?.name).toBe(`qwen-${n}`);
    expect(readFileSync(pt(`qwen-${n}`))).toEqual(NEW_PT);
  });

  it("P11-2: Don't reuse on Two lands between Three's mint and its landing: One keeps a voice file", async () => {
    seedLegacyChain(true);
    beforeLanding.bookId = ids['Book Three'];
    let dec: { status: number } | undefined;
    beforeLanding.fn = async () => {
      dec = await decline('Book Two', 'Book One');
    };
    const d = await design('Book Three');
    expect(dec?.status).toBe(200);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const x = row('Book Three').voiceUuid;
    expect(row('Book Two').voiceUuid).toBe(x);
    expect(d.body.voiceId).toBe(`qwen-${x}`);
    expect(readFileSync(pt(`qwen-${x}`))).toEqual(NEW_PT);
    expect(readFileSync(keyFile('Book One'))).toEqual(ORIG);
  });

  it("P11-2 guard: a decline whose source .pt is missing while the row has a designed slot fails retryably and moves nothing", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    const twoBefore = row('Book Two');
    const dec = await decline('Book Two', 'Book One');
    expect(dec.status).toBe(500);
    expect(dec.body.error).toMatch(/try again/);
    expect(row('Book Two')).toEqual(twoBefore);
    expect(readdirSync(qwenDir())).toEqual([]);
  });
});
describe('pass 11, P11-1: a design in a book whose cast is not confirmed yet', () => {
  /* The series walk skips unconfirmed books, the designing one included; the mint
     stamps the row's own book itself, so the design lands and no other book is
     left on a uuid without a file. */
  const legacySlot = { overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
  const sse = (t: Title, extra: Record<string, unknown> = {}) =>
    request(app)
      .post(`/api/books/${ids[t]}/cast/wren/design-voice/stream`)
      .send({ persona: 'a bright voice', sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra })
      .then((r) =>
        r.text
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => JSON.parse(l.slice(6)) as Record<string, any>),
      );
  const final = (events: Array<Record<string, any>>) => events.filter((e) => e.type !== 'heartbeat' && e.type !== 'phase').at(-1)!;
  const keyFile = (t: Title) => pt(row(t).voiceUuid ? `qwen-${row(t).voiceUuid}` : 'qwen-v_wren');
  const seedLinkedUnconfirmed = () => {
    reset();
    writeBook('Book One', [{ ...legacy, ...legacySlot }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }], false);
    writeFileSync(pt('qwen-v_wren'), ORIG);
  };
  const seedFreshUnconfirmed = () => {
    reset();
    writeBook('Book Two', [{ ...legacy, voiceId: undefined }], false);
  };

  it('(a) REST: Two (unconfirmed) linked to legacy One designs; One keeps a real .pt', async () => {
    seedLinkedUnconfirmed();
    const d = await design('Book Two');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const n = row('Book Two').voiceUuid;
    expect(n).toBeTruthy();
    expect(d.body.voiceId).toBe(`qwen-${n}`);
    expect(readFileSync(pt(`qwen-${n}`))).toEqual(NEW_PT);
    expect(readFileSync(keyFile('Book One')).length).toBeGreaterThan(0);
  });

  it('(a) SSE first design: designed, and One keeps a real .pt', async () => {
    seedLinkedUnconfirmed();
    const end = final(await sse('Book Two'));
    expect(end.type, JSON.stringify(end)).toBe('designed');
    const n = row('Book Two').voiceUuid;
    expect(end.voiceId).toBe(`qwen-${n}`);
    expect(readFileSync(keyFile('Book One')).length).toBeGreaterThan(0);
  });

  it('(a) SSE Design & compare: preview_ready, and One keeps its own bytes', async () => {
    seedLinkedUnconfirmed();
    const end = final(await sse('Book Two', { preview: true }));
    expect(end.type, JSON.stringify(end)).toBe('preview_ready');
    expect(readFileSync(keyFile('Book One'))).toEqual(ORIG);
  });

  it('(b) REST: a fresh unlinked character in an unconfirmed book designs', async () => {
    seedFreshUnconfirmed();
    const d = await design('Book Two');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.voiceId).toBe(`qwen-${row('Book Two').voiceUuid}`);
  });

  it('(b) SSE first design and Design & compare: a fresh unlinked character in an unconfirmed book designs', async () => {
    seedFreshUnconfirmed();
    const first = final(await sse('Book Two'));
    expect(first.type, JSON.stringify(first)).toBe('designed');
    seedFreshUnconfirmed();
    const compare = final(await sse('Book Two', { preview: true }));
    expect(compare.type, JSON.stringify(compare)).toBe('preview_ready');
  });
});
describe('pass 11, P11-5 (owner decision: discard and retry when the voice changed under the render)', () => {
  /* Legacy One designed with angry; legacy Two on its own voice (v_two). A
     link-prior Two -> One that lands mid-render changes Two's key to One's: the
     design must not land on another book's key, so it is discarded and the user
     is asked to design again. */
  const RETRY = "This character's voice changed while it was being designed. Design it again.";
  const staged = () => readdirSync(qwenDir()).filter((f) => f.startsWith('qwen-staging-'));
  const seedTwoOwnVoice = () => {
    reset();
    writeBook('Book One', [
      { ...legacy, overrideTtsVoices: { qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } } } },
    ]);
    writeBook('Book Two', [{ ...legacy, voiceId: 'v_two', overrideTtsVoices: { qwen: { name: 'qwen-v_two' } } }]);
    writeFileSync(pt('qwen-v_wren'), ORIG);
    writeFileSync(pt('qwen-v_wren__angry'), Buffer.from('ONE-ANGRY'));
    writeFileSync(pt('qwen-v_two'), Buffer.from('TWO-OWN'));
  };
  const oneUntouched = (oneBefore: Record<string, unknown>) => {
    expect(readFileSync(pt('qwen-v_wren'))).toEqual(ORIG);
    expect(readFileSync(pt('qwen-v_wren__angry')).toString()).toBe('ONE-ANGRY');
    expect(row('Book One')).toEqual(oneBefore);
    expect(staged()).toEqual([]);
  };

  for (const shape of [
    { name: 'variant (angry)', extra: { emotion: 'angry' } },
    { name: 'base redesign', extra: {} },
  ]) {
    it(`${shape.name}: link-prior Two -> One lands mid-render; the design answers the retry error and One is byte-identical`, async () => {
      seedTwoOwnVoice();
      const oneBefore = row('Book One');
      const entered = holdNextDesign();
      const designing = design('Book Two', shape.extra).then((r) => r);
      await entered;
      const link = await linkPrior('Book Two', 'Book One');
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      expect(row('Book Two').voiceId).toBe('v_wren');
      gate.release!();
      const d = await designing;
      expect(d.status).toBe(500);
      expect(d.body.error).toBe(RETRY);
      oneUntouched(oneBefore);
    });
  }

  it('variant: the link lands after the uuid step, just before the landing; the landing itself refuses it', async () => {
    seedTwoOwnVoice();
    const oneBefore = row('Book One');
    beforeLanding.bookId = ids['Book Two'];
    let link: { status: number } | undefined;
    beforeLanding.fn = async () => {
      link = await linkPrior('Book Two', 'Book One');
    };
    const d = await design('Book Two', { emotion: 'angry' });
    expect(link?.status).toBe(200);
    expect(d.status).toBe(500);
    expect(d.body.error).toBe(RETRY);
    oneUntouched(oneBefore);
  });

  it('control: with no link mid-render, the same base redesign lands on Two’s own new key', async () => {
    seedTwoOwnVoice();
    const oneBefore = row('Book One');
    const d = await design('Book Two');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.voiceId).toBe(`qwen-${row('Book Two').voiceUuid}`);
    oneUntouched(oneBefore);
  });
});
describe('pass 11, Y1: a first design stamps its own slot under the landing lock', () => {
  it("Don't reuse right after an SSE first design lands: the moved row keeps a .pt AND a qwen slot", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One') }]);
    let dec: { status: number } | undefined;
    afterLanding.fn = async () => {
      dec = await decline('Book Two', 'Book One');
    };
    const res = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/design-voice/stream`)
      .send({ persona: 'a bright voice', sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(res.status).toBe(200);
    expect(dec?.status).toBe(200);
    const two = row('Book Two');
    expect(two.voiceUuid).not.toBe('u_shared');
    expect(readFileSync(pt(`qwen-${two.voiceUuid}`))).toEqual(NEW_PT);
    const { pickVoiceForEngine } = await import('../tts/voice-mapping.js');
    expect(pickVoiceForEngine('qwen', two as never)).toBe(`qwen-${two.voiceUuid}`);
  });
});
describe('pass 11, Y2: staged files a late sidecar write leaves behind are swept', () => {
  it('startup: every qwen-staging-* file goes, every other voice file stays', async () => {
    reset();
    for (const f of ['qwen-staging-abc.pt', 'qwen-staging-abc.json', 'qwen-staging-abc__master.wav', 'qwen-keep.pt']) {
      writeFileSync(join(qwenDir(), f), 'x');
    }
    const { sweepStaleDesignStaging } = await import('./qwen-voice.js');
    expect(await sweepStaleDesignStaging()).toBe(3);
    expect(readdirSync(qwenDir())).toEqual(['qwen-keep.pt']);
  });

  it('a render that timed out: the files the sidecar writes afterwards are removed later', async () => {
    seedChain();
    const qv = await import('./qwen-voice.js');
    const delay = qv.LATE_STAGING_SWEEP.delayMs;
    qv.LATE_STAGING_SWEEP.delayMs = 50;
    try {
      let staging = '';
      fetchMock.mockImplementationOnce(async (_url: unknown, init: { body?: string } | undefined) => {
        staging = JSON.parse(init?.body ?? '{}').voiceId;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      });
      const d = await design('Book Two');
      expect(d.status).toBeGreaterThanOrEqual(500);
      expect(staging).toMatch(/^qwen-staging-/);
      writeFileSync(pt(staging), NEW_PT); // the sidecar's thread finishes after the abort
      await new Promise((r) => setTimeout(r, 300));
      expect(readdirSync(qwenDir()).filter((f) => f.startsWith('qwen-staging-'))).toEqual([]);
      oneIntact();
    } finally {
      qv.LATE_STAGING_SWEEP.delayMs = delay;
    }
  });
});