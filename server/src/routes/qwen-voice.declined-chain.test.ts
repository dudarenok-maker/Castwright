/* #3992 — a fork on a row that OTHER books link to carries those books with it.

   Book One keeps `u_shared`, Book Two DECLINED it, Book Three links to Book Two
   (the real linker builds this chain: the stable-key pass prefers the most recent
   earlier book). Redesigning Book Two must (a) never touch Book One's
   `qwen-u_shared.pt`, and (b) move Book Three to the new uuid in the SAME locked
   write, because it is Book Two's voice it follows. Chains of several links all
   move; a row that does not (or no longer) follow stays put.

   Sidecar mocked as in qwen-voice.declined-fork.test.ts: it writes the voice it is
   asked for with DIFFERENT bytes, so an overwrite of Book One shows up as bytes. */

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
/* Runs once, just before the next copy: lets a test change a book in the window
   between the fork's follower scan and its locked write. */
const beforeCopy = vi.hoisted(() => ({ fn: null as (() => void) | null }));
/* Fails any fs write whose path contains this text (an EBUSY from a scanner), to
   prove the fork's failure paths: a cast.json write is the only writeFile under it. */
const failWriteIn = vi.hoisted(() => ({ text: null as string | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const copyFile = async (src: unknown, dest: unknown, mode?: number) => {
    if (beforeCopy.fn) {
      const run = beforeCopy.fn;
      beforeCopy.fn = null;
      run();
    }
    return actual.copyFile(src as string, dest as string, mode);
  };
  const writeFile = async (path: unknown, ...rest: unknown[]) => {
    if (failWriteIn.text && String(path).includes(failWriteIn.text)) {
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(path)}'`), {
        code: 'EBUSY',
        syscall: 'open',
        path: String(path),
      });
    }
    return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
  };
  return { ...actual, default: { ...actual, copyFile, writeFile }, copyFile, writeFile };
});
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
const bookDir = (title: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, title);
const castPath = (title: string) => join(bookDir(title), '.audiobook', 'cast.json');
const rowsOf = (title: string): Array<Record<string, any>> =>
  JSON.parse(readFileSync(castPath(title), 'utf8')).characters;
const readRow = (title: string): Record<string, any> => rowsOf(title)[0];
const writeRows = (title: string, rows: Array<Record<string, unknown>>) =>
  writeFileSync(castPath(title), JSON.stringify({ characters: rows }));

function writeBook(title: Title, rows: Array<Record<string, unknown>>) {
  const dir = bookDir(title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: ids[title],
      manuscriptId: `m_${ids[title]}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: TITLES.indexOf(title) + 1,
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
  writeRows(title, rows);
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
};
const linkTo = (title: Title, characterId = 'wren') => ({
  matchedFrom: { bookId: ids[title], characterId, bookTitle: title, confidence: 1 },
});

/* One / Two (declined One) / Three (links Two) [/ Four (links Three)] */
function seedChain(opts: { four?: boolean } = {}) {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  writeBook('Book One', [{ ...baseRow }]);
  writeBook('Book Two', [{ ...baseRow, declinedVoiceFrom: [ids['Book One']] }]);
  writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two') }]);
  if (opts.four) writeBook('Book Four', [{ ...baseRow, ...linkTo('Book Three') }]);
  mkdirSync(qwenDir(), { recursive: true });
  writeFileSync(join(qwenDir(), 'qwen-u_shared.pt'), ORIG_PT);
  writeFileSync(join(qwenDir(), 'qwen-u_shared.json'), ORIG_JSON);
}

const pcm = () => new Uint8Array(24_000 * 2 * 0.3);

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-declined-chain-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-declined-chain-audio-'));
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
  beforeCopy.fn = null;
  failWriteIn.text = null;
  requestedVoiceIds = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* not a design call */
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
  vi.mocked(withCapacityRetry).mockImplementation((doPost, opts) => doPost(opts.signal));
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

const design = (title: Title, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${ids[title]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });

const book1Intact = () =>
  readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT) &&
  readFileSync(join(qwenDir(), 'qwen-u_shared.json')).equals(ORIG_JSON);

describe('#3992 — Book Three follows Book Two when Book Two forks', () => {
  it('redesigning the middle book leaves Book One’s bytes alone and moves Book Three with it', async () => {
    seedChain();
    const res = await design('Book Two');
    expect(res.status).toBe(200);

    expect(requestedVoiceIds).toHaveLength(1);
    const fresh = /^qwen-(.+)$/.exec(requestedVoiceIds[0])![1];
    expect(fresh).not.toBe('u_shared');

    expect(book1Intact()).toBe(true);
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    expect(readRow('Book Two').voiceUuid).toBe(fresh);
    expect(readRow('Book Three').voiceUuid).toBe(fresh);
    /* Three keeps its link: it still follows Two, now on Two's new voice */
    expect(readRow('Book Three').matchedFrom.bookId).toBe(ids['Book Two']);
    /* Three plays the copy of Book One's voice until the redesign lands, then the redesign */
    expect(existsSync(join(qwenDir(), `qwen-${fresh}.pt`))).toBe(true);
  });

  it('a chain of several links all move; Book One still does not', async () => {
    seedChain({ four: true });
    expect((await design('Book Two')).status).toBe(200);
    const fresh = readRow('Book Two').voiceUuid;
    expect(fresh).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe(fresh);
    expect(readRow('Book Four').voiceUuid).toBe(fresh);
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    expect(book1Intact()).toBe(true);
  });

  it('a link cycle terminates: a row that names its own book (no characterId) is moved once, not looped on', async () => {
    seedChain();
    /* Book Three has two rows sharing the voice: wren links Book Two, wren_b links
       Book Three itself with no characterId, which matches both of Three's rows. */
    writeRows('Book Three', [
      { ...baseRow, ...linkTo('Book Two') },
      { ...baseRow, id: 'wren_b', matchedFrom: { bookId: ids['Book Three'], bookTitle: 'Book Three', confidence: 1 } },
    ]);
    const res = await design('Book Two');
    expect(res.status).toBe(200);
    const fresh = readRow('Book Two').voiceUuid;
    expect(fresh).not.toBe('u_shared');
    expect(rowsOf('Book Three').map((r) => r.voiceUuid)).toEqual([fresh, fresh]);
    expect(book1Intact()).toBe(true);
  });

  it('a row that links a DIFFERENT character of Book Two does not follow', async () => {
    seedChain();
    writeRows('Book Two', [
      { ...baseRow, declinedVoiceFrom: [ids['Book One']] },
      { ...baseRow, id: 'someone_else', voiceId: 'v_other', voiceUuid: 'u_other' },
    ]);
    writeRows('Book Three', [{ ...baseRow, ...linkTo('Book Two', 'someone_else') }]);
    expect((await design('Book Two')).status).toBe(200);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(book1Intact()).toBe(true);
  });

  it('a bookId-less link (manual Assign) is not a follower: it stays on u_shared', async () => {
    seedChain();
    writeRows('Book Three', [{ ...baseRow, matchedFrom: { bookTitle: 'Book Two', confidence: 1 } }]);
    expect((await design('Book Two')).status).toBe(200);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(book1Intact()).toBe(true);
  });

  it('an unreadable follower cast is skipped, not a failure: Book Two still forks and Book One is safe', async () => {
    seedChain();
    writeFileSync(castPath('Book Three'), '{"characters":[{"id":');
    const res = await design('Book Two');
    expect(res.status).toBe(200);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
    expect(readFileSync(castPath('Book Three'), 'utf8')).toBe('{"characters":[{"id":');
    expect(book1Intact()).toBe(true);
  });

  it('a follower that stopped following between the scan and the locked write is NOT moved', async () => {
    seedChain();
    beforeCopy.fn = () => writeRows('Book Three', [{ ...baseRow }]); // link dropped mid-fork
    expect((await design('Book Two')).status).toBe(200);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(readRow('Book Three').matchedFrom).toBeUndefined();
    expect(book1Intact()).toBe(true);
  });

  it('a follower’s qwen variants map is dropped with the stamp (render re-derives <uuid>__<emotion>)', async () => {
    seedChain();
    writeFileSync(join(qwenDir(), 'qwen-u_shared__angry.pt'), Buffer.from('ONE-ANGRY'));
    const withVariant = (extra: Record<string, unknown>) => ({
      ...baseRow,
      ...extra,
      overrideTtsVoices: {
        qwen: { name: 'qwen-u_shared', variants: { angry: { name: 'qwen-u_shared__angry' } } },
      },
    });
    writeRows('Book Two', [withVariant({ declinedVoiceFrom: [ids['Book One']] })]);
    writeRows('Book Three', [withVariant(linkTo('Book Two'))]);
    expect((await design('Book Two')).status).toBe(200);
    expect(readRow('Book Three').overrideTtsVoices.qwen.variants).toBeUndefined();
    expect(readRow('Book Two').overrideTtsVoices.qwen.variants).toBeUndefined();
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared__angry.pt')).equals(Buffer.from('ONE-ANGRY'))).toBe(true);
  });

  it('only followers hold u_shared with Book One gone: no fork, the shared pair is redesigned together', async () => {
    seedChain();
    writeRows('Book One', [{ ...baseRow, voiceUuid: 'u_something_else' }]);
    expect((await design('Book Two')).status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
  });
  it('a book that STARTED following between the scan and the locked write is left on u_shared, never written outside the lock set', async () => {
    seedChain({ four: true });
    writeRows('Book Four', [{ ...baseRow }]); // holds u_shared, follows nobody yet
    beforeCopy.fn = () => writeRows('Book Four', [{ ...baseRow, ...linkTo('Book Three') }]);
    expect((await design('Book Two')).status).toBe(200);
    const fresh = readRow('Book Two').voiceUuid;
    expect(readRow('Book Three').voiceUuid).toBe(fresh);
    expect(readRow('Book Four').voiceUuid).toBe('u_shared');
    expect(book1Intact()).toBe(true);
  });

  it('the fork holds the FOLLOWER’s cast lock too: nothing is stamped while another writer holds it', async () => {
    seedChain();
    let pending: Promise<unknown> | undefined;
    const { withCastLock } = await import('../workspace/cast-lock.js'); // lazy: paths.js binds WORKSPACE_DIR on load
    await withCastLock(bookDir('Book Three'), async () => {
      pending = design('Book Two').then((r) => r);
      await new Promise((r) => setTimeout(r, 400));
      /* the fork got as far as the copies, but cannot enter the locked write */
      expect(readRow('Book Two').voiceUuid).toBe('u_shared');
      expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    });
    expect((await pending as { status: number }).status).toBe(200);
    expect(readRow('Book Three').voiceUuid).toBe(readRow('Book Two').voiceUuid);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
  });

  it('a failed write to the follower aborts the fork before anything is stamped, with no stray copies', async () => {
    seedChain();
    failWriteIn.text = 'Book Three';
    const res = await design('Book Two');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('Book Three'); // path-free
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(readdirSync(qwenDir()).filter((f) => f.endsWith('.pt'))).toEqual(['qwen-u_shared.pt']);
    expect(book1Intact()).toBe(true);
  });

  it('a failed write to Book Two AFTER the follower moved keeps the copies the follower points at; a retry then forks Book Two alone', async () => {
    seedChain();
    failWriteIn.text = 'Book Two';
    const res = await design('Book Two');
    expect(res.status).toBe(500);
    const followerUuid = readRow('Book Three').voiceUuid;
    expect(followerUuid).not.toBe('u_shared');
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(existsSync(join(qwenDir(), `qwen-${followerUuid}.pt`))).toBe(true);
    expect(book1Intact()).toBe(true);

    failWriteIn.text = null;
    expect((await design('Book Two')).status).toBe(200);
    const two = readRow('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(two).not.toBe(followerUuid); // Three no longer holds u_shared, so it is not re-followed
    expect(readRow('Book Three').voiceUuid).toBe(followerUuid);
    expect(book1Intact()).toBe(true);
  });
  it('inside a follower book only the follower’s own voice moves: a same-voiceId sibling follows it, an unrelated voice sharing the uuid does not', async () => {
    seedChain();
    writeRows('Book Three', [
      { ...baseRow, ...linkTo('Book Two') },
      { ...baseRow, id: 'wren_b' },
      { ...baseRow, id: 'stranger', voiceId: 'v_other' },
    ]);
    expect((await design('Book Two')).status).toBe(200);
    const fresh = readRow('Book Two').voiceUuid;
    expect(rowsOf('Book Three').map((r) => r.voiceUuid)).toEqual([fresh, fresh, 'u_shared']);
  });
});
