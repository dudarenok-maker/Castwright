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

import { copyFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
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
