/* #3992 pass 8 - the fork decision reads the disk, never the stored declinedVoiceUuids (P8-1, P8-2), the decline route records only a uuid the declined book holds, and the chain refusal names a book only when redesigning it helps (P8-3). Real routes, real cast.json files; the sidecar mock writes different bytes for whatever voice it is asked for. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
const ids = {} as Record<Title, string>;
let requested: string[];
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const row = (t: string): Record<string, any> => JSON.parse(readFileSync(castPath(t), 'utf8')).characters[0];
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
const reset = () => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
};

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-3992p8-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-3992p8-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('../routes/qwen-voice.js');
  const { castDeclineVoiceLinkRouter } = await import('../routes/cast-decline-voice-link.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
});
beforeEach(() => {
  requested = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* */
    }
    if (voiceId && String(_url).includes('/qwen/') && !String(_url).includes('evict')) {
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

const variantsOf = (t: Title): string[] => Object.keys(row(t).overrideTtsVoices?.qwen?.variants ?? {}).sort();

const torn = (t: Title) => writeFileSync(castPath(t), '{"characters":[');
/* An unrelated book (another author and series) whose state.json is torn with no backup:
   it cannot be identified, so it "could be" any book. */
function writeTornElsewhere() {
  const dir = join(workspaceRoot, 'books', 'Other Author', 'Other Series', 'Other Book');
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, '.audiobook', 'state.json'), '{"bookId":');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [{ id: 'zed', name: 'Zed' }] }));
}

describe('P8-1 - a decline never records the uuid of a voice the declined book does not hold', () => {
  /* Two declined One's u_shared and forked to u_two (it owns angry); Three links to
     Two and Four to Three, all on u_two. */
  function seed() {
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
  const expectUntouched = async () => {
    expect((await design('Book Two', { emotion: 'sad' })).status).toBe(200);
    expect(row('Book Two').voiceUuid).toBe('u_two');
    expect(variantsOf('Book Two')).toEqual(['angry', 'sad']);
    expect(row('Book Three').voiceUuid).toBe('u_two');
    expect(row('Book Four').voiceUuid).toBe('u_two');
    expect(variantsOf('Book Three')).toEqual(['angry', 'sad']); // the follower carries the new variant too
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  };

  it("link back to One (link-prior moves no uuid), Don't reuse again, design sad: Two keeps u_two and {angry, sad}", async () => {
    seed();
    writeRows('Book Two', [{ ...row('Book Two'), ...linkTo('Book One') }]); // the matchedFrom autosave
    const r = await decline('Book Two', 'Book One');
    expect(r.status).toBe(200);
    expect(r.body.declinedVoiceUuids).not.toContain('u_two');
    await expectUntouched();
  });

  it('a stale tab declining again after the fork records no own uuid and keeps u_two', async () => {
    seed();
    const r = await decline('Book Two', 'Book One');
    expect(r.status).toBe(200);
    expect(row('Book Two').declinedVoiceUuids).toEqual(['u_shared']);
    await expectUntouched();
  });

  it("a stale list already holding the row's own uuid still does not fork it", async () => {
    seed();
    writeRows('Book Two', [{ ...row('Book Two'), declinedVoiceUuids: ['u_shared', 'u_two'] }]);
    await expectUntouched();
  });

  it('the decline route records the uuid when the declined book holds it', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    const r = await decline('Book Two', 'Book One');
    expect(r.status).toBe(200);
    expect(r.body.declinedVoiceUuids).toEqual(['u_shared']);
  });
});

describe('P8-2 - a legacy decliner that already forked is decided from disk', () => {
  /* Legacy One and Two linked; Two declines One (records the book, no uuid); designing
     One mints N onto both; Two's design forks it to T; Two then owns angry. */
  async function forkedLegacy(): Promise<string> {
    reset();
    const legacy = { ...baseRow, voiceUuid: undefined, overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    writeFileSync(pt('qwen-v_wren'), Buffer.from('LEGACY'));
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect((await design('Book One')).status).toBe(200);
    const n = row('Book One').voiceUuid as string;
    writeFileSync(pt(`qwen-${n}`), ORIG);
    writeRows('Book One', [{ ...row('Book One'), ...slot(n) }]);
    writeRows('Book Two', [{ ...row('Book Two'), ...slot(n) }]);
    expect((await design('Book Two')).status).toBe(200);
    const t = row('Book Two').voiceUuid as string;
    expect(t).not.toBe(n);
    writeRows('Book Two', [{ ...row('Book Two'), ...slot(t, ['angry']) }]);
    writeFileSync(pt(`qwen-${t}__angry`), Buffer.from('TWO-ANGRY'));
    return t;
  }

  it('an unrelated torn book: redesigning the base keeps T and {angry}', async () => {
    const t = await forkedLegacy();
    writeTornElsewhere();
    expect((await design('Book Two')).status).toBe(200);
    expect(row('Book Two').voiceUuid).toBe(t);
    expect(variantsOf('Book Two')).toEqual(['angry']);
  });

  it('two redesigns in a row mint no new uuid', async () => {
    const t = await forkedLegacy();
    writeTornElsewhere();
    expect((await design('Book Two')).status).toBe(200);
    expect((await design('Book Two')).status).toBe(200);
    expect(row('Book Two').voiceUuid).toBe(t);
  });

  it('Book One torn: the retry sentence, and nothing is written', async () => {
    const t = await forkedLegacy();
    torn('Book One');
    requested = [];
    const before = readFileSync(castPath('Book Two'), 'utf8');
    const r = await design('Book Two');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('A book in this series could not be read; try again once it can.');
    expect(requested).toEqual([]);
    expect(readFileSync(castPath('Book Two'), 'utf8')).toBe(before);
    expect(row('Book Two').voiceUuid).toBe(t);
  });
});

describe('P8-3 - the chain refusal only sends the user to a book whose redesign helps', () => {
  it("a follower stranded on One's uuid (Two forked away) is told Don't reuse", async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, voiceUuid: 'u_two', declinedVoiceFrom: [ids['Book One']], ...slot('u_two') }]);
    writeBook('Book Three', [{ ...baseRow, voiceUuid: 'u_shared', ...linkTo('Book Two'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    const r = await design('Book Three');
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("Don't reuse");
    expect(r.body.error).not.toContain('Redesign "Book One"');
  });

  it('the earlier book unreadable: the retry sentence, not a book that cannot help', async () => {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two'), ...slot('u_shared') }]);
    writeBook('Book Four', [
      { ...baseRow, declinedVoiceFrom: [ids['Book One']], declinedVoiceUuids: ['u_shared'], ...slot('u_shared') },
    ]);
    torn('Book One');
    const r = await design('Book Three');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('A book in this series could not be read; try again once it can.');
  });
});
