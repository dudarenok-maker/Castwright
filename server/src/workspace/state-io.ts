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
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { renameWithRetry } from './atomic-rename.js';

/* Monotonic in-process counter so two `writeJsonAtomic` calls that arrive
   in the same millisecond (same `Date.now()`, same `process.pid`) don't
   collide on temp-file names. Without this, plan 88 pipelining produced
   ENOENT-on-rename races: Phase 0 and Phase 1 both save to the same
   cache path inside a single tick, both pick `${path}.tmp-${pid}-${ts}`,
   one renames the temp away, the other's `renameWithRetry(tmp, path)`
   then explodes because its tmp no longer exists. */
let tmpSeq = 0;

export interface WriteJsonOpts {
  /** Rename `path` -> `path.bak.1` (after the new bytes are safely in a tmp
   *  file), shift `path.bak.{i}` -> `path.bak.{i+1}`,
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
  /* Strip a leading UTF-8 BOM (U+FEFF) if present. Node does not strip it
     when reading with 'utf8' encoding, and JSON.parse rejects the BOM as
     invalid. Windows editors and PowerShell 5.1's -Encoding utf8 write a
     BOM, so this handles user hand-edits and automated writes. */
  const stripped = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
  return JSON.parse(stripped) as T;
}

/** Read `path`. On JSON parse failure, fall back to `path.bak.1`,
 *  `path.bak.2`, ... `path.bak.{keep}` in order and return the first
 *  one that parses. When a backup is used, logs ONE warning naming the
 *  recovered backup so the operator can audit the corruption event;
 *  callers do NOT see the underlying parse error.
 *
 *  Any non-parse read error (EBUSY / EPERM / EIO — a transient lock on a
 *  HEALTHY file) is re-thrown untouched: `.bak.1` is the state before the
 *  last write, so substituting it and writing back would silently revert
 *  that write.
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
  opts: { keep: number; recoverMissing?: boolean },
): Promise<T | null> {
  /* `recoverMissing` (state.json only): an absent main is a STRANDED one - a
     crash between the rotation's renames, or a failed rename-in whose restore
     also failed - so it falls back to the newest parseable backup instead of
     reading as "no file". Callers where absence means "defaults" don't set it. */
  if (!opts.recoverMissing && !existsSync(path)) return null;
  /* The read sits OUTSIDE the try: only a parse failure (or, opted in, a
     missing main) may fall back. */
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (readErr) {
    if (opts.recoverMissing && (readErr as NodeJS.ErrnoException).code === 'ENOENT') {
      return (await readNewestBackup<T>(path, opts.keep, 'was missing')) ?? null;
    }
    throw readErr;
  }
  try {
    /* Strip a leading UTF-8 BOM (U+FEFF) if present. Node does not strip it
       when reading with 'utf8' encoding, and JSON.parse rejects the BOM as
       invalid. Windows editors and PowerShell 5.1's -Encoding utf8 write a
       BOM, so this handles user hand-edits and automated writes. */
    const stripped = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
    return JSON.parse(stripped) as T;
  } catch (originalErr) {
    if (!(originalErr instanceof SyntaxError)) throw originalErr;
    const recovered = await readNewestBackup<T>(
      path,
      opts.keep,
      `was unreadable (${originalErr.message})`,
    );
    if (recovered !== undefined) return recovered;
    throw originalErr;
  }
}

/** The newest `path.bak.{1..keep}` that parses (logging ONE warning naming it),
 *  or `undefined` when none does. */
async function readNewestBackup<T>(
  path: string,
  keep: number,
  why: string,
): Promise<T | undefined> {
  for (let i = 1; i <= keep; i += 1) {
    const backupPath = `${path}.bak.${i}`;
    if (!existsSync(backupPath)) continue;
    try {
      const raw = await readFile(backupPath, 'utf8');
      /* Strip a leading UTF-8 BOM (U+FEFF) if present. */
      const stripped = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
      const value = JSON.parse(stripped) as T;
      console.warn(`[state-io] ${path} ${why}; recovered from ${backupPath}.`);
      return value;
    } catch {
      /* That backup is also corrupt - try the next one. */
    }
  }
  return undefined;
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  opts?: WriteJsonOpts,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  /* Unique per call: pid + monotonic in-process counter + a 4-byte random
     suffix. The counter alone defeats same-millisecond collisions inside
     one process; the random tail defends against a hypothetical second
     worker process landing on the same `${pid}-${seq}` (the seq resets per
     process). All three components stay short so the path doesn't blow
     past Windows' 260-char limit on deeply-nested workspace folders. */
  const seq = (tmpSeq = (tmpSeq + 1) >>> 0);
  const rnd = randomBytes(4).toString('hex');
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${seq}-${rnd}`;
  /* Order matters (#3625 review): write the tmp FIRST, then rotate, then
     rename tmp onto the vacated name. A failed tmp write (ENOSPC) must not
     have shifted the backup chain — N failed writes over a torn main would
     otherwise propagate the torn bytes through every `.bak.N` — and the main
     file is never COPIED while another handle holds it (an AV/indexer scan
     makes CopyFile fail on Windows). Rotation moves main away by rename,
     which an open handle does not block, so the final rename lands on a
     vacant name instead of replacing a held file. */
  let rotated = false;
  try {
    /* `flush: true` fsyncs through the SAME handle before it closes — the
       header's durability claim without a reopen (a second open of a fresh tmp
       is an unretried EBUSY point on Windows and adds a scan-on-close). It also
       keeps `writeFile` the one seam the failure-injection tests hook. */
    await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', flush: true });
    if (opts?.rotate && existsSync(path)) {
      rotated = await rotateBackups(path, opts.rotate.keep);
    }
    await renameWithRetry(tmp, path);
  } catch (e) {
    /* Cleanup the temp file on terminal failure so we don't leak
       .tmp-<pid>-<ts> droppings into the workspace. */
    await unlink(tmp).catch(() => {});
    /* The rename-in failed after main was moved to `.bak.1`: put it back so a
       reader never finds the book without its main file. */
    if (rotated && !existsSync(path)) {
      await renameWithRetry(`${path}.bak.1`, path).catch((restoreErr) => {
        /* Not swallowed silently: main is now absent and only the recovering
           reader (which falls back to `.bak.1`) stands between the book and a
           hand repair. */
        console.warn(
          `[state-io] ${path}: the write failed after rotation and restoring ` +
            `${path}.bak.1 failed too (${(restoreErr as Error).message}); ` +
            `readers will recover from the backup.`,
        );
      });
    }
    throw e;
  }
}

/* #3427 — per-path op chain. `writeJsonAtomic` does not order same-path
   writes (and its EPERM retry jitters), so two overlapping writes to one file
   could land out of call order and let an older snapshot clobber a newer one.
   Each op awaits the previous op for the same path before running. A plain
   in-process chain rather than `withKeyLock`: that helper's 10s acquisition
   timeout would turn a slow disk into a thrown write. The tail is stored as a
   never-rejecting promise so a failed op cannot wedge the chain; the caller
   still gets the real rejection from its own op. */
const pathTails = new Map<string, Promise<void>>();

/** Run `op` after every earlier-called op for the same path has settled. */
export async function enqueuePathOp(path: string, op: () => Promise<void>): Promise<void> {
  const prev = pathTails.get(path) ?? Promise.resolve();
  const run = prev.then(op);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  pathTails.set(path, tail);
  try {
    await run;
  } finally {
    if (pathTails.get(path) === tail) pathTails.delete(path);
  }
}

/** Shift the backup chain up by one slot before a new write lands.
 *  `path.bak.{keep-1}` → `path.bak.{keep}` first (drops what was in
 *  `bak.{keep}`), then `bak.{keep-2}` → `bak.{keep-1}`, …, finally
 *  `path` is RENAMED to `path.bak.1`, vacating the main name for the caller's
 *  tmp -> main rename. Walking top-down means each destination is vacant by
 *  the time we rename to it.
 *
 *  Returns true when main was moved away (so the caller can restore it if the
 *  rename-in then fails). Each step is `renameWithRetry`, so a partial failure
 *  (e.g. EPERM mid-rotation) aborts but leaves the chain in a state the next
 *  call can resume: the `existsSync` gates skip already-moved slots, and the
 *  next rotation completes the chain. No data loss path — every previous
 *  version of `path` lives in some `bak.i` slot until intentionally
 *  shifted off the end. */
async function rotateBackups(path: string, keep: number): Promise<boolean> {
  if (keep < 1) return false;
  for (let i = keep - 1; i >= 1; i -= 1) {
    const src = `${path}.bak.${i}`;
    const dest = `${path}.bak.${i + 1}`;
    if (existsSync(src)) {
      await renameWithRetry(src, dest);
    }
  }
  await renameWithRetry(path, `${path}.bak.1`);
  return true;
}
