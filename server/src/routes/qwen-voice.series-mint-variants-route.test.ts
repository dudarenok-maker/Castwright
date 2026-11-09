/* #4037 — the variant copy driven through the real design route. The sibling
   *-mint-variants tests call ensureCharacterVoiceUuid directly; here the mint is
   reached the way a user reaches it: POST design-voice on a book whose voice is on
   the legacy key `qwen-v_wren` (with an `angry` variant), in a series (Book Two
   linked to Book One) and standalone. After it, every stamped row must name
   `qwen-<uuid>__angry`, that file must exist, and the render's resolution
   (dropStaleVariants -> pickVoiceForEngine -> pickEmotionVariantVoice) must land
   on it.

   A preview design mints but replaces no base, so the copied variant stays
   CURRENT (the copied sidecars carry rev / baseRev together). A full design over
   the copied base is a base redesign (#4040), so it stamps a fresh rev and the
   copied variant is, by that rule, stale: still named and on disk, but the render
   falls back to the base. */

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
    fetch: (...args: unknown[]) => (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
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
const TITLES = ['Book One', 'Book Two'] as const;
type Title = (typeof TITLES)[number];

let workspaceRoot: string;
let audioDir: string;
let app: Express;
const ids = {} as Record<Title, string>;
let standaloneId: string;
let counter = 0;
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const standaloneDir = () => join(workspaceRoot, 'books', AUTHOR, 'Standalones', 'Solo');
const readRowAt = (dir: string): Record<string, any> =>
  JSON.parse(readFileSync(join(dir, '.audiobook', 'cast.json'), 'utf8')).characters[0];
const row = (t: Title) => readRowAt(bookDir(t));

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
  overrideTtsVoices: {
    qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } },
  },
};

function writeState(dir: string, s: { bookId: string; title: string; series?: string; position?: number }) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: s.bookId,
      manuscriptId: `m_${s.bookId}`,
      title: s.title,
      author: AUTHOR,
      ...(s.series ? { series: s.series, seriesPosition: s.position } : {}),
      isStandalone: !s.series,
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
}

/* The legacy key's base + angry variant, with the rev / baseRev pair a real
   voice carries (the variant was designed against base rev `r1`). */
function seedLegacyFiles() {
  mkdirSync(qwenDir(), { recursive: true });
  const files: Record<string, string> = {
    'qwen-v_wren.pt': 'base-bytes',
    'qwen-v_wren.json': JSON.stringify({ rev: 'r1' }),
    'qwen-v_wren__angry.pt': 'angry-bytes',
    'qwen-v_wren__angry.json': JSON.stringify({ baseRev: 'r1' }),
  };
  for (const [f, body] of Object.entries(files)) writeFileSync(join(qwenDir(), f), body);
}

function seedSeries() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  seedLegacyFiles();
  TITLES.forEach((t, i) => {
    writeState(bookDir(t), { bookId: ids[t], title: t, series: SERIES, position: i + 1 });
    const link = t === 'Book Two' ? { matchedFrom: { bookId: ids['Book One'], characterId: 'wren', bookTitle: 'Book One', confidence: 1 } } : {};
    writeFileSync(join(bookDir(t), '.audiobook', 'cast.json'), JSON.stringify({ characters: [{ ...legacy, ...link }] }));
  });
}

function seedStandalone() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  seedLegacyFiles();
  writeState(standaloneDir(), { bookId: standaloneId, title: 'Solo' });
  writeFileSync(join(standaloneDir(), '.audiobook', 'cast.json'), JSON.stringify({ characters: [{ ...legacy }] }));
}

const designAt = (bookId: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${bookId}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });

/* What the render does with a row: drop stale variants, resolve the base key, then
   the emotion variant for an `angry` line. */
async function resolveAngry(r: Record<string, any>): Promise<string> {
  const { dropStaleVariants } = await import('../workspace/variant-base-rev.js');
  const { pickVoiceForEngine, pickEmotionVariantVoice } = await import('../tts/voice-mapping.js');
  const [current] = await dropStaleVariants([r]);
  const base = pickVoiceForEngine('qwen', current as any);
  return pickEmotionVariantVoice('qwen', (current as any).overrideTtsVoices?.qwen?.variants, 'angry', base, false);
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-mint-variants-route-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-mint-variants-route-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  standaloneId = makeBookId(AUTHOR, '', 'Solo');
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
});

beforeEach(() => {
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
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), Buffer.from(`DESIGN-${++counter}`));
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
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
});

describe('#4037 — the design route carries a legacy voice’s emotion variant to qwen-<uuid>', () => {
  it('series: a Design & compare preview of Book Two re-keys Book One’s angry row to a copied, current variant', async () => {
    seedSeries();
    const res = await designAt(ids['Book Two'], { preview: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const uuid = row('Book Two').voiceUuid as string;
    expect(uuid).toBeTruthy();
    expect(row('Book One').voiceUuid).toBe(uuid);
    for (const t of TITLES) expect(row(t).overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);

    expect(readFileSync(join(qwenDir(), `qwen-${uuid}__angry.pt`), 'utf8')).toBe('angry-bytes');
    expect(JSON.parse(readFileSync(join(qwenDir(), `qwen-${uuid}__angry.json`), 'utf8'))).toEqual({ baseRev: 'r1' });
    expect(JSON.parse(readFileSync(join(qwenDir(), `qwen-${uuid}.json`), 'utf8'))).toEqual({ rev: 'r1' });
    /* the preview replaced no base: Book One's angry line resolves to the copy */
    expect(await resolveAngry(row('Book One'))).toBe(`qwen-${uuid}__angry`);
    expect(await resolveAngry(row('Book Two'))).toBe(`qwen-${uuid}__angry`);
  });

  it('series: a full design of Book Two names and keeps the copy for Book One; the base redesign marks it stale (#4040)', async () => {
    seedSeries();
    const res = await designAt(ids['Book Two']);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const uuid = row('Book Two').voiceUuid as string;
    expect(row('Book One').voiceUuid).toBe(uuid);
    expect(row('Book One').overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
    expect(existsSync(join(qwenDir(), `qwen-${uuid}__angry.pt`))).toBe(true);
    /* the design replaced the copied base, so the render falls back to the base */
    expect(await resolveAngry(row('Book One'))).toBe(`qwen-${uuid}`);
  });

  it('standalone: a preview design re-keys the row’s angry variant to a copied, current variant', async () => {
    seedStandalone();
    const res = await designAt(standaloneId, { preview: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const r = readRowAt(standaloneDir());
    const uuid = r.voiceUuid as string;
    expect(uuid).toBeTruthy();
    expect(r.overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${uuid}__angry`);
    expect(readFileSync(join(qwenDir(), `qwen-${uuid}__angry.pt`), 'utf8')).toBe('angry-bytes');
    expect(await resolveAngry(r)).toBe(`qwen-${uuid}__angry`);
  });
});
