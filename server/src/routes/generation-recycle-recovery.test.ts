/* srv-17c — in-worker recovery when the sidecar dies mid-synth.
 *
 * A host-RAM recycle (plan 143), a crash, or an OOM drops the in-flight
 * `/synthesize` connection (or, while a recycle drains, returns a non-poisoned
 * 503). Both surface as a `transient` error once `withTtsRetry`'s short budget
 * exhausts. The srv-17b readiness gate only protects the NEXT chapter; the one
 * already mid-synth would otherwise be classified fatal ("sidecar not
 * reachable") → `chapter_failed` + run abort, recovered only by a later manual
 * Retry / boot sweep (the ch36/ch46 drops).
 *
 * These pin the recovery loop in `processOneChapter`:
 *   1. transient-then-success → chapter COMPLETES (srv-16 done-prune), NO
 *      `chapter_failed`, and the readiness gate was polled between attempts;
 *   2. transient on every attempt → after MAX_RECYCLE_RECOVERIES it falls
 *      through to the unchanged `chapter_failed` path (a truly-dead sidecar
 *      still surfaces, never an infinite loop);
 *   3. a non-transient error → NO recovery loop (straight to failure), proving
 *      poison / fatal-classifier errors still surface immediately;
 *   4. an abort mid-wait (pause / displacement) → clean stop, no failure tick.
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

/* A transient sidecar-down error — exactly what `sidecar.ts:post()` annotates on
   a connection drop (and what `throwForResponse` annotates on a non-poisoned
   5xx). `withTtsRetry` has already exhausted its short budget by the time this
   reaches `processOneChapter`. */
function transientSidecarDown(): Error {
  return Object.assign(new Error('Local TTS sidecar not reachable at http://x. (fetch failed)'), {
    transient: true as const,
    cause: 'network' as const,
  });
}

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
  it('re-renders the chapter after a transient sidecar-down — completes, no chapter_failed', async () => {
    let calls = 0;
    synthesiseImpl = async () => {
      calls += 1;
      if (calls === 1) throw transientSidecarDown(); // recycle kills the first attempt
      return okResult(); // sidecar respawned → second attempt succeeds
    };

    const body = await runChapter();

    expect(calls).toBe(2); // failed once, recovered once
    expect(body).toContain('"type":"chapter_complete"');
    expect(body).not.toContain('"type":"chapter_failed"');
    // Preload gate (1) + one recovery wait (1) = the gate was polled between attempts.
    expect(ensureReadyCalls).toBeGreaterThanOrEqual(2);
    // srv-16 done-prune fired → the entry is gone (never left failed/in_progress).
    await vi.waitFor(async () => {
      expect(await readEntryStatus()).toBeUndefined();
    });
  }, 10_000);

  it('falls through to chapter_failed once the recovery budget is exhausted', async () => {
    let calls = 0;
    synthesiseImpl = async () => {
      calls += 1;
      throw transientSidecarDown(); // sidecar never comes back
    };

    const body = await runChapter();

    // 1 primary + MAX_RECYCLE_RECOVERIES (2) re-attempts = 3 synth calls, then fail.
    expect(calls).toBe(3);
    expect(body).toContain('"type":"chapter_failed"');
    expect(body).not.toContain('"type":"chapter_complete"');
  }, 10_000);

  it('does NOT recover a non-transient error — surfaces immediately', async () => {
    let calls = 0;
    synthesiseImpl = async () => {
      calls += 1;
      throw new Error('index out of range in self'); // XTTS tensor — fatal, not transient
    };

    const body = await runChapter();

    expect(calls).toBe(1); // no recovery loop for a non-transient error
    expect(body).toContain('"type":"chapter_failed"');
  }, 10_000);

  it('stops cleanly (no chapter_failed) when the run is aborted during the recovery wait', async () => {
    let calls = 0;
    synthesiseImpl = async () => {
      calls += 1;
      throw transientSidecarDown();
    };
    /* First gate call (preload) resolves; the recovery wait throws AbortError —
       as if /pause fired while we were riding out the respawn. */
    ensureReadyImpl = async () => {
      if (ensureReadyCalls >= 2) throw new DOMException('preload aborted', 'AbortError');
    };

    const body = await runChapter();

    expect(calls).toBe(1); // failed once, then the recovery wait aborted
    expect(body).not.toContain('"type":"chapter_failed"'); // abort is a clean stop
    expect(body).not.toContain('"type":"chapter_complete"');
  }, 10_000);
});
