/* srv-17c — in-worker recovery when the sidecar dies mid-synth.
 *
 * As of C1 (Wave 3) the recovery loop lives INSIDE `synthesiseChapter`: a
 * mid-render recycle is recovered from the failed synth site via an injected
 * `onRecoverRecycle` hook (riding out the respawn on the readiness gate),
 * WITHOUT re-rendering the already-completed groups. `generation.ts` no longer
 * wraps the whole chapter in a `for (recovery…)` loop — it injects the hook
 * (wired to `ensureSidecarEngineReady`) and maps a thrown `RecycleStormError`
 * (budget exhausted) to `chapter_failed` via the outer catch.
 *
 * Because this suite mocks `synthesiseChapter` wholesale, it can no longer drive
 * the inner recovery — it pins the generation-side WIRING instead:
 *   1. the injected `onRecoverRecycle` drives `ensureSidecarEngineReady`, then
 *      the chapter COMPLETES (no `chapter_failed`);
 *   2. a thrown `RecycleStormError` → `chapter_failed` (budget exhausted);
 *   3. a non-transient error → `chapter_failed` (surfaces immediately);
 *   4. an abort thrown from the hook's wait (pause / displacement mid-recovery)
 *      → clean stop, no failure tick.
 * The resume-preservation proof (completed groups survive a recovery) now lives
 * in `synthesise-chapter.test.ts` (the C1 unit tests), where the real per-group
 * loop is exercised.
 *
 * Same fetch+SSE socket harness as generation-orphan-recovery.test.ts; we drive
 * a real http.Server and read the SSE body text to assert which ticks fired. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';

let synthesiseImpl: (args: unknown) => Promise<unknown>;
/* Swappable readiness-gate stub. Default resolves (the preload gate + each
   recovery wait become no-ops); a test can make a specific call throw to
   simulate a pause/displacement mid-wait. Counts calls so a test can assert the
   gate was polled between synth attempts. */
let ensureReadyImpl: () => Promise<void>;
let ensureReadyCalls = 0;

vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...actual,
    synthesiseChapter: (args: unknown) => synthesiseImpl(args),
  };
});
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  ensureSidecarEngineReady: () => {
    ensureReadyCalls += 1;
    return ensureReadyImpl();
  },
  /* Empty so the side-11 boundary-recycle check (the only SIDECAR_ENGINES
     consumer) is a no-op here — this suite drives a gemini run and asserts the
     srv-17c recovery, not the boundary recycle. */
  SIDECAR_ENGINES: new Set(),
}));
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: () => ({ synthesize: vi.fn() }),
  };
});

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Recycle Recovery Test';
const MANUSCRIPT_ID = 'm_recycle_recovery_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let server: import('node:http').Server;
let baseUrl: string;
let bookId: string;
let queuePath: string;
let readQueueFile: (path: string) => Promise<import('../workspace/queue-io.js').QueueFile>;
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

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'recycle-recovery-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.GEN_WORKERS = '1';

  const [{ generationRouter }, { makeBookId, queueJsonPath }, cacheModule, migrateModule] =
    await Promise.all([
      import('./generation.js'),
      import('../workspace/paths.js'),
      import('../store/analysis-cache.js'),
      import('../workspace/queue-migrate.js'),
    ]);
  readQueueFile = migrateModule.readQueueFile;
  writeQueueFile = migrateModule.writeQueueFile;

  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  queuePath = queueJsonPath();
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      author: AUTHOR,
      title: TITLE,
      series: SERIES,
      updatedAt: '2026-05-23T00:00:00.000Z',
      schema: 1,
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
  await rm(workspaceRoot, { recursive: true, force: true });
});

const ENTRY_ID = 'recycle-entry-1';

beforeEach(async () => {
  ensureReadyCalls = 0;
  ensureReadyImpl = async () => {};
  await writeQueueFile(queuePath, {
    entries: [
      {
        id: ENTRY_ID,
        bookId,
        chapterId: 1,
        scope: 'this',
        addedAt: '2026-05-23T00:00:00.000Z',
        status: 'in_progress',
        order: 0,
      },
    ],
    paused: false,
  });
});

/* Drive a queue-style single-chapter generation POST and resolve with the FULL
   SSE body text once the run ends (the route sends `idle` + closes every
   subscriber when the job finishes, so the reader naturally drains). */
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

async function readEntryStatus(): Promise<string | undefined> {
  const file = await readQueueFile(queuePath);
  return file.entries.find((e) => e.id === ENTRY_ID)?.status;
}

describe('srv-17c in-worker recovery after a mid-synth sidecar death', () => {
  it('drives ensureSidecarEngineReady from onRecoverRecycle, then completes (no chapter_failed)', async () => {
    let calls = 0;
    synthesiseImpl = async (args: any) => {
      calls += 1;
      if (calls === 1) {
        // First call: exercise the injected hook once (simulating an in-loop
        // recovery), then succeed — proving generation wires the hook to the gate.
        await args.onRecoverRecycle({ engine: 'kokoro', attempt: 1 });
        return okResult();
      }
      return okResult();
    };

    const body = await runChapter();

    expect(calls).toBe(1); // synthesiseChapter called ONCE (recovery is internal now)
    expect(ensureReadyCalls).toBeGreaterThanOrEqual(2); // preload gate + the hook's wait
    // C2 — the hook emits a visible "recovering" tick while it rides out the respawn.
    expect(body).toContain('"type":"chapter_recovering"');
    expect(body).toContain('"type":"chapter_complete"');
    expect(body).not.toContain('"type":"chapter_failed"');
    // srv-16 done-prune fired → the entry is gone (never left failed/in_progress).
    await vi.waitFor(async () => {
      expect(await readEntryStatus()).toBeUndefined();
    });
  }, 10_000);

  it('surfaces chapter_failed when synthesiseChapter throws RecycleStormError', async () => {
    const { RecycleStormError } = await import('../tts/synthesise-chapter.js');
    synthesiseImpl = async () => {
      throw new RecycleStormError(2, new Error('sidecar down'));
    };

    const body = await runChapter();

    expect(body).toContain('"type":"chapter_failed"');
    expect(body).not.toContain('"type":"chapter_complete"');
    // C3 — the chapter_failed frame carries the named recycle-storm code + a
    // concrete remediation (restart sidecar / lower concurrency / side-11),
    // NOT a generic vram-spill / unknown classification.
    expect(body).toContain('"errorCode":"recycle-storm"');
    expect(body).toMatch(/"remediation":"[^"]*(?:sidecar|concurrency|headroom)/i);
    /* C3 — on the QUEUE path one POST = one chapter, so the cross-chapter
       cascade can never escalate. A recycle-storm instead PAUSES the queue
       server-side, stopping a thrashing sidecar from grinding chapter after
       chapter. The harness seeds paused:false, so a true flag proves the
       storm set it. */
    await vi.waitFor(async () => {
      const file = await readQueueFile(queuePath);
      expect(file.paused).toBe(true);
    });
  }, 10_000);

  it('does NOT recover a non-transient error — surfaces immediately', async () => {
    synthesiseImpl = async () => {
      throw new Error('index out of range in self'); // XTTS tensor — fatal, not transient
    };

    const body = await runChapter();

    expect(body).toContain('"type":"chapter_failed"');
  }, 10_000);

  it('stops cleanly when the hook wait aborts (pause/displacement mid-recovery)', async () => {
    synthesiseImpl = async (args: any) => {
      // The hook's readiness wait throws AbortError (ensureReadyImpl below); that
      // must propagate out of synthesiseChapter as a clean stop, not a failure.
      await args.onRecoverRecycle({ engine: 'kokoro', attempt: 1 });
      return okResult();
    };
    /* First gate call (preload) resolves; the recovery wait throws AbortError —
       as if /pause fired while we were riding out the respawn. */
    ensureReadyImpl = async () => {
      if (ensureReadyCalls >= 2) throw new DOMException('preload aborted', 'AbortError');
    };

    const body = await runChapter();

    expect(body).not.toContain('"type":"chapter_failed"'); // abort = clean stop
    expect(body).not.toContain('"type":"chapter_complete"');
  }, 10_000);
});
