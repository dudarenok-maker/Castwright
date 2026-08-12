/* Finding 5 (independent review of the export crash-fix PR): the
   fire-and-forget `.catch` backstop in export.ts's POST handler exists to
   catch anything that slips past runExportJob's own try/catch/finally —
   e.g. a non-Error thrown by a builder, which makes `(e as Error).message`
   inside runExportJob's own catch throw a SECOND time. runExportJob's own
   `finally` still runs (JS guarantees this) and writes a manifest — but at
   that point the second throw means `job.errorReason`/`job.completedAt`
   never got set, so the manifest it persists is an incomplete snapshot.
   The backstop then finishes fixing up the in-memory `job` (status,
   errorReason, completedAt) — but, before this fix, ONLY in memory. A
   server restart rehydrates the STALE on-disk manifest instead of the
   corrected state.

   Mocks buildMp3Zip to `throw undefined` (a non-Error) so the build fails
   in exactly the shape that makes runExportJob's own catch block throw a
   second time out from underneath itself, forcing execution down the
   backstop path instead of runExportJob's normal catch/finally alone. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('../export/build-mp3-zip.js', () => ({
  buildMp3Zip: vi.fn(async () => {
    // Deliberately a non-Error throw, per finding 5.
    throw undefined;
  }),
  sanitiseForZip: (s: string) => s,
  ExportIncompleteError: class ExportIncompleteError extends Error {},
}));

const AUTHOR = 'Backstop Author';
const SERIES = 'Standalones';
const TITLE = 'Backstop Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let resetJobs: () => void;
let awaitInFlightJobs: () => Promise<void>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-export-backstop-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  // Sequential awaits (not Promise.all) — a Promise.all of dynamic imports
  // races the async vi.mock factory above (#2083's documented pattern).
  const { exportRouter, _resetExportJobs, _awaitInFlightExportJobs } = await import('./export.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const { _resetUserSettingsCache } = await import('../workspace/user-settings.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  resetJobs = _resetExportJobs;
  awaitInFlightJobs = _awaitInFlightExportJobs;
  _resetUserSettingsCache();

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  const audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'mns_backstop',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one' }],
      coverGradient: ['#abc', '#def'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  // Only needs to exist for the route-layer preflight (findChapterAudio) —
  // the actual build is mocked away, so content is irrelevant.
  writeFileSync(join(audioRoot, '01-chapter-one.mp3'), Buffer.alloc(1024));

  app = express();
  app.use(express.json());
  app.use('/api/books', exportRouter);
});

beforeEach(async () => {
  await awaitInFlightJobs?.();
  resetJobs?.();
  const exportsDir = join(bookDir, 'exports');
  const manifestsDir = join(bookDir, '.audiobook', 'export-manifests');
  if (existsSync(exportsDir)) rmSync(exportsDir, { recursive: true, force: true });
  if (existsSync(manifestsDir)) rmSync(manifestsDir, { recursive: true, force: true });
});

afterAll(async () => {
  await awaitInFlightJobs?.();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/* Poll instead of `_awaitInFlightExportJobs()` for the assertion itself —
   that helper ABORTS every in-flight controller before waiting (it's a
   teardown primitive, not a neutral "wait until done"), and aborting this
   job races runExportJob's own catch into taking the CANCELLATION branch
   (it only checks `signal.aborted`, not why) instead of the non-Error
   failure path this test means to exercise. Confirmed empirically: using
   `_awaitInFlightExportJobs()` here made the job land 'cancelled' instead
   of 'failed'. */
/* Poll for `errorReason` specifically, not just a terminal `status` — the
   in-memory `jobs` map already flips to `status: 'failed'` inside
   runExportJob's OWN `finally` (which runs, and persists ITS OWN manifest
   snapshot, before the backstop below ever gets a turn), with
   `errorReason` still null at that point in exactly this non-Error-throw
   scenario. Only the backstop's fix-up sets a real `errorReason`. Polling
   on bare `status` raced ahead of the backstop and read the job before it
   had run — confirmed empirically (this test failed against the FIXED
   code with a bare-status poll, for that exact reason). */
async function waitForTerminal(exportId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
    const body = res.body as { status?: string; errorReason?: string | null };
    if (body.status === 'done' || body.errorReason != null) return res.body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Export ${exportId} did not reach a terminal state within timeout.`);
}

describe('export POST backstop persists what it fixes up', () => {
  it('persists the corrected errorReason/status to the manifest, not just in-memory, on a non-Error throw', async () => {
    const create = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    expect(create.status).toBe(201);
    const exportId = create.body.id as string;

    const inMemoryBody = await waitForTerminal(exportId);
    const inMemory = { status: 200, body: inMemoryBody };
    expect(inMemory.status).toBe(200);
    expect(inMemory.body.status).toBe('failed');
    expect(inMemory.body.status).not.toBe('in_progress');
    expect(inMemory.body.errorReason).toBeTruthy();
    expect(inMemory.body.completedAt).toBeTruthy();

    // The persisted manifest must match what the backstop fixed up in
    // memory — never 'in_progress', and never missing the errorReason/
    // completedAt the backstop set. Before the fix, runExportJob's OWN
    // finally already wrote a manifest snapshot from BEFORE the backstop's
    // fix-up ran (status='failed' but errorReason/completedAt still null),
    // and the backstop never re-persisted — so this manifest stayed stale.
    const manifestPath = join(bookDir, '.audiobook', 'export-manifests', `${exportId}.json`);
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      status: string;
      errorReason: string | null;
      completedAt: string | null;
    };
    expect(manifest.status).toBe('failed');
    expect(manifest.status).not.toBe('in_progress');
    expect(manifest.errorReason).toBe(inMemory.body.errorReason);
    expect(manifest.completedAt).toBe(inMemory.body.completedAt);

    // And a simulated restart (dropping the in-memory table and rehydrating
    // from disk) must show the SAME corrected state, not a stale one.
    resetJobs();
    const rehydrated = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
    expect(rehydrated.status).toBe(200);
    expect(rehydrated.body.status).toBe('failed');
    expect(rehydrated.body.errorReason).toBeTruthy();
    expect(rehydrated.body.completedAt).toBeTruthy();
  });
});
