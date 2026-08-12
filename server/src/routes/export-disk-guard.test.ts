/* srv-28 — export route disk-guard integration. Mocks the disk probe to report
   a critically-low free figure so the guard trips, then asserts:
     - BLOCK mode → 409 { error: 'disk_full' } before any job is created,
     - WARN mode → 201 with a `warning` advisory attached to the job body.
   Mocking the probe (not the volume) keeps the test deterministic regardless of
   the CI box's real free space. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Stub the actual archive build so the fire-and-forget job in WARN/OFF mode
   doesn't spawn ffmpeg/zip — but DO write the expected partial file so the
   route's renameWithRetry succeeds and the job reaches `done` quickly and
   cleanly (no dangling fs work that could outlive the test and crash the
   worker fork). The disk guard runs BEFORE the build, so this stub doesn't
   affect the gate under test. */
vi.mock('../export/build-mp3-zip.js', () => ({
  buildMp3Zip: vi.fn(async (opts: { outPath: string }) => {
    writeFileSync(opts.outPath, Buffer.from('PK stub-zip'));
    return { sizeBytes: 16, entries: 1 };
  }),
  sanitiseForZip: (s: string) => s,
  ExportIncompleteError: class ExportIncompleteError extends Error {},
}));

/* Report a tiny free figure so estimate + headroom always exceeds it. The path
   is echoed back per the DiskProbe contract. */
vi.mock('../diagnostics/disk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../diagnostics/disk.js')>();
  return {
    ...actual,
    probeDiskSpace: vi.fn(async (path: string) => ({
      status: 'fail' as const,
      freeGb: 0.2,
      path,
    })),
  };
});

const AUTHOR = 'Guard Author';
const SERIES = 'Standalones';
const TITLE = 'Guard Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let resetJobs: () => void;
let awaitInFlightJobs: () => Promise<void>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-export-guard-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  /* #2083 — sequential awaits, not Promise.all: a Promise.all of dynamic
     imports here races the async vi.mock factory above (module-under-test can
     receive the real binding instead of the mock). Measured latent for this
     file — 0 failures in 14 runs (#2083's own survey) — not the live
     ~2-in-5 rate, which belongs to voices.test.ts, a different file already
     fixed under #2046. */
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
      manuscriptId: 'mns_guard',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
      ],
      coverGradient: ['#abc', '#def'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  /* Both chapters present so the missing-chapter pre-flight passes and the
     disk guard is the gate under test. Tiny files — the estimate adds the
     headroom that trips the mocked 0.2 GB free. */
  writeFileSync(join(audioRoot, '01-chapter-one.mp3'), Buffer.alloc(1024));
  writeFileSync(join(audioRoot, '02-chapter-two.mp3'), Buffer.alloc(1024));

  app = express();
  app.use(express.json());
  app.use('/api/books', exportRouter);
});

/* Nit (a) (independent review): this file's own beforeEach/afterAll used
   to reset/rmSync with no drain at all, and its local `drain()` (removed
   below) polled `job.status` — this PR's OWN new regression test
   (export.test.ts's "awaiting in-flight jobs ... waits for the WHOLE job,
   not just its status flip") proves that's insufficient: `job.status`
   flips inside runExportJob's try block, well before its `finally` (the
   manifest write) has run. Same defect class as the crash this whole PR
   fixes — a teardown that doesn't actually wait for a job's tail-end fs
   work can race it. `_awaitInFlightExportJobs()` (which also aborts, so
   it can't hang on a stuck build — see its own doc comment) replaces both
   the ad-hoc drain and the un-awaited reset/rmSync calls below. */
beforeEach(async () => {
  await awaitInFlightJobs?.();
  resetJobs?.();
  const exportsDir = join(bookDir, 'exports');
  if (existsSync(exportsDir)) rmSync(exportsDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.DISK_GUARD_MODE;
});

afterAll(async () => {
  await awaitInFlightJobs?.();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('export disk guard', () => {
  it('BLOCK mode → 409 disk_full before the job is created', async () => {
    process.env.DISK_GUARD_MODE = 'block';
    const res = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('disk_full');
    expect(res.body.message).toMatch(/disk space/i);
  });

  it('WARN mode → 201 with a `warning` advisory on the job body', async () => {
    process.env.DISK_GUARD_MODE = 'warn';
    const res = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('in_progress');
    expect(typeof res.body.warning).toBe('string');
    expect(res.body.warning).toMatch(/disk space/i);
    await awaitInFlightJobs();
  });

  it('OFF mode → 201 with no warning', async () => {
    process.env.DISK_GUARD_MODE = 'off';
    const res = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
    await awaitInFlightJobs();
  });
});
