/* #3992 passes 5 and 6 — every repro that overwrote another book through the old
   recursive chain walker, re-run against the fail-closed rule
   (decideSharedVoiceDesign), on real cast.json files with a mocked sidecar that
   writes DIFFERENT bytes for whatever voice it is asked for, so an unprotected
   earlier book shows up as its bytes being overwritten. Each one ends with every
   other book's voice files byte-identical: designed safely (the two-book fork, or a
   voice nobody else holds) or refused with the curated message. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
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
const TITLES = ['Book One', 'Book Two', 'Book Three', 'Book Four', 'Book Five'] as const;
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

const CHAIN_ONE =
  'This voice is shared with an earlier book. Choose "Don\'t reuse" to give this character its own.';
const CHAIN_ONE_REDESIGN = CHAIN_ONE.replace(/^.*Choose /, 'Redesign "Book One" to change this shared voice, or choose ');
const REDESIGN_TWO = 'Redesign "Book Two" first. This voice is shared with it.';
const reset = () => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
};
/* Every .pt in the voice dir, by name, so "byte-identical" covers every book. */
const snapshotPts = (): Record<string, string> =>
  Object.fromEntries(
    readdirSync(qwenDir())
      .filter((f) => f.endsWith('.pt'))
      .map((f) => [f, readFileSync(join(qwenDir(), f)).toString('base64')]),
  );
const keptAll = (before: Record<string, string>) => {
  const now = snapshotPts();
  for (const [f, bytes] of Object.entries(before)) expect(now[f], f).toBe(bytes);
};

describe('pass-5 P5-1 — a legacy row linked to a declined row that has not forked', () => {
  it('(a) design One, decline on Two, confirm Three and design it: no other book’s voice is written', async () => {
    reset();
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
    const before = snapshotPts();
    expect((await design('Book Three')).status).toBe(200);
    keptAll(before);
    const three = readRow('Book Three').voiceUuid;
    expect(three).toBeTruthy();
    expect(three).not.toBe(u);
    /* Nothing on a voice another book holds moved: the legacy row took a voice of its own. */
    expect(requestedVoiceIds).toEqual([`qwen-${three}`]);
    expect(readRow('Book One').voiceUuid).toBe(u);
    expect(readRow('Book Two').voiceUuid).toBe(u);
  });

  function seed(threeUuid: string | undefined) {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...declined() }]);
    writeBook('Book Three', [{ ...baseRow, voiceUuid: threeUuid, ...linkTo('Book Two') }]);
    writeFileSync(ptOf('qwen-u_shared'), ORIG_PT);
    writeFileSync(join(qwenDir(), 'qwen-u_shared.json'), ORIG_JSON);
  }

  it('(b) seeded: One u_shared, Two u_shared declined, Three no uuid linked to Two: a voice nobody else holds', async () => {
    seed(undefined);
    expect((await design('Book Three')).status).toBe(200);
    expect(book1Intact()).toBe(true);
    expect(requestedVoiceIds).not.toContain('qwen-u_shared');
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    const three = readRow('Book Three').voiceUuid;
    expect(three).toBeTruthy();
    expect(three).not.toBe('u_shared');
  });

  it('Three already on u_shared is refused, naming Book Two; Book Two’s own design then forks and carries it', async () => {
    seed('u_shared');
    const res = await design('Book Three');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: REDESIGN_TWO, code: 'voice_shared' });
    expect(requestedVoiceIds).toEqual([]);
    expect(book1Intact()).toBe(true);

    expect((await design('Book Two')).status).toBe(200);
    const two = readRow('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe(two);
    expect(book1Intact()).toBe(true);
  });

  it('a legacy row whose source forked off u_two but still shares it never writes u_two', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, voiceUuid: 'u_two' }]);
    writeBook('Book Two', [
      { ...baseRow, voiceUuid: 'u_two', declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'] },
    ]);
    writeBook('Book Three', [{ ...baseRow, voiceUuid: undefined, ...linkTo('Book Two') }]);
    writeFileSync(ptOf('qwen-u_two'), ORIG_PT);
    expect((await design('Book Three')).status).toBe(200);
    expect(readFileSync(ptOf('qwen-u_two')).equals(ORIG_PT)).toBe(true);
    expect(requestedVoiceIds).not.toContain('qwen-u_two');
    expect(readRow('Book Three').voiceUuid).not.toBe('u_two');
    expect(readRow('Book One').voiceUuid).toBe('u_two');
    expect(readRow('Book Two').voiceUuid).toBe('u_two');
  });
});

describe('pass-5 P5-2 (#4025) — a link target whose state.json cannot be read', () => {
  it('refuses with the retry sentence instead of designing over Book One', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...declined() }]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two') }]);
    writeFileSync(ptOf('qwen-u_shared'), ORIG_PT);
    writeFileSync(join(bookDir('Book Two'), '.audiobook', 'state.json'), '{"bookId":');
    const res = await design('Book Three');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A book in this series could not be read; try again once it can.');
    expect(requestedVoiceIds).toEqual([]);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
  });
});

describe('pass-6 — the shapes the recursive walker still overwrote, and its cycle', () => {
  it('P6-A seeded: a legacy row below a stranded follower never writes Book One’s u_two', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, voiceUuid: 'u_two' }]);
    writeBook('Book Two', [
      { ...baseRow, voiceUuid: 'u_two', declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'] },
    ]);
    writeBook('Book Three', [{ ...baseRow, voiceUuid: 'u_shared', ...linkTo('Book Two') }]);
    writeBook('Book Four', [{ ...baseRow, voiceUuid: undefined, ...linkTo('Book Three') }]);
    writeFileSync(ptOf('qwen-u_two'), ORIG_PT);
    writeFileSync(ptOf('qwen-u_shared'), Buffer.from('THREE-PT'));
    const before = snapshotPts();
    const res = await design('Book Four');
    expect([200, 409]).toContain(res.status);
    keptAll(before);
    expect(requestedVoiceIds).not.toContain('qwen-u_two');
    expect(requestedVoiceIds).not.toContain('qwen-u_shared');
    expect(readRow('Book One').voiceUuid).toBe('u_two');
    expect(readRow('Book Two').voiceUuid).toBe('u_two');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared');
  });

  it('P6-A routes: design One, decline Two, design Two, decline Five, re-link Three to Two, design Four: Book Five keeps its voice', async () => {
    reset();
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book One') }]);
    writeBook('Book Five', [{ ...legacy, ...linkTo('Book Two') }]);
    writeBook('Book Four', [{ ...legacy, ...linkTo('Book Three') }]);
    setConfirmed('Book Four', false);

    expect((await design('Book One')).status).toBe(200); // series mint: U on One, Two, Three, Five
    const u = readRow('Book One').voiceUuid;
    for (const t of ['Book Two', 'Book Three', 'Book Five'] as const) expect(readRow(t).voiceUuid).toBe(u);
    expect(readRow('Book Four').voiceUuid).toBeUndefined();
    const decline = (t: Title, from: Title) =>
      request(app).post(`/api/books/${ids[t]}/cast/wren/decline-voice-link`).send({ fromBookId: ids[from] });
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect((await design('Book Two')).status).toBe(200); // forks to X, carries Five
    const x = readRow('Book Two').voiceUuid;
    expect(x).not.toBe(u);
    expect(readRow('Book Five').voiceUuid).toBe(x);
    expect((await decline('Book Five', 'Book Two')).status).toBe(200);
    writeFileSync(ptOf(`qwen-${x}`), Buffer.from('BOOK-FIVE-KEEPS-X'));
    /* What link-prior Three -> Two plus its matchedFrom autosave leave on disk:
       the link moves, voiceUuid does not. */
    writeRows('Book Three', [{ ...readRow('Book Three'), ...linkTo('Book Two') }]);
    setConfirmed('Book Four', true);

    requestedVoiceIds = [];
    const before = snapshotPts();
    expect([200, 409]).toContain((await design('Book Four')).status);
    keptAll(before);
    expect(requestedVoiceIds).not.toContain(`qwen-${x}`);
    expect(requestedVoiceIds).not.toContain(`qwen-${u}`);
    expect(readRow('Book Five').voiceUuid).toBe(x);

    /* And Three, still on U and now linked to a Two that left U, is refused. */
    const three = await design('Book Three');
    expect(three.status).toBe(409);
    expect(three.body.error).toBe(CHAIN_ONE);
    keptAll(before);
  });

  it('P6-B: a link cycle where each row declines the other’s uuid answers promptly and writes nothing shared', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, voiceUuid: 'u_s' }]);
    writeBook('Book Two', [
      {
        ...baseRow,
        voiceUuid: 'u_s',
        ...linkTo('Book Three'),
        declinedVoiceFrom: [ids['Book Three']],
        declinedVoiceUuids: ['u_t'],
      },
    ]);
    writeBook('Book Three', [
      {
        ...baseRow,
        voiceUuid: 'u_t',
        ...linkTo('Book Two'),
        declinedVoiceFrom: [ids['Book Two']],
        declinedVoiceUuids: ['u_s'],
      },
    ]);
    writeBook('Book Four', [{ ...baseRow, voiceUuid: undefined, ...linkTo('Book Two') }]);
    writeFileSync(ptOf('qwen-u_s'), ORIG_PT);
    writeFileSync(ptOf('qwen-u_t'), Buffer.from('THREE-PT'));
    const before = snapshotPts();
    const started = Date.now();
    const four = await design('Book Four');
    const two = await design('Book Two');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(four.status).toBe(200); // a legacy row nobody shares its key with: a voice of its own
    expect(two.status).toBe(409); // on u_s with Book One, linked to a Three that declined u_s
    expect(two.body.error).toBe(CHAIN_ONE);
    keptAll(before);
    expect(requestedVoiceIds).not.toContain('qwen-u_s');
    expect(requestedVoiceIds).not.toContain('qwen-u_t');
  });

  it('P6-C: a chain hanging off a declined row never forks it twice', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...declined() }]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two') }]);
    writeBook('Book Four', [{ ...baseRow, ...linkTo('Book Three') }]);
    writeFileSync(ptOf('qwen-u_shared'), ORIG_PT);
    const four = await design('Book Four');
    expect(four.status).toBe(409);
    expect(four.body.error).toBe(CHAIN_ONE_REDESIGN);
    expect(requestedVoiceIds).toEqual([]);

    expect((await design('Book Two')).status).toBe(200);
    const two = readRow('Book Two').voiceUuid;
    expect(readRow('Book Three').voiceUuid).toBe(two);
    expect(readRow('Book Four').voiceUuid).toBe('u_shared');
    expect((await design('Book Three')).status).toBe(200);
    expect(readRow('Book Two').voiceUuid).toBe(two); // forked exactly once
    expect(readRow('Book Three').voiceUuid).toBe(two);
    expect((await design('Book Four')).status).toBe(409);
    expect(book1Intact()).toBe(true);
    expect(requestedVoiceIds).not.toContain('qwen-u_shared');
  });

  it('P6-C legacy: Four -> Three (both legacy) -> an unforked declined Two leaves Book One intact', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...declined() }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two') }]);
    writeBook('Book Four', [{ ...legacy, ...linkTo('Book Three') }]);
    writeFileSync(ptOf('qwen-u_shared'), ORIG_PT);
    const before = snapshotPts();
    expect([200, 409]).toContain((await design('Book Four')).status);
    expect([200, 409]).toContain((await design('Book Three')).status);
    expect((await design('Book Two')).status).toBe(200);
    keptAll(before);
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    expect(requestedVoiceIds).not.toContain('qwen-u_shared');
  });

  it('P6-D: a follower re-linked to Book One while Book Two forks stays with Book One and is not written', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...declined() }]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two') }]);
    writeFileSync(ptOf('qwen-u_shared'), ORIG_PT);
    copyHook.fn = () => writeRows('Book Three', [{ ...baseRow, ...linkTo('Book One') }]);
    const res = await design('Book Two');
    expect(res.status).toBe(200);
    const two = readRow('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(readRow('Book Three').voiceUuid).toBe('u_shared'); // it follows Book One now
    expect(requestedVoiceIds).toEqual([`qwen-${two}`]);
    expect(book1Intact()).toBe(true);
  });

  it('P6-D legacy: a legacy row linked to the unforked declined row takes no fork, so there is no window to race', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...declined() }]);
    writeBook('Book Three', [{ ...legacy, ...linkTo('Book Two') }]);
    writeFileSync(ptOf('qwen-u_shared'), ORIG_PT);
    copyHook.fn = () => writeRows('Book Three', [{ ...legacy, ...linkTo('Book One') }]);
    expect((await design('Book Three')).status).toBe(200);
    expect(book1Intact()).toBe(true);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(requestedVoiceIds).not.toContain('qwen-u_shared');
  });
});

describe('the rule leaves the ordinary cases alone', () => {
  it('a never-shared voice designs normally', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, voiceUuid: 'u_only' }]);
    expect((await design('Book One')).status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_only']);
    expect(readRow('Book One').voiceUuid).toBe('u_only');
  });

  it('a series voice nobody declined is redesigned together, from any book, as before', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One') }]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two') }]);
    expect((await design('Book Three')).status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
  });

  it('the two-book declined case still forks and designs', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...declined() }]);
    writeFileSync(ptOf('qwen-u_shared'), ORIG_PT);
    expect((await design('Book Two')).status).toBe(200);
    const two = readRow('Book Two').voiceUuid;
    expect(two).not.toBe('u_shared');
    expect(requestedVoiceIds).toEqual([`qwen-${two}`]);
    expect(book1Intact()).toBe(true);
  });

  it('Book One redesigning its own voice is not refused by Book Two’s decline', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow }]);
    writeBook('Book Two', [{ ...baseRow, ...declined() }]);
    expect((await design('Book One')).status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
  });
});
