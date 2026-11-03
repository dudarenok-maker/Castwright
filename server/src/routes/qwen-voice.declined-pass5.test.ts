/* #3992 pass-5 — the design route's fork against the shapes pass 3 left armed, on real
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
const pcm = () => new Uint8Array(24_000 * 2 * 0.3);
const design = (t: Title, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });
const book1Intact = () => readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT);

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'pr4007p5-'));
  audioDir = mkdtempSync(join(tmpdir(), 'pr4007p5-audio-'));
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


function setConfirmed(t: Title, castConfirmed: boolean) {
  const p = join(bookDir(t), '.audiobook', 'state.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), castConfirmed }));
}
const ptOf = (key: string) => join(qwenDir(), `${key}.pt`);
const legacy = { ...baseRow, voiceUuid: undefined, overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };

describe('pass-5 P5-1 — a legacy follower of a declined row that has not forked yet forks it first', () => {
  it('(a) design One, decline on Two, confirm Three and design it: Book One keeps its voice, Two and Three share a new one', async () => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two') }]);
    setConfirmed('Book Three', false);

    expect((await design('Book One')).status).toBe(200);
    const u = readRow('Book One').voiceUuid;
    expect(u).toBeTruthy();
    expect(readRow('Book Two').voiceUuid).toBe(u);
    expect(readRow('Book Three').voiceUuid).toBeUndefined(); // unconfirmed: the series mint skipped it
    writeFileSync(ptOf(`qwen-${u}`), ORIG_PT); // Book One's own designed voice

    const dec = await request(app)
      .post(`/api/books/${ids['Book Two']}/cast/wren/decline-voice-link`)
      .send({ fromBookId: ids['Book One'] });
    expect(dec.status).toBe(200);

    setConfirmed('Book Three', true);
    requestedVoiceIds = [];
    expect((await design('Book Three')).status).toBe(200);
    expect(readFileSync(ptOf(`qwen-${u}`)).equals(ORIG_PT)).toBe(true);
    expect(requestedVoiceIds).not.toContain(`qwen-${u}`);
    expect(readRow('Book One').voiceUuid).toBe(u);
    const three = readRow('Book Three').voiceUuid;
    expect(three).toBeTruthy();
    expect(three).not.toBe(u);
    expect(readRow('Book Two').voiceUuid).toBe(three);
    expect(requestedVoiceIds).toEqual([`qwen-${three}`]);
  });

  function seed(threeUuid: string | undefined) {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...declined() }]);
    writeBook('Book Three', [{ ...baseRow, voiceUuid: threeUuid, ...linkTo('Book Two') }]);
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(ptOf('qwen-u_shared'), ORIG_PT);
    writeFileSync(join(qwenDir(), 'qwen-u_shared.json'), ORIG_JSON);
  }

  it('(b) seeded: One u_shared, Two u_shared declined, Three no uuid linked to Two', async () => {
    seed(undefined);
    expect((await design('Book Three')).status).toBe(200);
    expect(book1Intact()).toBe(true);
    expect(requestedVoiceIds).not.toContain('qwen-u_shared');
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    const three = readRow('Book Three').voiceUuid;
    expect(three).not.toBe('u_shared');
    expect(readRow('Book Two').voiceUuid).toBe(three);
  });

  it('control: Three already on u_shared forks Two first and leaves Book One intact', async () => {
    seed('u_shared');
    expect((await design('Book Three')).status).toBe(200);
    expect(book1Intact()).toBe(true);
    const three = readRow('Book Three').voiceUuid;
    expect(three).not.toBe('u_shared');
    expect(readRow('Book Two').voiceUuid).toBe(three);
  });
});

describe('pass-5 — the other walker shortcut: a stranded follower’s source that still shares the uuid it forked to', () => {
  it('forks the source off Book One’s u_two before Three follows it, so Book One’s file is never written', async () => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', [{ ...baseRow, voiceUuid: 'u_two' }]);
    writeBook('Book Two', [
      { ...baseRow, voiceUuid: 'u_two', declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'] },
    ]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two') }]);
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(ptOf('qwen-u_two'), ORIG_PT);
    expect((await design('Book Three')).status).toBe(200);
    expect(readFileSync(ptOf('qwen-u_two')).equals(ORIG_PT)).toBe(true);
    expect(requestedVoiceIds).not.toContain('qwen-u_two');
    const three = readRow('Book Three').voiceUuid;
    expect(three).not.toBe('u_two');
    expect(readRow('Book Two').voiceUuid).toBe(three);
    expect(readRow('Book One').voiceUuid).toBe('u_two');
  });
});
