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
   never touches disk (and so the temp-dir teardown can't race a real ffmpeg/zip
   write). The disk guard runs BEFORE the build, so this doesn't affect the gate
   under test. */
vi.mock('../export/build-mp3-zip.js', () => ({
  buildMp3Zip: vi.fn(async () => ({ sizeBytes: 1024 })),
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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-export-guard-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ exportRouter, _resetExportJobs }, { makeBookId }, { _resetUserSettingsCache }] =
    await Promise.all([
      import('./export.js'),
      import('../workspace/paths.js'),
      import('../workspace/user-settings.js'),
    ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  resetJobs = _resetExportJobs;
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

beforeEach(() => {
  resetJobs?.();
  const exportsDir = join(bookDir, 'exports');
  if (existsSync(exportsDir)) rmSync(exportsDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.DISK_GUARD_MODE;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/* Drain a fire-and-forget export job to a terminal state so its background
   work never outlives the test (and can't race the temp-dir teardown). */
async function drain(exportId: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
    const status = (res.body as { status?: string }).status;
    if (status === 'done' || status === 'failed' || status === 'cancelled') return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

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
    await drain(res.body.id as string);
  });

  it('OFF mode → 201 with no warning', async () => {
    process.env.DISK_GUARD_MODE = 'off';
    const res = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    expect(res.status).toBe(201);
    expect(res.body.warning).toBeUndefined();
    await drain(res.body.id as string);
  });
});
