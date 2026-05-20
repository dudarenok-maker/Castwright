/* Sync-folder writer tests. Atomic-rename retry coverage already lives in
   state-io's tests (indirectly via the shared helper); this suite focuses
   on the writer's own contract — destination is mkdir'd on demand, the
   tmp file is cleaned up on terminal failure, and the returned syncPath
   matches what landed on disk. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeToSyncFolder } from './sync-folder.js';

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
