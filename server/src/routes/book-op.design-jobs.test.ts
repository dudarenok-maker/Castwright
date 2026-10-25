/* #3711 task 4 -- the voice-design jobs are registered `design` jobs: cast/design (bulk),
   design-voice/stream (single) and design-voice (qwen REST). While one runs, a folder
   rename and a DELETE are refused with 409 `book_busy` and the folder is untouched;
   the registration is released on every exit path (success, per-character failure,
   early return) and a start for a deleted book registers nothing.

   Driven through the real routes with the sidecar's fetch held by a gate (the same
   seam cast-design.test.ts uses). Event-based, no sleeps. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) => (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK = 'The Hollow Tide';
const NEW_BOOK = 'The Hollow Tide Renamed';
const QWEN_KEY = 'qwen3-tts-0.6b';

let workspaceRoot: string;
let audioDir: string;
let bookDir: string;
let newDir: string;
let app: Express;
let bookId: string;
let bookJobKinds: typeof import('../workspace/book-op-lock.js').bookJobKinds;

const fetchMock = vi.fn();
const { personaMock } = vi.hoisted(() => ({ personaMock: vi.fn() }));
vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona: personaMock,
  resolvePersonaEngine: vi.fn().mockReturnValue('gemini'),
}));
vi.mock('../tts/persona-gpu-plan.js', () => ({
  preparePersonaBatch: vi.fn().mockResolvedValue({ onCpu: false, keepAlive: 0 }),
  resolvePersonaGpuPlan: vi.fn().mockReturnValue({ onCpu: false, evict: false, keepAlive: 0 }),
}));
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: async (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {
    code = 'GPU_BUSY';
    constructor(m: string) {
      super(m);
      this.name = 'GpuBusyError';
    }
  },
}));

const characters = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
  {
    id: 'aria',
    name: 'Aria',
    role: 'supporting',
    color: 'lilac',
    voiceId: 'v_aria',
    voiceUuid: 'v_aria',
    voiceStyle: 'a poised, confident teenage girl, clear and warm',
    evidence: [{ quote: '”We have to tell the Council before the others wake.”' }],
  },
];

function seedBook(): void {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title: BOOK,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
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
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
}

function okSidecarResponse(pcm = new Uint8Array(24_000 * 2 * 0.3)) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
    arrayBuffer: async () => pcm.buffer,
    json: async () => ({}),
  };
}
function badSidecarResponse() {
  const response = {
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({ detail: 'model exploded' }),
  };
  return Object.assign(response, { clone: () => response });
}

function parseSse(text: string): Array<Record<string, any>> {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** The next sidecar call parks on `release`; `started` resolves once it has been made. */
function holdSidecar(): { started: Promise<void>; release: () => void } {
  const started = gate();
  const release = gate();
  fetchMock.mockImplementationOnce(async () => {
    started.open();
    await release.promise;
    return okSidecarResponse();
  });
  return { started: started.promise, release: release.open };
}

beforeAll(() => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
});
afterAll(() => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
});

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-design-jobs-test-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-design-jobs-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const [castDesign, qwenVoice, singleDesign, voiceStyle, bookState, { makeBookId }, opLock] = await Promise.all([
    import('./cast-design.js'),
    import('./qwen-voice.js'),
    import('./single-design.js'),
    import('./voice-style.js'),
    import('./book-state.js'),
    import('../workspace/paths.js'),
    import('../workspace/book-op-lock.js'),
  ]);
  bookJobKinds = opLock.bookJobKinds;
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
  newDir = join(workspaceRoot, 'books', AUTHOR, SERIES, NEW_BOOK);
  app = express();
  app.use(express.json());
  app.use('/api/books', castDesign.castDesignRouter);
  app.use('/api/books', qwenVoice.qwenVoiceRouter);
  app.use('/api/books', singleDesign.singleDesignRouter);
  app.use('/api/books', voiceStyle.voiceStyleRouter);
  app.use('/api/books', bookState.bookStateRouter);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okSidecarResponse());
  personaMock.mockReset();
  personaMock.mockResolvedValue('a bright, quick-witted teenage boy');
  for (const f of readdirSync(audioDir)) rmSync(join(audioDir, f), { force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  seedBook();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (audioDir) rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

const renameRequest = () =>
  request(app)
    .put(`/api/books/${bookId}/state`)
    .set('Content-Type', 'application/json')
    .send({ slice: 'state', patch: { title: NEW_BOOK } });

async function expectBusyRefusals(): Promise<void> {
  const rename = await renameRequest();
  expect(rename.status).toBe(409);
  expect(rename.body.code).toBe('book_busy');
  expect(rename.body.error).toMatch(/designing voices/i);
  const del = await request(app).delete(`/api/books/${bookId}`);
  expect(del.status).toBe(409);
  expect(del.body.code).toBe('book_busy');
  expect(existsSync(bookDir)).toBe(true);
  expect(existsSync(newDir)).toBe(false);
  expect(JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8')).title).toBe(BOOK);
}

describe('cast/design (bulk) is a registered design job (#3711)', () => {
  it('refuses rename and DELETE with 409 while it runs, then allows them', async () => {
    const held = holdSidecar();
    const run = request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY })
      .then((r) => r);
    await held.started;
    expect(bookJobKinds(bookId)).toEqual(['design']);

    await expectBusyRefusals();

    held.release();
    const res = await run;
    expect(parseSse(res.text).some((e) => e.type === 'character_designed')).toBe(true);
    await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual([]));
    expect((await renameRequest()).status).toBe(200);
    expect(existsSync(newDir)).toBe(true);
  });

  it('releases the registration when every character fails', async () => {
    fetchMock.mockResolvedValue(badSidecarResponse());
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });
    expect(parseSse(res.text).find((e) => e.type === 'idle')?.failures).toHaveLength(1);
    await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual([]));
    expect((await renameRequest()).status).toBe(200);
  });

  it('releases the registration on an early return (a bare subscribe probe with nothing running)', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cast/design`).send({});
    expect(parseSse(res.text).some((e) => e.type === 'idle')).toBe(true);
    expect(bookJobKinds(bookId)).toEqual([]);
    expect((await renameRequest()).status).toBe(200);
  });

  it('a start for a deleted book answers 404 and registers nothing', async () => {
    rmSync(bookDir, { recursive: true, force: true });
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });
    expect(res.status).toBe(404);
    expect(bookJobKinds(bookId)).toEqual([]);
  });
});

describe('design-voice (qwen REST) is a registered design job (#3711)', () => {
  it('refuses rename and DELETE with 409 while the sidecar design call is in flight', async () => {
    const held = holdSidecar();
    const run = request(app)
      .post(`/api/books/${bookId}/cast/aria/design-voice`)
      .send({ persona: 'a poised teenage girl', sampleVoiceId: 'v_aria', modelKey: QWEN_KEY })
      .then((r) => r);
    await held.started;
    expect(bookJobKinds(bookId)).toEqual(['design']);

    await expectBusyRefusals();

    held.release();
    const res = await run;
    expect(res.status).toBe(200);
    expect(bookJobKinds(bookId)).toEqual([]);
    expect((await renameRequest()).status).toBe(200);
  });

  it('releases the registration on an early return (unknown character -> 404)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/nobody/design-voice`)
      .send({ persona: 'x', sampleVoiceId: 'v', modelKey: QWEN_KEY });
    expect(res.status).toBe(404);
    expect(bookJobKinds(bookId)).toEqual([]);
  });
});

describe('design-voice/stream (single) is a registered design job (#3711)', () => {
  it('refuses rename and DELETE with 409 while it runs, then allows them', async () => {
    const held = holdSidecar();
    const run = request(app)
      .post(`/api/books/${bookId}/cast/aria/design-voice/stream`)
      .send({ persona: 'a poised teenage girl', sampleVoiceId: 'v_aria', modelKey: QWEN_KEY })
      .then((r) => r);
    await held.started;
    expect(bookJobKinds(bookId)).toEqual(['design']);

    await expectBusyRefusals();

    held.release();
    const res = await run;
    expect(parseSse(res.text).some((e) => e.type === 'designed')).toBe(true);
    await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual([]));
    expect((await renameRequest()).status).toBe(200);
  });
});

describe('voice-style (generate / generate-all) is a registered design job (#3711)', () => {
  it('refuses rename and DELETE while the persona LLM call is in flight, and releases after', async () => {
    const started = gate();
    const release = gate();
    personaMock.mockImplementationOnce(async () => {
      started.open();
      await release.promise;
      return 'a bright, quick-witted teenage boy';
    });
    const run = request(app)
      .post(`/api/books/${bookId}/cast/aria/voice-style/generate`)
      .send({})
      .then((r) => r);
    await started.promise;
    expect(bookJobKinds(bookId)).toEqual(['design']);

    await expectBusyRefusals();

    release.open();
    expect((await run).status).toBe(200);
    expect(bookJobKinds(bookId)).toEqual([]);
  });

  it('generate-all registers too, and a deleted book answers 404 with nothing registered', async () => {
    const started = gate();
    const release = gate();
    personaMock.mockImplementation(async () => {
      started.open();
      await release.promise;
      return 'a persona';
    });
    const run = request(app)
      .post(`/api/books/${bookId}/cast/voice-style/generate-all`)
      .send({})
      .then((r) => r);
    await started.promise;
    expect(bookJobKinds(bookId)).toEqual(['design']);
    release.open();
    expect((await run).status).toBe(200);
    expect(bookJobKinds(bookId)).toEqual([]);

    rmSync(bookDir, { recursive: true, force: true });
    const gone = await request(app).post(`/api/books/${bookId}/cast/voice-style/generate-all`).send({});
    expect(gone.status).toBe(404);
    expect(bookJobKinds(bookId)).toEqual([]);
  });
});
