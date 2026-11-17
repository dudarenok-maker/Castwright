/* #4223 — seam tests for the cancel windows in `runExportJob` that a real
   build is too fast to land a DELETE in. Each test holds the job at one
   awaited step (the builder, the rename into place, the sync-folder copy, the
   stale-manifest revoke) through a mocked seam that delegates to the real
   implementation, fires DELETE inside that gap, releases the hold, and asserts
   that the in-memory job, the manifest and the artifact agree.

   The `readdir` mock only holds a call once `holds.revoke` is armed AND the
   stub builder has returned, so rehydrate's own `readdir` of the manifests dir
   (every request) is never the held one. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const seam = vi.hoisted(() => {
  type Hold = { entered: Promise<void>; release: () => void; enter: () => void; released: Promise<void> };
  const holds: Record<string, Hold | undefined> = {};
  /* Holds that were entered stay reachable here so cleanup can release them. */
  const entered: Hold[] = [];
  const state = { revokeReady: false, renameCalls: 0, builds: 0, folderBuilds: 0, failCopy: false };
  /* Predicates over (src, dest): a rename matching any of them rejects with EPERM. */
  const failRenames: Array<(src: string, dest: string) => boolean> = [];
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
    entered.push(h);
    h.enter();
    await h.released;
  }
  function releaseAll(): void {
    for (const h of Object.values(holds)) h?.release();
    for (const h of entered.splice(0)) h.release();
  }
  return { holds, state, failRenames, arm, maybeHold, releaseAll };
});

vi.mock('../export/build-mp3-zip.js', () => ({
  buildMp3Zip: vi.fn(async (opts: { outPath: string; onProgress?: (r: number) => void }) => {
    /* A progress tick replaces the jobs-map entry with a copy, as every real builder does. */
    opts.onProgress?.(0.5);
    await seam.maybeHold('builder');
    /* Different bytes per build so a test can tell which build the flat artifact holds. */
    const bytes = Buffer.from(`PK stub-zip-${++seam.state.builds}`);
    writeFileSync(opts.outPath, bytes);
    seam.state.revokeReady = !!seam.holds.revoke;
    return { sizeBytes: bytes.length, entries: ['stub'] };
  }),
  sanitiseForZip: (s: string) => s,
  ExportIncompleteError: class ExportIncompleteError extends Error {},
}));

vi.mock('../export/build-mp3-folder.js', () => ({
  buildMp3Folder: vi.fn(async (opts: { outDir: string }) => {
    await seam.maybeHold('folderBuild');
    mkdirSync(opts.outDir, { recursive: true });
    /* Per-call bytes so a test can tell which build a folder holds. */
    writeFileSync(join(opts.outDir, '01.mp3'), Buffer.from(`id3-${++seam.state.folderBuilds}`));
    return { totalBytes: 5, entries: [join(opts.outDir, '01.mp3')] };
  }),
}));

vi.mock('../workspace/atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/atomic-rename.js')>();
  return {
    ...actual,
    renameWithRetry: vi.fn(async (src: string, dest: string) => {
      if (seam.failRenames.some((f) => f(src, dest))) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${src}' -> '${dest}'`), {
          code: 'EPERM',
          syscall: 'rename',
          path: src,
        });
      }
      /* The first manifest write's tmp -> manifest rename (not the .bak rotation). */
      if (dest.includes('export-manifests') && dest.endsWith('.json')) await seam.maybeHold('manifestRename');
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
    /* The stage has LANDED (tmp present, final untouched) when `syncCopy` is
       entered: the cancel arrives before the commit. */
    stageToSyncFolder: vi.fn(async (...a: Parameters<typeof actual.stageToSyncFolder>) => {
      const r = await actual.stageToSyncFolder(...a);
      await seam.maybeHold('syncCopy');
      return r;
    }),
    /* `syncCommit` is entered AFTER the real commit rename landed. */
    commitSyncStage: vi.fn(async (...a: Parameters<typeof actual.commitSyncStage>) => {
      const r = await actual.commitSyncStage(...a);
      await seam.maybeHold('syncCommit');
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
  /* `cancelRm` holds the first removal of a job-private `.partial-` path: that is
     bailIfCancelled's own rm, reached right after the post-copy syncPath patch
     and before the job's catch/finally rewrite the map entry. */
  const copyFile = (async (...a: Parameters<typeof actual.copyFile>) => {
    if (seam.state.failCopy) {
      throw Object.assign(
        new Error(`EPERM: operation not permitted, copyfile '${String(a[0])}' -> '${String(a[1])}'`),
        { code: 'EPERM', syscall: 'copyfile', path: String(a[0]) },
      );
    }
    return actual.copyFile(...a);
  }) as typeof actual.copyFile;
  const rm = (async (...a: Parameters<typeof actual.rm>) => {
    if (seam.holds.cancelRm && String(a[0]).includes('.partial-')) await seam.maybeHold('cancelRm');
    return actual.rm(...a);
  }) as typeof actual.rm;
  return { ...actual, readdir, rm, copyFile, default: { ...actual, readdir, rm, copyFile } };
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
  seam.releaseAll();
  await awaitInFlightJobs?.();
  resetJobs?.();
  for (const k of Object.keys(seam.holds)) delete seam.holds[k];
  seam.state.revokeReady = false;
  seam.state.renameCalls = 0;
  seam.state.builds = 0;
  seam.state.folderBuilds = 0;
  seam.state.failCopy = false;
  seam.failRenames.length = 0;
  rmSync(join(bookDir, 'exports'), { recursive: true, force: true });
  rmSync(join(bookDir, '.audiobook', 'export-manifests'), { recursive: true, force: true });
});

afterEach(() => {
  seam.releaseAll();
});

afterAll(async () => {
  seam.releaseAll();
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

  it('a cancel during a re-export\'s sync-folder copy leaves the earlier sync copy byte-identical and the earlier export intact (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-sync-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const first = await post('mp3-zip', 'sync-folder');
      await awaitInFlightJobs();
      const firstDone = (await request(app).get(`/api/books/${bookId}/exports/${first.id}`)).body;
      expect(firstDone.status).toBe('done');
      const firstSyncBytes = readFileSync(firstDone.syncPath);
      expect(firstSyncBytes.toString()).toBe('PK stub-zip-1');
      const flatLocal = join(exportsDir(), first.filename);
      const firstLocalBytes = readFileSync(flatLocal);

      const copy = seam.arm('syncCopy');
      const second = await post('mp3-zip', 'sync-folder');
      await copy.entered;
      /* The stage landed: a job-private tmp sits beside the untouched flat copy. */
      expect(ls(join(syncRoot, AUTHOR)).some((n) => n.includes('.tmp-'))).toBe(true);
      expect(readFileSync(firstDone.syncPath).equals(firstSyncBytes)).toBe(true);
      const del = await request(app).delete(`/api/books/${bookId}/exports/${second.id}`);
      expect(del.status).toBe(204);
      copy.release();
      await awaitInFlightJobs();

      const mem = (await request(app).get(`/api/books/${bookId}/exports/${second.id}`)).body;
      expect(mem.status).toBe('cancelled');
      expect(mem.syncPath ?? null).toBeNull();
      expect(readFileSync(firstDone.syncPath).equals(firstSyncBytes)).toBe(true);
      expect(ls(join(syncRoot, AUTHOR))).toEqual([first.filename]);
      const firstAfter = (await request(app).get(`/api/books/${bookId}/exports/${first.id}`)).body;
      expect(firstAfter.status).toBe('done');
      expect(existsSync(firstAfter.syncPath)).toBe(true);
      expect(readFileSync(flatLocal).equals(firstLocalBytes)).toBe(true);
      expect(ls(exportsDir()).filter((n) => n.includes('.partial-'))).toEqual([]);
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('a cancel after the sync commit leaves the new synced copy and syncPath, and skips the local rename (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-sync-commit-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const first = await post('mp3-zip', 'sync-folder');
      await awaitInFlightJobs();
      const flatLocal = join(exportsDir(), first.filename);
      const firstLocalBytes = readFileSync(flatLocal);
      expect(firstLocalBytes.toString()).toBe('PK stub-zip-1');

      const commit = seam.arm('syncCommit');
      const second = await post('mp3-zip', 'sync-folder');
      await commit.entered;
      const del = await request(app).delete(`/api/books/${bookId}/exports/${second.id}`);
      expect(del.status).toBe(204);
      commit.release();
      await awaitInFlightJobs();

      const syncFile = join(syncRoot, AUTHOR, first.filename);
      expect(readFileSync(syncFile).toString()).toBe('PK stub-zip-2');
      expect(ls(join(syncRoot, AUTHOR))).toEqual([first.filename]);
      const mem = (await request(app).get(`/api/books/${bookId}/exports/${second.id}`)).body;
      expect(mem.status).toBe('cancelled');
      expect(manifestOf(second.id).status).toBe('cancelled');
      expect(manifestOf(second.id).syncPath).toBe(syncFile);
      expect(readFileSync(flatLocal).equals(firstLocalBytes)).toBe(true);
      expect(ls(exportsDir()).filter((n) => n.includes('.partial-'))).toEqual([]);
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  const SYNC_SENTENCE = 'Cancelled by user. The files were already copied to the sync folder.';

  it('a cancel after the sync commit records the sync-folder sentence, publishes syncPath to the map before the job settles, and does not revert the cancel (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-sync-reason-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const commit = seam.arm('syncCommit');
      const bail = seam.arm('cancelRm');
      const job = await post('mp3-zip', 'sync-folder');
      await commit.entered;
      expect((await request(app).delete(`/api/books/${bookId}/exports/${job.id}`)).status).toBe(204);
      commit.release();
      /* The job is now inside bailIfCancelled's rm: the syncPath patch has run, but
         the job's own catch/finally have not yet rewritten the map entry. What
         the map holds here is only what the patch did, so a patch that copied
         the job's own in_progress object over it would show up as a revert. */
      await bail.entered;
      const syncFile = join(syncRoot, AUTHOR, job.filename);
      const midway = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
      expect(midway.status).toBe('cancelled');
      expect(midway.syncPath).toBe(syncFile);
      expect(midway.errorReason).toBe(SYNC_SENTENCE);
      bail.release();
      await awaitInFlightJobs();

      const mem = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
      expect(mem.status).toBe('cancelled');
      expect(mem.syncPath).toBe(syncFile);
      expect(mem.errorReason).toBe(SYNC_SENTENCE);
      expect(manifestOf(job.id).status).toBe('cancelled');
      expect(manifestOf(job.id).syncPath).toBe(syncFile);
      expect(manifestOf(job.id).errorReason).toBe(SYNC_SENTENCE);
      expect(existsSync(syncFile)).toBe(true);
    } finally {
      seam.releaseAll();
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('an mp3-folder cancelled during the swap after its sync copy: DELETE already reads the sync-folder sentence and the synced copy stays (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-folder-reason-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      /* `rename` is the staging->flat swap, entered after the sync copy and its patch. */
      const swap = seam.arm('rename');
      const job = await post('mp3-folder', 'sync-folder');
      await swap.entered;
      expect((await request(app).delete(`/api/books/${bookId}/exports/${job.id}`)).status).toBe(204);
      const syncDir = join(syncRoot, AUTHOR, TITLE);
      const afterDelete = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
      expect(afterDelete.status).toBe('cancelled');
      expect(afterDelete.syncPath).toBe(syncDir);
      expect(afterDelete.errorReason).toBe(SYNC_SENTENCE);
      swap.release();
      await awaitInFlightJobs();

      expect(manifestOf(job.id).status).toBe('cancelled');
      expect(manifestOf(job.id).syncPath).toBe(syncDir);
      expect(manifestOf(job.id).errorReason).toBe(SYNC_SENTENCE);
      expect(readFileSync(join(syncDir, '01.mp3')).toString()).toBe('id3-1');
    } finally {
      seam.releaseAll();
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
    expect(mem.syncPath ?? null).toBeNull();
    expect(manifestOf(job.id).status).toBe('cancelled');
    expect(manifestOf(job.id).errorReason).toBe('Cancelled by user.');
  });

  it('a cancel while a re-export builds keeps the previous export of that format byte-identical and downloadable (#4228)', async () => {
    const first = await post('mp3-zip', 'download');
    await awaitInFlightJobs();
    const flat = join(exportsDir(), first.filename);
    const firstBytes = readFileSync(flat);
    expect(firstBytes.toString()).toBe('PK stub-zip-1');
    const firstGet = (await request(app).get(`/api/books/${bookId}/exports/${first.id}`)).body;
    expect(firstGet.status).toBe('done');
    expect(firstGet.downloadUrl).toBeTruthy();

    const builder = seam.arm('builder');
    const second = await post('mp3-zip', 'download');
    await builder.entered;
    expect((await request(app).delete(`/api/books/${bookId}/exports/${second.id}`)).status).toBe(204);
    builder.release();
    await awaitInFlightJobs();

    expect(readFileSync(flat).equals(firstBytes)).toBe(true);
    expect((await request(app).get(`/api/books/${bookId}/exports/${first.id}`)).body.status).toBe('done');
    const dl = await request(app)
      .get(`/api/books/${bookId}/exports/${first.id}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(Buffer.from(dl.body).equals(firstBytes)).toBe(true);
    expect((await request(app).get(`/api/books/${bookId}/exports/${second.id}`)).body.status).toBe('cancelled');
    expect(ls(exportsDir()).filter((n) => n.includes('.partial-'))).toEqual([]);
  });

  it('a cancel during the rename into place is never undone: the second build stays as the newest export and nothing is deleted (#4228)', async () => {
    const first = await post('mp3-zip', 'download');
    await awaitInFlightJobs();
    const flat = join(exportsDir(), first.filename);
    expect(readFileSync(flat).toString()).toBe('PK stub-zip-1');

    const rename = seam.arm('rename');
    const second = await post('mp3-zip', 'download');
    await rename.entered;
    expect((await request(app).delete(`/api/books/${bookId}/exports/${second.id}`)).status).toBe(204);
    rename.release();
    await awaitInFlightJobs();

    expect(existsSync(flat)).toBe(true);
    expect(readFileSync(flat).toString()).toBe('PK stub-zip-2');
    expect(ls(exportsDir()).filter((n) => n.includes('.partial-'))).toEqual([]);
    expect((await request(app).get(`/api/books/${bookId}/exports/${second.id}`)).body.status).toBe('cancelled');
    expect(manifestOf(second.id).status).toBe('cancelled');
    expect(manifestOf(first.id).status).toBe('done');
    expect((await request(app).get(`/api/books/${bookId}/exports/${first.id}`)).body.status).toBe('done');
  });

  const droppings = () => ls(exportsDir()).filter((n) => n.includes('.partial-') || n.includes('.old-'));

  it('an mp3-folder cancelled while the builder runs with no earlier export leaves nothing behind', async () => {
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
      expect(droppings()).toEqual([]);
      expect(ls(join(syncRoot, AUTHOR))).toEqual([]);
      expect((await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body.status).toBe('cancelled');
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('an mp3-folder re-export cancelled while the builder runs keeps the previous flat folder and synced copy (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-folder-prev-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const first = await post('mp3-folder', 'sync-folder');
      await awaitInFlightJobs();
      const flat = join(exportsDir(), first.filename, '01.mp3');
      const synced = join(syncRoot, AUTHOR, TITLE, '01.mp3');
      expect(readFileSync(flat).toString()).toBe('id3-1');
      expect(readFileSync(synced).toString()).toBe('id3-1');

      const build = seam.arm('folderBuild');
      const second = await post('mp3-folder', 'sync-folder');
      await build.entered;
      expect((await request(app).delete(`/api/books/${bookId}/exports/${second.id}`)).status).toBe(204);
      build.release();
      await awaitInFlightJobs();

      expect(readFileSync(flat).toString()).toBe('id3-1');
      expect(readFileSync(synced).toString()).toBe('id3-1');
      expect((await request(app).get(`/api/books/${bookId}/exports/${first.id}`)).body.status).toBe('done');
      expect((await request(app).get(`/api/books/${bookId}/exports/${second.id}`)).body.status).toBe('cancelled');
      expect(droppings()).toEqual([]);
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('an mp3-folder re-export cancelled during its sync copy keeps the previous flat folder and leaves the synced files (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-folder-sync-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const first = await post('mp3-folder', 'sync-folder');
      await awaitInFlightJobs();
      const flat = join(exportsDir(), first.filename, '01.mp3');
      const synced = join(syncRoot, AUTHOR, TITLE, '01.mp3');
      expect(readFileSync(flat).toString()).toBe('id3-1');

      const copy = seam.arm('syncCopy');
      const second = await post('mp3-folder', 'sync-folder');
      await copy.entered;
      expect((await request(app).delete(`/api/books/${bookId}/exports/${second.id}`)).status).toBe(204);
      copy.release();
      await awaitInFlightJobs();

      expect(readFileSync(flat).toString()).toBe('id3-1');
      /* The sync folder merges per file, so the second build's copy stays. */
      expect(readFileSync(synced).toString()).toBe('id3-2');
      expect(droppings()).toEqual([]);
      const mem = (await request(app).get(`/api/books/${bookId}/exports/${second.id}`)).body;
      expect(mem.status).toBe('cancelled');
      expect(manifestOf(second.id).syncPath).toBe(join(syncRoot, AUTHOR, TITLE));
      expect(manifestOf(second.id).errorReason).toBe(SYNC_SENTENCE);
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('a second completed mp3-folder export replaces the flat folder and leaves no staging or .old- entries (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-folder-swap-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const first = await post('mp3-folder', 'sync-folder');
      await awaitInFlightJobs();
      const second = await post('mp3-folder', 'sync-folder');
      await awaitInFlightJobs();

      expect(readFileSync(join(exportsDir(), first.filename, '01.mp3')).toString()).toBe('id3-2');
      expect((await request(app).get(`/api/books/${bookId}/exports/${second.id}`)).body.status).toBe('done');
      expect(droppings()).toEqual([]);
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  /* An mp3-folder re-export whose swap onto the flat folder fails (a scanner holds a
     fresh mp3, say): staging -> flat rejects; with `restoreFails`, `.old-` -> flat
     rejects too. */
  async function failedSwap(restoreFails: boolean) {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-swapfail-'));
    await writeUserSettings({ exportSyncFolder: syncRoot });
    const first = await post('mp3-folder', 'sync-folder');
    await awaitInFlightJobs();
    seam.failRenames.push((src, dest) => src.includes('.partial-') && !dest.includes('.old-'));
    if (restoreFails) seam.failRenames.push((src, dest) => src.includes('.old-') && !dest.includes('.old-'));
    const second = await post('mp3-folder', 'sync-folder');
    await awaitInFlightJobs();
    return { syncRoot, first, second };
  }

  it('a failed mp3-folder swap whose restore succeeds leaves the previous export byte-identical at the flat name (#4228)', async () => {
    let syncRoot = '';
    try {
      const r = await failedSwap(false);
      syncRoot = r.syncRoot;
      const second = (await request(app).get(`/api/books/${bookId}/exports/${r.second.id}`)).body;
      expect(second.status).toBe('failed');
      expect(readFileSync(join(exportsDir(), r.first.filename, '01.mp3')).toString()).toBe('id3-1');
      expect(droppings()).toEqual([]);
    } finally {
      await awaitInFlightJobs();
      if (syncRoot) rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('a failed mp3-folder swap whose restore also fails never deletes the previous export (#4228)', async () => {
    let syncRoot = '';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await failedSwap(true);
      syncRoot = r.syncRoot;
      const second = (await request(app).get(`/api/books/${bookId}/exports/${r.second.id}`)).body;
      expect(second.status).toBe('failed');
      /* The previous folder sits in its dot-prefixed swap-aside, byte-identical, not deleted. */
      const aside = ls(exportsDir()).filter((n) => n.startsWith('.') && n.includes('.old-'));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(exportsDir(), aside[0], '01.mp3')).toString()).toBe('id3-1');
      expect(ls(exportsDir()).filter((n) => n.includes('.partial-'))).toEqual([]);
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes('could not restore the previous export'))).toBe(true);
    } finally {
      errSpy.mockRestore();
      await awaitInFlightJobs();
      if (syncRoot) rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('a previous done mp3-folder manifest survives a rehydrate while its folder sits in the swap-aside (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-aside-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const first = await post('mp3-folder', 'sync-folder');
      await awaitInFlightJobs();
      renameSync(join(exportsDir(), first.filename), join(exportsDir(), `.${first.filename}.old-exp_crash`));
      resetJobs();
      const list = (await request(app).get(`/api/books/${bookId}/exports`)).body as Array<{ id: string }>;
      expect(list.map((j) => j.id)).toContain(first.id);
      expect(existsSync(join(bookDir, '.audiobook', 'export-manifests', `${first.id}.json`))).toBe(true);
    } finally {
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('the job record marks the mp3-folder sync copy in flight while it runs, and a cancel during it reads in-flight, then the landed syncPath (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-inflight-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const copy = seam.arm('syncCopy');
      const job = await post('mp3-folder', 'sync-folder');
      await copy.entered;
      expect((await request(app).delete(`/api/books/${bookId}/exports/${job.id}`)).status).toBe(204);
      /* What the modal reads right after DELETE: cancelled, no syncPath yet, copy in flight. */
      const during = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
      expect(during.status).toBe('cancelled');
      expect(during.syncPath ?? null).toBeNull();
      expect(during.syncCopyInFlight).toBe(true);
      copy.release();
      await awaitInFlightJobs();
      const after = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
      expect(after.status).toBe('cancelled');
      expect(after.syncCopyInFlight).toBe(false);
      expect(after.syncPath).toBe(join(syncRoot, AUTHOR, TITLE));
      expect(manifestOf(job.id).syncCopyInFlight).toBe(false);
    } finally {
      seam.releaseAll();
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('a single-file sync commit is marked in flight too (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-inflight-file-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const commit = seam.arm('syncCommit');
      const job = await post('mp3-zip', 'sync-folder');
      await commit.entered;
      expect((await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body.syncCopyInFlight).toBe(true);
      commit.release();
      await awaitInFlightJobs();
      const done = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
      expect(done.status).toBe('done');
      expect(done.syncCopyInFlight).toBe(false);
    } finally {
      seam.releaseAll();
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('a sync-copy failure under a OneDrive path reports a reason with no workspace or sync-folder path (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-leak-'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeUserSettings({ exportSyncFolder: join(syncRoot, 'OneDrive', 'Audiobooks') });
      seam.state.failCopy = true;
      const job = await post('mp3-zip', 'sync-folder');
      await awaitInFlightJobs();
      const mem = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
      expect(mem.status).toBe('failed');
      expect(mem.errorReason).toMatch(/OneDrive folder/);
      expect(mem.errorReason).toContain('EPERM');
      for (const text of [mem.errorReason, String(manifestOf(job.id).errorReason)]) {
        expect(text).not.toContain(workspaceRoot);
        expect(text).not.toContain(syncRoot);
        expect(text).not.toMatch(/copyfile/i);
      }
    } finally {
      errSpy.mockRestore();
      seam.state.failCopy = false;
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('a local commit failing after the sync copy landed says the files were already copied (#4228)', async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-failafter-'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      seam.failRenames.push((src) => src.includes('.partial-'));
      const job = await post('mp3-zip', 'sync-folder');
      await awaitInFlightJobs();
      const syncFile = join(syncRoot, AUTHOR, job.filename);
      const mem = (await request(app).get(`/api/books/${bookId}/exports/${job.id}`)).body;
      expect(mem.status).toBe('failed');
      expect(mem.syncPath).toBe(syncFile);
      expect(mem.errorReason).toContain('The files were already copied to the sync folder.');
      expect(mem.errorReason).not.toContain(workspaceRoot);
      expect(String(manifestOf(job.id).errorReason)).toContain('already copied to the sync folder');
      expect(existsSync(syncFile)).toBe(true);
    } finally {
      errSpy.mockRestore();
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it("DELETE's manifest write cannot land after the job's own later write: the final manifest keeps syncPath (#4228)", async () => {
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-seam-order-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });
      const commit = seam.arm('syncCommit');
      const heldWrite = seam.arm('manifestRename');
      const job = await post('mp3-zip', 'sync-folder');
      await commit.entered;
      /* DELETE snapshots the job BEFORE syncPath is published, and its manifest rename is held. */
      const del = request(app)
        .delete(`/api/books/${bookId}/exports/${job.id}`)
        .then((r) => r);
      await heldWrite.entered;
      commit.release();
      /* Let the job run on to its own `finally` manifest write while DELETE's is still held. */
      await new Promise((r) => setTimeout(r, 200));
      heldWrite.release();
      expect((await del).status).toBe(204);
      await awaitInFlightJobs();
      expect(manifestOf(job.id).syncPath).toBe(join(syncRoot, AUTHOR, job.filename));
    } finally {
      seam.releaseAll();
      await awaitInFlightJobs();
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });
});
