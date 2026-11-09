/* #4067, pass 4 S2 — the bulk "Design full cast" job's first design of a row that
   "Don't reuse" separated must leave the declined book's legacy row (no uuid, never
   designed) alone: applyOverrideToCastFiles' walk matches it by `voiceId` and used to
   write `qwen-<U'>` onto it. The single-design path is pinned in
   qwen-voice.declined-no-uuid.test.ts. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  const { writesStagedPt } = await import('../test-utils/staged-sidecar-fetch.js');
  return {
    ...actual,
    fetch: writesStagedPt((...args: unknown[]) => (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args)),
  };
});
vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona: vi.fn().mockResolvedValue('a bright voice'),
  personaSharesGpu: vi.fn().mockReturnValue(false),
}));
vi.mock('../tts/persona-gpu-plan.js', () => ({
  preparePersonaBatch: vi.fn().mockResolvedValue({ onCpu: false, keepAlive: 0 }),
  resolvePersonaGpuPlan: vi.fn().mockReturnValue({ onCpu: false, evict: false, keepAlive: 0 }),
}));
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: async (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {
    code = 'GPU_BUSY';
  },
}));

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
const fetchMock = vi.fn();

const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const readRow = (t: string): Record<string, any> =>
  JSON.parse(readFileSync(join(bookDir(t), '.audiobook', 'cast.json'), 'utf8')).characters[0];

function writeBook(t: string, position: number, id: string, row: Record<string, unknown>) {
  mkdirSync(join(bookDir(t), '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir(t), '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title: t,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: position,
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
  writeFileSync(join(bookDir(t), 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir(t), '.audiobook', 'cast.json'), JSON.stringify({ characters: [row] }));
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-design-declined-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-cast-design-declined-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);
  const { castDesignRouter } = await import('./cast-design.js');
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOneId = makeBookId(AUTHOR, SERIES, 'Book One');
  bookTwoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  app = express();
  app.use(express.json());
  app.use('/api/books', castDesignRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
    arrayBuffer: async () => new Uint8Array(24_000 * 2 * 0.3).buffer,
    json: async () => ({}),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

const wren = (extra: Record<string, unknown> = {}) => ({
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
  ...extra,
});

describe("bulk design of a decliner's row leaves the declined book alone (#4067, pass 4 S2)", () => {
  it('Book One keeps its undesigned legacy row; Book Two gets the designed slot', async () => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', 1, bookOneId, wren());
    writeBook(
      'Book Two',
      2,
      bookTwoId,
      wren({ matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } }),
    );
    const declined = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/decline-voice-link`)
      .send({ fromBookId: bookOneId });
    expect(declined.status).toBe(200);
    const u = declined.body.voiceUuid as string;
    const before = readRow('Book One');

    const res = await request(app)
      .post(`/api/books/${bookTwoId}/cast/design`)
      .send({ characterIds: ['wren'], modelKey: QWEN_KEY });
    expect(res.status).toBe(200);
    expect(res.text).toContain('character_designed');

    expect(readRow('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${u}`);
    expect(readRow('Book One')).toEqual(before);
  });

  it('Book One keeps a library-assigned qwen slot (libraryUuid and provenance) intact', async () => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook(
      'Book One',
      1,
      bookOneId,
      wren({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-L1', libraryUuid: 'L1', provenance: 'designed' } } }),
    );
    writeBook(
      'Book Two',
      2,
      bookTwoId,
      wren({ matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } }),
    );
    const declined = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/decline-voice-link`)
      .send({ fromBookId: bookOneId });
    expect(declined.status).toBe(200);
    const u = declined.body.voiceUuid as string;
    const before = readRow('Book One');

    const res = await request(app)
      .post(`/api/books/${bookTwoId}/cast/design`)
      .send({ characterIds: ['wren'], modelKey: QWEN_KEY });
    expect(res.status).toBe(200);
    expect(res.text).toContain('character_designed');

    expect(readRow('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${u}`);
    expect(readRow('Book One')).toEqual(before);
    expect(readRow('Book One').overrideTtsVoices.qwen.libraryUuid).toBe('L1');
  });
});
