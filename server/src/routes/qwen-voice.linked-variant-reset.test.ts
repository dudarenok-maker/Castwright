/* #4040 (reset them together) — a promote that REPLACES an existing base `.pt`
   (the approve step of a redesign) drops the emotion variants of every row linked
   to that voice: the designing row, its same-book followers, and the rows on the
   same storage key in every other book of the library. A declined book is on a
   separated voice (another key) and is never reached. A first design behaves as
   it always did. No variant FILE is deleted (the startup sweep does that).

   Real design (preview) and promote routes against real cast.json files. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
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
/* Holds the next design sidecar call until `release`. */
const gate = { hold: false, entered: null as null | (() => void), release: null as null | (() => void) };
const holdNextDesign = (): Promise<void> => {
  gate.hold = true;
  return new Promise<void>((r) => (gate.entered = r));
};

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
  gate.release?.(); // a test that failed while holding a render must not wedge the next
  gate.hold = false;
  gate.entered = null;
  gate.release = null;
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
      if (gate.hold) {
        gate.hold = false;
        await new Promise<void>((r) => {
          gate.release = r;
          gate.entered?.();
        });
      }
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

  it('P1b: B and C link to A through matchedFrom (the real shape); the redesign still resets them', async () => {
    seedFiles(true);
    writeBook(A, [variantsRow('wren', 'u1')]);
    for (const b of [B, C]) {
      writeBook(b, [
        variantsRow('wren', 'u1', { voiceState: 'reused', matchedFrom: { bookTitle: A.title, confidence: 0.9 } }),
      ]);
    }
    await redesign(A);
    for (const b of [A, B, C]) expect(hasVariants(b), `${b.title} (matchedFrom) kept its variants`).toBe(false);
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

  it('P5: a standalone redesign resets its own rows AND a series book on the same key; a book on another key is untouched', async () => {
    seedFiles(true);
    writeBook(SOLO, [variantsRow('wren', 'u1'), variantsRow('fern', 'u1')]);
    writeBook(ELSEWHERE, [variantsRow('wren', 'u1')]);
    writeBook(D, [variantsRow('wren', 'u9')]);
    const other = readFileSync(castPath(D));
    await redesign(SOLO);
    expect(hasVariants(SOLO, 'wren')).toBe(false);
    expect(hasVariants(SOLO, 'fern')).toBe(false);
    expect(hasVariants(ELSEWHERE), 'a book on the same key kept its variants').toBe(false);
    expect(readFileSync(castPath(D)).equals(other), 'a book on another key was touched').toBe(true);
  });

  it('P5: a series redesign resets a book of ANOTHER series on the same key; a book on another key is untouched', async () => {
    seedFiles(true);
    writeBook(A, [variantsRow('wren', 'u1')]);
    writeBook(B, [variantsRow('wren', 'u1')]);
    writeBook(ELSEWHERE, [variantsRow('wren', 'u1')]);
    writeBook(D, [variantsRow('wren', 'u9')]);
    const other = readFileSync(castPath(D));
    await redesign(A);
    expect(hasVariants(B)).toBe(false);
    expect(hasVariants(ELSEWHERE), 'an out-of-series book on the same key kept its variants').toBe(false);
    expect(readFileSync(castPath(D)).equals(other), 'a book on another key was touched').toBe(true);
  });

  it('P6: a linked row whose slot name is a legacy name (series mint left it) is reset by the key it renders from', async () => {
    seedFiles(true);
    writeBook(A, [variantsRow('wren', 'u1')]);
    writeBook(B, [variantsRow('wren', 'u1', { overrideTtsVoices: { qwen: { name: 'qwen-legacy', variants: { angry: { name: 'qwen-u1__angry' } } } } })]);
    await redesign(A);
    expect(hasVariants(A)).toBe(false);
    expect(hasVariants(B), 'a legacy-named linked row kept its variants').toBe(false);
    expect(rowOf(B).overrideTtsVoices.qwen.name).toBe('qwen-legacy');
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

/* #4040 — a re-parsed book waiting for re-analysis has no cast rows in cast.json: its
   voice slots sit in the reuse carryover, which the next analysis restores. */
const carryPath = (b: BookSpec) => join(dirOf(b), '.audiobook', 'cast-reuse-carryover.json');
const writeCarryover = (b: BookSpec, rows: Array<Record<string, unknown>>) =>
  writeFileSync(carryPath(b), JSON.stringify({ characters: rows }));
const carryRows = (b: BookSpec): Array<Record<string, any>> => JSON.parse(readFileSync(carryPath(b), 'utf8')).characters;
const carryRow = (b: BookSpec, id = 'wren') => carryRows(b).find((r) => r.id === id) as Record<string, any>;

describe('#4040 — a re-parsed book keeps no stale variants in its carryover', () => {
  it('R1: B has no cast rows, only a carryover on u1; a promote on A clears its variants and nothing else', async () => {
    seedFiles(true);
    writeBook(A, [variantsRow('wren', 'u1')]);
    writeBook(B, []);
    writeCarryover(B, [variantsRow('wren', 'u1'), variantsRow('fern', 'u9')]);
    const fernBefore = JSON.stringify(carryRow(B, 'fern'));
    const wrenBefore = carryRow(B);
    await redesign(A);
    expect(hasVariants(A)).toBe(false);
    const wren = carryRow(B);
    expect(wren.overrideTtsVoices.qwen.variants, 'the carried-over row kept its variants').toBeUndefined();
    const { variants: _v, ...slotRest } = wrenBefore.overrideTtsVoices.qwen;
    expect(wren).toEqual({ ...wrenBefore, overrideTtsVoices: { qwen: slotRest } });
    expect(JSON.stringify(carryRow(B, 'fern')), 'a carried-over row on another voice changed').toBe(fernBefore);
    expect(existsSync(pt(VARIANT)), 'a variant file was deleted inline').toBe(true);
  });

  it('R2: a direct base design on A clears the carryover too', async () => {
    seedFiles(true);
    writeBook(A, [variantsRow('wren', 'u1')]);
    writeBook(B, []);
    writeCarryover(B, [variantsRow('wren', 'u1')]);
    const res = await directDesign(A);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(carryRow(B).overrideTtsVoices.qwen.variants).toBeUndefined();
  });

  it('R3: B has both a cast.json and a carryover on u1; both are cleared', async () => {
    seedFiles(true);
    writeBook(A, [variantsRow('wren', 'u1')]);
    writeBook(B, [variantsRow('wren', 'u1')]);
    writeCarryover(B, [variantsRow('wren', 'u1')]);
    await redesign(A);
    expect(hasVariants(B), 'cast.json kept its variants').toBe(false);
    expect(carryRow(B).overrideTtsVoices.qwen.variants, 'the carryover kept its variants').toBeUndefined();
  });

  it('R4: a carryover on another key is not rewritten', async () => {
    seedFiles(true);
    writeBook(A, [variantsRow('wren', 'u1')]);
    writeBook(B, [variantsRow('wren', 'u1')]);
    writeBook(D, []);
    writeCarryover(D, [variantsRow('wren', 'u9')]);
    const before = readFileSync(carryPath(D));
    await redesign(A);
    expect(readFileSync(carryPath(D)).equals(before)).toBe(true);
  });
});

/* #4040 — an emotion variant still rendering against the OLD base when another book
   replaces that base must not land: the reset already cleared every row, and the
   landing would spread an old-base variant across the library again. */
describe('#4040 — an emotion variant rendered against a replaced base is discarded', () => {
  const RETRY = "This character's voice changed while it was being designed. Design it again.";
  const staged = () => readdirSync(qwenDir()).filter((f) => f.startsWith('qwen-staging-'));

  it('E1: B renders angry against u1; A promotes a new u1 base; B answers the retry error, no row carries it, nothing staged', async () => {
    seedFiles(true);
    rmSync(pt(VARIANT), { force: true });
    for (const b of [A, B]) writeBook(b, [variantsRow('wren', 'u1', { overrideTtsVoices: { qwen: { name: KEY } } })]);
    const entered = holdNextDesign();
    const designing = directDesign(B, { emotion: 'angry' }).then((r) => r);
    await entered;
    await redesign(A);
    expect(readFileSync(pt(KEY)).toString(), 'the base was not replaced').not.toBe('OLD-BASE');
    gate.release!();
    const d = await designing;
    expect(d.status).toBe(500);
    expect(d.body.error).toBe(RETRY);
    for (const b of [A, B]) {
      expect(rowOf(b).overrideTtsVoices.qwen.variants?.angry, `${b.title} carries the old-base variant`).toBeUndefined();
    }
    expect(staged()).toEqual([]);
  });

  it('E2 (control): an emotion design with no base write in between lands on every linked row', async () => {
    seedFiles(true);
    rmSync(pt(VARIANT), { force: true });
    for (const b of [A, B]) writeBook(b, [variantsRow('wren', 'u1', { overrideTtsVoices: { qwen: { name: KEY } } })]);
    const res = await directDesign(B, { emotion: 'angry' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    for (const b of [A, B]) expect(rowOf(b).overrideTtsVoices.qwen.variants?.angry, `${b.title} missing the variant`).toBeDefined();
    expect(staged()).toEqual([]);
  });
});
