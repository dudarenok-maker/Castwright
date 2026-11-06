/* PR #4007 pass 12 — who a first design is shared with (owner decision: share a
   first design), on the real design (REST, preview), promote, discard and decline
   routes, against real cast.json files.

   One rule for the landing and for promote: share only when THIS write creates
   the key's first `.pt` AND the designing row carries no decline marker. A
   decliner's voice is never shared (P12-1); a Cancel before a plain first design
   does not lose the share (P12-4).

   A fresh series: One, Two and Three never designed, Two and Three linked to One,
   all on the legacy key `qwen-v_wren` with no `.pt`. The sidecar mock writes
   distinct bytes for each call, and one hook runs just before a multi-book
   landing takes its book-ops. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
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
/* Awaited once, just before a design's multi-book landing takes its book-ops (the
   first withBookOps call whose ids include `bookId` and more than one id). */
const beforeShareLanding = vi.hoisted(() => ({ bookId: null as string | null, fn: null as (() => Promise<void>) | null }));
vi.mock('../workspace/book-op-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/book-op-lock.js')>();
  const withBookOps: typeof actual.withBookOps = async (ids, fn, opts) => {
    if (beforeShareLanding.fn && ids.length > 1 && ids.includes(beforeShareLanding.bookId as string)) {
      const run = beforeShareLanding.fn;
      beforeShareLanding.fn = null;
      await run();
    }
    return actual.withBookOps(ids, fn, opts);
  };
  return { ...actual, withBookOps };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';
const TITLES = ['Book One', 'Book Two', 'Book Three'] as const;
type Title = (typeof TITLES)[number];

let workspaceRoot: string;
let audioDir: string;
let app: Express;
const ids = {} as Record<Title, string>;
let counter = 0;
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const row = (t: string): Record<string, any> => JSON.parse(readFileSync(castPath(t), 'utf8')).characters[0];
function writeState(dir: string, s: { bookId: string; title: string; author: string; series: string; position: number }) {
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: s.bookId,
      manuscriptId: `m_${s.bookId}`,
      title: s.title,
      author: s.author,
      series: s.series,
      seriesPosition: s.position,
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
}
function writeBook(t: Title, rows: Array<Record<string, unknown>>) {
  writeState(bookDir(t), { bookId: ids[t], title: t, author: AUTHOR, series: SERIES, position: TITLES.indexOf(t) + 1 });
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
const linkTo = (t: Title) => ({ matchedFrom: { bookId: ids[t], characterId: 'wren', bookTitle: t, confidence: 1 } });
const pt = (k: string) => join(qwenDir(), `${k}.pt`);
const design = (t: Title, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });
const decline = (t: Title, from: Title) =>
  request(app).post(`/api/books/${ids[t]}/cast/wren/decline-voice-link`).send({ fromBookId: ids[from] });
const promote = (t: Title, previewVoiceId: string) =>
  request(app)
    .post(`/api/books/${ids[t]}/cast/wren/promote-voice`)
    .send({ previewVoiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });

/* One, Two, Three never designed; Two and Three both linked to One (the linker's
   output for a fresh series). */
function seedNeverDesigned() {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
  writeBook('Book One', [{ ...legacy }]);
  writeBook('Book Two', [{ ...legacy, ...linkTo('Book One') }]);
  writeBook('Book Three', [{ ...legacy, ...linkTo('Book One') }]);
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-first-share-'));
  audioDir = mkdtempSync(join(tmpdir(), 'castwright-first-share-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { makeBookId } = await import('../workspace/paths.js');
  for (const t of TITLES) ids[t] = makeBookId(AUTHOR, SERIES, t);
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
});

beforeEach(() => {
  beforeShareLanding.fn = null;
  beforeShareLanding.bookId = null;
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

describe("P12-1 — a decliner's kept first design is never shared", () => {
  it("(a) Don't reuse (from One), then Design & compare -> Keep on Two: Three, linked to One, does not take Two's voice", async () => {
    seedNeverDesigned();
    const d = await decline('Book Two', 'Book One');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const x = row('Book Two').voiceUuid as string;
    expect(x).toBeTruthy();
    expect(row('Book Three').voiceUuid).toBeUndefined();

    const preview = await design('Book Two', { preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const kept = await promote('Book Two', preview.body.voiceId);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(kept.body.voiceId).toBe(`qwen-${x}`);

    expect(row('Book One').voiceUuid).toBeUndefined();
    expect(row('Book Three').voiceUuid, "Three was moved onto the decliner's voice").toBeUndefined();
  });

  it("(a) ...and then designing Three does not rewrite Two's qwen-<x>.pt", async () => {
    seedNeverDesigned();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = row('Book Two').voiceUuid as string;
    const preview = await design('Book Two', { preview: true });
    expect((await promote('Book Two', preview.body.voiceId)).status).toBe(200);
    const twoBytes = readFileSync(pt(`qwen-${x}`));

    const three = await design('Book Three');
    expect(three.status, JSON.stringify(three.body)).toBe(200);
    expect(three.body.voiceId).not.toBe(`qwen-${x}`);
    expect(readFileSync(pt(`qwen-${x}`)).equals(twoBytes), "Book Three's design rewrote Two's voice").toBe(true);
  });

  it("(a) ...and Two's own later redesign does not change what Three (One's character) speaks", async () => {
    seedNeverDesigned();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const preview = await design('Book Two', { preview: true });
    expect((await promote('Book Two', preview.body.voiceId)).status).toBe(200);
    const threeKey = row('Book Three').voiceUuid ? `qwen-${row('Book Three').voiceUuid}` : 'qwen-v_wren';
    const threeBefore = existsSync(pt(threeKey)) ? readFileSync(pt(threeKey)) : null;
    const again = await design('Book Two');
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const threeAfter = existsSync(pt(threeKey)) ? readFileSync(pt(threeKey)) : null;
    expect(String(threeAfter), `Two's redesign changed Three's ${threeKey}`).toBe(String(threeBefore));
  });

  it("(b) Design & compare, then Don't reuse, then Keep: Three does not take the voice Two kept", async () => {
    seedNeverDesigned();
    const preview = await design('Book Two', { preview: true });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const d = await decline('Book Two', 'Book One');
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const kept = await promote('Book Two', preview.body.voiceId);
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect(row('Book Two').declinedVoiceFrom).toEqual([ids['Book One']]);
    expect(row('Book One').voiceUuid).toBeUndefined();
    expect(row('Book Three').voiceUuid, 'Three took the voice Two kept after declining One').toBeUndefined();
  });

  it("(c) Don't reuse lands between a first design's mint and its landing: Three does not take Two's voice", async () => {
    seedNeverDesigned();
    beforeShareLanding.bookId = ids['Book Two'];
    let declineStatus = 0;
    beforeShareLanding.fn = async () => {
      declineStatus = (await decline('Book Two', 'Book One')).status;
    };
    const res = await design('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(declineStatus).toBe(200);
    expect(row('Book Two').declinedVoiceFrom).toEqual([ids['Book One']]);
    expect(row('Book One').voiceUuid).toBeUndefined();
    expect(row('Book Three').voiceUuid, "Three, One's character, took the decliner's voice").toBeUndefined();
  });

  it("control: Don't reuse, then a plain first design of Two, shares nothing with Three", async () => {
    seedNeverDesigned();
    expect((await decline('Book Two', 'Book One')).status).toBe(200);
    const x = row('Book Two').voiceUuid as string;
    const res = await design('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.voiceId).toBe(`qwen-${x}`);
    expect(row('Book Three').voiceUuid).toBeUndefined();
  });

  it('control: with no decline, a first design of Two is shared with One and Three', async () => {
    seedNeverDesigned();
    const res = await design('Book Two');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const n = row('Book Two').voiceUuid;
    expect(row('Book One').voiceUuid).toBe(n);
    expect(row('Book Three').voiceUuid).toBe(n);
    expect(existsSync(pt(`qwen-${n}`))).toBe(true);
    expect(readdirSync(qwenDir()).filter((f) => f.startsWith('qwen-staging-'))).toEqual([]);
  });
});
