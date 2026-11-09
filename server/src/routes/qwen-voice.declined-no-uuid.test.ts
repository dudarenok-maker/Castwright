/* #4067 — a row with NO voiceUuid that carries a decline marker has its first design
   separate it (mustSeparateOnDesign: a marker and no uuid always separates). The
   server renames its qwen slot to `qwen-<new>` and drops its variants, but a client
   that only sees `undefined -> uuid` cannot tell that from a plain first mint (which
   keeps the legacy name), so the single-design events say so: `separated: true`.

   Reachability, stated narrowly: the real seedReuseGuardsFromPriorCast (the #3965
   union for an id-drifted speaker whose name two prior rows share) does leave
   markers on a row with no uuid (the first case below). It builds ONLY the markers:
   the qwen slot, its `angry` variant and `voiceId` are written onto the fixture row
   by hand, and no merged code path is shown to produce that slot beside the markers
   (the series linker, series-reuse-link.ts, is the plausible one, unverified). The
   slot is what makes `separated` change the client's result. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
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
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {
    code = 'GPU_BUSY';
  },
}));
vi.mock('../gpu/sidecar-vram-sample.js', () => ({ maybeSampleSidecarEngine: async () => {} }));
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));
/* Runs once, just before a separation takes its book-ops (the window between the
   lock-free pre-check and the locked re-decision). */
const beforeLocks = vi.hoisted(() => ({ fn: null as (() => void) | null }));
vi.mock('../workspace/book-op-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/book-op-lock.js')>();
  const withBookOps: typeof actual.withBookOps = (ids, fn, opts) => {
    if (beforeLocks.fn) {
      const run = beforeLocks.fn;
      beforeLocks.fn = null;
      run();
    }
    return actual.withBookOps(ids, fn, opts);
  };
  return { ...actual, withBookOps };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (title: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, title);
const castPath = (title: string) => join(bookDir(title), '.audiobook', 'cast.json');
const readRow = (title: string): Record<string, any> =>
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
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [row] }));
}

/* Book Two's row as the merge leaves it: markers unioned from two same-name prior
   rows, nothing else copied (no voiceUuid), the fresh row's own legacy-name slot. */
async function declinedRowWithNoUuid(): Promise<Record<string, unknown>> {
  const { seedReuseGuardsFromPriorCast } = await import('../store/merge-analysis-cast.js');
  const prior = [
    { id: 'wren-a', name: 'Wren', declinedVoiceFrom: [bookOneId], declinedVoiceUuids: ['u_shared'] },
    { id: 'wren-b', name: 'Wren', declinedVoiceFrom: [bookOneId] },
  ];
  const fresh: Record<string, unknown>[] = [
    {
      id: 'wren',
      name: 'Wren',
      role: 'supporting',
      color: 'sky',
      voiceId: 'v_wren',
      voiceStyle: 'a bright voice',
      evidence: [{ quote: '"Hello there."' }],
      overrideTtsVoices: { qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } } },
    },
  ];
  seedReuseGuardsFromPriorCast(prior as never, fresh as never);
  return fresh[0];
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-declined-no-uuid-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-declined-no-uuid-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const { singleDesignRouter } = await import('./single-design.js');
  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOneId = makeBookId(AUTHOR, SERIES, 'Book One');
  bookTwoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  app = express();
  app.use(express.json());
  app.use('/api/books', singleDesignRouter);
  app.use('/api/books', castDeclineVoiceLinkRouter);
});

beforeEach(() => {
  beforeLocks.fn = null;
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

const stream = (preview: boolean) =>
  request(app)
    .post(`/api/books/${bookTwoId}/cast/wren/design-voice/stream`)
    .send({ persona: 'a warm voice', sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, preview });

async function seed(): Promise<void> {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  writeBook('Book One', 1, bookOneId, { id: 'wren', name: 'Wren', role: 'supporting', color: 'sky', voiceId: 'v_wren', voiceUuid: 'u_shared' });
  writeBook('Book Two', 2, bookTwoId, await declinedRowWithNoUuid());
}

describe('a declined row with no voiceUuid (#4067)', () => {
  it('is reachable: the merge union leaves markers on a row that has no voiceUuid', async () => {
    await seed();
    const row = readRow('Book Two');
    expect(row.voiceUuid).toBeUndefined();
    expect(row.declinedVoiceFrom).toEqual([bookOneId]);
    expect(row.declinedVoiceUuids).toEqual(['u_shared']);
  });

  it('preview_ready says it was separated: the slot was renamed and the variants dropped on disk', async () => {
    await seed();
    const res = await stream(true);
    const ready = collectSse(res).find((e) => e.type === 'preview_ready');
    const row = readRow('Book Two');
    expect(row.voiceUuid).toEqual(expect.any(String));
    expect(ready).toMatchObject({ voiceUuid: row.voiceUuid, separated: true });
    expect(row.overrideTtsVoices.qwen.name).toBe(`qwen-${row.voiceUuid}`);
    expect(row.overrideTtsVoices.qwen.variants).toBeUndefined();
  });

  it('designed says it was separated too', async () => {
    await seed();
    const res = await stream(false);
    const designed = collectSse(res).find((e) => e.type === 'designed');
    const row = readRow('Book Two');
    expect(designed).toMatchObject({ voiceUuid: row.voiceUuid, separated: true });
  });

  it('a plain first mint (no marker) is not reported as separated', async () => {
    await seed();
    const row = readRow('Book Two');
    delete row.declinedVoiceFrom;
    delete row.declinedVoiceUuids;
    writeFileSync(castPath('Book Two'), JSON.stringify({ characters: [row] }));
    const res = await stream(true);
    const ready = collectSse(res).find((e) => e.type === 'preview_ready');
    expect(ready?.voiceUuid).toEqual(expect.any(String));
    expect(ready?.separated).toBe(false);
  });
});

/* Pass 4, S1 — a "Don't reuse" from another tab DURING the render separates the row
   first; the landing follows it (the P11-5 watcher), and the design's own uuid step
   then finds nothing left to separate. The event still has to say the row was
   separated, or a stale tab's first-mint mirror keeps the old name and variants. */
describe('a decline that lands during the render (#4067, pass 4 S1)', () => {
  const legacyLinked = (extra: Record<string, unknown> = {}) => ({
    id: 'wren',
    name: 'Wren',
    role: 'supporting',
    color: 'sky',
    voiceId: 'v_wren',
    voiceStyle: 'a bright voice',
    evidence: [{ quote: '"Hello there."' }],
    overrideTtsVoices: { qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } } },
    ...extra,
  });

  async function declineDuringRender(preview: boolean) {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', 1, bookOneId, legacyLinked());
    writeBook(
      'Book Two',
      2,
      bookTwoId,
      legacyLinked({ matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } }),
    );
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_wren.pt'), Buffer.from('ORIG'));
    const base = fetchMock.getMockImplementation()!;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (entered = r));
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    fetchMock.mockImplementation(async (url: unknown, init: { body?: string } | undefined) => {
      if (first && !String(url).includes('evict')) {
        first = false;
        entered();
        await held;
      }
      return base(url, init);
    });
    const streaming = Promise.resolve(stream(preview));
    await reached;
    const declined = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/decline-voice-link`)
      .send({ fromBookId: bookOneId });
    expect(declined.status).toBe(200);
    release();
    return { events: collectSse(await streaming), declined: declined.body };
  }

  it('preview_ready carries separated: true', async () => {
    const { events, declined } = await declineDuringRender(true);
    const ready = events.find((e) => e.type === 'preview_ready');
    expect(declined.separated).toBe(true);
    expect(ready).toMatchObject({ voiceUuid: declined.voiceUuid, separated: true });
  });

  it('designed carries separated: true', async () => {
    const { events, declined } = await declineDuringRender(false);
    const designed = events.find((e) => e.type === 'designed');
    expect(designed).toMatchObject({ voiceUuid: declined.voiceUuid, separated: true });
  });
});

/* Pass 4, minor 2 — `separated` is the LOCKED re-decision's answer, not the lock-free
   pre-check's. A row with a uuid and a marker, with an outside holder that leaves
   between the two, is not separated: reporting it so would make the client fork a
   row the server kept, and the next PUT would delete its variants on disk. */
describe('a holder that leaves before the locks (#4067, pass 4)', () => {
  it('reports separated: false and keeps the uuid, name and variants', async () => {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    const wren = {
      id: 'wren',
      name: 'Wren',
      role: 'supporting',
      color: 'sky',
      voiceId: 'v_wren',
      voiceUuid: 'u_shared',
      voiceStyle: 'a bright voice',
      evidence: [{ quote: '"Hello there."' }],
    };
    writeBook('Book One', 1, bookOneId, wren);
    writeBook('Book Two', 2, bookTwoId, {
      ...wren,
      declinedVoiceFrom: [bookOneId],
      overrideTtsVoices: { qwen: { name: 'qwen-u_shared', variants: { angry: { name: 'qwen-u_shared__angry' } } } },
    });
    beforeLocks.fn = () => writeBook('Book One', 1, bookOneId, { ...wren, voiceId: 'v_other', voiceUuid: 'u_other' });
    const res = await stream(true);
    expect(beforeLocks.fn).toBeNull(); // the window was hit
    const ready = collectSse(res).find((e) => e.type === 'preview_ready');
    expect(ready).toMatchObject({ voiceUuid: 'u_shared', separated: false });
    expect(readRow('Book Two').voiceUuid).toBe('u_shared');
  });
});

/* Pass 4, S2 (pre-existing, #4067's class) — the declined book is untouched by the
   decliner's first design. "Don't reuse" separates Two onto U'; Two's first design
   then writes its slot, and applyOverrideToCastFiles' walk used to write `qwen-U'`
   onto Book One's legacy row too (the #3992 guard only skipped a row with a
   DIFFERENT uuid), pinning One to a key with no file. */
describe("the decliner's first design leaves the declined book's legacy row alone (#4067, pass 4 S2)", () => {
  const plain = (extra: Record<string, unknown> = {}) => ({
    id: 'wren',
    name: 'Wren',
    role: 'supporting',
    color: 'sky',
    voiceId: 'v_wren',
    voiceStyle: 'a bright voice',
    evidence: [{ quote: '"Hello there."' }],
    ...extra,
  });

  async function seedDeclined() {
    rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
    rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
    writeBook('Book One', 1, bookOneId, plain());
    writeBook(
      'Book Two',
      2,
      bookTwoId,
      plain({ matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } }),
    );
    const declined = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/decline-voice-link`)
      .send({ fromBookId: bookOneId });
    expect(declined.status).toBe(200);
    return declined.body.voiceUuid as string;
  }

  it('single design: Book One keeps no slot, no engine pin, no uuid', async () => {
    const u = await seedDeclined();
    const before = readRow('Book One');
    const res = await stream(false);
    expect(collectSse(res).find((e) => e.type === 'designed')).toMatchObject({ voiceUuid: u });
    expect(readRow('Book Two').overrideTtsVoices.qwen.name).toBe(`qwen-${u}`);
    expect(readRow('Book One')).toEqual(before);
  });
});
