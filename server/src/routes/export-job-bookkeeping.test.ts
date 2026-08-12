/* Regression coverage for two independent-review nits on the export
   crash-fix PR — both about the test-only job-lifecycle bookkeeping
   (`_resetExportJobs` / `_awaitInFlightExportJobs`) in export.ts, not the
   production route behaviour:

   Nit (b): `_resetExportJobs()` used to clear `jobPromises` too. Its own
   docstring says the required order is "drain, THEN reset" — but nothing
   enforced it, and a caller that reset FIRST silently destroyed
   `_awaitInFlightExportJobs`'s only handle on any still-running job: a
   SUBSEQUENT drain call would return immediately, having waited for
   nothing, with no error to signal the mistake.

   Nit (c): `_awaitInFlightExportJobs()` snapshots `jobPromises`
   atomically, but a POST parked on its pre-flight work (mkdir /
   disk-guard probe) before any job exists hadn't registered into
   `jobPromises` yet — it would register AFTER the snapshot and escape the
   drain entirely.

   Both are proven with an artificially slow mocked builder so "did the
   drain actually wait" is a deterministic timing assertion, not a race. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const BUILD_DELAY_MS = 200;

vi.mock('../export/build-mp3-zip.js', () => ({
  buildMp3Zip: vi.fn(async (opts: { outPath: string }) => {
    await new Promise((r) => setTimeout(r, BUILD_DELAY_MS));
    writeFileSync(opts.outPath, Buffer.from('PK stub-zip'));
    return { sizeBytes: 16, entries: ['stub'] };
  }),
  sanitiseForZip: (s: string) => s,
  ExportIncompleteError: class ExportIncompleteError extends Error {},
}));

/* Nit (c)'s test needs a DETERMINISTIC way to widen the POST's own
   pre-flight window (the gap between "request dispatched" and "job
   registered into jobPromises") — real-clock races between that window
   (a few ms on a synthetic fast fs) and an arbitrary setTimeout proved too
   tight to be reliable (a naive version of this test passed even with the
   fix reverted, because the unfixed handler still finished registering
   before the race window closed). `readUserSettings` is awaited on every
   POST, strictly before a job is created, so delaying it on demand opens
   that window wide and predictably. */
let preflightDelayMs = 0;
vi.mock('../workspace/user-settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/user-settings.js')>();
  return {
    ...actual,
    readUserSettings: vi.fn(async () => {
      if (preflightDelayMs > 0) await new Promise((r) => setTimeout(r, preflightDelayMs));
      return actual.readUserSettings();
    }),
  };
});

const AUTHOR = 'Bookkeeping Author';
const SERIES = 'Standalones';
const TITLE = 'Bookkeeping Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let resetJobs: () => void;
let awaitInFlightJobs: () => Promise<void>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-export-bookkeeping-test-'));
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
      manuscriptId: 'mns_bookkeeping',
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

describe('nit (b) — _resetExportJobs() must not destroy the drain handle', () => {
  it('a drain called AFTER a misordered reset still waits for the job to genuinely finish', async () => {
    const create = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    expect(create.status).toBe(201);

    // Misordered on purpose: reset BEFORE draining — exactly the misuse
    // nit (b) describes. Before the fix this cleared `jobPromises`, so
    // the drain below would have nothing left to wait for.
    resetJobs();

    const t0 = Date.now();
    await awaitInFlightJobs();
    const elapsed = Date.now() - t0;

    // If jobPromises survived the reset, this genuinely waited out the
    // mocked builder's artificial delay (minus whatever abort raced it —
    // the mocked builder doesn't check the signal, so it always runs the
    // full delay). If it didn't survive, this returns near-instantly.
    expect(elapsed).toBeGreaterThanOrEqual(BUILD_DELAY_MS - 20);
  });
});

describe('nit (c) — _awaitInFlightExportJobs() must not miss a POST still in its pre-flight window', () => {
  afterEach(() => {
    preflightDelayMs = 0;
  });

  it('a drain that starts while a POST is still awaiting its own pre-flight work still catches that job', async () => {
    // Widen the POST's pre-flight window deterministically (see the
    // `readUserSettings` mock's comment at the top of this file) so the
    // race below isn't at the mercy of how fast this box's synthetic fs
    // happens to be.
    preflightDelayMs = 150;

    // supertest's Request is LAZY — `request(app).post(...).send(...)`
    // does NOT dispatch until something consumes it (`.then()`/`.end()`).
    // Assigning it to a variable and awaiting it LATER (as a naive version
    // of this test did) means the request hasn't been sent at all yet, so
    // racing a drain against it proves nothing. `.end(cb)` is what
    // actually triggers dispatch — call it now, to genuinely start the
    // request, and capture completion via a promise instead of awaiting
    // the Test object itself.
    let createStatus = 0;
    let createBody: Record<string, unknown> = {};
    const createSettled = new Promise<void>((resolve, reject) => {
      request(app)
        .post(`/api/books/${bookId}/exports`)
        .send({ format: 'mp3-zip', destination: 'download' })
        .end((err, res) => {
          if (err && !res) return reject(err);
          createStatus = res.status;
          createBody = res.body as Record<string, unknown>;
          resolve();
        });
    });

    // Give supertest/Express a short, real window to actually route the
    // now-dispatched request and enter the handler (which registers into
    // `pendingPostCreations` as its very first synchronous statement,
    // before any of its own awaited pre-flight work) — comfortably short
    // relative to `preflightDelayMs`, so the drain below starts WELL
    // before the job itself has been created or registered into
    // `jobPromises`.
    await new Promise((r) => setTimeout(r, 10));

    const t0 = Date.now();
    // Start the drain here — racing the POST's own (now artificially
    // widened) pre-flight work. Before the fix, `_awaitInFlightExportJobs`
    // would snapshot an EMPTY `jobPromises` right now and return
    // immediately, since the POST hasn't registered its job yet.
    const drainPromise = awaitInFlightJobs();

    await createSettled;
    expect(createStatus).toBe(201);
    const exportId = createBody.id as string;

    await drainPromise;
    const elapsed = Date.now() - t0;

    // The drain must have waited for the job's full (mocked, delayed)
    // build — not returned before the POST even finished creating it.
    expect(elapsed).toBeGreaterThanOrEqual(BUILD_DELAY_MS - 20);

    const manifestPath = join(bookDir, '.audiobook', 'export-manifests', `${exportId}.json`);
    expect(existsSync(manifestPath)).toBe(true);
  });
});
