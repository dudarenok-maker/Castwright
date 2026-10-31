/* #3992 — redesigning a character whose series link the user DECLINED must
   give it its own voiceUuid (the earlier book's `qwen-<uuid>.pt` stays
   untouched); a character whose link is still active keeps sharing.

   Two real books in one series; Book One's row and Book Two's row share
   `voiceId` + `voiceUuid: 'u_shared'`. The sidecar fetch is mocked: it records
   the voiceId it is asked for and writes that `.pt` with DIFFERENT bytes, so a
   missing fork shows up as Book One's bytes being overwritten. */

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
const ORIG_PT = Buffer.from('BOOK-ONE-ORIGINAL-PT');
const ORIG_JSON = Buffer.from('{"voiceId":"qwen-u_shared","instruct":"book one"}');
const NEW_PT = Buffer.from('REDESIGNED-BY-SIDECAR');

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
let requestedVoiceIds: string[];
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (title: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, title);
const castPath = (title: string) => join(bookDir(title), '.audiobook', 'cast.json');
const readRow = (title: string): Record<string, unknown> =>
  JSON.parse(readFileSync(castPath(title), 'utf8')).characters[0];

function writeBook(title: string, position: number, id: string, row: Record<string, unknown>) {
  const dir = bookDir(title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title,
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
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: [row] }),
  );
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
};

function seed(bookTwoExtra: Record<string, unknown>) {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  writeBook('Book One', 1, bookOneId, { ...baseRow });
  writeBook('Book Two', 2, bookTwoId, { ...baseRow, ...bookTwoExtra });
  mkdirSync(qwenDir(), { recursive: true });
  writeFileSync(join(qwenDir(), 'qwen-u_shared.pt'), ORIG_PT);
  writeFileSync(join(qwenDir(), 'qwen-u_shared.json'), ORIG_JSON);
}

function pcm() {
  return new Uint8Array(24_000 * 2 * 0.3);
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-declined-fork-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-declined-fork-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOneId = makeBookId(AUTHOR, SERIES, 'Book One');
  bookTwoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
});

beforeEach(() => {
  requestedVoiceIds = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      voiceId = JSON.parse(init?.body ?? '{}').voiceId;
    } catch {
      /* not a design call */
    }
    if (voiceId) {
      requestedVoiceIds.push(voiceId);
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), NEW_PT);
    }
    const bytes = pcm();
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
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

const design = (id: () => string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${id()}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });

describe('#3992 — declined series link forks the shared voiceUuid on a base design', () => {
  it('Declined: Book Two gets its own uuid; Book One’s files stay byte-identical', async () => {
    seed({});
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);

    expect(requestedVoiceIds).toHaveLength(1);
    const m = /^qwen-(.+)$/.exec(requestedVoiceIds[0]);
    expect(m).not.toBeNull();
    const fresh = m![1];
    expect(fresh).not.toBe('u_shared');

    expect(readRow('Book Two').voiceUuid).toBe(fresh);
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    expect(existsSync(join(qwenDir(), `qwen-${fresh}.pt`))).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT)).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.json')).equals(ORIG_JSON)).toBe(true);
    /* the sidecar overwrote only the forked copy */
    expect(readFileSync(join(qwenDir(), `qwen-${fresh}.pt`)).equals(NEW_PT)).toBe(true);
  });

  it('Declined + preview: discard leaves Book Two on U’ holding Book One’s original bytes', async () => {
    seed({});
    const res = await design(() => bookTwoId, { preview: true });
    expect(res.status).toBe(200);

    const previewId = requestedVoiceIds[0];
    expect(previewId).toMatch(/^qwen-.+-preview$/);
    const fresh = previewId.replace(/^qwen-/, '').replace(/-preview$/, '');
    expect(fresh).not.toBe('u_shared');
    expect(readRow('Book Two').voiceUuid).toBe(fresh);

    const discard = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/discard-voice`)
      .send({ previewVoiceId: previewId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
    expect(discard.status).toBe(200);

    expect(readRow('Book Two').voiceUuid).toBe(fresh);
    expect(readFileSync(join(qwenDir(), `qwen-${fresh}.pt`)).equals(ORIG_PT)).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT)).toBe(true);
    expect(readFileSync(join(qwenDir(), 'qwen-u_shared.json')).equals(ORIG_JSON)).toBe(true);
  });

  it('Linked: a design for Book Two goes to qwen-u_shared, no new uuid, no copy', async () => {
    seed({});
    /* matchedFrom names the real Book One */
    const row = { ...readRow('Book Two'), matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } };
    writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [row] }));

    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(qwenDir()).filter((f) => f.endsWith('.pt'))).toEqual(['qwen-u_shared.pt']);
  });

  it('Source of a live link: designing Book One’s row shares qwen-u_shared, no fork', async () => {
    seed({});
    const row = { ...readRow('Book Two'), matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } };
    writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [row] }));

    const res = await design(() => bookOneId);
    expect(res.status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
    expect(readRow('Book One').voiceUuid).toBe('u_shared');
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
  });

  it('Assign: a bookId-less matchedFrom counts as an active link — no fork', async () => {
    seed({ matchedFrom: { bookTitle: 'Book One', confidence: 0.92 } });
    const res = await design(() => bookTwoId);
    expect(res.status).toBe(200);
    expect(requestedVoiceIds).toEqual(['qwen-u_shared']);
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
  });
});
