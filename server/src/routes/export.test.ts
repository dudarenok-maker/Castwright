/* Integration tests for the export router. Scaffolds a synthetic
   workspace with a complete (or deliberately-incomplete) book, drives
   the route with supertest, polls the job to completion, then asserts
   the download endpoint streams the zip with the expected Content-Type. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { encodePcmToMp3 } from '../tts/mp3.js';

const ffmpegPresent = (() => {
  try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
})();
const describeIfFfmpeg = ffmpegPresent ? describe : describe.skip;

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Bonus Story';

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let app: Express;
let bookId: string;
let resetJobs: () => void;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-export-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [
    { exportRouter, _resetExportJobs },
    { exportLanRouter },
    { makeBookId },
    { _resetUserSettingsCache },
  ] = await Promise.all([
    import('./export.js'),
    import('./export-lan.js'),
    import('../workspace/paths.js'),
    import('../workspace/user-settings.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  resetJobs = _resetExportJobs;
  _resetUserSettingsCache();

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });

  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'mns_test',
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
        { id: 3, title: 'Front matter', slug: '00-front-matter', excluded: true },
      ],
      coverGradient: ['#abc', '#def'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      narratorCredit: 'Jane Narrator',
      genre: 'Audiobook',
      publicationDate: '2025',
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');

  const mp3 = await encodePcmToMp3(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
  writeFileSync(join(audioRoot, '01-chapter-one.mp3'), mp3);
  writeFileSync(join(audioRoot, '02-chapter-two.mp3'), mp3);

  app = express();
  app.use(express.json());
  app.use('/api/books', exportRouter);
  app.use('/api/export', exportLanRouter);
});

beforeEach(() => {
  resetJobs?.();
  /* Clear any prior staged exports between tests so download checks
     hit a known artifact. */
  const exportsDir = join(bookDir, '.audiobook', 'exports');
  if (existsSync(exportsDir)) rmSync(exportsDir, { recursive: true, force: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

async function waitForDone(exportId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
    const body = res.body as { status?: string };
    if (body.status === 'done' || body.status === 'failed') {
      return { status: res.status, body: res.body as Record<string, unknown> };
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Export ${exportId} did not finish within timeout.`);
}

describeIfFfmpeg('POST /api/books/:bookId/exports + GET status + download', () => {
  it('creates a job, finishes successfully, and streams the zip', async () => {
    const create = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('in_progress');
    expect(create.body.format).toBe('mp3-zip');
    expect(create.body.filename).toMatch(/\.zip$/);

    const exportId = create.body.id as string;
    const { body: done } = await waitForDone(exportId);
    expect(done.status).toBe('done');
    expect(done.downloadUrl).toMatch(/\/exports\/.+\/download$/);
    expect(typeof done.sizeBytes).toBe('number');
    expect(done.sizeBytes).toBeGreaterThan(0);

    const dl = await request(app).get(`/api/books/${bookId}/exports/${exportId}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/application\/zip/);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename=/);
    expect(dl.body.length ?? dl.text?.length ?? 0).toBeGreaterThan(0);
  });

  it('refuses with 409 export_incomplete when a chapter has no MP3', async () => {
    /* Delete chapter 2's MP3 to simulate a partially-generated book. */
    const ch2 = join(audioRoot, '02-chapter-two.mp3');
    rmSync(ch2);
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/exports`)
        .send({ format: 'mp3-zip', destination: 'download' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('export_incomplete');
      expect(res.body.missing).toContain('02-chapter-two');
    } finally {
      const mp3 = await encodePcmToMp3(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
      writeFileSync(ch2, mp3);
    }
  });

  it('rejects unsupported format / destination', async () => {
    const fmt = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'opus', destination: 'download' });
    expect(fmt.status).toBe(400);
    expect(fmt.body.error).toBe('unsupported_format');

    const dest = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'email' });
    expect(dest.status).toBe(400);
    expect(dest.body.error).toBe('invalid_destination');
  });

  it('rejects sync-folder destination when exportSyncFolder is unset', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'sync-folder' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('sync_folder_unset');
  });

  it('404s an unknown export id', async () => {
    const res = await request(app).get(`/api/books/${bookId}/exports/exp_doesnotexist`);
    expect(res.status).toBe(404);
  });

  it('persists the manifest so a fresh server process can rehydrate the job', async () => {
    const create = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    const exportId = create.body.id as string;
    await waitForDone(exportId);

    /* Drop the in-memory table to simulate a server restart. The manifest
       on disk should let the next GET re-populate. */
    resetJobs();
    const res = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
    expect(res.body.id).toBe(exportId);
    /* Artifact bytes are still on disk. */
    const path = join(bookDir, '.audiobook', 'exports', exportId, res.body.filename as string);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
    void readFileSync;
  });
});

describe('GET /api/export/lan', () => {
  it('returns the listening port and only non-loopback IPv4 URLs', async () => {
    const res = await request(app).get(`/api/export/lan`);
    expect(res.status).toBe(200);
    expect(typeof res.body.port).toBe('number');
    expect(Array.isArray(res.body.urls)).toBe(true);
    for (const url of res.body.urls as string[]) {
      expect(url).toMatch(/^http:\/\//);
      expect(url).not.toContain('127.0.0.1');
      expect(url).not.toContain('169.254.');
    }
  });
});

if (!ffmpegPresent) {
  // eslint-disable-next-line no-console
  console.warn('[export.test.ts] ffmpeg missing — skipping export integration tests.');
}
