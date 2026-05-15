/* Atomic JSON read/write for .audiobook/*.json.

   Write strategy: serialise to a temp file alongside the target, fsync, then
   rename over the target. This avoids partial writes if the process is killed
   mid-write and preserves the previous file until the rename completes.

   Windows + OneDrive caveat: when the destination is in a OneDrive-synced
   folder, OneDrive briefly holds a read handle on the file as part of its
   change-detection probe. A rename() landing in that window fails with
   `EPERM`. Retry a few times with exponential backoff so a 50–100ms hold
   doesn't surface as a persistence failure to the user. */

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

const RENAME_RETRY_DELAYS_MS = [25, 75, 200, 500];

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

async function renameWithRetry(src: string, dest: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rename(src, dest);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      /* EPERM / EBUSY on Windows is almost always a transient handle held
         by AV / OneDrive / Defender / indexer. Retry.
         ENOENT is also transient under OneDrive: the sync client briefly
         moves the just-written tmp file into its own staging dir to scan
         it, then drops it back — if the rename lands during the move
         window we see ENOENT on src even though writeFile resolved cleanly
         milliseconds earlier. Treat it the same as EPERM/EBUSY: retry
         with backoff. A real "file doesn't exist" caller error would have
         failed at writeFile, not here. Crashed the Node server on
         2026-05-15 from a library-cast-override call landing inside a
         OneDrive scan window.
         Anything else (EACCES, EXDEV cross-device) is a real fault —
         surface immediately. */
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOENT') throw e;
      lastErr = e;
      if (attempt === RENAME_RETRY_DELAYS_MS.length) break;
      await new Promise(r => setTimeout(r, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
  throw lastErr;
}
