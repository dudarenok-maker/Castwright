/* Atomic JSON read/write for .audiobook/*.json.

   Write strategy: serialise to a temp file alongside the target, fsync, then
   rename over the target. This avoids partial writes if the process is killed
   mid-write and preserves the previous file until the rename completes.

   Windows + OneDrive caveat: when the destination is in a OneDrive-synced
   folder, OneDrive briefly holds a read handle on the file as part of its
   change-detection probe. A rename() landing in that window fails with
   `EPERM`. Retry a few times with exponential backoff so a 50–100ms hold
   doesn't surface as a persistence failure to the user. */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { renameWithRetry } from './atomic-rename.js';

export async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await renameWithRetry(tmp, path);
  } catch (e) {
    /* Cleanup the temp file on terminal failure so we don't leak
       .tmp-<pid>-<ts> droppings into the workspace. */
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
