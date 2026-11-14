/* #4040 (owner decision 2026-11-08) — when a linked voice's BASE is redesigned
   from any book, the emotion variants designed against the old base stop being
   used in every book sharing that voice: each variant records the base `rev` it
   was made from (`baseRev` in its sidecar json) and is stale once the base's
   `rev` moves on. No other book's cast.json is written. A stale variant is treated
   as not designed: the render falls back to the base voice, the cast GET omits
   it, a client's whole-roster PUT that still carries it does not restore it, a
   reparse carryover drops it, and the startup sweep removes its files. A book
   that declined the link onto its own separated voice is untouched. A first
   design, a preview design and an emotion-only design make nothing stale; a
   legacy variant (no `baseRev`) stays valid until its base is first redesigned.

   On real cast.json files; the sidecar fetch is mocked. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { withCapacityRetry } from '../gpu/capacity-retry.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from '../tts/index.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));
/* Fails the next `times` reads of a file whose path contains `text` (an EBUSY from
   a scanner); `times: Infinity` is a persistent fault. */
const failReadIn = vi.hoisted(() => ({ text: null as string | null, times: 0 }));
const onRenamed = vi.hoisted(() => ({ fn: null as null | ((to: string) => void) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = async (path: unknown, ...rest: unknown[]) => {
    if (failReadIn.text && failReadIn.times > 0 && String(path).includes(failReadIn.text)) {
      failReadIn.times--;
      throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(path)}'`), {
        code: 'EBUSY',
        syscall: 'open',
        path: String(path),
      });
    }
    return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
  };
  /* Runs right after each rename lands, so a test can read a file the moment it appears. */
  const rename = async (from: unknown, to: unknown) => {
    await (actual.rename as (...a: unknown[]) => Promise<void>)(from, to);
    onRenamed.fn?.(String(to));
  };
  return { ...actual, default: { ...actual, readFile, rename }, readFile, rename };
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
const TITLES = ['Book A', 'Book B', 'Book C', 'Book D'] as const;
type Title = (typeof TITLES)[number];
const LINKED = ['Book A', 'Book B', 'Book C'] as const;

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let previewVoiceIdFor: typeof import('./qwen-voice.js').previewVoiceIdFor;
const ids = {} as Record<Title, string>;
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const carryoverPath = (t: string) => join(bookDir(t), '.audiobook', 'cast-reuse-carryover.json');
const diskCast = (t: Title) => JSON.parse(readFileSync(castPath(t), 'utf8'));
const diskVariantsOf = (t: Title): Record<string, { name: string }> | undefined =>
  diskCast(t).characters.find((c: { id: string }) => c.id === 'wren')?.overrideTtsVoices?.qwen?.variants;
const pt = (k: string) => join(qwenDir(), `${k}.pt`);
const json = (k: string) => join(qwenDir(), `${k}.json`);

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
  writeFileSync(castPath(t), JSON.stringify({ characters: rows }));
}

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
const designedOn = (uuid: string) => ({
  ...legacy,
  ttsEngine: 'qwen',
  voiceUuid: uuid,
  overrideTtsVoices: { qwen: { name: `qwen-${uuid}`, variants: { angry: { name: `qwen-${uuid}__angry` } } } },
});

/* A, B and C linked to u_shared; D declined the link and is on its own separated
   uuid. Every voice and variant is legacy: no json carries a rev. */
async function seed() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
  for (const t of LINKED) writeBook(t, [designedOn('u_shared')]);
  writeBook('Book D', [{ ...designedOn('u_sep'), declinedVoiceFrom: [ids['Book A']] }]);
  const { recordSeparatedVoice } = await import('../workspace/separated-voices.js');
  await recordSeparatedVoice('u_sep');
  for (const k of ['qwen-u_shared', 'qwen-u_shared__angry', 'qwen-u_sep', 'qwen-u_sep__angry']) {
    writeFileSync(pt(k), Buffer.from(`BYTES-${k}`));
    writeFileSync(json(k), JSON.stringify({ voiceId: k, instruct: 'a bright voice' }));
  }
}

const promote = (t: Title, uuid: string) => {
  const previewId = previewVoiceIdFor(`qwen-${uuid}`, ids[t], 'wren');
  writeFileSync(pt(previewId), Buffer.from('PREVIEW'));
  writeFileSync(json(previewId), JSON.stringify({ voiceId: previewId, instruct: 'a new voice' }));
  return request(app)
    .post(`/api/books/${ids[t]}/cast/wren/promote-voice`)
    .send({ previewVoiceId: previewId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
};
const design = (t: Title, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });

/* What the client sees: the cast GET's variants for the row. */
async function servedVariantsOf(t: Title): Promise<Record<string, { name: string }> | undefined> {
  const res = await request(app).get(`/api/books/${ids[t]}/state`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.cast.characters.find((c: { id: string }) => c.id === 'wren')?.overrideTtsVoices?.qwen?.variants;
}

/* What the render does with an angry line for the row, read off disk. */
async function renderedAngryVoice(t: Title): Promise<string> {
  const { synthesiseChapter } = await import('../tts/synthesise-chapter.js');
  const calls: SynthesizeInput[] = [];
  const provider: TtsProvider = {
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      return { pcm: Buffer.alloc(2), sampleRate: 24000, mimeType: 'audio/pcm' };
    },
  };
  await synthesiseChapter({
    sentences: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'Stop right there.', emotion: 'angry' }],
    cast: diskCast(t).characters,
    provider,
    modelKey: QWEN_KEY,
    engine: 'qwen',
  });
  expect(calls).toHaveLength(1);
  return calls[0].voiceName;
}

async function expectStale(t: Title, uuid: string) {
  expect(await servedVariantsOf(t), `${t}: the GET still serves the stale variant`).toBeUndefined();
  expect(await renderedAngryVoice(t), `${t}: the render used the stale variant`).toBe(`qwen-${uuid}`);
}
async function expectCurrent(t: Title, uuid: string) {
  expect((await servedVariantsOf(t))?.angry?.name, `${t}: the GET dropped a current variant`).toBe(`qwen-${uuid}__angry`);
  expect(await renderedAngryVoice(t), `${t}: the render skipped a current variant`).toBe(`qwen-${uuid}__angry`);
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-linked-variant-stale-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-linked-variant-stale-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { bookStateRouter } = await import('./book-state.js');
  ({ previewVoiceIdFor } = await import('./qwen-voice.js'));
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/books', bookStateRouter);
});

beforeEach(async () => {
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
      /* the sidecar writes the staged `.pt` and its `.json` (no rev of its own) */
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), Buffer.from('DESIGNED'));
      writeFileSync(join(qwenDir(), `${voiceId}.json`), JSON.stringify({ voiceId, instruct: 'designed' }));
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
  await seed();
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

describe('#4040 — a linked voice’s base redesign makes the old emotion variants stale', () => {
  it('baseline: every legacy variant is current before any redesign', async () => {
    for (const t of LINKED) await expectCurrent(t, 'u_shared');
    await expectCurrent('Book D', 'u_sep');
  });

  it('promoting a new base from A makes A, B and C’s variants stale, writes no other book, and leaves the declined D alone', async () => {
    const before = Object.fromEntries(TITLES.map((t) => [t, readFileSync(castPath(t), 'utf8')]));
    const res = await promote('Book A', 'u_shared');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt('qwen-u_shared')).toString(), 'the base was replaced').toBe('PREVIEW');
    for (const t of LINKED) await expectStale(t, 'u_shared');
    await expectCurrent('Book D', 'u_sep');
    for (const t of ['Book B', 'Book C', 'Book D'] as const) {
      expect(readFileSync(castPath(t), 'utf8'), `${t}'s cast.json was written`).toBe(before[t]);
    }
    /* nothing deletes a file inline */
    expect(existsSync(pt('qwen-u_shared__angry'))).toBe(true);
  });

  it('a direct non-preview base design from A makes A, B and C’s variants stale; D keeps its own', async () => {
    const res = await design('Book A');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt('qwen-u_shared')).toString(), 'the base was replaced').toBe('DESIGNED');
    for (const t of LINKED) await expectStale(t, 'u_shared');
    await expectCurrent('Book D', 'u_sep');
  });

  it('the bulk/SSE landing (persistSlot) on an already-designed key makes every linked row stale', async () => {
    const { designQwenVoiceForCharacter } = await import('./qwen-voice.js');
    await designQwenVoiceForCharacter({
      bookId: ids['Book B'],
      bookDir: bookDir('Book B'),
      seriesFilter: { author: AUTHOR, series: SERIES },
      character: diskCast('Book B').characters[0],
      characterId: 'wren',
      persona: 'a bright voice',
      sampleVoiceId: 'v_wren',
      modelKey: QWEN_KEY,
      language: 'english',
      persistSlot: true,
    });
    for (const t of LINKED) await expectStale(t, 'u_shared');
    await expectCurrent('Book D', 'u_sep');
  });

  it('a client whole-roster PUT that still carries the stale variant does not restore it', async () => {
    const stalePatch = diskCast('Book B'); // the open tab's cast, angry still in it
    expect((await promote('Book A', 'u_shared')).status).toBe(200);
    const res = await request(app)
      .put(`/api/books/${ids['Book B']}/state`)
      .send({ slice: 'cast', patch: stalePatch });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(diskVariantsOf('Book B'), 'the PUT wrote the stale variant back').toBeUndefined();
    await expectStale('Book B', 'u_shared');
    /* a PUT on the declined book keeps its current variant */
    const putD = await request(app)
      .put(`/api/books/${ids['Book D']}/state`)
      .send({ slice: 'cast', patch: diskCast('Book D') });
    expect(putD.status).toBe(200);
    expect(diskVariantsOf('Book D')?.angry?.name).toBe('qwen-u_sep__angry');
  });

  it('a reparsed book whose variants live only in cast-reuse-carryover.json is stale too', async () => {
    renameSync(castPath('Book C'), carryoverPath('Book C'));
    expect((await promote('Book A', 'u_shared')).status).toBe(200);
    const { readPriorCastForMerge } = await import('./analysis.js');
    const prior = await readPriorCastForMerge(bookDir('Book C'));
    expect(prior.source).toBe('carryover');
    const wren = prior.rows.find((r) => r.id === 'wren') as { overrideTtsVoices?: { qwen?: { variants?: unknown } } };
    expect(wren?.overrideTtsVoices?.qwen?.variants, 'the carryover kept the stale variant').toBeUndefined();
  });

  it('the startup sweep removes the stale variant files (no row counts as naming them) and keeps D’s', async () => {
    renameSync(castPath('Book C'), carryoverPath('Book C'));
    expect((await promote('Book A', 'u_shared')).status).toBe(200);
    const { sweepOrphanVariantFiles } = await import('./qwen-voice.js');
    expect(await sweepOrphanVariantFiles(-1)).toBeGreaterThan(0);
    expect(existsSync(pt('qwen-u_shared__angry')), 'the stale variant was kept').toBe(false);
    expect(existsSync(pt('qwen-u_sep__angry'))).toBe(true);
    expect(existsSync(pt('qwen-u_shared')), 'the base was swept').toBe(true);
  });

  it('a variant designed after the redesign is current again, for every linked book', async () => {
    expect((await promote('Book A', 'u_shared')).status).toBe(200);
    const res = await design('Book B', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const t of LINKED) await expectCurrent(t, 'u_shared');
  });

  it('a first-ever design (no file at the key yet) makes nothing stale', async () => {
    rmSync(pt('qwen-u_shared'), { force: true });
    rmSync(json('qwen-u_shared'), { force: true });
    const res = await design('Book A');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const t of LINKED) await expectCurrent(t, 'u_shared');
  });

  it('a preview design that is not promoted makes nothing stale', async () => {
    const res = await design('Book A', { preview: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const t of LINKED) await expectCurrent(t, 'u_shared');
  });

  it('an emotion-only design makes nothing stale', async () => {
    const res = await design('Book A', { emotion: 'sad' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const t of LINKED) await expectCurrent(t, 'u_shared');
  });

  it('a variant records the base rev read BEFORE its render: a base redesigned during the render leaves it stale (#4040)', async () => {
    writeFileSync(json('qwen-u_shared'), JSON.stringify({ voiceId: 'qwen-u_shared', rev: 'r1' }));
    /* Hold only the variant's sidecar render; everything else answers as usual. */
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let renderStarted!: () => void;
    const started = new Promise<void>((r) => (renderStarted = r));
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: unknown, init: { body?: string } | undefined) => {
      if (String(init?.body ?? '').includes('variantVoiceId')) {
        renderStarted();
        await gate;
      }
      return normal(url, init);
    });
    /* B designs an angry variant (the route, so its real design lock and render
       ordering run); A's promote is a different book, so no lock serialises them. */
    const variantRes = design('Book B', { emotion: 'angry' }).then((r) => r);
    await started;
    expect((await promote('Book A', 'u_shared')).status).toBe(200);
    release();
    const res = await variantRes;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const variantJson = JSON.parse(readFileSync(json('qwen-u_shared__angry'), 'utf8'));
    const baseJson = JSON.parse(readFileSync(json('qwen-u_shared'), 'utf8'));
    expect(baseJson.rev, 'the promote stamped a new base rev').not.toBe('r1');
    expect(variantJson.baseRev, 'the variant recorded the rev read after the render').toBe('r1');
    for (const t of LINKED) await expectStale(t, 'u_shared');
  });

  it('a base json that stays unreadable fails the variant design retryably and records nothing (#4040)', async () => {
    writeFileSync(json('qwen-u_shared'), JSON.stringify({ voiceId: 'qwen-u_shared', rev: 'r1' }));
    const variantBefore = readFileSync(json('qwen-u_shared__angry'), 'utf8');
    failReadIn.text = 'qwen-u_shared.json';
    failReadIn.times = Infinity;
    try {
      const res = await design('Book B', { emotion: 'angry' });
      expect(res.status, JSON.stringify(res.body)).toBe(500);
      expect(JSON.stringify(res.body), 'a path or errno leaked').not.toMatch(/EBUSY|qwen-u_shared|castwright/);
    } finally {
      failReadIn.text = null;
    }
    expect(readFileSync(json('qwen-u_shared__angry'), 'utf8'), 'the variant json was rewritten').toBe(variantBefore);
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body ?? '').includes('variantVoiceId'))).toBe(false);
  });

  it('a torn base json fails the variant design with a curated retryable error, never a raw parse message (#4040)', async () => {
    writeFileSync(json('qwen-u_shared'), '{"rev":');
    const variantBefore = readFileSync(json('qwen-u_shared__angry'), 'utf8');
    const res = await design('Book B', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(500);
    expect(res.body.error).toMatch(/try again/i);
    expect(JSON.stringify(res.body), 'a raw parse message leaked').not.toMatch(/JSON|Unexpected|position|qwen-u_shared/);
    expect(readFileSync(json('qwen-u_shared__angry'), 'utf8'), 'the variant json was rewritten').toBe(variantBefore);
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body ?? '').includes('variantVoiceId'))).toBe(false);
  });

  it('a base json unreadable once, then readable, still records the base rev (#4040)', async () => {
    writeFileSync(json('qwen-u_shared'), JSON.stringify({ voiceId: 'qwen-u_shared', rev: 'r1' }));
    failReadIn.text = 'qwen-u_shared.json';
    failReadIn.times = 1;
    try {
      const res = await design('Book B', { emotion: 'angry' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      failReadIn.text = null;
    }
    expect(JSON.parse(readFileSync(json('qwen-u_shared__angry'), 'utf8')).baseRev).toBe('r1');
  });

  it('a landed variant json carries its baseRev the moment it appears, so a copy at any point after sees it (#4040)', async () => {
    writeFileSync(json('qwen-u_shared'), JSON.stringify({ voiceId: 'qwen-u_shared', rev: 'r1' }));
    const seen: unknown[] = [];
    onRenamed.fn = (to) => {
      if (to === json('qwen-u_shared__angry')) seen.push(JSON.parse(readFileSync(to, 'utf8')).baseRev);
    };
    try {
      const res = await design('Book B', { emotion: 'angry' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    } finally {
      onRenamed.fn = null;
    }
    expect(seen, 'the variant json landed without the base rev it was designed against').toEqual(['r1']);
  });

  it('an absent base json records no baseRev (#4040)', async () => {
    rmSync(json('qwen-u_shared'));
    const res = await design('Book B', { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.parse(readFileSync(json('qwen-u_shared__angry'), 'utf8'))).not.toHaveProperty('baseRev');
  });

  it('a legacy variant (no baseRev) on a base with a rev is stale; one recorded against the current rev is current', async () => {
    writeFileSync(json('qwen-u_shared'), JSON.stringify({ voiceId: 'qwen-u_shared', rev: 'r1' }));
    for (const t of LINKED) await expectStale(t, 'u_shared');
    writeFileSync(json('qwen-u_shared__angry'), JSON.stringify({ voiceId: 'qwen-u_shared__angry', baseRev: 'r1' }));
    for (const t of LINKED) await expectCurrent(t, 'u_shared');
  });
});
