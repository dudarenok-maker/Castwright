/* Atomic JSON read/write for .audiobook/*.json.

   Write strategy: serialise to a temp file alongside the target, fsync, then
   rename it onto the target. A non-rotating write renames OVER the existing
   file, so the previous bytes survive until that rename completes. A rotating
   write (`{ rotate }`) first moves the old file to `.bak.1` and renames the tmp
   onto the vacated name: a kill between the two renames leaves main absent
   (the previous state is in `.bak.1`), and for a moment during EVERY rotating
   write main is absent too. A plain read (`readJson`, `existsSync`) in that
   window sees no file, so every reader of a rotated file must recover:
   `readJsonWithRecovery` with `recoverMissing` serves the backup. For
   state.json that is `readStateJsonWithRecovery` (state-migrate.ts), and
   `state-json-read.guard.test.ts` fails the build on a plain state.json read.
   The rotating write also drops a `<file>.writing-<pid>-<n>` marker BEFORE the
   first rename and removes it after the rename-in, for a caller where absence
   can also mean a deliberate delete (user-settings.json): a marker that
   explains the absence (`writeMarkersExplainAbsence`) makes it a stranded
   write, anything else a delete. A kill mid-write never leaves a partial main
   file.

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
import { existsSync, readdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { renameWithRetry } from './atomic-rename.js';

/* Monotonic in-process counter so two `writeJsonAtomic` calls that arrive
   in the same millisecond (same `Date.now()`, same `process.pid`) don't
   collide on temp-file names. Without this, plan 88 pipelining produced
   ENOENT-on-rename races: Phase 0 and Phase 1 both save to the same
   cache path inside a single tick, both pick `${path}.tmp-${pid}-${ts}`,
   one renames the temp away, the other's `renameWithRetry(tmp, path)`
   then explodes because its tmp no longer exists. */
let tmpSeq = 0;

/* The write-in-flight marker (see the header): `<path>.writing-<pid>-<n>`. */
function writeMarkerPrefix(path: string): string {
  return `${basename(path)}.writing-`;
}

/** True when a rotating write to `path` has started and not finished - it is
 *  between (or about to be between) its rename-away and rename-in, or it died
 *  there. With `path` absent that is a STRANDED file, as opposed to a deliberate
 *  delete, which leaves no marker. Synchronous so callers can decide after a read. */
export function hasWriteInFlightMarker(path: string): boolean {
  return listWriteMarkers(path).length > 0;
}

/* The marker files for `path`. A missing directory is "none"; any other readdir
   error is THROWN (#3625 delta review 3, I4): "could not look" must never read
   as "no write in flight", which is the deliberate-delete answer. */
function listWriteMarkers(path: string): string[] {
  const prefix = writeMarkerPrefix(path);
  try {
    return readdirSync(dirname(path)).filter((n) => n.startsWith(prefix));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Markers older than this cannot belong to a live write: a rotation is at most
 *  four `renameWithRetry` calls (~3.6 s each at worst), so 30 s is a wide margin. */
const STALE_MARKER_MS = 30_000;

/** Markers this process created for writes that are still running. */
const liveMarkers = new Set<string>();

/** Markers this process KEPT because its own write failed after rotation and
 *  the restore failed too (main left absent). Dead, but this process knows they
 *  are a strand, not a delete (#3625 pass 6). */
const keptMarkers = new Set<string>();

/** One marker's state: `live` (it may belong to a write still running), `dead`
 *  (with its mtime), or `gone` (vanished while we looked). Live is this process's
 *  own running write, or another's marker younger than STALE_MARKER_MS. */
function markerState(path: string, name: string): { full: string; state: 'live' | 'dead' | 'gone'; mtimeMs: number } {
  const full = join(dirname(path), name);
  const own = name.startsWith(`${writeMarkerPrefix(path)}${process.pid}-`);
  if (own && liveMarkers.has(full)) return { full, state: 'live', mtimeMs: Number.NaN };
  let mtimeMs: number;
  try {
    mtimeMs = statSync(full).mtimeMs;
  } catch {
    return { full, state: 'gone', mtimeMs: Number.NaN };
  }
  if (own) return { full, state: 'dead', mtimeMs };
  return { full, state: Date.now() - mtimeMs > STALE_MARKER_MS ? 'dead' : 'live', mtimeMs };
}

/** Remove every marker for `path` that cannot belong to a live write - this
 *  process's own whose write has returned, or anyone's older than
 *  STALE_MARKER_MS - and report whether any (possibly live) marker remains.
 *  A marker outliving its write turns every later deliberate delete into a
 *  recovery (#3625 delta review 3, I2), so writes, stranded reads and reads
 *  that find main present sweep. `remove: false` only reports. Throws like
 *  `hasWriteInFlightMarker` when the directory cannot be listed. */
export function sweepDeadWriteMarkers(path: string, remove = true): boolean {
  let remaining = 0;
  for (const name of listWriteMarkers(path)) {
    const { full, state } = markerState(path, name);
    if (state === 'gone') continue;
    if (state === 'live') remaining += 1;
    else if (remove) {
      removeMarker(full);
      keptMarkers.delete(full);
    }
  }
  return remaining > 0;
}

/** Whether the markers beside an ABSENT `path` explain that absence to this
 *  process - a strand it can attribute, as opposed to a deliberate delete
 *  (#3625 pass 6). A marker explains it when it is LIVE (a write may be between
 *  its renames right now), when this process kept it after its own failed
 *  write, or when it is dead but NEWER than `mainSeenAtMs`, this process's last
 *  sighting of a present main. A dead marker older than that sighting was
 *  already there while main was whole, so it cannot be why main is gone now;
 *  with no sighting at all (`null`: a cold boot) no dead marker can be
 *  attributed, and the absence reads as a delete. Throws like
 *  `hasWriteInFlightMarker` when the directory cannot be listed. */
export function writeMarkersExplainAbsence(path: string, mainSeenAtMs: number | null): boolean {
  for (const name of listWriteMarkers(path)) {
    const { full, state, mtimeMs } = markerState(path, name);
    if (state === 'gone') continue;
    if (state === 'live' || keptMarkers.has(full)) return true;
    if (mainSeenAtMs !== null && mtimeMs > mainSeenAtMs) return true;
  }
  return false;
}

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

/** True for the error a read raises when the file is not there. */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export async function readJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  /* #3700 — a concurrent writer can rename a file over/away between the
     existence check above and this read (Windows rename-over window). That is
     "missing", the same answer the check gives, not a failure. */
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
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
 *  but JSON.parse rejects it" — UNLESS the caller opts in with
 *  `recoverMissing` (state.json always - nothing deletes it on purpose, so an
 *  absent main with a parseable `.bak.N` is a stranded book; user-settings.json
 *  only once `writeMarkersExplainAbsence` says a write died, since deleting that file
 *  is how a user resets it), in which case the newest parseable backup is
 *  returned with a warning, and `null` only when there is none. When the main file is corrupt AND every
 *  backup is corrupt / missing, the original parse error is re-thrown
 *  so the caller surfaces the same diagnostic it would have seen from
 *  `readJson` directly.
 *
 *  Pairs with the `{ rotate }` option on `writeJsonAtomic`. */
export async function readJsonWithRecovery<T>(
  path: string,
  opts: { keep: number; recoverMissing?: boolean },
): Promise<T | null> {
  /* `recoverMissing`: the caller has established that an absent main is a
     STRANDED one - a crash between the rotation's renames, or a failed rename-in
     whose restore also failed - so it falls back to the newest parseable backup
     instead of reading as "no file". A caller where absence can mean a
     deliberate delete (user-settings.json) sets it only on marker evidence. */
  if (!opts.recoverMissing && !existsSync(path)) return null;
  /* The read sits OUTSIDE the try: only a parse failure (or, opted in, a
     missing main) may fall back. */
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (readErr) {
    if (isEnoent(readErr)) {
      if (opts.recoverMissing) {
        return (await readNewestBackup<T>(path, opts.keep, 'was missing')) ?? null;
      }
      /* #3700 — vanished between the check and the read: "missing", like the
         check above, not a corrupt file to recover from a backup. */
      return null;
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
    /* The read is OUTSIDE the try: only a PARSE failure is corruption. A transient
       error (EBUSY / EPERM / EIO) says nothing about the backup, and substituting
       the next-older one would serve stale settings as if they were the latest. */
    const raw = await readFile(backupPath, 'utf8');
    try {
      /* Strip a leading UTF-8 BOM (U+FEFF) if present. */
      const stripped = raw.startsWith('\ufeff') ? raw.slice(1) : raw;
      const value = JSON.parse(stripped) as T;
      console.warn(`[state-io] ${path} ${why}; recovered from ${backupPath}.`);
      return value;
    } catch (parseErr) {
      if (!(parseErr instanceof SyntaxError)) throw parseErr;
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
  let marker: string | null = null;
  try {
    /* `flush: true` fsyncs through the SAME handle before it closes — the
       header's durability claim without a reopen (a second open of a fresh tmp
       is an unretried EBUSY point on Windows and adds a scan-on-close). It also
       keeps `writeFile` the one seam the failure-injection tests hook. */
    await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', flush: true });
    if (opts?.rotate && existsSync(path)) {
      /* Sync create: no `writeFile` seam, no await between marker and rotation. */
      marker = join(dirname(path), `${writeMarkerPrefix(path)}${process.pid}-${seq}`);
      liveMarkers.add(marker);
      closeSync(openSync(marker, 'w'));
      rotated = await rotateBackups(path, opts.rotate.keep);
    }
    await renameWithRetry(tmp, path);
    if (marker) {
      liveMarkers.delete(marker);
      removeMarker(marker);
    }
    /* Best-effort: clear markers older writes left (a kept restore-failure
       marker, a killed process's) now that main is whole again. */
    if (opts?.rotate) {
      try {
        sweepDeadWriteMarkers(path);
      } catch {
        /* Could not list the directory: the next write or stranded read retries. */
      }
    }
  } catch (e) {
    /* Cleanup the temp file on terminal failure so we don't leak
       .tmp-<pid>-<ts> droppings into the workspace. */
    await unlink(tmp).catch(() => {});
    /* The rename-in failed after main was moved to `.bak.1`: put it back so a
       reader never finds the book without its main file. */
    if (rotated && !existsSync(path)) {
      await renameWithRetry(`${path}.bak.1`, path).catch((restoreErr) => {
        /* Not swallowed silently: main is now absent. The marker stays (see
           below), so readers that honour it recover from `.bak.1`. */
        console.warn(
          `[state-io] ${path}: the write failed after rotation and restoring ` +
            `${path}.bak.1 failed too (${(restoreErr as Error).message}); ` +
            `the in-flight marker is kept so the next read recovers the backup.`,
        );
      });
    }
    /* Main is back (or was never moved): the marker has nothing left to prove.
       Main still absent: leave it - it is the evidence of a stranded write. */
    if (marker) liveMarkers.delete(marker);
    if (marker && existsSync(path)) removeMarker(marker);
    else if (marker) keptMarkers.add(marker);
    throw e;
  }
}

function removeMarker(marker: string): void {
  try {
    unlinkSync(marker);
  } catch {
    /* Already gone. */
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
  /* RENAME, not copy (#3625 pass 3). #3700 copied main to `.bak.1` so main was
     never absent, but the tmp -> main rename then REPLACES a file, and on
     Windows that fails with EPERM while any reader holds main open (Node's own
     readers included); the retry budget then runs out and the write throws.
     Renaming main away is not blocked by an open handle. The cost is a
     sub-millisecond absent window, which the write-in-flight marker and
     `recoverMissing` cover (see the header). */
  await renameWithRetry(path, `${path}.bak.1`);
  return true;
}
