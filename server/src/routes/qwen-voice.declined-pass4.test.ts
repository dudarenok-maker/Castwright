/* #3992 pass-4 — the design route's fork against the shapes pass 3 left armed, on real
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
const declined = () => ({
  declinedVoiceFrom: [ids['Book One']],
  declinedVoiceUuids: ['u_shared'],
});
const linkTo = (t: Title, characterId = 'wren') => ({
  matchedFrom: { bookId: ids[t], characterId, bookTitle: t, confidence: 1 },
});
function seedChain() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  writeBook('Book One', [{ ...baseRow }]);
  writeBook('Book Two', [{ ...baseRow, ...declined() }]);
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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'pr4007p4-'));
  audioDir = mkdtempSync(join(tmpdir(), 'pr4007p4-audio-'));
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

const TORN = '{"characters":[{"id":';

describe('pass-4 A — moving a stranded follower carries the rows that follow it', () => {
  function seedFour() {
    seedChain();
    writeBook('Book Four', [{ ...baseRow, ...linkTo('Book Three') }]);
  }
  async function strandThreeAndFour() {
    const goodThree = readFileSync(castPath('Book Three'), 'utf8');
    writeFileSync(castPath('Book Three'), TORN);
    expect((await design('Book Two')).status).toBe(200);
    writeFileSync(castPath('Book Three'), goodThree);
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(readRow('Book Four').voiceUuid).toBe('u_shared');
  }

  it('design Two (Three torn), restore, design Three, design Four: Book One stays intact', async () => {
    seedFour();
    await strandThreeAndFour();
    const two = readRow('Book Two').voiceUuid;

    requestedVoiceIds = [];
    expect((await design('Book Three')).status).toBe(200);
    expect(readRow('Book Three').voiceUuid).toBe(two);
    expect(readRow('Book Four').voiceUuid).toBe(two); // carried with Three

    requestedVoiceIds = [];
    expect((await design('Book Four')).status).toBe(200);
    expect(requestedVoiceIds).toEqual([`qwen-${two}`]);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
  });

  it('the walk is a backstop: Four left on U under a moved Three walks past it to the declined Two', async () => {
    seedFour();
    await strandThreeAndFour();
    const two = readRow('Book Two').voiceUuid;
    // Three is already on Two's uuid, Four was left behind on the declined one.
    writeBook('Book Three', [{ ...baseRow, voiceUuid: two, ...linkTo('Book Two') }]);
    requestedVoiceIds = [];
    expect((await design('Book Four')).status).toBe(200);
    expect(book1Intact()).toBe(true);
    expect(requestedVoiceIds).toEqual([`qwen-${two}`]);
    expect(readRow('Book Four').voiceUuid).toBe(two);
  });

  it('failure path: a failed write of the carried follower fails the design and leaves everything where it was', async () => {
    seedFour();
    await strandThreeAndFour();
    requestedVoiceIds = [];
    failWriteIn.text = 'Book Four';
    const res = await design('Book Three');
    failWriteIn.text = null;
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    expect(requestedVoiceIds).toEqual([]);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(readRow('Book Four').voiceUuid).toBe('u_shared');
  });

  it('failure path: a follower unreadable at the move is left on U, and ITS design then walks up and follows, never writing Book One', async () => {
    seedFour();
    await strandThreeAndFour();
    const two = readRow('Book Two').voiceUuid;
    const goodFour = readFileSync(castPath('Book Four'), 'utf8');
    writeFileSync(castPath('Book Four'), TORN);
    expect((await design('Book Three')).status).toBe(200);
    writeFileSync(castPath('Book Four'), goodFour);
    expect(readRow('Book Four').voiceUuid).toBe('u_shared'); // not carried: it could not be read
    requestedVoiceIds = [];
    expect((await design('Book Four')).status).toBe(200);
    expect(requestedVoiceIds).toEqual([`qwen-${two}`]);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book Four').voiceUuid).toBe(two);
  });
});

describe('pass-4 B — a stranded legacy follower takes its source’s uuid and the series mint never restamps', () => {
  const legacy = {
    ...baseRow,
    voiceUuid: undefined,
    overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } },
  };
  function seedLegacyThree() {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, declinedVoiceFrom: [ids['Book One']] }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two') }]);
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_wren.pt'), ORIG_PT);
  }
  const oneIntact = () =>
    readFileSync(join(qwenDir(), 'qwen-v_wren.pt')).equals(ORIG_PT) &&
    readRow('Book One').voiceUuid === undefined;
  async function strandLegacyThree() {
    const goodThree = readFileSync(castPath('Book Three'), 'utf8');
    writeFileSync(castPath('Book Three'), TORN);
    expect((await design('Book Two')).status).toBe(200);
    writeFileSync(castPath('Book Three'), goodThree);
  }

  it('design Two (Three torn), restore, design Three: Three takes Two’s uuid, Book One has none', async () => {
    seedLegacyThree();
    await strandLegacyThree();
    const two = readRow('Book Two').voiceUuid;
    expect(two).toBeTruthy();
    expect(readRow('Book Three').voiceUuid).toBeUndefined();

    requestedVoiceIds = [];
    expect((await design('Book Three')).status).toBe(200);
    expect(requestedVoiceIds).toEqual([`qwen-${two}`]);
    expect(readRow('Book Two').voiceUuid).toBe(two);
    expect(readRow('Book Three').voiceUuid).toBe(two);
    expect(oneIntact()).toBe(true);
  });

  it('failure path: a failed write of the legacy follower fails the design and stamps nothing', async () => {
    seedLegacyThree();
    await strandLegacyThree();
    const two = readRow('Book Two').voiceUuid;
    requestedVoiceIds = [];
    failWriteIn.text = 'Book Three';
    const res = await design('Book Three');
    failWriteIn.text = null;
    expect(res.status).toBe(500);
    expect(requestedVoiceIds).toEqual([]);
    expect(readRow('Book Three').voiceUuid).toBeUndefined();
    expect(readRow('Book Two').voiceUuid).toBe(two);
    expect(oneIntact()).toBe(true);
  });

  it('the series mint leaves a row that already has its own uuid alone', async () => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, voiceUuid: 'u_two' }]);
    writeBook('Book Three', [{ ...legacy }]);
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_wren.pt'), ORIG_PT);
    writeFileSync(join(qwenDir(), 'qwen-u_two.pt'), Buffer.from('TWO-OWN-PT'));
    expect((await design('Book Three')).status).toBe(200);
    const three = readRow('Book Three').voiceUuid;
    expect(three).toBeTruthy();
    expect(three).not.toBe('u_two');
    expect(readRow('Book Two').voiceUuid).toBe('u_two');
    expect(readFileSync(join(qwenDir(), 'qwen-u_two.pt')).equals(Buffer.from('TWO-OWN-PT'))).toBe(true);
  });
});
