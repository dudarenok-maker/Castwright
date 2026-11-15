/* #4223 — seam tests for the cancel windows in `runExportJob` that a real
   build is too fast to land a DELETE in. Each test holds the job at one
   awaited step (the builder, the rename into place, the sync-folder copy, the
   stale-manifest revoke) through a mocked seam that delegates to the real
   implementation, fires DELETE inside that gap, releases the hold, and asserts
   that the in-memory job, the manifest and the artifact agree.

   The `readdir` mock only holds a call once `holds.revoke` is armed AND the
   stub builder has returned, so rehydrate's own `readdir` of the manifests dir
   (every request) is never the held one. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const seam = vi.hoisted(() => {
  type Hold = { entered: Promise<void>; release: () => void; enter: () => void; released: Promise<void> };
  const holds: Record<string, Hold | undefined> = {};
  const state = { revokeReady: false, renameCalls: 0 };
  function arm(name: string): { entered: Promise<void>; release: () => void } {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => (enter = r));
    const released = new Promise<void>((r) => (release = r));
    holds[name] = { entered, release, enter, released };
    return { entered, release };
  }
  async function maybeHold(name: string): Promise<void> {
    const h = holds[name];
    if (!h) return;
    delete holds[name];
    h.enter();
    await h.released;
  }
  return { holds, state, arm, maybeHold };
});

vi.mock('../export/build-mp3-zip.js', () => ({
  buildMp3Zip: vi.fn(async (opts: { outPath: string; onProgress?: (r: number) => void }) => {
    /* A progress tick replaces the jobs-map entry with a copy, as every real builder does. */
    opts.onProgress?.(0.5);
    await seam.maybeHold('builder');
    writeFileSync(opts.outPath, Buffer.from('PK stub-zip'));
    seam.state.revokeReady = !!seam.holds.revoke;
    return { sizeBytes: 11, entries: ['stub'] };
  }),
  sanitiseForZip: (s: string) => s,
  ExportIncompleteError: class ExportIncompleteError extends Error {},
}));

vi.mock('../export/build-mp3-folder.js', () => ({
  buildMp3Folder: vi.fn(async (opts: { outDir: string }) => {
    await seam.maybeHold('folderBuild');
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(join(opts.outDir, '01.mp3'), Buffer.from('id3'));
    return { totalBytes: 3, entries: [join(opts.outDir, '01.mp3')] };
  }),
}));

vi.mock('../workspace/atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/atomic-rename.js')>();
  return {
    ...actual,
    renameWithRetry: vi.fn(async (src: string, dest: string) => {
      /* Only the build's own rename into place: manifest writes also go through here. */
      if (src.includes('.partial-')) {
        seam.state.renameCalls++;
        await seam.maybeHold('rename');
      }
      return actual.renameWithRetry(src, dest);
    }),
  };
});

vi.mock('../export/sync-folder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../export/sync-folder.js')>();
  return {
    ...actual,
    /* The copy has LANDED when the hold is entered: the cancel arrives after it. */
    writeToSyncFolder: vi.fn(async (...a: Parameters<typeof actual.writeToSyncFolder>) => {
      const r = await actual.writeToSyncFolder(...a);
      await seam.maybeHold('syncCopy');
      return r;
    }),
    writeFolderToSyncFolder: vi.fn(async (...a: Parameters<typeof actual.writeFolderToSyncFolder>) => {
      const r = await actual.writeFolderToSyncFolder(...a);
      await seam.maybeHold('syncCopy');
      return r;
    }),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readdir = (async (...a: Parameters<typeof actual.readdir>) => {
    if (seam.state.revokeReady && String(a[0]).endsWith('export-manifests')) {
      seam.state.revokeReady = false;
      await seam.maybeHold('revoke');
    }
    return actual.readdir(...a);
  }) as typeof actual.readdir;
  return { ...actual, readdir, default: { ...actual, readdir } };
});

const AUTHOR = 'Seam Author';
const SERIES = 'Standalones';
const TITLE = 'Seam Book';

let workspaceRoot: string;
let bookDir: string;
let app: Express;
let bookId: string;
let resetJobs: () => void;
let awaitInFlightJobs: () => Promise<void>;
let writeUserSettings: (p: Record<string, unknown>) => Promise<unknown>;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-export-seams-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { exportRouter, _resetExportJobs, _awaitInFlightExportJobs } = await import('./export.js');
  const { makeBookId } = await import('../workspace/paths.js');
  const us = await import('../workspace/user-settings.js');
  writeUserSettings = us.writeUserSettings as never;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  resetJobs = _resetExportJobs;
  awaitInFlightJobs = _awaitInFlightExportJobs;
  us._resetUserSettingsCache();

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'mns_seams',
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
  writeFileSync(join(bookDir, 'audio', '01-chapter-one.mp3'), Buffer.alloc(1024));

  app = express();
  app.use(express.json());
  app.use('/api/books', exportRouter);
});

beforeEach(async () => {
  await awaitInFlightJobs?.();
  resetJobs?.();
  for (const k of Object.keys(seam.holds)) delete seam.holds[k];
  seam.state.revokeReady = false;
  seam.state.renameCalls = 0;
  rmSync(join(bookDir, 'exports'), { recursive: true, force: true });
  rmSync(join(bookDir, '.audiobook', 'export-manifests'), { recursive: true, force: true });
});

afterAll(async () => {
  for (const h of Object.values(seam.holds)) h?.release();
  await awaitInFlightJobs?.();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

const exportsDir = () => join(bookDir, 'exports');
const manifestOf = (id: string) =>
  JSON.parse(readFileSync(join(bookDir, '.audiobook', 'export-manifests', `${id}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
const ls = (d: string) => (existsSync(d) ? readdirSync(d) : []);

async function post(format: string, destination: string) {
  const res = await request(app).post(`/api/books/${bookId}/exports`).send({ format, destination });
  expect(res.status).toBe(201);
  return res.body as { id: string; filename: string };
}

describe('cancel seams (#4223)', () => {
  it('a cancel landing while revokeStaleSameFormat runs does not delete the finished artifact (status, manifest and artifact agree on done)', async () => {
    const revoke = seam.arm('revoke');
    const job = await post('mp3-zip', 'download');
    await revoke.entered;
    /* The artifact is renamed into place and the job is past its last cancel check. */
    expect(existsSync(join(exportsDir(), job.filename))).toBe(true);

    const del = await request(app).delete(`/api/books/${bookId}/exports/${job.id}`);
    expect(del.status).toBe(204);
    revoke.release();
    await awaitInFlightJobs();

    const mem = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
    expect(mem.status).toBe('done');
    expect(manifestOf(job.id).status).toBe('done');
    expect(existsSync(join(exportsDir(), job.filename))).toBe(true);
    const dl = await request(app).get(`/api/books/${bookId}/exports/${job.id}/download`);
    expect(dl.status).toBe(200);
  });

  it('a cancel during a re-export\'s sync-folder copy keeps the earlier sync copy and the earlier export\'s syncPath', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-sync-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const first = await post('mp3-zip', 'sync-folder');
      await awaitInFlightJobs();
      const firstDone = (await request(app).get(`/api/books/${bookId}/exports/${first.id}`)).body;
      expect(firstDone.status).toBe('done');
      expect(existsSync(firstDone.syncPath)).toBe(true);

      const copy = seam.arm('syncCopy');
      const second = await post('mp3-zip', 'sync-folder');
      await copy.entered;
      const del = await request(app).delete(`/api/books/${bookId}/exports/${second.id}`);
      expect(del.status).toBe(204);
      copy.release();
      await awaitInFlightJobs();

      const mem = (await request(app).get(`/api/books/${bookId}/exports/${second.id}`)).body;
      expect(mem.status).toBe('cancelled');
      expect(existsSync(firstDone.syncPath)).toBe(true);
      expect(ls(join(syncRoot, AUTHOR)).filter((n) => !n.includes('.tmp-'))).toEqual([first.filename]);
      const firstAfter = (await request(app).get(`/api/books/${bookId}/exports/${first.id}`)).body;
      expect(existsSync(firstAfter.syncPath)).toBe(true);
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('a cancel while the builder runs never reaches the rename, leaves no partial, and the reason reads "Cancelled by user." in memory and in the manifest', async () => {
    const builder = seam.arm('builder');
    const job = await post('mp3-zip', 'download');
    await builder.entered;
    expect((await request(app).delete(`/api/books/${bookId}/exports/${job.id}`)).status).toBe(204);
    builder.release();
    await awaitInFlightJobs();

    expect(seam.state.renameCalls).toBe(0);
    expect(ls(exportsDir()).filter((n) => n.includes(job.id))).toEqual([]);
    const mem = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
    expect(mem.status).toBe('cancelled');
    expect(mem.errorReason).toBe('Cancelled by user.');
    expect(manifestOf(job.id).status).toBe('cancelled');
    expect(manifestOf(job.id).errorReason).toBe('Cancelled by user.');
  });

  it('a cancel during the rename into place removes the renamed artifact', async () => {
    const rename = seam.arm('rename');
    const job = await post('mp3-zip', 'download');
    await rename.entered;
    expect((await request(app).delete(`/api/books/${bookId}/exports/${job.id}`)).status).toBe(204);
    rename.release();
    await awaitInFlightJobs();

    expect(existsSync(join(exportsDir(), job.filename))).toBe(false);
    expect(ls(exportsDir()).filter((n) => n.includes(job.id))).toEqual([]);
    expect((await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body.status).toBe('cancelled');
    expect(manifestOf(job.id).status).toBe('cancelled');
  });

  it('an mp3-folder cancelled while the builder runs leaves no staging folder', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-folder-build-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const build = seam.arm('folderBuild');
      const job = await post('mp3-folder', 'sync-folder');
      await build.entered;
      expect((await request(app).delete(`/api/books/${bookId}/exports/${job.id}`)).status).toBe(204);
      build.release();
      await awaitInFlightJobs();

      expect(existsSync(join(exportsDir(), job.filename))).toBe(false);
      expect(ls(join(syncRoot, AUTHOR))).toEqual([]);
      expect((await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body.status).toBe('cancelled');
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('an mp3-folder cancelled during its sync copy ends cancelled and leaves the sync copy (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-folder-sync-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const copy = seam.arm('syncCopy');
      const job = await post('mp3-folder', 'sync-folder');
      await copy.entered;
      expect((await request(app).delete(`/api/books/${bookId}/exports/${job.id}`)).status).toBe(204);
      copy.release();
      await awaitInFlightJobs();

      expect(existsSync(join(exportsDir(), job.filename))).toBe(false);
      expect(existsSync(join(syncRoot, AUTHOR, TITLE, '01.mp3'))).toBe(true);
      expect((await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body.status).toBe('cancelled');
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });
});
