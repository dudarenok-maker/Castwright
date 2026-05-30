/* srv-12 — orphan recovery on SSE last-subscriber disconnect.
 *
 * When the LAST subscriber to a generation SSE closes BEFORE the frontend
 * POSTs /complete, the in-flight chapter's queue entry is an orphan (the
 * watcher vanished mid-run). The route then (a) resets that entry
 * `in_progress`→`queued` so the dispatcher re-claims it, and (b) aborts the
 * now-unwatched synthesis to free the GPU.
 *
 * The happy path POSTs /complete BEFORE the SSE closes, so a clean
 * disconnect-after-completion must NOT reset anything.
 *
 * Unlike the supertest-based suites, this test needs a REAL socket it can tear
 * down mid-stream, so it boots an http.Server and drives it with node's
 * http.request — `clientReq.destroy()` triggers the route's `req.on('close')`
 * while the synth is still blocked (job still registered, entry still
 * in_progress). */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';

let synthesiseImpl: (args: unknown) => Promise<unknown>;
vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  /* Spread the real module so the route's other imports from here
     (toVoiceLike + buildHintFromCast, pure transforms used to build the
     per-character snapshot) keep working; only synthesiseChapter is stubbed. */
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return {
    ...actual,
    synthesiseChapter: (args: unknown) => synthesiseImpl(args),
  };
});
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return {
    ...actual,
    selectTtsProvider: () => ({ synthesize: vi.fn() }),
  };
});

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Orphan Recovery Test';
const MANUSCRIPT_ID = 'm_orphan_recovery_test';

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

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'orphan-recovery-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.GEN_WORKERS = '1';

  const [
    { generationRouter },
    { makeBookId, queueJsonPath },
    cacheModule,
    migrateModule,
  ] = await Promise.all([
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

const ENTRY_ID = 'orphan-entry-1';

beforeEach(async () => {
  /* Seed a queue with the chapter-1 entry already in_progress (the dispatcher
     POSTs /start on claim, so a live run's entry is in_progress on disk). */
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

/* Open the SSE via fetch + AbortController so aborting mid-stream reliably
   tears the socket down (which fires the route's server-side req.on('close')).
   Resolves once the response headers have arrived (synth is blocked by then,
   so the job is registered + the entry is in_progress). `destroy()` aborts the
   fetch; `done` resolves once the body stream errors/ends. */
function openStream(): Promise<{ destroy: () => void; done: Promise<void> }> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const drain = fetch(`${baseUrl}/api/books/${bookId}/generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelKey: 'gemini-2.5-flash',
        chapterIds: [1],
        force: true,
        queueEntryId: ENTRY_ID,
      }),
      signal: controller.signal,
    })
      .then(async (res) => {
        settled = true;
        const reader = res.body!.getReader();
        const done = (async () => {
          try {
            for (;;) {
              const { done: d } = await reader.read();
              if (d) break;
            }
          } catch {
            /* abort surfaces here — that's the disconnect we're testing. */
          }
        })();
        resolve({ destroy: () => controller.abort(), done });
      })
      .catch((err) => {
        if (!settled) reject(err);
      });
    void drain;
    setTimeout(() => {
      if (!settled) reject(new Error('stream never started'));
    }, 4000).unref();
  });
}

async function readEntryStatus(): Promise<string | undefined> {
  const file = await readQueueFile(queuePath);
  return file.entries.find((e) => e.id === ENTRY_ID)?.status;
}

describe('srv-12 orphan recovery on SSE last-subscriber disconnect', () => {
  it('resets the in_progress entry to queued AND aborts synth when the last subscriber disconnects mid-run', async () => {
    let resolveStarted: () => void;
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });
    let aborted = false;
    /* Synth blocks until the signal aborts — proving the route aborted it. */
    synthesiseImpl = (args: unknown) => {
      const signal = (args as { signal?: AbortSignal }).signal;
      return new Promise((_resolve, reject) => {
        const fail = () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        };
        if (signal?.aborted) return fail();
        signal?.addEventListener('abort', fail, { once: true });
        resolveStarted();
      });
    };

    const stream = await openStream();
    await started; // synth is now blocked, job registered, entry in_progress
    stream.destroy(); // simulate the last subscriber vanishing
    await stream.done; // server-side req.on('close') has fired

    /* Give the async reset + abort a tick to settle. */
    await vi.waitFor(async () => {
      expect(await readEntryStatus()).toBe('queued');
    });
    expect(aborted).toBe(true);
  }, 10_000);

  it('done-prunes the entry server-side on a completed run (srv-16) — and never resets it to queued', async () => {
    /* Synth resolves immediately → the loop runs to completion and
       deregisterJob fires BEFORE we tear the socket down. Two things must hold:
       (1) srv-16 — the SERVER marks the queue entry done (pruned) right after
       the chapter renders, so completion no longer depends on the frontend
       POSTing /complete (a hard kill / closed tab used to leave it stuck
       in_progress forever); (2) srv-12 — orphan recovery must NOT reset it to
       `queued` (the close handler's registration guard skips the deregistered,
       completed job). So the entry ends up GONE, and specifically not queued. */
    synthesiseImpl = async () => ({
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
    });

    const stream = await openStream();
    /* Wait for the run to fully drain (idle + response close) before destroying. */
    await stream.done;
    stream.destroy();

    /* srv-16: the server-side completion removes the entry on render. Give the
       async (serialized) mutation a tick, then assert it's gone — and was never
       flipped to `queued` by orphan recovery. */
    await vi.waitFor(async () => {
      expect(await readEntryStatus()).toBeUndefined();
    });
  }, 10_000);
});

describe('srv-16 server completion when the target chapter is already on disk', () => {
  it('done-prunes a queue entry whose chapter audio already exists, without re-rendering', async () => {
    /* Simulates the restart-after-crash case: chapter 1 was rendered before the
       crash (audio on disk) and its queue entry was re-queued then re-claimed
       (in_progress, seeded by beforeEach). A non-force generation POST for it
       finds the audio present → renders nothing → no chapter_complete → Hook 1
       can't fire. Hook 2 must complete the entry anyway, or it loops
       in_progress↔queued forever across boots. */
    writeFileSync(join(bookDir, 'audio', 'chapter-1.mp3'), Buffer.from([0, 0]));
    let synthCalled = false;
    synthesiseImpl = async () => {
      synthCalled = true;
      return { pcm: Buffer.alloc(2), sampleRate: 24000, durationSec: 1, segments: [] };
    };

    /* No `force` → the audio-exists check excludes the chapter from targets. We
       don't need to drain the SSE; Hook 2 runs server-side as the request is
       handled. Abort once the entry is gone. */
    const controller = new AbortController();
    void fetch(`${baseUrl}/api/books/${bookId}/generation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelKey: 'gemini-2.5-flash', chapterIds: [1], queueEntryId: ENTRY_ID }),
      signal: controller.signal,
    }).catch(() => undefined);

    await vi.waitFor(async () => {
      expect(await readEntryStatus()).toBeUndefined();
    });
    controller.abort();
    expect(synthCalled).toBe(false); // never rendered — audio already on disk
  }, 10_000);
});
