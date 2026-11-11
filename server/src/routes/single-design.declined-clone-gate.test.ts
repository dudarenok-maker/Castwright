/* #4074 — the clone pre-gates of the single and bulk design routes ran BEFORE the design's uuid
   step, so they counted the declined book's consented clone on the shared voice even though a
   "Don't reuse" row is (or is about to be) on a new voice uuid U' that clone is not on. That
   refused a design that should succeed. A row carrying a decline marker now skips the early
   series scan; the design's landing runs it after the uuid step and before writing anything,
   scoped to the rows on U' (#4069), so a refusal leaves the disk as it was. The row's own
   slots, and a row with no marker, are still refused early. The emotion-variant gates scope
   the same way. */

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
vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona: vi.fn().mockResolvedValue('a bright voice'),
  personaSharesGpu: vi.fn().mockReturnValue(false),
}));
vi.mock('../tts/persona-gpu-plan.js', () => ({
  preparePersonaBatch: vi.fn().mockResolvedValue({ onCpu: false, keepAlive: 0 }),
  resolvePersonaGpuPlan: vi.fn().mockReturnValue({ onCpu: false, evict: false, keepAlive: 0 }),
}));
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

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
let bookThreeId: string;
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const readRow = (t: string): Record<string, any> => JSON.parse(readFileSync(castPath(t), 'utf8')).characters[0];

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
  writeFileSync(castPath(t), JSON.stringify({ characters: [row] }));
}

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
const coquiClone = { coqui: { name: 'wren-clone', libraryUuid: 'C1', provenance: 'cloned' } };
const linkedToBookOne = () => ({
  matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 },
});

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-declined-clone-gate-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-declined-clone-gate-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const { singleDesignRouter } = await import('./single-design.js');
  const { castDesignRouter } = await import('./cast-design.js');
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOneId = makeBookId(AUTHOR, SERIES, 'Book One');
  bookTwoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  bookThreeId = makeBookId(AUTHOR, SERIES, 'Book Three');
  app = express();
  app.use(express.json());
  app.use('/api/books', singleDesignRouter);
  app.use('/api/books', castDesignRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
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
      /* not a design call */
    }
    if (voiceId && !String(url).includes('evict')) {
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), Buffer.from('PT'));
      writeFileSync(join(qwenDir(), `${voiceId}.json`), JSON.stringify({ instruct: 'persona' }));
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
  vi.mocked(withCapacityRetry).mockReset();
  vi.mocked(withCapacityRetry).mockImplementation((doPost, opts) => doPost(opts.signal));
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

function collectSse(res: request.Response): Record<string, any>[] {
  return res.text
    .split('\n\n')
    .map((b) =>
      b
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n'),
    )
    .filter(Boolean)
    .map((j) => JSON.parse(j));
}

const single = () =>
  request(app)
    .post(`/api/books/${bookTwoId}/cast/wren/design-voice/stream`)
    .send({ persona: 'a warm voice', sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
const variantRoute = () =>
  request(app)
    .post(`/api/books/${bookTwoId}/cast/wren/design-voice`)
    .send({ persona: 'a warm voice', sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, emotion: 'angry' });
const bulkVariant = () =>
  request(app)
    .post(`/api/books/${bookTwoId}/cast/design`)
    .send({ scope: 'variants', variantTasks: [{ characterId: 'wren', emotions: ['angry'] }], modelKey: QWEN_KEY });
const qwenFiles = (): string[] => (existsSync(qwenDir()) ? readdirSync(qwenDir()).sort() : []);
const bulk = () =>
  request(app).post(`/api/books/${bookTwoId}/cast/design`).send({ characterIds: ['wren'], modelKey: QWEN_KEY });

/* Book One keeps a consented Coqui clone; Book Two is linked to it. */
function seedLinked(bookOneExtra: Record<string, unknown>, bookTwoExtra: Record<string, unknown> = {}) {
  writeBook('Book One', 1, bookOneId, wren({ ttsEngine: 'coqui', overrideTtsVoices: coquiClone, ...bookOneExtra }));
  writeBook('Book Two', 2, bookTwoId, wren({ ...linkedToBookOne(), ...bookTwoExtra }));
}
async function decline(): Promise<string> {
  const res = await request(app)
    .post(`/api/books/${bookTwoId}/cast/wren/decline-voice-link`)
    .send({ fromBookId: bookOneId });
  expect(res.status).toBe(200);
  return res.body.voiceUuid as string;
}
/* Book Two's row as a decline from before the route separated it left it: a marker, the
   shared uuid, still on the declined voice -- the design itself separates it. */
function seedUnseparatedDecline(bookOneUuid: string) {
  writeBook('Book One', 1, bookOneId, wren({ voiceUuid: bookOneUuid, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
  writeBook(
    'Book Two',
    2,
    bookTwoId,
    wren({ ...linkedToBookOne(), voiceUuid: bookOneUuid, declinedVoiceFrom: [bookOneId], declinedVoiceUuids: [bookOneUuid] }),
  );
}

/* Book Two's row is on an ordinary (never separated) uuid with a designed base; the linked
   Book One row has no uuid and holds the clone. A variant must keep the full voiceId scan. */
function seedOrdinaryUuidWithLinkedClone() {
  writeBook('Book One', 1, bookOneId, wren({ ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
  writeBook(
    'Book Two',
    2,
    bookTwoId,
    wren({ ...linkedToBookOne(), voiceUuid: 'w1', ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-w1' } } }),
  );
  mkdirSync(qwenDir(), { recursive: true });
  writeFileSync(join(qwenDir(), 'qwen-w1.pt'), Buffer.from('PT'));
  writeFileSync(join(qwenDir(), 'qwen-w1.json'), JSON.stringify({ instruct: 'persona', rev: 'r1' }));
}

describe('single design -- a declined row is gated after its uuid step (#4074)', () => {
  it('designs a declined row whose shared voice is cloned only on the declined book', async () => {
    seedLinked({});
    const u = await decline();
    const before = readRow('Book One');
    const res = await single();
    expect(res.status).toBe(200);
    const events = collectSse(res);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'designed')).toBeDefined();
    expect(readRow('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${u}`);
    expect(readRow('Book One')).toEqual(before);
  });

  it('designs a declined row the design itself separates (uuid step runs first)', async () => {
    seedUnseparatedDecline('u_shared');
    const before = readRow('Book One');
    const res = await single();
    expect(res.status).toBe(200);
    const designed = collectSse(res).find((e) => e.type === 'designed');
    expect(designed).toMatchObject({ separated: true });
    const row = readRow('Book Two');
    expect(row.voiceUuid).not.toBe('u_shared');
    expect(row.overrideTtsVoices.qwen.name).toBe(`qwen-${row.voiceUuid}`);
    expect(readRow('Book One')).toEqual(before);
  });

  it('a row with no decline marker is still refused early (409) for a clone on a linked book', async () => {
    seedLinked({});
    const res = await single();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clone_protected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a declined row's own cloned slot is still refused early (409)", async () => {
    seedLinked({}, { ttsEngine: 'coqui', overrideTtsVoices: coquiClone });
    await decline();
    fetchMock.mockClear();
    const res = await single();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clone_protected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a clone on another book's row that IS on the new uuid is refused with clone_protected and writes nothing", async () => {
    seedLinked({});
    const u = await decline();
    writeBook('Book Three', 3, bookThreeId, wren({ voiceUuid: u, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    const filesBefore = qwenFiles();
    const res = await single();
    expect(res.status).toBe(200);
    const events = collectSse(res);
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'clone_protected' });
    expect(events.find((e) => e.type === 'designed')).toBeUndefined();
    /* the refusal came before the landing: no key file, no staged leftovers, no slot */
    expect(existsSync(join(qwenDir(), `qwen-${u}.pt`))).toBe(false);
    expect(existsSync(join(qwenDir(), `qwen-${u}.json`))).toBe(false);
    expect(qwenFiles()).toEqual(filesBefore);
    expect(readRow('Book Two').overrideTtsVoices?.qwen).toBeUndefined();
    expect(readRow('Book Three').overrideTtsVoices.qwen).toBeUndefined();
  });

  it('a refused redesign over an existing base leaves its bytes and rev untouched', async () => {
    seedLinked({});
    const u = await decline();
    writeBook('Book Three', 3, bookThreeId, wren({ voiceUuid: u, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    mkdirSync(qwenDir(), { recursive: true });
    const pt = join(qwenDir(), `qwen-${u}.pt`);
    const json = join(qwenDir(), `qwen-${u}.json`);
    writeFileSync(pt, Buffer.from('OLD'));
    writeFileSync(json, JSON.stringify({ instruct: 'old', rev: 'r1' }));
    const filesBefore = qwenFiles();
    const jsonBefore = readFileSync(json, 'utf8');
    const res = await single();
    expect(collectSse(res).find((e) => e.type === 'error')).toMatchObject({ code: 'clone_protected' });
    expect(readFileSync(pt, 'utf8')).toBe('OLD');
    expect(readFileSync(json, 'utf8')).toBe(jsonBefore);
    expect(qwenFiles()).toEqual(filesBefore);
  });

  it('a bulk run after a refused single design is not freshness-skipped as designed', async () => {
    seedLinked({});
    const u = await decline();
    writeBook('Book Three', 3, bookThreeId, wren({ voiceUuid: u, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    await single();
    fetchMock.mockClear();
    const res = await bulk();
    expect(res.text).toContain('already_cloned');
    expect(res.text).toContain('"clonedSkips":[{"characterId":"wren"');
    expect(res.text).not.toContain('character_designed');
  });

  it('an emotion variant of a declined, separated row succeeds when the clone is only on the declined book', async () => {
    seedLinked({});
    const u = await decline();
    expect((await single()).status).toBe(200);
    const res = await variantRoute();
    expect(res.status).toBe(200);
    expect(readRow('Book Two').overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${u}__angry`);
  });

  it('an emotion variant of a row on an ordinary uuid is still refused (409) for a clone on a linked no-uuid row', async () => {
    seedOrdinaryUuidWithLinkedClone();
    const res = await variantRoute();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clone_protected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a refusal after the design separated the row tells the open tab: the error carries separated and the new uuid', async () => {
    seedUnseparatedDecline('u_shared');
    writeBook(
      'Book Three',
      3,
      bookThreeId,
      wren({
        voiceUuid: 'u_shared',
        ttsEngine: 'coqui',
        overrideTtsVoices: coquiClone,
        matchedFrom: { bookId: bookTwoId, characterId: 'wren', bookTitle: 'Book Two', confidence: 1 },
      }),
    );
    const res = await single();
    const events = collectSse(res);
    expect(events.find((e) => e.type === 'designed')).toBeUndefined();
    const error = events.find((e) => e.type === 'error');
    const moved = readRow('Book Two').voiceUuid;
    expect(moved).not.toBe('u_shared');
    expect(error).toMatchObject({ code: 'clone_protected', characterId: 'wren', separated: true, voiceUuid: moved });
  });

  it('a refusal on a row the design did not separate carries no separation', async () => {
    seedLinked({});
    const u = await decline();
    writeBook('Book Three', 3, bookThreeId, wren({ voiceUuid: u, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    const error = collectSse(await single()).find((e) => e.type === 'error');
    expect(error).toMatchObject({ code: 'clone_protected' });
    expect(error).not.toHaveProperty('separated');
    expect(error).not.toHaveProperty('voiceUuid');
  });

  it('an emotion variant of a separated row logs no residual-window warning for a clone on another uuid', async () => {
    seedLinked({});
    await decline();
    expect((await single()).status).toBe(200);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect((await variantRoute()).status).toBe(200);
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('residual-window'))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('an emotion variant is still refused (409) when the clone is on a row of the separated uuid', async () => {
    seedLinked({});
    const u = await decline();
    expect((await single()).status).toBe(200);
    writeBook('Book Three', 3, bookThreeId, wren({ voiceUuid: u, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    fetchMock.mockClear();
    const res = await variantRoute();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clone_protected');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bulk design -- a declined row is gated after its uuid step (#4074)', () => {
  it('designs a declined row whose shared voice is cloned only on the declined book', async () => {
    seedLinked({});
    const u = await decline();
    const before = readRow('Book One');
    const res = await bulk();
    expect(res.status).toBe(200);
    expect(res.text).toContain('character_designed');
    expect(res.text).not.toContain('already_cloned');
    expect(readRow('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${u}`);
    expect(readRow('Book One')).toEqual(before);
  });

  it('a row with no decline marker is still skipped early as already_cloned', async () => {
    seedLinked({});
    const res = await bulk();
    expect(res.text).toContain('already_cloned');
    expect(res.text).not.toContain('character_designed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a clone on another book's row that IS on the new uuid lands in clonedSkips and writes nothing", async () => {
    seedLinked({});
    const u = await decline();
    writeBook('Book Three', 3, bookThreeId, wren({ voiceUuid: u, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    const filesBefore = qwenFiles();
    const res = await bulk();
    expect(res.status).toBe(200);
    expect(res.text).toContain('already_cloned');
    expect(res.text).not.toContain('character_designed');
    expect(res.text).toContain('"clonedSkips":[{"characterId":"wren"');
    expect(existsSync(join(qwenDir(), `qwen-${u}.pt`))).toBe(false);
    expect(qwenFiles()).toEqual(filesBefore);
    expect(readRow('Book Two').overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('a refused bulk redesign over an existing base leaves its bytes and rev untouched', async () => {
    seedLinked({});
    const u = await decline();
    writeBook('Book Three', 3, bookThreeId, wren({ voiceUuid: u, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    mkdirSync(qwenDir(), { recursive: true });
    const json = join(qwenDir(), `qwen-${u}.json`);
    writeFileSync(join(qwenDir(), `qwen-${u}.pt`), Buffer.from('OLD'));
    writeFileSync(json, JSON.stringify({ instruct: 'old', rev: 'r1' }));
    const filesBefore = qwenFiles();
    const jsonBefore = readFileSync(json, 'utf8');
    const res = await bulk();
    expect(res.text).toContain('already_cloned');
    expect(readFileSync(join(qwenDir(), `qwen-${u}.pt`), 'utf8')).toBe('OLD');
    expect(readFileSync(json, 'utf8')).toBe(jsonBefore);
    expect(qwenFiles()).toEqual(filesBefore);
  });

  it('an emotion variant of a declined, separated row succeeds when the clone is only on the declined book', async () => {
    seedLinked({});
    const u = await decline();
    expect((await bulk()).text).toContain('character_designed');
    const res = await bulkVariant();
    expect(res.text).toContain('variant_designed');
    expect(res.text).not.toContain('already_cloned');
    expect(readRow('Book Two').overrideTtsVoices.qwen.variants.angry.name).toBe(`qwen-${u}__angry`);
  });

  it('an emotion variant of a row on an ordinary uuid is still skipped as already_cloned for a clone on a linked no-uuid row', async () => {
    seedOrdinaryUuidWithLinkedClone();
    const res = await bulkVariant();
    expect(res.text).toContain('already_cloned');
    expect(res.text).not.toContain('variant_designed');
  });

  it('an emotion variant is still skipped as already_cloned when the clone is on a row of the separated uuid', async () => {
    seedLinked({});
    const u = await decline();
    expect((await bulk()).text).toContain('character_designed');
    writeBook('Book Three', 3, bookThreeId, wren({ voiceUuid: u, ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    const res = await bulkVariant();
    expect(res.text).toContain('already_cloned');
    expect(res.text).not.toContain('variant_designed');
  });
});
