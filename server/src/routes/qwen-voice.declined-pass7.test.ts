/* #3992 pass 7 — an already-forked declined row never forks again (finding A), and a decline recorded before the row had a uuid still counts (finding F). Real design, decline and link routes plus the real series linker, on real cast.json files; the sidecar mock writes different bytes for whatever voice it is asked for. */
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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-3992p7-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-3992p7-audio-'));
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
function setConfirmed(t: Title, castConfirmed: boolean) {
  const p = join(bookDir(t), '.audiobook', 'state.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), castConfirmed }));
}

describe('A — an already-forked decliner never forks again when its chain grows a second hop', () => {
  /* Two declined u_shared and forked to u_two (it owns angry); Three links to Two
     and Four links to Three, all on u_two. One keeps u_shared untouched. */
  function seed() {
    reset();
    writeBook('Book One', [{ ...baseRow, ...slot('u_shared') }]);
    writeBook('Book Two', [
      {
        ...baseRow,
        voiceUuid: 'u_two',
        declinedVoiceFrom: [ids['Book One']],
        declinedVoiceUuids: ['u_shared'],
        ...slot('u_two', ['angry']),
      },
    ]);
    writeBook('Book Three', [{ ...baseRow, voiceUuid: 'u_two', ...linkTo('Book Two'), ...slot('u_two', ['angry']) }]);
    writeBook('Book Four', [{ ...baseRow, voiceUuid: 'u_two', ...linkTo('Book Three'), ...slot('u_two', ['angry']) }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    writeFileSync(pt('qwen-u_two'), Buffer.from('TWO-OWN'));
    writeFileSync(pt('qwen-u_two__angry'), Buffer.from('TWO-ANGRY'));
  }

  it('a new variant on Two keeps u_two and {angry, sad}, and Three and Four stay on it', async () => {
    seed();
    const r = await design('Book Two', { emotion: 'sad' });
    expect(r.status).toBe(200);
    expect(row('Book Two').voiceUuid).toBe('u_two');
    expect(variantsOf('Book Two')).toEqual(['angry', 'sad']);
    expect(row('Book Three').voiceUuid).toBe('u_two');
    expect(row('Book Four').voiceUuid).toBe('u_two');
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it('a base redesign of Two keeps u_two, and Four then designs with its chain', async () => {
    seed();
    expect((await design('Book Two')).status).toBe(200);
    expect(row('Book Two').voiceUuid).toBe('u_two');
    expect(row('Book Three').voiceUuid).toBe('u_two');
    expect(row('Book Four').voiceUuid).toBe('u_two');
    expect(variantsOf('Book Two')).toEqual(['angry']);
    expect((await design('Book Four')).status).toBe(200);
    expect(row('Book Four').voiceUuid).toBe('u_two');
    expect(readFileSync(pt('qwen-u_shared'))).toEqual(ORIG);
  });

  it('Book One carrying a marker redesigns its own voice without forking away from Three and Four', async () => {
    reset();
    /* One once declined Five's voice: it carries a marker, but its own uuid is not
       on that list. */
    writeBook('Book One', [
      { ...baseRow, declinedVoiceFrom: [ids['Book Five']], declinedVoiceUuids: ['u_other'], ...slot('u_shared') },
    ]);
    writeBook('Book Two', [{ ...baseRow, ...linkTo('Book One'), ...slot('u_shared') }]);
    writeBook('Book Three', [{ ...baseRow, ...linkTo('Book Two'), ...slot('u_shared') }]);
    writeFileSync(pt('qwen-u_shared'), ORIG);
    expect((await design('Book One')).status).toBe(200);
    expect(requested).toEqual(['qwen-u_shared']);
    for (const t of ['Book One', 'Book Two', 'Book Three'] as const) expect(row(t).voiceUuid).toBe('u_shared');
  });

  it('the natural workflow through the real linker: Two angry, Three and Four analysed, Two sad', async () => {
    reset();
    const fresh = { ...baseRow, voiceUuid: undefined };
    writeBook('Book One', [{ ...fresh }]);
    writeBook('Book Two', [{ ...fresh, ...linkTo('Book One') }]);
    expect((await design('Book One')).status).toBe(200);
    const u = row('Book One').voiceUuid;
    writeRows('Book One', [{ ...row('Book One'), ...slot(u) }]); // the drawer's Save
    writeRows('Book Two', [{ ...row('Book Two'), ...slot(u) }]);
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect((await design('Book Two')).status).toBe(200);
    const two = row('Book Two').voiceUuid;
    expect(two).not.toBe(u);
    writeRows('Book Two', [{ ...row('Book Two'), ...slot(two) }]);
    expect((await design('Book Two', { emotion: 'angry' })).status).toBe(200);
    const { linkSeriesReuseAtAnalysis } = await import('../workspace/series-reuse-link.js');
    for (const t of ['Book Three', 'Book Four'] as const) {
      writeBook(t, [{ ...fresh, voiceId: 'v_wren' }]);
      setConfirmed(t, false);
      const chars = [{ ...fresh, voiceId: 'v_wren' }] as any[];
      await linkSeriesReuseAtAnalysis(ids[t], chars);
      writeRows(t, chars);
      setConfirmed(t, true);
    }
    expect(row('Book Three').voiceUuid).toBe(two);
    expect(row('Book Four').voiceUuid).toBe(two);
    expect((await design('Book Two', { emotion: 'sad' })).status).toBe(200);
    expect(row('Book Two').voiceUuid).toBe(two);
    expect(variantsOf('Book Two')).toEqual(['angry', 'sad']);
    expect(row('Book Three').voiceUuid).toBe(two);
    expect(row('Book Four').voiceUuid).toBe(two);
  });
});


describe('F — a decline recorded while the row had no uuid still counts', () => {
  /* Legacy One and Two (no uuid), linked; Two declines One (so it records the book
     and no uuid); designing One then series-mints its fresh uuid N onto Two as well. */
  async function legacyThenMint(): Promise<string> {
    reset();
    const legacy = { ...baseRow, voiceUuid: undefined, overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } } };
    writeBook('Book One', [{ ...legacy }]);
    writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
    writeFileSync(pt('qwen-v_wren'), Buffer.from('LEGACY'));
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    expect(row('Book Two').declinedVoiceUuids ?? []).toEqual([]);
    expect((await design('Book One')).status).toBe(200);
    const n = row('Book One').voiceUuid as string;
    expect(row('Book Two').voiceUuid).toBe(n);
    writeFileSync(pt(`qwen-${n}`), ORIG);
    return n;
  }

  it('with Book One readable, Two forks off the minted uuid', async () => {
    const n = await legacyThenMint();
    expect((await design('Book Two')).status).toBe(200);
    expect(row('Book Two').voiceUuid).not.toBe(n);
    expect(readFileSync(pt(`qwen-${n}`))).toEqual(ORIG);
  });

  it('with Book One unreadable, Two does not design over Book One', async () => {
    const n = await legacyThenMint();
    writeFileSync(castPath('Book One'), '{"characters":[');
    requested = [];
    const r = await design('Book Two');
    expect(r.status).toBe(200);
    expect(requested).not.toContain(`qwen-${n}`);
    expect(row('Book Two').voiceUuid).not.toBe(n);
    expect(readFileSync(pt(`qwen-${n}`))).toEqual(ORIG);
  });
});
