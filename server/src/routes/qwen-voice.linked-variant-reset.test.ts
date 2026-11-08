/* #4040 — redesigning the BASE of a linked (series-shared) voice resets the
   emotion variants of every row linked to that voice, not just the redesigned
   row: they were designed against the previous base. A book that declined the
   link is on a voice of its own (a separated uuid) and is untouched. No file is
   deleted inline: once no row names the variants, the startup sweep
   (sweepOrphanVariantFiles, #4038) removes them. Redesigning an emotion variant
   (not the base) clears nothing.

   On real cast.json files; the sidecar fetch is mocked. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let previewVoiceIdFor: typeof import('./qwen-voice.js').previewVoiceIdFor;
const ids = {} as Record<Title, string>;
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const variantsOf = (t: Title): Record<string, { name: string }> | undefined =>
  JSON.parse(readFileSync(castPath(t), 'utf8')).characters.find((c: { id: string }) => c.id === 'wren')
    ?.overrideTtsVoices?.qwen?.variants;
const pt = (k: string) => join(qwenDir(), `${k}.pt`);

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
  voiceUuid: uuid,
  overrideTtsVoices: { qwen: { name: `qwen-${uuid}`, variants: { angry: { name: `qwen-${uuid}__angry` } } } },
});

/* A, B and C linked to u_shared; D declined the link and is on its own separated uuid. */
async function seed() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
  for (const t of ['Book A', 'Book B', 'Book C'] as const) writeBook(t, [designedOn('u_shared')]);
  writeBook('Book D', [{ ...designedOn('u_sep'), declinedVoiceFrom: [ids['Book A']] }]);
  const { recordSeparatedVoice } = await import('../workspace/separated-voices.js');
  await recordSeparatedVoice('u_sep');
  for (const k of ['qwen-u_shared', 'qwen-u_shared__angry', 'qwen-u_sep', 'qwen-u_sep__angry']) {
    writeFileSync(pt(k), Buffer.from(`BYTES-${k}`));
  }
}

const promote = (t: Title, uuid: string) => {
  const previewId = previewVoiceIdFor(`qwen-${uuid}`, ids[t], 'wren');
  writeFileSync(pt(previewId), Buffer.from('PREVIEW'));
  return request(app)
    .post(`/api/books/${ids[t]}/cast/wren/promote-voice`)
    .send({ previewVoiceId: previewId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
};

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-linked-variant-reset-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-linked-variant-reset-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  ({ previewVoiceIdFor } = await import('./qwen-voice.js'));
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
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
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), Buffer.from('DESIGNED'));
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

describe('#4040 — a linked voice’s base redesign resets every linked row’s emotion variants', () => {
  it('promoting a new base from A clears the variants of A, B and C; the declined D keeps its own', async () => {
    const res = await promote('Book A', 'u_shared');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt('qwen-u_shared')).toString(), 'the base was replaced').toBe('PREVIEW');
    for (const t of ['Book A', 'Book B', 'Book C'] as const) {
      expect(variantsOf(t), `${t} kept stale variants`).toBeUndefined();
    }
    expect(variantsOf('Book D')?.angry?.name).toBe('qwen-u_sep__angry');
    /* nothing deletes a file inline: the startup sweep removes the now-unnamed ones */
    expect(existsSync(pt('qwen-u_shared__angry'))).toBe(true);
    expect(existsSync(pt('qwen-u_sep__angry'))).toBe(true);
  });

  it('a redesign from the middle book resets the others just the same', async () => {
    expect((await promote('Book B', 'u_shared')).status).toBe(200);
    for (const t of ['Book A', 'Book B', 'Book C'] as const) expect(variantsOf(t)).toBeUndefined();
    expect(variantsOf('Book D')?.angry).toBeDefined();
  });

  it('a direct non-preview base design on A (design-voice route) clears A, B and C; D keeps its own', async () => {
    const res = await request(app)
      .post(`/api/books/${ids['Book A']}/cast/wren/design-voice`)
      .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt('qwen-u_shared')).toString(), 'the base was replaced').toBe('DESIGNED');
    for (const t of ['Book A', 'Book B', 'Book C'] as const) {
      expect(variantsOf(t), `${t} kept stale variants`).toBeUndefined();
    }
    expect(variantsOf('Book D')?.angry?.name).toBe('qwen-u_sep__angry');
    expect(existsSync(pt('qwen-u_shared__angry'))).toBe(true);
  });

  it('the bulk/SSE landing (persistSlot) on an already-designed key clears every linked row', async () => {
    const { designQwenVoiceForCharacter } = await import('./qwen-voice.js');
    const cast = JSON.parse(readFileSync(castPath('Book A'), 'utf8'));
    await designQwenVoiceForCharacter({
      bookId: ids['Book A'],
      bookDir: bookDir('Book A'),
      seriesFilter: { author: AUTHOR, series: SERIES },
      character: cast.characters[0],
      characterId: 'wren',
      persona: 'a bright voice',
      sampleVoiceId: 'v_wren',
      modelKey: QWEN_KEY,
      language: 'english',
      persistSlot: true,
    });
    for (const t of ['Book A', 'Book B', 'Book C'] as const) {
      expect(variantsOf(t), `${t} kept stale variants`).toBeUndefined();
    }
    expect(variantsOf('Book D')?.angry).toBeDefined();
  });

  it('a first-ever design (no file at the key yet) clears nothing', async () => {
    rmSync(pt('qwen-u_shared'), { force: true });
    const res = await request(app)
      .post(`/api/books/${ids['Book A']}/cast/wren/design-voice`)
      .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const t of TITLES) expect(variantsOf(t)?.angry, `${t} lost its variant`).toBeDefined();
  });

  it('a preview design clears nothing', async () => {
    const res = await request(app)
      .post(`/api/books/${ids['Book A']}/cast/wren/design-voice`)
      .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, preview: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const t of TITLES) expect(variantsOf(t)?.angry, `${t} lost its variant`).toBeDefined();
  });

  it('redesigning an emotion variant (not the base) clears nothing', async () => {
    const res = await request(app)
      .post(`/api/books/${ids['Book A']}/cast/wren/design-voice`)
      .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const t of TITLES) expect(variantsOf(t)?.angry, `${t} lost its variant`).toBeDefined();
  });
});
