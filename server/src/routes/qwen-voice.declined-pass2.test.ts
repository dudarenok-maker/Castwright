/* #3992 pass-2 — the design route's fork against the shapes pass 2 found, on real
   cast.json files with a mocked sidecar that writes DIFFERENT bytes for whatever
   voice it is asked for, so an unprotected earlier book shows up as its bytes
   being overwritten. Book One holds the shared voice u_shared; Book Two declined
   it; Book Three follows Book Two. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
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
const failWriteIn = vi.hoisted(() => ({ text: null as string | null, skip: 0 }));
/* Runs once, in the middle of the fork's copy step (after the scan, before the
   locks), to simulate a book changing under it. */
const copyHook = vi.hoisted(() => ({ fn: null as null | (() => void) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile = async (path: unknown, ...rest: unknown[]) => {
    if (failWriteIn.text && String(path).includes(failWriteIn.text) && failWriteIn.skip-- <= 0) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(path)}'`), {
        code: 'EBUSY',
        syscall: 'open',
        path: String(path),
      });
    }
    return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
  };
  const copyFile = async (...a: unknown[]) => {
    const hook = copyHook.fn;
    copyHook.fn = null;
    hook?.();
    return (actual.copyFile as (...x: unknown[]) => Promise<void>)(...a);
  };
  return { ...actual, default: { ...actual, writeFile, copyFile }, writeFile, copyFile };
});
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

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';
const ORIG_PT = Buffer.from('BOOK-ONE-ORIGINAL-PT');
const ORIG_JSON = Buffer.from('{"voiceId":"qwen-u_shared","instruct":"book one"}');
const NEW_PT = Buffer.from('REDESIGNED-BY-SIDECAR');
const TITLES = ['Book One', 'Book Two', 'Book Three', 'Book Four'] as const;
type Title = (typeof TITLES)[number];

let workspaceRoot: string;
let audioDir: string;
let app: Express;
const ids = {} as Record<Title, string>;
let requestedVoiceIds: string[];
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const rowsOf = (t: string): Array<Record<string, any>> =>
  JSON.parse(readFileSync(castPath(t), 'utf8')).characters;
const readRow = (t: string): Record<string, any> => rowsOf(t)[0];
const writeRows = (t: string, rows: Array<Record<string, unknown>>) =>
  writeFileSync(castPath(t), JSON.stringify({ characters: rows }));
function writeBook(t: Title, rows: Array<Record<string, unknown>>) {
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
      castConfirmed: true,
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
const linkTo = (t: Title, characterId = 'wren') => ({
  matchedFrom: { bookId: ids[t], characterId, bookTitle: t, confidence: 1 },
});
function seedChain() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  writeBook('Book One', [{ ...baseRow }]);
  writeBook('Book Two', [
    { ...baseRow, declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'] },
  ]);
  writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two') }]);
  mkdirSync(qwenDir(), { recursive: true });
  writeFileSync(join(qwenDir(), 'qwen-u_shared.pt'), ORIG_PT);
  writeFileSync(join(qwenDir(), 'qwen-u_shared.json'), ORIG_JSON);
}
const pcm = () => new Uint8Array(24_000 * 2 * 0.3);
const design = (t: Title, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });
const book1Intact = () => readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT);

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'pr4007p2-'));
  audioDir = mkdtempSync(join(tmpdir(), 'pr4007p2-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { voicesRouter } = await import('./voices.js');
  const { voiceMatchRouter } = await import('./voice-match.js');
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/books', voiceMatchRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
  app.use('/api/voices', voicesRouter);
});
beforeEach(() => {
  failWriteIn.text = null;
  failWriteIn.skip = 0;
  copyHook.fn = null;
  requestedVoiceIds = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* */
    }
    if (voiceId) {
      requestedVoiceIds.push(voiceId);
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), NEW_PT);
    }
    const bytes = pcm();
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

describe('pass-2 U — an unreadable earlier book is a holder, not an absence', () => {
  /* The safe direction costs one extra fork (a copy and a fresh uuid, nothing
     audible); the other silently destroys the earlier book's voice. */
  it('a torn Book One does not let the declined Book Two overwrite qwen-u_shared.pt', async () => {
    seedChain();
    writeRows('Book Three', []);
    const good = readFileSync(castPath('Book One'), 'utf8');
    writeFileSync(castPath('Book One'), '{"characters":[{"id":'); // torn / EBUSY stand-in
    const res = await design('Book Two');
    writeFileSync(castPath('Book One'), good);
    expect(res.status).toBe(200);
    expect(book1Intact()).toBe(true);
    expect(requestedVoiceIds).toHaveLength(1);
    expect(requestedVoiceIds[0]).not.toBe('qwen-u_shared');
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
  });

  it('once forked, a second design while Book One stays unreadable does not fork again (pass 3), and never touches it', async () => {
    seedChain();
    writeRows('Book Three', []);
    const good = readFileSync(castPath('Book One'), 'utf8');
    writeFileSync(castPath('Book One'), '{"characters":[{"id":');
    expect((await design('Book Two')).status).toBe(200);
    const first = readRow('Book Two').voiceUuid;
    expect((await design('Book Two')).status).toBe(200);
    writeFileSync(castPath('Book One'), good);
    expect(readRow('Book Two').voiceUuid).toBe(first);
    expect(book1Intact()).toBe(true);
  });

  it('the legacy-key mint agrees: a torn Book One still gets Book Two a uuid of its own', async () => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    const legacy = {
      ...baseRow,
      voiceUuid: undefined,
      overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } },
    };
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, declinedVoiceFrom: [ids['Book One']] }]);
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_wren.pt'), ORIG_PT);
    const good = readFileSync(castPath('Book One'), 'utf8');
    writeFileSync(castPath('Book One'), '{"characters":[{"id":');
    const res = await design('Book Two');
    writeFileSync(castPath('Book One'), good);
    expect(res.status).toBe(200);
    expect(readRow('Book Two').voiceUuid).toBeTruthy();
    expect(readRow('Book One').voiceUuid).toBeUndefined();
    expect(readFileSync(join(qwenDir(), 'qwen-v_wren.pt')).equals(ORIG_PT)).toBe(true);
  });
});

const strays = () => readdirSync(qwenDir()).filter((f) => !f.startsWith('qwen-u_shared'));

describe('pass-2 F — a follower never ends on a different uuid from the row it links to', () => {
  it('a failed write of the declining row rolls the follower back, so the retry forks them together', async () => {
    seedChain();
    failWriteIn.text = 'Book Two';
    const failed = await design('Book Two');
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain(workspaceRoot);
    // nothing moved: both still on the shared voice, no copy left behind
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(strays()).toEqual([]);

    failWriteIn.text = null;
    expect((await design('Book Two')).status).toBe(200);
    const two = readRow('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe(two);
    expect(readRow('Book Three').matchedFrom?.bookId).toBe(ids['Book Two']);
    expect(book1Intact()).toBe(true);
  });

  it('if the rollback ALSO fails the follower stays on the copy and the copy is kept, so nothing points at a missing .pt', async () => {
    seedChain();
    // the follower's write passes, then every later cast write fails: the declining row's, then the rollback
    failWriteIn.text = 'cast.json';
    failWriteIn.skip = 1;
    const res = await design('Book Two');
    expect(res.status).toBe(500);
    failWriteIn.text = null;
    const three = readRow('Book Three').voiceUuid;
    expect(three).not.toBe('u_shared');
    expect(readFileSync(join(qwenDir(), `qwen-${three}.pt`)).equals(ORIG_PT)).toBe(true);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(book1Intact()).toBe(true);
  });

  it('a follower that became unreadable after the scan fails the fork instead of being skipped', async () => {
    seedChain();
    const goodThree = readFileSync(castPath('Book Three'), 'utf8');
    copyHook.fn = () => writeFileSync(castPath('Book Three'), '{"characters":[{"id":');
    const res = await design('Book Two');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    // nothing was stamped and nothing was designed or left behind
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(requestedVoiceIds).toEqual([]);
    expect(strays()).toEqual([]);
    expect(book1Intact()).toBe(true);

    // readable again: the retry forks the pair together
    writeFileSync(castPath('Book Three'), goodThree);
    expect((await design('Book Two')).status).toBe(200);
    expect(readRow('Book Three').voiceUuid).toBe(readRow('Book Two').voiceUuid);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
  });
});

describe('pass-2 3 — designing a FOLLOWER of a declined, unforked row must not overwrite the earlier book', () => {
  it('Book Three (linked to the declined, unforked Book Two) is refused, writes nothing, and designs once Book Two has forked', async () => {
    seedChain();
    const res = await design('Book Three');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Redesign "Book Two" first. This voice is shared with it.');
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    expect(requestedVoiceIds).toEqual([]);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(strays()).toEqual([]);

    /* Following the message: Book Two's own design forks and carries Book Three. */
    expect((await design('Book Two')).status).toBe(200);
    const two = readRow('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe(two);
    requestedVoiceIds = [];
    expect((await design('Book Three')).status).toBe(200);
    expect(requestedVoiceIds).toEqual([`qwen-${two}`]);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    expect(readRow('Book Three').matchedFrom?.bookId).toBe(ids['Book Two']);
  });

  it('never walks a longer chain: Book Four -> Book Three -> the declined Book Two is refused, nothing moves', async () => {
    seedChain();
    writeBook('Book Four', [{ ...baseRow, ...linkTo('Book Three') }]);
    const res = await design('Book Four');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^This voice is still shared with "Book One"/);
    expect(requestedVoiceIds).toEqual([]);
    expect(book1Intact()).toBe(true);
    for (const t of ['Book Two', 'Book Three', 'Book Four'] as const) expect(readRow(t).voiceUuid).toBe('u_shared');
  });

  it('an emotion variant on Book Three follows the same rule: refused, and never lands on Book One’s variant file', async () => {
    seedChain();
    writeFileSync(join(qwenDir(), 'qwen-u_shared__angry.pt'), Buffer.from('ONE-ANGRY'));
    const res = await design('Book Three', { emotion: 'angry' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Redesign "Book Two" first. This voice is shared with it.');
    expect(
      readFileSync(join(qwenDir(), 'qwen-u_shared__angry.pt')).equals(Buffer.from('ONE-ANGRY')),
    ).toBe(true);
    expect(requestedVoiceIds).toEqual([]);
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
  });

  it('control: a chain nobody declined is shared by design and does not fork', async () => {
    seedChain();
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One') }]);
    expect((await design('Book Three')).status).toBe(200);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
  });

  it('a link into a book that cannot be read refuses the design (the unreadable book may be the target)', async () => {
    seedChain();
    const goodTwo = readFileSync(castPath('Book Two'), 'utf8');
    writeFileSync(castPath('Book Two'), '{"characters":[{"id":');
    const res = await design('Book Three');
    writeFileSync(castPath('Book Two'), goodTwo);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/try again/);
    expect(requestedVoiceIds).toEqual([]);
    expect(book1Intact()).toBe(true);
  });
});

describe('pass-2 L — the legacy-key mint follows the same rules as the uuid fork', () => {
  const legacySlot = { qwen: { name: 'qwen-v_wren' } };
  const legacy = { ...baseRow, voiceUuid: undefined, overrideTtsVoices: legacySlot };
  function seedLegacy(rows: { one?: object; two?: object; three?: object }) {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', [{ ...legacy, ...rows.one }]);
    writeBook('Book Two', [{ ...legacy, declinedVoiceFrom: [ids['Book One']], ...rows.two }]);
    if (rows.three) writeBook('Book Three', [{ ...legacy, ...rows.three }]);
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_wren.pt'), ORIG_PT);
  }

  it('a third book’s bookId-less link does not reopen the series mint onto Book One', async () => {
    seedLegacy({ three: { matchedFrom: { bookTitle: 'Book Two', confidence: 0.92 } } });
    const res = await design('Book Two');
    expect(res.status).toBe(200);
    expect(readRow('Book One').voiceUuid).toBeUndefined();
    expect(readRow('Book Two').voiceUuid).toBeTruthy();
    expect(readRow('Book Three').voiceUuid).toBeUndefined();
    expect(readFileSync(join(qwenDir(), 'qwen-v_wren.pt')).equals(ORIG_PT)).toBe(true);
  });

  it('the minted row drops the qwen variants map, whose render keys would not exist under the new uuid', async () => {
    const slot = {
      qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } },
    };
    seedLegacy({ one: { overrideTtsVoices: slot }, two: { overrideTtsVoices: slot } });
    writeFileSync(join(qwenDir(), 'qwen-v_wren__angry.pt'), Buffer.from('ONE-ANGRY'));
    expect((await design('Book Two', { preview: true })).status).toBe(200);
    const two = readRow('Book Two');
    expect(two.voiceUuid).toBeTruthy();
    expect(two.overrideTtsVoices?.qwen?.variants).toBeUndefined();
    // Book One keeps its own variant, untouched
    expect(readRow('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe(
      'qwen-v_wren__angry',
    );
    expect(existsSync(join(qwenDir(), 'qwen-v_wren__angry.pt'))).toBe(true);
  });
});

describe('pass-2 stray copies — a throw after the copies leaves no qwen-<new>.* behind', () => {
  it('the fork: a follower book whose state.json breaks between the scan and its book-op', async () => {
    seedChain();
    copyHook.fn = () =>
      writeFileSync(join(bookDir('Book Three'), '.audiobook', 'state.json'), '{"bookId":');
    const res = await design('Book Two');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    expect(strays()).toEqual([]);
    expect(requestedVoiceIds).toEqual([]);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
  });

  it('the fork: a lock that times out waiting for the follower’s book-op', async () => {
    seedChain();
    const { withBookOp } = await import('../workspace/book-op-lock.js');
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = withBookOp(ids['Book Three'], async () => {
      await held;
    });
    const res = await design('Book Two');
    release();
    await holder;
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    expect(strays()).toEqual([]);
    expect(book1Intact()).toBe(true);
  }, 40_000);

  it('the legacy-key mint: a cast lock that times out after the copies', async () => {
    const legacy = {
      ...baseRow,
      voiceUuid: undefined,
      overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } },
    };
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, declinedVoiceFrom: [ids['Book One']] }]);
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_wren.pt'), ORIG_PT);
    const { withCastLock } = await import('../workspace/cast-lock.js');
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const holder = withCastLock(bookDir('Book Two'), async () => {
      await held;
    });
    const res = await design('Book Two');
    release();
    await holder;
    expect(res.status).toBe(500);
    expect(readdirSync(qwenDir()).filter((f) => f !== 'qwen-v_wren.pt')).toEqual([]);
    expect(readRow('Book Two').voiceUuid).toBeUndefined();
  }, 40_000);
});
