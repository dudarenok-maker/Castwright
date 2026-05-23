/* Integration tests for the export router. Scaffolds a synthetic
   workspace with a complete (or deliberately-incomplete) book, drives
   the route with supertest, polls the job to completion, then asserts
   the download endpoint streams the zip with the expected Content-Type. */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { encodePcmToAudio } from '../tts/mp3.js';

const ffmpegPresent = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
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

  const mp3 = await encodePcmToAudio(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
  writeFileSync(join(audioRoot, '01-chapter-one.mp3'), mp3);
  writeFileSync(join(audioRoot, '02-chapter-two.mp3'), mp3);

  app = express();
  app.use(express.json());
  app.use('/api/books', exportRouter);
  app.use('/api/export', exportLanRouter);
});

beforeEach(() => {
  resetJobs?.();
  /* Plan 79 — clear both the new and old staging dirs between tests so
     download checks hit a known artifact. The .audiobook/exports/<id>/
     path is gone in production but cleaning it keeps the suite robust
     to a future test scaffold that lands files there. */
  const exportsDir = join(bookDir, 'exports');
  const manifestsDir = join(bookDir, '.audiobook', 'export-manifests');
  const legacyExportsDir = join(bookDir, '.audiobook', 'exports');
  if (existsSync(exportsDir)) rmSync(exportsDir, { recursive: true, force: true });
  if (existsSync(manifestsDir)) rmSync(manifestsDir, { recursive: true, force: true });
  if (existsSync(legacyExportsDir)) rmSync(legacyExportsDir, { recursive: true, force: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

async function waitForDone(
  exportId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let i = 0; i < 50; i++) {
    const res = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
    const body = res.body as { status?: string };
    if (body.status === 'done' || body.status === 'failed') {
      return { status: res.status, body: res.body as Record<string, unknown> };
    }
    await new Promise((r) => setTimeout(r, 100));
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

  it('creates an M4B job, finishes successfully, and streams audio/mp4', async () => {
    const create = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'm4b', destination: 'download' });
    expect(create.status).toBe(201);
    expect(create.body.format).toBe('m4b');
    expect(create.body.filename).toMatch(/\.m4b$/);

    const exportId = create.body.id as string;
    const { body: done } = await waitForDone(exportId);
    expect(done.status).toBe('done');
    expect(done.format).toBe('m4b');
    expect(typeof done.sizeBytes).toBe('number');
    expect(done.sizeBytes).toBeGreaterThan(0);

    const dl = await request(app).get(`/api/books/${bookId}/exports/${exportId}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/audio\/mp4/);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename=/);
  }, 30_000);

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
      const mp3 = await encodePcmToAudio(Buffer.alloc(24_000 * 2 * 0.2), 24_000, { quality: 9 });
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

  it('rejects mp3-folder + download combo at create time (plan 34 B1)', async () => {
    /* mp3-folder artifacts live as a directory tree; the download
       endpoint serves single files. The route must refuse this combo
       BEFORE allocating an export id so the client gets a clear 400
       rather than a confused 409 on the download endpoint later. */
    const res = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-folder', destination: 'download' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_destination');
    expect(res.body.message).toMatch(/mp3-folder/);
    expect(res.body.message).toMatch(/sync-folder/);
  });

  it('404s an unknown export id', async () => {
    const res = await request(app).get(`/api/books/${bookId}/exports/exp_doesnotexist`);
    expect(res.status).toBe(404);
  });

  it('DELETE cancels a running job and flips its status to cancelled', async () => {
    const create = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'm4b', destination: 'download' });
    expect(create.status).toBe(201);
    const exportId = create.body.id as string;

    /* Fire DELETE while the fire-and-forget build is still running. The
       m4b path probes durations + spawns ffmpeg; even on a 2-chapter
       fixture the SIGTERM lands well before completion. */
    const del = await request(app).delete(`/api/books/${bookId}/exports/${exportId}`);
    expect(del.status).toBe(204);

    /* Subsequent GET reports cancelled. Allow a couple of poll ticks in
       case runExportJob's finally hasn't flushed yet — the DELETE
       handler synchronously flips the status, so the first GET should
       already see it. */
    let final: Record<string, unknown> | null = null;
    for (let i = 0; i < 20; i++) {
      const res = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
      if (res.status === 200 && res.body.status === 'cancelled') {
        final = res.body;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(final).not.toBeNull();
    expect(final!.status).toBe('cancelled');
    expect(final!.errorReason).toMatch(/cancel/i);

    /* Plan 79 — partial artifact in <bookDir>/exports/ is unlinked.
       The exports dir itself stays (other completed exports live there);
       the per-format final-name artifact and any `.<filename>.partial-<id>`
       tmp are gone. */
    const exportsDir = join(bookDir, 'exports');
    const remaining = existsSync(exportsDir) ? readdirSync(exportsDir) : [];
    expect(remaining.filter((n: string) => n.includes(exportId))).toEqual([]);
  }, 15_000);

  it('DELETE is idempotent on already-terminal jobs', async () => {
    const create = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    const exportId = create.body.id as string;
    await waitForDone(exportId);

    const del = await request(app).delete(`/api/books/${bookId}/exports/${exportId}`);
    expect(del.status).toBe(204);

    /* Status stays 'done' — the cancel was a no-op. */
    const after = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe('done');
  });

  it('DELETE on an unknown export id 404s', async () => {
    const res = await request(app).delete(`/api/books/${bookId}/exports/exp_doesnotexist`);
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
    /* Plan 79 — artifact lives in the visible <bookDir>/exports/ folder
       with a flat name (no exportId in the path); the manifest sits in
       the hidden .audiobook/export-manifests/<exportId>.json jail so the
       exports folder stays clean for the user. */
    const artifactPath = join(bookDir, 'exports', res.body.filename as string);
    expect(existsSync(artifactPath)).toBe(true);
    expect(statSync(artifactPath).size).toBeGreaterThan(0);
    const manifestPath = join(bookDir, '.audiobook', 'export-manifests', `${exportId}.json`);
    expect(existsSync(manifestPath)).toBe(true);
    void readFileSync;
  });

  /* Plan 79 — the user-visible artifact lives at <bookDir>/exports/<slug>.<ext>
     (flat, no exportId, no .audiobook/ jail). Same-format re-exports
     clobber the prior file (newest wins) AND revoke the older job's
     manifest so the queue rail stays de-duped to one row per format. */
  it('writes the artifact to the visible <bookDir>/exports folder (not .audiobook/)', async () => {
    const create = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'm4b', destination: 'download' });
    const exportId = create.body.id as string;
    const { body: done } = await waitForDone(exportId);
    expect(done.status).toBe('done');

    const filename = done.filename as string;
    expect(filename).toMatch(/\.m4b$/);
    expect(filename).not.toContain(exportId); // no UUID in the visible name

    const visiblePath = join(bookDir, 'exports', filename);
    expect(existsSync(visiblePath)).toBe(true);

    /* Old layout MUST be empty (or absent) — no <bookDir>/.audiobook/exports/<id>/ */
    const legacyDir = join(bookDir, '.audiobook', 'exports');
    expect(existsSync(legacyDir)).toBe(false);
  }, 30_000);

  it('revokes the older same-format manifest when a re-export of the same format finishes', async () => {
    const first = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    const firstId = first.body.id as string;
    await waitForDone(firstId);

    const second = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    const secondId = second.body.id as string;
    await waitForDone(secondId);

    /* First manifest is gone, second is present. */
    const firstManifest = join(bookDir, '.audiobook', 'export-manifests', `${firstId}.json`);
    const secondManifest = join(bookDir, '.audiobook', 'export-manifests', `${secondId}.json`);
    expect(existsSync(firstManifest)).toBe(false);
    expect(existsSync(secondManifest)).toBe(true);

    /* And the first job's GET now 404s — its row disappears from the queue. */
    const lookupFirst = await request(app).get(`/api/books/${bookId}/exports/${firstId}`);
    expect(lookupFirst.status).toBe(404);
  });

  it('different-format re-exports DO NOT revoke each other (one row per format)', async () => {
    const zip = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    const zipId = zip.body.id as string;
    await waitForDone(zipId);

    const m4b = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'm4b', destination: 'download' });
    const m4bId = m4b.body.id as string;
    await waitForDone(m4bId);

    /* Both manifests survive. */
    expect(existsSync(join(bookDir, '.audiobook', 'export-manifests', `${zipId}.json`))).toBe(true);
    expect(existsSync(join(bookDir, '.audiobook', 'export-manifests', `${m4bId}.json`))).toBe(true);
  }, 30_000);

  it('rehydration drops manifests whose artifact has been deleted from the exports folder', async () => {
    const create = await request(app)
      .post(`/api/books/${bookId}/exports`)
      .send({ format: 'mp3-zip', destination: 'download' });
    const exportId = create.body.id as string;
    const { body: done } = await waitForDone(exportId);
    expect(done.status).toBe('done');

    /* Simulate the user deleting the artifact from the exports folder. */
    const filename = done.filename as string;
    const visiblePath = join(bookDir, 'exports', filename);
    expect(existsSync(visiblePath)).toBe(true);
    rmSync(visiblePath);

    /* Simulate a server restart so rehydrate rescans manifests. */
    resetJobs();
    const lookup = await request(app).get(`/api/books/${bookId}/exports/${exportId}`);
    expect(lookup.status).toBe(404);
    /* Stale manifest was unlinked on the rehydrate scan. */
    const manifestPath = join(bookDir, '.audiobook', 'export-manifests', `${exportId}.json`);
    expect(existsSync(manifestPath)).toBe(false);
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
  console.warn('[export.test.ts] ffmpeg missing — skipping export integration tests.');
}
