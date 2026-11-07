/* #4040 (reset them together) — a promote that REPLACES an existing base `.pt`
   (the approve step of a redesign) drops the emotion variants of every row linked
   to that voice: the designing row, its same-book followers, and the rows on the
   same storage key in every other book of the series. A declined book is on a
   separated voice (another key) and is never reached. A first design behaves as
   it always did. No variant FILE is deleted (the startup sweep does that).

   Real design (preview) and promote routes against real cast.json files. */

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
const OTHER_SERIES = 'Another Shore';
const QWEN_KEY = 'qwen3-tts-0.6b';
const KEY = 'qwen-u1';
const VARIANT = 'qwen-u1__angry';

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let counter = 0;
const fetchMock = vi.fn();
const ids: Record<string, string> = {};

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const pt = (k: string) => join(qwenDir(), `${k}.pt`);

interface BookSpec {
  title: string;
  series?: string; // undefined => standalone
  author?: string;
}
const dirOf = (b: BookSpec) =>
  join(workspaceRoot, 'books', b.author ?? AUTHOR, b.series ?? 'Standalones', b.title);
const castPath = (b: BookSpec) => join(dirOf(b), '.audiobook', 'cast.json');
const rowsOf = (b: BookSpec): Array<Record<string, any>> => JSON.parse(readFileSync(castPath(b), 'utf8')).characters;
const rowOf = (b: BookSpec, id = 'wren') => rowsOf(b).find((r) => r.id === id) as Record<string, any>;

const variantsRow = (id: string, uuid: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  role: 'supporting',
  color: 'sky',
  voiceId: `v_${id}`,
  voiceUuid: uuid,
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
  gender: 'female',
  ageRange: 'adult',
  overrideTtsVoices: { qwen: { name: `qwen-${uuid}`, variants: { angry: { name: `qwen-${uuid}__angry` } } } },
  ...extra,
});

function writeBook(b: BookSpec, rows: Array<Record<string, unknown>>) {
  const author = b.author ?? AUTHOR;
  ids[b.title] = ids[b.title] ?? '';
  mkdirSync(join(dirOf(b), '.audiobook'), { recursive: true });
  writeFileSync(
    join(dirOf(b), '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: ids[b.title],
      manuscriptId: `m_${ids[b.title]}`,
      title: b.title,
      author,
      series: b.series ?? '',
      seriesPosition: 1,
      isStandalone: b.series === undefined,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dirOf(b), 'manuscript.txt'), 'placeholder');
  writeFileSync(castPath(b), JSON.stringify({ characters: rows }));
}

const A: BookSpec = { title: 'Book A', series: SERIES };
const B: BookSpec = { title: 'Book B', series: SERIES };
const C: BookSpec = { title: 'Book C', series: SERIES };
const D: BookSpec = { title: 'Book D', series: SERIES };
const SOLO: BookSpec = { title: 'Solo' };
const ELSEWHERE: BookSpec = { title: 'Elsewhere', series: OTHER_SERIES };

const design = (b: BookSpec) =>
  request(app)
    .post(`/api/books/${ids[b.title]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, preview: true });
const promote = (b: BookSpec, previewVoiceId: string) =>
  request(app)
    .post(`/api/books/${ids[b.title]}/cast/wren/promote-voice`)
    .send({ previewVoiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
async function redesign(b: BookSpec) {
  const preview = await design(b);
  expect(preview.status, JSON.stringify(preview.body)).toBe(200);
  const kept = await promote(b, preview.body.voiceId);
  expect(kept.status, JSON.stringify(kept.body)).toBe(200);
}

function seedFiles(withBase: boolean) {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
  if (withBase) writeFileSync(pt(KEY), Buffer.from('OLD-BASE'));
  writeFileSync(pt(VARIANT), Buffer.from('OLD-VARIANT'));
}
const hasVariants = (b: BookSpec, id = 'wren') => rowOf(b, id).overrideTtsVoices?.qwen?.variants !== undefined;

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-linked-reset-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-linked-reset-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const b of [A, B, C, D, SOLO, ELSEWHERE]) {
    ids[b.title] = makeBookId(b.author ?? AUTHOR, b.series ?? '', b.title);
  }
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

describe('#4040 — a redesign resets the emotion variants of every linked row', () => {
  it('P1: A, B and C share u1; redesigning in A drops all three variants maps, keeps the slot names and the variant file', async () => {
    seedFiles(true);
    for (const b of [A, B, C]) writeBook(b, [variantsRow('wren', 'u1')]);
    await redesign(A);
    expect(readFileSync(pt(KEY)).toString(), 'the base was not replaced').not.toBe('OLD-BASE');
    for (const b of [A, B, C]) {
      expect(hasVariants(b), `${b.title} kept its variants`).toBe(false);
      expect(rowOf(b).overrideTtsVoices.qwen.name, `${b.title} lost its slot name`).toBe(KEY);
    }
    expect(existsSync(pt(VARIANT)), 'a variant file was deleted inline').toBe(true);
  });

  it('P2: a book that declined the link (separated voice u-sep) is untouched', async () => {
    seedFiles(true);
    const { recordSeparatedVoice } = await import('../workspace/separated-voices.js');
    await recordSeparatedVoice('u-sep');
    for (const b of [A, B, C]) writeBook(b, [variantsRow('wren', 'u1')]);
    writeBook(D, [variantsRow('wren', 'u-sep', { declinedVoiceFrom: [ids[A.title]] })]);
    const before = readFileSync(castPath(D));
    await redesign(A);
    expect(hasVariants(B)).toBe(false);
    expect(readFileSync(castPath(D)).equals(before), "D's cast.json changed").toBe(true);
    expect(hasVariants(D)).toBe(true);
  });

  it('P3: a second row in A on u1 is reset too; a row on another voice is not', async () => {
    seedFiles(true);
    writeBook(A, [
      variantsRow('wren', 'u1'),
      variantsRow('fern', 'u1'),
      variantsRow('moss', 'u9'),
    ]);
    writeBook(B, [variantsRow('wren', 'u1')]);
    await redesign(A);
    expect(hasVariants(A, 'wren')).toBe(false);
    expect(hasVariants(A, 'fern'), 'the same-book follower kept its variants').toBe(false);
    expect(hasVariants(A, 'moss'), 'a row on another voice was reset').toBe(true);
    expect(hasVariants(B)).toBe(false);
  });

  it("P4: a promote that writes the key's FIRST .pt touches no other book's cast.json", async () => {
    seedFiles(false);
    for (const b of [A, B, C]) writeBook(b, [variantsRow('wren', 'u1')]);
    const before = [B, C].map((b) => readFileSync(castPath(b)));
    await redesign(A);
    expect(existsSync(pt(KEY))).toBe(true);
    [B, C].forEach((b, i) => expect(readFileSync(castPath(b)).equals(before[i]), `${b.title} changed`).toBe(true));
    expect(hasVariants(B)).toBe(true);
  });

  it('P5: a standalone redesign resets only its own rows; a series book on the same key is untouched', async () => {
    seedFiles(true);
    writeBook(SOLO, [variantsRow('wren', 'u1'), variantsRow('fern', 'u1')]);
    writeBook(ELSEWHERE, [variantsRow('wren', 'u1')]);
    const elsewhere = readFileSync(castPath(ELSEWHERE));
    await redesign(SOLO);
    expect(hasVariants(SOLO, 'wren')).toBe(false);
    expect(hasVariants(SOLO, 'fern')).toBe(false);
    expect(readFileSync(castPath(ELSEWHERE)).equals(elsewhere), 'a series book was touched').toBe(true);
  });

  it('P5: a series redesign never reaches a book of ANOTHER series on the same key', async () => {
    seedFiles(true);
    writeBook(A, [variantsRow('wren', 'u1')]);
    writeBook(B, [variantsRow('wren', 'u1')]);
    writeBook(ELSEWHERE, [variantsRow('wren', 'u1')]);
    const elsewhere = readFileSync(castPath(ELSEWHERE));
    await redesign(A);
    expect(hasVariants(B)).toBe(false);
    expect(readFileSync(castPath(ELSEWHERE)).equals(elsewhere), 'a book of another series was reset').toBe(true);
  });
});

/* #4040 child 4 — the direct base landing (landStagedDesign): no preview, no emotion. */
const directDesign = (b: BookSpec, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${ids[b.title]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });

describe('#4040 — a direct base redesign (landStagedDesign) resets linked variants too', () => {
  it('L1: A, B, C share u1 with a base; a direct base design on A drops all three variants maps, keeps the variant file', async () => {
    seedFiles(true);
    for (const b of [A, B, C]) writeBook(b, [variantsRow('wren', 'u1')]);
    const res = await directDesign(A);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(readFileSync(pt(KEY)).toString(), 'the base was not replaced').not.toBe('OLD-BASE');
    for (const b of [A, B, C]) expect(hasVariants(b), `${b.title} kept its variants`).toBe(false);
    expect(existsSync(pt(VARIANT)), 'a variant file was deleted inline').toBe(true);
  });

  it('L2: the separated book D is untouched', async () => {
    seedFiles(true);
    const { recordSeparatedVoice } = await import('../workspace/separated-voices.js');
    await recordSeparatedVoice('u-sep');
    for (const b of [A, B, C]) writeBook(b, [variantsRow('wren', 'u1')]);
    writeBook(D, [variantsRow('wren', 'u-sep', { declinedVoiceFrom: [ids[A.title]] })]);
    const before = readFileSync(castPath(D));
    const res = await directDesign(A);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(hasVariants(B)).toBe(false);
    expect(readFileSync(castPath(D)).equals(before), "D's cast.json changed").toBe(true);
  });

  it("L3: a direct base design that writes the key's FIRST .pt touches no other book", async () => {
    seedFiles(false);
    for (const b of [A, B, C]) writeBook(b, [variantsRow('wren', 'u1')]);
    const before = [B, C].map((b) => readFileSync(castPath(b)));
    const res = await directDesign(A);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(existsSync(pt(KEY))).toBe(true);
    [B, C].forEach((b, i) => expect(readFileSync(castPath(b)).equals(before[i]), `${b.title} changed`).toBe(true));
  });

  it('L4: an emotion design on A leaves every row\'s other variants in place', async () => {
    seedFiles(true);
    for (const b of [A, B, C]) writeBook(b, [variantsRow('wren', 'u1')]);
    const res = await directDesign(A, { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const b of [A, B, C]) expect(hasVariants(b), `${b.title} lost its variants`).toBe(true);
  });
});
