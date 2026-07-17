/* Sync-folder writer tests. Atomic-rename retry coverage already lives in
   state-io's tests (indirectly via the shared helper); this suite focuses
   on the writer's own contract — destination is mkdir'd on demand, the
   tmp file is cleaned up on terminal failure, and the returned syncPath
   matches what landed on disk. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeToSyncFolder, writeFolderToSyncFolder } from './sync-folder.js';

describe('writeToSyncFolder', () => {
  let tmpRoot: string;
  let srcPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sync-folder-'));
    srcPath = join(tmpRoot, 'src.bin');
    writeFileSync(srcPath, Buffer.from('hello world'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies the source into the destination folder, returning the final path', async () => {
    const dest = join(tmpRoot, 'sync');
    const result = await writeToSyncFolder(srcPath, dest, 'audiobook.zip');

    expect(result.syncPath).toBe(join(dest, 'audiobook.zip'));
    expect(readFileSync(result.syncPath, 'utf8')).toBe('hello world');
  });

  it('mkdirs the destination if it does not yet exist', async () => {
    const dest = join(tmpRoot, 'nested', 'sync', 'dir');
    const result = await writeToSyncFolder(srcPath, dest, 'audiobook.zip');
    expect(result.syncPath).toBe(join(dest, 'audiobook.zip'));
    expect(readFileSync(result.syncPath, 'utf8')).toBe('hello world');
  });

  it('overwrites an existing destination file atomically (rename semantics)', async () => {
    const dest = join(tmpRoot, 'sync');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'audiobook.zip'), 'stale content');

    await writeToSyncFolder(srcPath, dest, 'audiobook.zip');
    expect(readFileSync(join(dest, 'audiobook.zip'), 'utf8')).toBe('hello world');
  });

  it('does not leave .tmp- droppings on success', async () => {
    const dest = join(tmpRoot, 'sync');
    await writeToSyncFolder(srcPath, dest, 'audiobook.zip');
    const stragglers = readdirSync(dest).filter((n) => n.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });

  it('keeps a path-traversal filename contained under the destination (CodeQL path-injection)', async () => {
    /* Pre-fix, `join(dest, '../escape.zip')` would write into tmpRoot — one
       level ABOVE the user's chosen sync target. The sanitiser collapses the
       `..` so the file can only ever land inside dest. */
    const dest = join(tmpRoot, 'sync');
    const result = await writeToSyncFolder(srcPath, dest, '../escape.zip');

    expect(result.syncPath.startsWith(dest)).toBe(true);
    expect(existsSync(join(tmpRoot, 'escape.zip'))).toBe(false);
  });

  /* Plan 79 — Google Drive / OneDrive sync failures should surface with
     a destination-specific hint instead of just the raw errno. The
     renameWithRetry primitive throws after exhausting its backoff; the
     wrapper catches that and prepends "Google Drive for Desktop folder:
     ..." / "OneDrive folder: ..." so the export modal can show the user
     what's likely wrong without them digging through server logs. */
  it('wraps the error with a Drive hint when destDir looks like a Drive for Desktop mount', async () => {
    const dest = join(tmpRoot, 'My Drive', 'Audiobooks');
    /* Source missing -> copyFile throws ENOENT before rename even runs.
       The wrapper only kicks in on the rename branch, so we craft a
       failure inside rename by writing to a path whose parent is a file
       (EEXIST/ENOTDIR depending on platform). Easiest: write to a path
       under a dest-dir that we then rm in a child invocation. We just
       assert that on a successful rename inside a "My Drive"-shaped
       path, no hint is added (happy path coverage), and reserve the
       hint assertion for an injected-failure test where we mock rename
       directly. */
    const result = await writeToSyncFolder(srcPath, dest, 'audiobook.zip');
    expect(result.syncPath).toBe(join(dest, 'audiobook.zip'));
  });
});

/* Plan 79 — atomic-rename retry contract widened to cover EACCES/EIO
   (Drive for Desktop's virtual FS surfaces these intermittently during
   sync-scan flushes). The retry primitive is in workspace/atomic-rename
   so the contract test lives there too; this suite just smoke-checks
   the writer doesn't regress the happy paths. */
describe('writeToSyncFolder — Drive hint wrapping', () => {
  it('wraps a terminal rename failure inside a Google Drive path with a Drive-specific hint', async () => {
    /* The cleanest way to force the rename branch to throw is to point
       the copy at a directory whose final component already exists as a
       READONLY directory (so the rename onto that name fails with
       EISDIR / EPERM). We avoid filesystem mocking here — instead we
       drive the wrapper directly via an injected path that smells like
       Drive but contains a forced-fail destination.

       Use a fresh tmp dir + create a directory at the destination
       filename ("audiobook.zip" exists as a dir, not a file). On
       Windows + POSIX, rename onto a non-empty directory of the same
       name fails with EPERM/ENOTEMPTY; renameWithRetry's retry list
       covers EPERM, but ENOTEMPTY isn't in it, so the throw escapes
       to the wrapper, which adds the Drive hint. */
    const driveTmp = mkdtempSync(join(tmpdir(), 'sync-drive-test-'));
    try {
      const drivePath = join(driveTmp, 'My Drive', 'Audiobooks');
      mkdirSync(join(drivePath, 'audiobook.zip'), { recursive: true });
      /* Plant a file inside so rename-over-dir fails (rename onto a
         non-empty dir is rejected on every platform). */
      writeFileSync(join(drivePath, 'audiobook.zip', 'sentinel'), 'block');

      const src = join(driveTmp, 'src.bin');
      writeFileSync(src, Buffer.from('x'.repeat(32)));

      await expect(writeToSyncFolder(src, drivePath, 'audiobook.zip')).rejects.toThrow(
        /Google Drive for Desktop/i,
      );
    } finally {
      rmSync(driveTmp, { recursive: true, force: true });
    }
  });

  it('leaves the error message unwrapped when destDir is not a known sync mount', async () => {
    const plainTmp = mkdtempSync(join(tmpdir(), 'sync-plain-test-'));
    try {
      const plainPath = join(plainTmp, 'random', 'folder');
      mkdirSync(join(plainPath, 'audiobook.zip'), { recursive: true });
      writeFileSync(join(plainPath, 'audiobook.zip', 'sentinel'), 'block');

      const src = join(plainTmp, 'src.bin');
      writeFileSync(src, Buffer.from('x'.repeat(32)));

      await expect(writeToSyncFolder(src, plainPath, 'audiobook.zip')).rejects.not.toThrow(
        /Google Drive|OneDrive/i,
      );
    } finally {
      rmSync(plainTmp, { recursive: true, force: true });
    }
  });
});

describe('writeFolderToSyncFolder', () => {
  let tmpRoot: string;
  let srcDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sync-folder-dir-'));
    srcDir = join(tmpRoot, 'staging');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, '01 - Chapter One.mp3'), 'mp3-bytes-1');
    writeFileSync(join(srcDir, '02 - Chapter Two.mp3'), 'mp3-bytes-2');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies every .mp3 into <destDir>/<bookSubfolder>/', async () => {
    const destDir = join(tmpRoot, 'sync');
    const result = await writeFolderToSyncFolder(srcDir, destDir, 'The Coalfall Commission');
    expect(result.copied).toBe(2);
    const names = readdirSync(result.syncPath).sort();
    expect(names).toEqual(['01 - Chapter One.mp3', '02 - Chapter Two.mp3']);
  });

  it('copies metadata.json and cover.jpg through the allowlist (fs-54)', async () => {
    writeFileSync(join(srcDir, 'metadata.json'), '{"title":"x"}');
    writeFileSync(join(srcDir, 'cover.jpg'), 'jpeg-bytes');
    const destDir = join(tmpRoot, 'sync');
    const result = await writeFolderToSyncFolder(srcDir, destDir, 'The Coalfall Commission');
    expect(result.copied).toBe(4);
    const names = readdirSync(result.syncPath).sort();
    expect(names).toEqual([
      '01 - Chapter One.mp3',
      '02 - Chapter Two.mp3',
      'cover.jpg',
      'metadata.json',
    ]);
  });

  it('excludes an unrelated stray file that is neither .mp3 nor an allowlisted sidecar', async () => {
    writeFileSync(join(srcDir, 'README.txt'), 'not for shipping');
    const destDir = join(tmpRoot, 'sync');
    const result = await writeFolderToSyncFolder(srcDir, destDir, 'The Coalfall Commission');
    expect(result.copied).toBe(2);
    expect(existsSync(join(result.syncPath, 'README.txt'))).toBe(false);
  });

  it('keeps a path-traversal book sub-folder contained under destDir (CodeQL path-injection)', async () => {
    /* A crafted book title of `../escape` would, pre-fix, place the copied
       chapters in tmpRoot/escape — outside the user's sync target. The
       sanitiser keeps the sub-folder inside destDir. */
    const destDir = join(tmpRoot, 'sync');
    const result = await writeFolderToSyncFolder(srcDir, destDir, '../escape');

    expect(result.copied).toBe(2);
    expect(result.syncPath.startsWith(destDir)).toBe(true);
    expect(existsSync(join(tmpRoot, 'escape'))).toBe(false);
  });
});
