/* Sync-folder writer for the export pipeline. Copies a freshly-built
   artifact (Phase A zip, Phase B m4b) into a user-configured destination
   directory — typically a OneDrive / Syncthing / Google Drive watch path
   the user mirrors to their Android phone.

   Atomic by design: writes to `<dest>/<filename>.tmp-<pid>-<ts>` first,
   then renames over the final name using the same EPERM/EBUSY/ENOENT
   backoff the workspace's state.json writer relies on. Without that,
   OneDrive's change-detection scan window briefly locks the destination
   and the rename surfaces as a spurious export failure (see the comment
   block in workspace/atomic-rename.ts).

   The writer mkdirs the destination on demand; it does NOT validate that
   the path makes sense (e.g. "is OneDrive actually syncing this folder").
   That's the user's call. */

import { copyFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { renameWithRetry } from '../workspace/atomic-rename.js';

export interface WriteToSyncFolderResult {
  syncPath: string;
}

export async function writeToSyncFolder(
  srcPath: string,
  destDir: string,
  filename: string,
): Promise<WriteToSyncFolderResult> {
  await mkdir(destDir, { recursive: true });
  const finalPath = join(destDir, filename);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;

  /* copyFile (not rename) because the source lives under the workspace
     and may be on a different volume than the sync folder — rename(2)
     across volumes fails with EXDEV on Windows, and the user's most
     likely sync folder (OneDrive under their profile) is genuinely on
     a different drive from the workspace under many setups. */
  await copyFile(srcPath, tmpPath);
  try {
    await renameWithRetry(tmpPath, finalPath);
  } catch (e) {
    /* Cleanup the tmp on terminal failure — leaving `.tmp-<pid>-<ts>`
       droppings inside a user's synced folder is the kind of thing they
       notice and complain about. */
    await unlink(tmpPath).catch(() => {});
    throw e;
  }
  return { syncPath: finalPath };
}

export interface WriteFolderToSyncFolderResult {
  /** Absolute path of the destination sub-folder the files landed in
      (e.g. `<destDir>/<bookSubfolder>`). */
  syncPath: string;
  /** Number of files copied. Excludes any non-matching entries already
      sitting in `srcDir`. */
  copied: number;
}

/* Folder variant for plan 34's MP3-folder export. Each file inside
   `srcDir` is copied into `<destDir>/<bookSubfolder>/` via the same
   tmp+renameWithRetry primitive so an in-flight copy can't surface a
   half-written file to whatever app is scanning the sync target. The
   destination sub-folder is created on demand; existing files in it
   are overwritten (renameWithRetry replaces atomically). */
export async function writeFolderToSyncFolder(
  srcDir: string,
  destDir: string,
  bookSubfolder: string,
): Promise<WriteFolderToSyncFolderResult> {
  const targetDir = join(destDir, bookSubfolder);
  await mkdir(targetDir, { recursive: true });

  const entries = await readdir(srcDir);
  let copied = 0;
  for (const name of entries) {
    /* Skip anything that doesn't look like a packed chapter file.
       Defensive — the builder only ever writes .mp3 today, but
       future formats (per-chapter cuesheets, README.txt) wouldn't
       want to leak into a Voice / Smart AudioBook folder scan. */
    if (!name.toLowerCase().endsWith('.mp3')) continue;
    const src = join(srcDir, name);
    const finalPath = join(targetDir, basename(name));
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${copied}`;
    await copyFile(src, tmpPath);
    try {
      await renameWithRetry(tmpPath, finalPath);
    } catch (e) {
      await unlink(tmpPath).catch(() => {});
      throw e;
    }
    copied++;
  }
  return { syncPath: targetDir, copied };
}
