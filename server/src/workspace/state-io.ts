/* Atomic JSON read/write for .audiobook/*.json.

   Write strategy: serialise to a temp file alongside the target, fsync, then
   rename over the target. This avoids partial writes if the process is killed
   mid-write and preserves the previous file until the rename completes.

   Windows + OneDrive caveat: when the destination is in a OneDrive-synced
   folder, OneDrive briefly holds a read handle on the file as part of its
   change-detection probe. A rename() landing in that window fails with
   `EPERM`. Retry a few times with exponential backoff so a 50–100ms hold
   doesn't surface as a persistence failure to the user.

   Rotating backups (opt-in via `{ rotate: { keep: N } }`): higher-value
   files like `.audiobook/state.json` opt into pre-write rotation so a
   future schema migration / corrupt write / OneDrive race that survives
   the rename-retry is recoverable from a recent snapshot. Other files
   (cast.json, revisions.json, ...) keep the single-file atomic write —
   they're cheaper to re-derive on loss and not worth the disk-multiplier. */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { renameWithRetry } from './atomic-rename.js';

export interface WriteJsonOpts {
  /** Rotate `path` -> `path.bak.1`, shift `path.bak.{i}` -> `path.bak.{i+1}`,
   *  keep the newest `keep` backups (oldest is dropped). Skipped on first
   *  write (no existing file to rotate). Each rename uses `renameWithRetry`,
   *  so the rotation chain is self-healing across OneDrive/AV races —
   *  see the rotation tests in `state-io.test.ts` for the partial-failure
   *  resume contract. */
  rotate?: { keep: number };
}

export async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as T;
}

/** Read `path`. On JSON parse failure, fall back to `path.bak.1`,
 *  `path.bak.2`, ... `path.bak.{keep}` in order and return the first
 *  one that parses. When a backup is used, logs ONE warning naming the
 *  recovered backup so the operator can audit the corruption event;
 *  callers do NOT see the underlying parse error.
 *
 *  When the main file is missing entirely (`existsSync === false`) we
 *  return `null` like `readJson` — recovery is only for "file exists
 *  but JSON.parse rejects it". When the main file is corrupt AND every
 *  backup is corrupt / missing, the original parse error is re-thrown
 *  so the caller surfaces the same diagnostic it would have seen from
 *  `readJson` directly.
 *
 *  Pairs with the `{ rotate }` option on `writeJsonAtomic`. */
export async function readJsonWithRecovery<T>(
  path: string,
  opts: { keep: number },
): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (originalErr) {
    for (let i = 1; i <= opts.keep; i += 1) {
      const backupPath = `${path}.bak.${i}`;
      if (!existsSync(backupPath)) continue;
      try {
        const raw = await readFile(backupPath, 'utf8');
        const value = JSON.parse(raw) as T;
        console.warn(
          `[state-io] ${path} was unreadable (${(originalErr as Error).message}); ` +
          `recovered from ${backupPath}.`,
        );
        return value;
      } catch {
        /* That backup is also corrupt — try the next one. */
      }
    }
    throw originalErr;
  }
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  opts?: WriteJsonOpts,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (opts?.rotate && existsSync(path)) {
    await rotateBackups(path, opts.rotate.keep);
  }
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

/** Shift the backup chain up by one slot before a new write lands.
 *  `path.bak.{keep-1}` → `path.bak.{keep}` first (drops what was in
 *  `bak.{keep}`), then `bak.{keep-2}` → `bak.{keep-1}`, …, finally
 *  `path` → `path.bak.1`. Walking top-down means each destination is
 *  vacant by the time we rename to it.
 *
 *  Each step is `renameWithRetry`, so a partial failure (e.g. EPERM mid-
 *  rotation) aborts but leaves the chain in a state the next call can
 *  resume: the `existsSync` gates skip already-moved slots, and the next
 *  rotation completes the chain. No data loss path — every previous
 *  version of `path` lives in some `bak.i` slot until intentionally
 *  shifted off the end. */
async function rotateBackups(path: string, keep: number): Promise<void> {
  if (keep < 1) return;
  for (let i = keep - 1; i >= 1; i -= 1) {
    const src = `${path}.bak.${i}`;
    const dest = `${path}.bak.${i + 1}`;
    if (existsSync(src)) {
      await renameWithRetry(src, dest);
    }
  }
  await renameWithRetry(path, `${path}.bak.1`);
}
