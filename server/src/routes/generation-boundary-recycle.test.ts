/* side-11 item 2 — recycle the sidecar at the chapter boundary.
 *
 * Once the sidecar's committed-private memory crosses the SOFT threshold it
 * raises `recycle_pending` in /health (WITHOUT exiting). The generation worker
 * reads that off /health at each chapter boundary and, for a sidecar engine,
 * POSTs /recycle to trigger a CLEAN recycle (drain -> respawn) before the next
 * chapter — earlier than the hard watchdog and never mid-chapter.
 *
 * These pin the boundary check in the chapter loop:
 *   1. recycle_pending:true + a sidecar engine -> POST /recycle fires after the
 *      chapter completes (chapter_complete, no chapter_failed);
 *   2. recycle_pending:false -> /health is probed but /recycle is NOT fired;
 *   3. a cloud (gemini) engine -> neither /health nor /recycle is touched
 *      (SIDECAR_ENGINES guard);
 *   4. a failing /health probe is best-effort -> generation still completes and
 *      no recycle is fired.
 *
 * Harness: a FAKE sidecar http.Server (configurable /health + a /recycle hit
 * counter) pointed at via LOCAL_TTS_URL, plus the same mocked synthesise-chapter
 * + provider as generation-recycle-recovery.test.ts. ensureSidecarEngineReady is
 * stubbed to a no-op but SIDECAR_ENGINES is preserved so the engine guard is real.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';

vi.mock('../tts/synthesise-chapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/synthesise-chapter.js')>();
  return { ...actual, synthesiseChapter: () => Promise.resolve(okResult()) };
});
vi.mock('../tts/ensure-sidecar-loaded.js', () => ({
  /* No sidecar /load in the test — stub the gate to a no-op so a kokoro run
     doesn't wait out its readiness budget. SIDECAR_ENGINES is the REAL set so
     the boundary check's engine guard is exercised honestly. */
  ensureSidecarEngineReady: async () => undefined,
  reconcileResidentQwenTiers: async () => undefined,
  SIDECAR_ENGINES: new Set(['qwen', 'kokoro', 'coqui']),
}));
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: () => ({ synthesize: vi.fn() }) };
});

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Boundary Recycle Test';
const MANUSCRIPT_ID = 'm_boundary_recycle_test';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let server: import('node:http').Server;
let baseUrl: string;
let bookId: string;
let queuePath: string;
let writeQueueFile: (
  path: string,
  file: import('../workspace/queue-io.js').QueueFile,
) => Promise<void>;
let resetUserSettingsCache: () => void;

/* The fake sidecar — its /health response is reconfigured per test, and every
   POST /recycle bumps `recycleHits`. */
let fakeSidecar: import('node:http').Server;
let healthRecyclePending = false;
let healthOk = true;
let healthHits = 0;
let recycleHits = 0;

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
  workspaceRoot = await mkdtemp(join(tmpdir(), 'boundary-recycle-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.GEN_WORKERS = '1';

  // Stand up the fake sidecar first, then point LOCAL_TTS_URL at it so
  // getResolvedSidecarUrl() (cache reset each test) resolves to it.
  const sidecarApp = express();
  sidecarApp.use(express.json());
  sidecarApp.get('/health', (_req, res) => {
    healthHits += 1;
    if (!healthOk) return res.status(500).json({ error: 'boom' });
    return res.json({ ok: true, recycle_pending: healthRecyclePending, committed_mb: 30000 });
  });
  sidecarApp.post('/recycle', (_req, res) => {
    recycleHits += 1;
    return res.status(202).json({ status: 'recycling', committed_mb: 30000 });
  });
  await new Promise<void>((resolve) => {
    fakeSidecar = sidecarApp.listen(0, () => {
      const addr = fakeSidecar.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      process.env.LOCAL_TTS_URL = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const [{ generationRouter }, { makeBookId, queueJsonPath }, cacheModule, migrateModule, settings] =
    await Promise.all([
      import('./generation.js'),
      import('../workspace/paths.js'),
      import('../store/analysis-cache.js'),
      import('../workspace/queue-migrate.js'),
      import('../workspace/user-settings.js'),
    ]);
  writeQueueFile = migrateModule.writeQueueFile;
  resetUserSettingsCache = settings._resetUserSettingsCache;

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
      updatedAt: '2026-06-01T00:00:00.000Z',
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
    chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Hello.' }] },
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
  await new Promise<void>((resolve) => fakeSidecar.close(() => resolve()));
  const { rm } = await import('node:fs/promises');
  /* Best-effort: a just-finished chapter render may still be flushing audio
     files when we tear down, which makes a single recursive rm race ENOTEMPTY
     on Linux. Retry briefly, then swallow — it's a tmpdir the OS reclaims. */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(workspaceRoot, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
});

const ENTRY_ID = 'boundary-entry-1';

beforeEach(async () => {
  healthRecyclePending = false;
  healthOk = true;
  healthHits = 0;
  recycleHits = 0;
  resetUserSettingsCache(); // cached=null → getResolvedSidecarUrl uses LOCAL_TTS_URL
  await writeQueueFile(queuePath, {
    entries: [
      {
        id: ENTRY_ID,
        bookId,
        chapterId: 1,
        scope: 'this',
        addedAt: '2026-06-01T00:00:00.000Z',
        status: 'in_progress',
        order: 0,
      },
    ],
    paused: false,
  });
});

function runChapter(modelKey: string): Promise<string> {
  return fetch(`${baseUrl}/api/books/${bookId}/generation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelKey, chapterIds: [1], force: true, queueEntryId: ENTRY_ID }),
  }).then((res) => res.text());
}

describe('side-11 boundary recycle', () => {
  it('triggers POST /recycle at the boundary when the sidecar reports recycle_pending', async () => {
    healthRecyclePending = true;

    const body = await runChapter('kokoro-v1');

    expect(body).toContain('"type":"chapter_complete"');
    expect(body).not.toContain('"type":"chapter_failed"');
    expect(healthHits).toBeGreaterThanOrEqual(1); // the boundary probe ran
    expect(recycleHits).toBe(1); // and fired exactly one clean recycle
  }, 10_000);

  it('probes /health but does NOT recycle when recycle_pending is false', async () => {
    healthRecyclePending = false;

    const body = await runChapter('kokoro-v1');

    expect(body).toContain('"type":"chapter_complete"');
    expect(healthHits).toBeGreaterThanOrEqual(1);
    expect(recycleHits).toBe(0);
  }, 10_000);

  it('does not touch the sidecar for a cloud engine (SIDECAR_ENGINES guard)', async () => {
    healthRecyclePending = true; // would recycle IF the engine were sidecar-backed

    const body = await runChapter('gemini-2.5-flash');

    expect(body).toContain('"type":"chapter_complete"');
    expect(healthHits).toBe(0); // gemini → boundary check skipped entirely
    expect(recycleHits).toBe(0);
  }, 10_000);

  it('is best-effort: a failing /health probe never blocks or fails generation', async () => {
    healthOk = false; // /health returns 500

    const body = await runChapter('kokoro-v1');

    expect(body).toContain('"type":"chapter_complete"');
    expect(body).not.toContain('"type":"chapter_failed"');
    expect(healthHits).toBeGreaterThanOrEqual(1); // probed, got 500
    expect(recycleHits).toBe(0); // a non-ok probe → no recycle
  }, 10_000);
});
