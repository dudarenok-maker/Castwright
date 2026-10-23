/* Per-chapter no-progress watchdog (2026-06-02 the drowning bell ch52 stall).
 *
 * A chapter that makes NO forward progress — no group/batch completes, and no
 * assembly milestone lands — for longer than CHAPTER_NO_PROGRESS_MS must be
 * aborted and recorded as a durable `generationError`, rather than hanging the
 * queue forever with no breadcrumb (the ch52 incident: no progress, no error,
 * no log). These pin:
 *   1. a synthesis-phase hang (synth never resolves, never ticks) → chapter_failed
 *      with a stall reason naming "synthesis", and `generationState:'failed'` +
 *      `generationError` persisted to state.json (so it rehydrates as Failed, not
 *      the misleading Queued);
 *   2. an assembly-phase hang (synth completes, encode never returns — the window
 *      with NO per-call timeout) → chapter_failed naming "assembly";
 *   3. a normally-progressing chapter that ticks within the window → COMPLETES
 *      and is NOT aborted, proving each tick resets the timer (no false-trip on a
 *      legitimately slow chapter).
 *
 * Same fetch+SSE socket harness as generation-recycle-recovery.test.ts. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';

let synthesiseImpl: (args: {
  onGroupComplete?: (e: { group: { characterId: string }; totalGroups: number; completed: number }) => void;
}) => Promise<unknown>;
/* null → the real encoder runs (tests 1 + 3); set to a hanging impl for the
   assembly-stall test (2). */
let encodeImpl: (() => Promise<Buffer>) | null = null;

vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...actual,
    synthesiseChapter: (args: unknown) => synthesiseImpl(args as never),
  };
});
/* #3711 review: `throwAfterChild` makes a chapter throw AFTER its scoring child is pushed (the
   throughput rollup throws, then the failure classifier throws too), so the error escapes the
   registered render job's fn; `scoringGate` holds the scoring child's `runBookJob` registration. */
let throwAfterChild = false;
let scoringGate: Promise<void> | null = null;
vi.mock('../tts/generation-stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/generation-stats.js')>();
  return {
    ...actual,
    recordChapterThroughput: (...a: Parameters<typeof actual.recordChapterThroughput>) => {
      if (throwAfterChild) throw new Error('rollup exploded');
      return actual.recordChapterThroughput(...a);
    },
  };
});
vi.mock('./generation-error.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./generation-error.js')>();
  return {
    ...actual,
    describeSynthesisError: (...a: Parameters<typeof actual.describeSynthesisError>) => {
      if (throwAfterChild) throw new Error('classifier exploded');
      return actual.describeSynthesisError(...a);
    },
  };
});
vi.mock('../audio/render-integrity/aggregate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audio/render-integrity/aggregate.js')>()),
  scoreBook: async () => ({ usedQwenTiers: { keep06: false, keep17: false }, mismatchCount: 0 }),
}));
vi.mock('../workspace/book-jobs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/book-jobs.js')>();
  return {
    ...actual,
    runBookJob: (...a: Parameters<typeof actual.runBookJob>) =>
      a[1] === 'scoring' && scoringGate ? scoringGate.then(() => actual.runBookJob(...a)) : actual.runBookJob(...a),
  };
});
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  ensureSidecarEngineReady: async () => {},
  reconcileResidentQwenTiers: async () => undefined,
  SIDECAR_ENGINES: new Set(),
}));
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: () => ({ synthesize: vi.fn() }),
  };
});
vi.mock('../tts/mp3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/mp3.js')>();
  return {
    ...actual,
    encodePcmToAudio: (pcm: unknown, sr: unknown, opts: unknown) =>
      encodeImpl
        ? encodeImpl()
        : actual.encodePcmToAudio(pcm as Buffer, sr as number, opts as never),
  };
});
const forceSidecarRecycleMock = vi.fn(async (..._args: unknown[]) => true);
vi.mock('../tts/sidecar-supervisor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/sidecar-supervisor.js')>();
  return {
    ...actual,
    forceSidecarRecycle: (...args: unknown[]) => forceSidecarRecycleMock(...args),
  };
});

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Stall Watchdog Test';
const MANUSCRIPT_ID = 'm_stall_watchdog_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let server: import('node:http').Server;
let baseUrl: string;
let bookId: string;
let queuePath: string;
let statePath: string;
let writeQueueFile: (
  path: string,
  file: import('../workspace/queue-io.js').QueueFile,
) => Promise<void>;

function okResult() {
  return {
    pcm: Buffer.alloc(2),
    sampleRate: 24000,
    durationSec: 1,
    segments: [
      {
        characterId: 'narrator',
        voiceName: 'af_alloy',
        sampleStart: 0,
        sampleEnd: 1,
        sentenceIds: [1],
      },
    ],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/* A promise that never settles — stands in for a wedged sidecar synth or a
   hung ffmpeg encode that ignores the abort signal. */
const hangForever = () => new Promise<never>(() => {});

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'stall-watchdog-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.GEN_WORKERS = '1';

  /* #2083 — sequential awaits, not Promise.all: a Promise.all of dynamic
     imports here races the async vi.mock factories above (module-under-test can
     receive the real binding instead of the mock). Measured latent for this
     file — 0 failures in 14 runs (#2083's own survey) — not the live
     ~2-in-5 rate, which belongs to voices.test.ts, a different file already
     fixed under #2046. */
  const { generationRouter } = await import('./generation.js');
  const { makeBookId, queueJsonPath } = await import('../workspace/paths.js');
  const cacheModule = await import('../store/analysis-cache.js');
  const migrateModule = await import('../workspace/queue-migrate.js');
  writeQueueFile = migrateModule.writeQueueFile;

  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  queuePath = queueJsonPath();
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  statePath = join(bookDir, '.audiobook', 'state.json');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });

  writeFileSync(
    statePath,
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      author: AUTHOR,
      title: TITLE,
      series: SERIES,
      updatedAt: '2026-06-02T00:00:00.000Z',
      schema: 1,
      language: 'en',
      chapters: [{ id: 1, title: 'Chapter 1', slug: 'chapter-1' }],
    }),
  );
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [{ id: 'narrator', name: 'Narrator', voiceId: 'af_alloy' }],
    }),
  );

  await cacheModule.saveAnalysisCache(MANUSCRIPT_ID, {
    chapters: {
      1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }],
    },
  });

  app = express();
  app.use(express.json());
  app.use('/api/books', generationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { rm } = await import('node:fs/promises');
  /* Best-effort: these tests intentionally leave never-resolving synth/encode
     promises pending (the wedge we're simulating), so on Windows the temp dir
     can still be busy at teardown (ENOTEMPTY). Retry once, then ignore — leaking
     a tmp dir is harmless and must not red the suite. */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await rm(workspaceRoot, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

const ENTRY_ID = 'stall-entry-1';

beforeEach(async () => {
  forceSidecarRecycleMock.mockClear();
  encodeImpl = null;
  throwAfterChild = false;
  scoringGate = null;
  vi.restoreAllMocks();
  for (const f of readdirSync(join(bookDir, 'audio'))) rmSync(join(bookDir, 'audio', f), { force: true, recursive: true });
  /* Reset the persisted state so a prior test's failure doesn't leak in. */
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.chapters = [{ id: 1, title: 'Chapter 1', slug: 'chapter-1' }];
  writeFileSync(statePath, JSON.stringify(state));
  await writeQueueFile(queuePath, {
    entries: [
      {
        id: ENTRY_ID,
        bookId,
        chapterId: 1,
        scope: 'this',
        addedAt: '2026-06-02T00:00:00.000Z',
        status: 'in_progress',
        order: 0,
      },
    ],
    paused: false,
  });
});

function runChapter(): Promise<string> {
  return fetch(`${baseUrl}/api/books/${bookId}/generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelKey: 'gemini-2.5-flash',
      chapterIds: [1],
      force: true,
      queueEntryId: ENTRY_ID,
    }),
  }).then((res) => res.text());
}

function persistedChapter(): { generationState?: string; generationError?: string } {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  return state.chapters.find((c: { id: number }) => c.id === 1) ?? {};
}

describe('per-chapter no-progress watchdog', () => {
  it('aborts + records a generationError when synthesis makes no progress', async () => {
    process.env.CHAPTER_NO_PROGRESS_MS = '250';
    synthesiseImpl = () => hangForever(); // wedged synth, no ticks ever

    const body = await runChapter();

    expect(body).toContain('"type":"chapter_failed"');
    expect(body).not.toContain('"type":"chapter_complete"');
    expect(body).toContain('no progress');
    expect(body).toContain('synthesis');

    const ch = persistedChapter();
    expect(ch.generationState).toBe('failed');
    expect(ch.generationError).toMatch(/no progress/i);
    expect(ch.generationError).toMatch(/synthesis/i);
    // srv-50: a synthesis-phase stall is strong evidence the sidecar is
    // wedged — force a recycle instead of only failing the chapter.
    expect(forceSidecarRecycleMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('aborts + records a stall when ASSEMBLY hangs (the window with no per-call timeout)', async () => {
    process.env.CHAPTER_NO_PROGRESS_MS = '250';
    synthesiseImpl = async () => okResult(); // synth completes fast
    encodeImpl = () => hangForever(); // ffmpeg/encode wedges → assembly never finishes

    const body = await runChapter();

    expect(body).toContain('"type":"chapter_failed"');
    expect(body).not.toContain('"type":"chapter_complete"');
    expect(body).toContain('assembly');

    const ch = persistedChapter();
    expect(ch.generationState).toBe('failed');
    expect(ch.generationError).toMatch(/assembly/i);
    // srv-50: an assembly-phase stall is not a sidecar problem (it's a
    // wedged ffmpeg/encode) — must NOT force-recycle.
    expect(forceSidecarRecycleMock).not.toHaveBeenCalled();
  }, 10_000);

  it('does NOT abort a chapter that keeps ticking within the window', async () => {
    /* Generous window; synth ticks several times with sub-window gaps, then
       completes. Each tick must reset the timer, so the chapter renders. */
    process.env.CHAPTER_NO_PROGRESS_MS = '1500';
    synthesiseImpl = async (args) => {
      for (let i = 1; i <= 3; i += 1) {
        await sleep(150);
        args.onGroupComplete?.({
          group: { characterId: 'narrator' },
          totalGroups: 3,
          completed: i,
        });
      }
      return okResult();
    };

    const body = await runChapter();

    expect(body).toContain('"type":"chapter_complete"');
    expect(body).not.toContain('"type":"chapter_failed"');
    expect(body).not.toContain('no progress');
  }, 10_000);

  it('an abandoned chapter whose abort-ignoring synth resolves late writes nothing (#3711)', async () => {
    process.env.CHAPTER_NO_PROGRESS_MS = '250';
    let releaseSynth!: () => void;
    synthesiseImpl = () =>
      new Promise((resolve) => {
        releaseSynth = () => resolve(okResult()); // ignores the abort signal entirely
      });
    const body = await runChapter();
    expect(body).toContain('"type":"chapter_failed"');
    const { bookJobKinds } = await import('../workspace/book-op-lock.js');
    expect(bookJobKinds(bookId)).toEqual([]); // the render token is released

    releaseSynth(); // the zombie body resumes after the token is gone
    await sleep(1500);
    expect(readdirSync(join(bookDir, 'audio'))).toEqual([]);
    expect(persistedChapter().generationState).toBe('failed');
  }, 15_000);

  it('a render whose fn throws after pushing a scoring child still waits for that child (#3711)', async () => {
    process.env.CHAPTER_NO_PROGRESS_MS = '0';
    synthesiseImpl = async () => okResult();
    throwAfterChild = true;
    const configModule = await import('../config/resolver.js');
    const realConfigValue = configModule.configValue;
    vi.spyOn(configModule, 'configValue').mockImplementation(((key: string) =>
      key === 'qa.speaker.enabled' ? true : realConfigValue(key as never)) as typeof realConfigValue);
    let openGate!: () => void;
    scoringGate = new Promise<void>((r) => (openGate = r));
    const { bookJobKinds } = await import('../workspace/book-op-lock.js');
    const run = runChapter();
    await sleep(1200);
    expect(bookJobKinds(bookId)).toContain('render'); // held: the child has not settled
    openGate();
    const body = await run;
    await vi.waitFor(() => expect(bookJobKinds(bookId)).toEqual([]));
    /* The callback threw: the stream still gets a curated terminal frame (never the raw
       message) instead of the socket being torn down by an unhandled `registered.done`. */
    expect(body).toContain('"type":"chapter_failed"');
    expect(body).toContain('"type":"idle"');
    expect(body).not.toContain('exploded');
  }, 15_000);
});

describe('drainChildren (#3711)', () => {
  it('also waits for children pushed while earlier ones were being awaited', async () => {
    const { drainChildren } = await import('./generation.js');
    const children: Promise<unknown>[] = [];
    let lateSettled = false;
    children.push(
      sleep(50).then(() => {
        children.push(sleep(50).then(() => (lateSettled = true)));
      }),
    );
    await drainChildren({ children } as never);
    expect(lateSettled).toBe(true);
  });
});
