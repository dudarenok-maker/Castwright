/* #3713 / PR #4004 pass 6 -- a design that would write a repaired series-mate is decided at START. A design
   persists across the series by voice id (the `voiceUuid` stamp and the override), so the client never names
   the mates: a start from a request without the current repair epoch is refused whole (409
   `book_repaired_reload`, before the SSE stream or any job exists), and one with it writes every mate, the
   repaired one included. A running job never reports a skip, and re-attaching to one checks nothing new. The real
   sweep repairs a pair in a temp workspace and the real routers serve it; only the sidecar design call is
   stubbed. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('./qwen-voice.js', async (orig) => ({
  ...(await orig<typeof import('./qwen-voice.js')>()),
  /* The real core names the voice qwen-<voiceUuid> (qwenStorageKey), and the Save that follows only writes a
     row on that uuid (#3992: a designed name for another uuid is not meant for it). */
  designQwenVoiceForCharacter: vi.fn(async (p: { characterId: string; character: { voiceUuid?: string } }) => ({
    voiceId: `qwen-${p.character.voiceUuid ?? p.characterId}`,
    url: `/api/voice-sample/${p.characterId}.mp3`,
  })),
}));
vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona: vi.fn(async () => 'a persona'),
  personaSharesGpu: vi.fn(() => false),
}));
vi.mock('../tts/persona-gpu-plan.js', () => ({
  preparePersonaBatch: vi.fn().mockResolvedValue({ onCpu: false, keepAlive: 0 }),
  resolvePersonaGpuPlan: vi.fn().mockReturnValue({ onCpu: false, evict: false, keepAlive: 0 }),
}));
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: async (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {},
}));

let root: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let sweep: typeof import('../workspace/duplicate-bookid-sweep.js');
let gate: typeof import('../workspace/repaired-book-gate.js');
let designLock: typeof import('../tts/design-lock.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-design-sse-'));
  process.env.WORKSPACE_DIR = root;
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  paths = await import('../workspace/paths.js');
  sweep = await import('../workspace/duplicate-bookid-sweep.js');
  gate = await import('../workspace/repaired-book-gate.js');
  designLock = await import('../tts/design-lock.js');
  const { singleDesignRouter } = await import('./single-design.js');
  const { castDesignRouter } = await import('./cast-design.js');
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  app = express();
  app.use(express.json());
  app.use('/api/books/:bookId', gate.repairedBookGate);
  app.use('/api/books', singleDesignRouter);
  app.use('/api/books', castDesignRouter);
  app.use('/api/books', qwenVoiceRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
});

beforeEach(() => {
  rmSync(paths.BOOKS_ROOT, { recursive: true, force: true });
  sweep.__resetDuplicateBookIdRepairsForTest();
});
afterEach(() => {
  sweep.__resetDuplicateBookIdRepairsForTest();
  if (src) designLock.clearDesignBusy(src);
});

function seed(folder: string, bookId: string, opts: { rendered: boolean }): string {
  const dir = join(paths.BOOKS_ROOT, 'Auth', 'Ser', folder);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId, manuscriptId: `m_${folder}`, title: folder, author: 'Auth', series: 'Ser', seriesPosition: 1,
      isStandalone: false, manuscriptFile: 'manuscript.md', castConfirmed: true, language: 'en',
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one', ...(opts.rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}) }],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  writeFileSync(
    paths.castJsonPath(dir),
    JSON.stringify({ characters: [{ id: 'c0', name: 'Rhea', role: 'lead', color: 'rose', voiceStyle: 'a warm voice' }] }),
  );
  return dir;
}

const DUP = 'auth__ser__book';
const SRC = 'auth__ser__src';
let kept: string;
let src: string;

async function repaired() {
  seed('Book', DUP, { rendered: false });
  kept = seed('Book original', DUP, { rendered: true });
  src = seed('Src', SRC, { rendered: false });
  await sweep.repairDuplicateBookIds();
}

const read = (dir: string) => readFileSync(paths.castJsonPath(dir), 'utf8');
/* The name the design wrote: qwen-<the uuid it stamped>. */
const designedName = () => `qwen-${JSON.parse(read(src)).characters[0].voiceUuid}`;

function sse(text: string): Array<Record<string, any>> {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

const single = (epoch: string | null) => {
  const r = request(app).post(`/api/books/${SRC}/cast/c0/design-voice/stream`);
  return (epoch === null ? r : r.set('X-Repair-Epoch', epoch)).send({ persona: 'a warm voice', sampleVoiceId: 'char-c0', modelKey: 'qwen3-tts-0.6b' });
};
const bulk = (epoch: string | null) => {
  const r = request(app).post(`/api/books/${SRC}/cast/design`);
  return (epoch === null ? r : r.set('X-Repair-Epoch', epoch)).send({ characterIds: ['c0'], modelKey: 'qwen3-tts-0.6b' });
};
const qwen = (epoch: string | null) => {
  const r = request(app).post(`/api/books/${SRC}/cast/c0/design-voice`);
  return (epoch === null ? r : r.set('X-Repair-Epoch', epoch)).send({ persona: 'a warm voice', sampleVoiceId: 'char-c0', modelKey: 'qwen3-tts-0.6b' });
};
const refused = (res: { status: number; body: { code?: string } }) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('book_repaired_reload');
};

describe('single design (SSE) with a repaired series-mate (#3713, pass 6)', () => {
  it('no epoch: refused at start (409, no stream), nothing is written', async () => {
    await repaired();
    const before = [read(kept), read(src)];
    refused(await single(null));
    expect([read(kept), read(src)]).toEqual(before);
  });

  it('with the current epoch: the repaired twin is written too, and no event reports a skip', async () => {
    await repaired();
    const res = await single(gate.currentRepairEpoch()!);
    const designed = sse(res.text).find((e) => e.type === 'designed');
    expect(designed).toBeDefined();
    expect(designed).not.toHaveProperty('skippedBooks');
    expect(read(kept)).toContain(designedName());
  });

  it('CONTROL: with no repair a start needs no epoch', async () => {
    seed('Book', 'auth__ser__book', { rendered: true });
    src = seed('Src', SRC, { rendered: false });
    expect(sse((await single(null)).text).find((e) => e.type === 'designed')).toBeDefined();
  });
});

describe('bulk design (SSE) with a repaired series-mate (#3713, pass 6)', () => {
  it('no epoch: the START is refused (409, no stream, no job), nothing is written', async () => {
    await repaired();
    const before = [read(kept), read(src)];
    refused(await bulk(null));
    expect([read(kept), read(src)]).toEqual(before);
  });

  it('the reviewer repro: a stale tab starts, a fresh page re-attaches -- the start is refused and the fresh page sees an idle stream (no skippedBooks, nothing to reload on)', async () => {
    await repaired();
    refused(await bulk(null));
    const events = sse((await request(app).post(`/api/books/${SRC}/cast/design`).set('X-Repair-Epoch', gate.currentRepairEpoch()!).send({})).text);
    expect(events.map((e) => e.type)).toEqual(['idle']);
    expect(events.filter((e) => e.skippedBooks)).toEqual([]);
  });

  it('with the current epoch: the repaired twin is written too, and no event reports a skip', async () => {
    await repaired();
    const events = sse((await bulk(gate.currentRepairEpoch()!)).text);
    expect(events.filter((e) => e.skippedBooks)).toEqual([]);
    expect(read(kept)).toContain(designedName());
  });
});

describe('qwen design-voice (JSON) with a repaired series-mate (#3713, pass 6)', () => {
  it('no epoch: refused before any GPU work; with the current epoch it is not refused', async () => {
    await repaired();
    const before = [read(kept), read(src)];
    refused(await qwen(null));
    expect([read(kept), read(src)]).toEqual(before);
    expect((await qwen(gate.currentRepairEpoch()!)).status).not.toBe(409);
  });
});
