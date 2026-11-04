/* #3992 pass-3 — the design route's fork against the shapes pass 2 found, on real
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
  readdirSync,
  existsSync,
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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'pr4007p3-'));
  audioDir = mkdtempSync(join(tmpdir(), 'pr4007p3-audio-'));
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

const strays = () => readdirSync(qwenDir()).filter((f) => !f.startsWith('qwen-u_shared'));
const TORN = '{"characters":[{"id":';

describe('pass-3 2 — a follower the fork could not see is not left on the earlier book’s voice', () => {
  it('a follower unreadable at the fork is left on u_shared, and ITS design is refused, never overwriting Book One', async () => {
    seedChain();
    const goodThree = readFileSync(castPath('Book Three'), 'utf8');
    writeFileSync(castPath('Book Three'), TORN);
    expect((await design('Book Two')).status).toBe(200);
    writeFileSync(castPath('Book Three'), goodThree);
    const two = readRow('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared'); // stranded on the declined voice

    requestedVoiceIds = [];
    const res = await design('Book Three');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      'Redesign "Book One" to change this shared voice, or choose "Don\'t reuse" to give this character its own.',
    );
    expect(book1Intact()).toBe(true);
    expect(requestedVoiceIds).toEqual([]);
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
  });

  it('a link that lands between the scan and the locks fails the fork, writes nothing, and retries clean', async () => {
    seedChain();
    writeBook('Book Three', [{ ...baseRow }]); // not linked yet
    copyHook.fn = () => writeRows('Book Three', [{ ...baseRow, ...linkTo('Book Two') }]);
    const res = await design('Book Two');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    expect(requestedVoiceIds).toEqual([]);
    expect(strays()).toEqual([]);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');

    expect((await design('Book Two')).status).toBe(200);
    expect(readRow('Book Three').voiceUuid).toBe(readRow('Book Two').voiceUuid);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
    expect(book1Intact()).toBe(true);
  });

  it('a link target that cannot be read refuses the design instead of proceeding under the shared uuid', async () => {
    seedChain();
    const goodTwo = readFileSync(castPath('Book Two'), 'utf8');
    writeFileSync(castPath('Book Two'), TORN);
    const res = await design('Book Three');
    writeFileSync(castPath('Book Two'), goodTwo);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/try again/);
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    expect(requestedVoiceIds).toEqual([]);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
    expect(strays()).toEqual([]);

    // readable again: Book Two is the declined row it follows, so it names it
    const again = await design('Book Three');
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Redesign "Book Two" first. This voice is shared with it.');
    expect(book1Intact()).toBe(true);
  });

  it('control: a link target that is simply gone (no unreadable book) designs as before', async () => {
    seedChain();
    rmSync(bookDir('Book Two'), { recursive: true, force: true });
    expect((await design('Book Three')).status).toBe(200);
  });
});

describe('pass-3 3 — an unreadable book anywhere does not re-fork a row that already left the declined voice', () => {
  const ownBase = {
    ...baseRow,
    voiceUuid: 'u_two',
    overrideTtsVoices: {
      qwen: {
        name: 'qwen-u_two',
        variants: { angry: { name: 'qwen-u_two__angry' } },
      },
    },
  };
  function seedForked() {
    seedChain();
    writeBook('Book Two', [{ ...ownBase, ...declined() }]);
    writeFileSync(join(qwenDir(), 'qwen-u_two.pt'), Buffer.from('TWO-OWN-PT'));
    writeFileSync(join(qwenDir(), 'qwen-u_two__angry.pt'), Buffer.from('TWO-ANGRY'));
    rmSync(bookDir('Book Three'), { recursive: true, force: true });
  }
  const tearUnrelated = () => {
    const dir = join(workspaceRoot, 'books', 'Someone Else', 'Standalones', 'Unrelated', '.audiobook');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cast.json'), TORN);
  };
  const mend = () =>
    rmSync(join(workspaceRoot, 'books', 'Someone Else'), { recursive: true, force: true });

  it('control: no torn file, a variant design keeps the uuid and both variants', async () => {
    seedForked();
    expect((await design('Book Two', { emotion: 'sad' })).status).toBe(200);
    const row = readRow('Book Two');
    expect(row.voiceUuid).toBe('u_two');
    expect(Object.keys(row.overrideTtsVoices.qwen.variants).sort()).toEqual(['angry', 'sad']);
  });

  it('a torn unrelated cast.json leaves the sole holder on its uuid with {angry, sad}', async () => {
    seedForked();
    tearUnrelated();
    const res = await design('Book Two', { emotion: 'sad' });
    mend();
    expect(res.status).toBe(200);
    const row = readRow('Book Two');
    expect(row.voiceUuid).toBe('u_two');
    expect(Object.keys(row.overrideTtsVoices.qwen.variants).sort()).toEqual(['angry', 'sad']);
    expect(strays().filter((f) => !f.startsWith('qwen-u_two'))).toEqual([]);
  });

  it('three base designs while the file stays torn make no new families and orphan nothing', async () => {
    seedForked();
    tearUnrelated();
    for (let i = 0; i < 3; i++) expect((await design('Book Two')).status).toBe(200);
    mend();
    expect(readRow('Book Two').voiceUuid).toBe('u_two');
    expect(strays().filter((f) => !f.startsWith('qwen-u_two'))).toEqual([]);
    expect(existsSync(join(qwenDir(), 'qwen-u_two__angry.pt'))).toBe(true);
  });

  it('failure path: a row still on the declined voice DOES fork when an unrelated book is torn (the earlier book wins)', async () => {
    seedChain();
    rmSync(bookDir('Book Three'), { recursive: true, force: true });
    writeRows('Book One', []); // Book One no longer visible as a holder...
    tearUnrelated(); // ...and an unreadable book might be it
    const res = await design('Book Two');
    mend();
    expect(res.status).toBe(200);
    expect(book1Intact()).toBe(true);
    expect(requestedVoiceIds[0]).not.toBe('qwen-u_shared');
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
  });
});

describe('pass-3 4 — the legacy-key path in three books matches the uuid path’s shape', () => {
  const legacy = {
    ...baseRow,
    voiceUuid: undefined,
    overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } },
  };
  const legacyStrays = () => readdirSync(qwenDir()).filter((f) => !f.startsWith('qwen-v_wren'));
  const legacyOneIntact = () =>
    readFileSync(join(qwenDir(), 'qwen-v_wren.pt')).equals(ORIG_PT) &&
    readRow('Book One').voiceUuid === undefined;
  function seedLegacyChain(opts: { three?: boolean } = { three: true }) {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, declinedVoiceFrom: [ids['Book One']] }]);
    if (opts.three !== false) writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two') }]);
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_wren.pt'), ORIG_PT);
  }

  it('designing Book Two mints apart for Two AND Three (a real follower), and never stamps Book One', async () => {
    seedLegacyChain();
    expect((await design('Book Two')).status).toBe(200);
    const two = readRow('Book Two').voiceUuid;
    expect(two).toBeTruthy();
    expect(readRow('Book Three').voiceUuid).toBe(two);
    expect(legacyOneIntact()).toBe(true);
    expect(requestedVoiceIds).toEqual([`qwen-${two}`]);
  });

  it('designing Book Three FIRST is refused, naming the declined Book Two, and stamps nothing', async () => {
    seedLegacyChain();
    const res = await design('Book Three');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Redesign "Book Two" first. This voice is shared with it.');
    expect(readRow('Book Two').voiceUuid).toBeUndefined();
    expect(readRow('Book Three').voiceUuid).toBeUndefined();
    expect(legacyOneIntact()).toBe(true);
    expect(legacyStrays()).toEqual([]);
    expect(requestedVoiceIds).toEqual([]);
  });

  it('control: without Book Three Book One stays on the legacy key', async () => {
    seedLegacyChain({ three: false });
    expect((await design('Book Two')).status).toBe(200);
    expect(readRow('Book Two').voiceUuid).toBeTruthy();
    expect(legacyOneIntact()).toBe(true);
  });

  it('failure path: a failed write to the follower stamps nothing and leaves no stray copies', async () => {
    seedLegacyChain();
    failWriteIn.text = 'Book Three';
    const res = await design('Book Two');
    failWriteIn.text = null;
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(workspaceRoot);
    expect(readRow('Book Two').voiceUuid).toBeUndefined();
    expect(readRow('Book Three').voiceUuid).toBeUndefined();
    expect(legacyStrays()).toEqual([]);
    expect(requestedVoiceIds).toEqual([]);
    expect(legacyOneIntact()).toBe(true);
  });
});

describe('pass-3 minor — a bookId link with no characterId reads the same in the walk and the follower rule', () => {
  const bookOnly = (t: Title) => ({ matchedFrom: { bookId: ids[t], bookTitle: t, confidence: 1 } });

  it('designing the follower is refused, naming its declined source, and never overwrites Book One', async () => {
    seedChain();
    writeBook('Book Three', [{ ...baseRow, ...bookOnly('Book Two') }]);
    const res = await design('Book Three');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Redesign "Book Two" first. This voice is shared with it.');
    expect(book1Intact()).toBe(true);
    expect(requestedVoiceIds).toEqual([]);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
  });

  it('designing the source still moves that follower with it (the rules agree)', async () => {
    seedChain();
    writeBook('Book Three', [{ ...baseRow, ...bookOnly('Book Two') }]);
    expect((await design('Book Two')).status).toBe(200);
    expect(readRow('Book Three').voiceUuid).toBe(readRow('Book Two').voiceUuid);
    expect(book1Intact()).toBe(true);
  });

  it('failure path: a link with no characterId to a character the source does not have is no follower and is not walked', async () => {
    seedChain();
    writeBook('Book Three', [{ ...baseRow, id: 'other', ...bookOnly('Book Two') }]);
    expect((await design('Book Two')).status).toBe(200);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared'); // not moved: no row of Book Two is its source
  });
});
