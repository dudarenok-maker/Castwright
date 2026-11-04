/* #3713 / PR #4004 pass 4, finding 6 -- the SSE design streams report a repaired series-mate their voice
   write skipped. A design persists across the series by voice id (the `voiceUuid` stamp and the override), so
   the client never names the mates; a gated mate is left alone on a request without the current repair epoch (owner
   decision) and the stream says so on `designed` (single), `character_designed` and the terminal `idle`
   (bulk), for the client to show the same toast as a plain series write. The real sweep repairs a pair in a
   temp workspace and the real routers serve it; only the sidecar design call is stubbed. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('./qwen-voice.js', async (orig) => ({
  ...(await orig<typeof import('./qwen-voice.js')>()),
  designQwenVoiceForCharacter: vi.fn(async (p: { characterId: string }) => ({
    voiceId: `qwen-${p.characterId}`,
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
  app = express();
  app.use(express.json());
  app.use('/api', gate.repairedFanOutScope);
  app.use('/api/books/:bookId', gate.repairedBookGate);
  app.use('/api/books', singleDesignRouter);
  app.use('/api/books', castDesignRouter);
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
const skippedIds = (ev: { skippedBooks?: Array<{ bookId: string }> } | undefined) => (ev?.skippedBooks ?? []).map((s) => s.bookId);

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
  return (epoch === null ? r : r.set('X-Repair-Epoch', epoch)).send({ characterIds: ['c0'], modelKey: 'qwen3-tts-0.6b', scope: 'series' });
};

describe('single design (SSE) with a repaired series-mate (#3713, pass 4)', () => {
  it('no epoch: the kept twin is not written, and the `designed` event names it', async () => {
    await repaired();
    const before = read(kept);
    const res = await single(null);
    const designed = sse(res.text).find((e) => e.type === 'designed');
    expect(designed).toBeDefined();
    expect(skippedIds(designed)).toContain(DUP);
    expect(designed!.skippedBooks[0].reason).toMatch(/^".+" was repaired after this page loaded. Reload Castwright/);
    expect(read(kept)).toBe(before);
    expect(read(src)).toContain('qwen-c0');
  });

  it('with the current epoch: written, and nothing is reported', async () => {
    await repaired();
    const res = await single(gate.currentRepairEpoch()!);
    const designed = sse(res.text).find((e) => e.type === 'designed');
    expect(designed).toBeDefined();
    expect(skippedIds(designed)).toEqual([]);
    expect(designed).not.toHaveProperty('skippedBooks');
    expect(read(kept)).toContain('qwen-c0');
  });

  it('CONTROL: with no repair there is no skippedBooks field at all', async () => {
    seed('Book', 'auth__ser__book', { rendered: true });
    src = seed('Src', SRC, { rendered: false });
    const designed = sse((await single(null)).text).find((e) => e.type === 'designed');
    expect(designed).toBeDefined();
    expect(designed).not.toHaveProperty('skippedBooks');
  });
});

describe('bulk design (SSE) with a repaired series-mate (#3713, pass 4)', () => {
  it('no epoch: `character_designed` and the terminal `idle` name the skipped twin; it is not written', async () => {
    await repaired();
    const before = read(kept);
    const res = await bulk(null);
    const events = sse(res.text);
    expect(skippedIds(events.find((e) => e.type === 'character_designed'))).toContain(DUP);
    const idle = events.find((e) => e.type === 'idle');
    expect(skippedIds(idle)).toContain(DUP);
    expect(read(kept)).toBe(before);
  });

  it('with the current epoch: written, and no event reports a skip', async () => {
    await repaired();
    const events = sse((await bulk(gate.currentRepairEpoch()!)).text);
    expect(events.filter((e) => e.skippedBooks)).toEqual([]);
    expect(read(kept)).toContain('qwen-c0');
  });
});
