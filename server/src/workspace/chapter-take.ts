/* The chapter take module (spec 2026-11-13-chapter-take-lifecycle-design.md,
   §4 "Take identity and fields" and §5.A "Ownership", OD1 Option A).

   One module owns every take path, every take mutation and every take field in
   `state.json`. Phase 1 (#4319) lands its first part: the sniffer, the stamp, the
   lazy identity, the Phase 1 forms of the A/B take functions that finalize and
   the Accept / Reject / restore-unrecorded routes call, and the lazy migration
   (`reconcileSlug`) that the boot fsck and those routes run.

   R10-2 LEAF RULE: `scan.ts` and every module it reaches import take names
   from `take-fields.ts` ONLY, never from this file. This file may import
   `scan.ts` types, `book-state-update.ts`, `audio/segments-io.ts`,
   `audio/render-integrity/embeddings-io.ts` and `book-op-lock.ts`.

   LOCKS (§5.A "Fence and lock placement"): entry points never lock
   themselves. Each takes a live `BookHandle` from the caller's `withBookOp`
   and refuses a stale or hand-built one (`assertHeld`, as `moveBookFolder`
   does). The only lock taken here is `updateStateAtDir`'s `book` -> `state-json`
   pair, and its mutate callback takes no other lock. */

import { spawn } from 'node:child_process';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { RENAME_RETRY_DELAYS_MS, jitteredDelayMs, renameWithRetry, RETRYABLE_CODES } from './atomic-rename.js';
import { assertHeld, readBookStateOrThrow, type AnyBookHandle } from './book-op-lock.js';
import { updateStateAtDir } from './book-state-update.js';
import { audioDir } from './paths.js';
import type { BookStateJson } from './scan.js';
import { readJson, writeJsonAtomic } from './state-io.js';
import {
  CHAPTER_AUDIO_EXTS,
  TAKE_STATE_FIELDS,
  chapterAudioExists,
  deriveTakeFields,
  findChapterAudio,
  findPreviousAudio,
  healTakeFields,
  isTakeId,
  liveAudioFiles,
  liveAudioPath,
  livePartPath,
  mintTakeId,
  previousAudioPath,
  previousPartPath,
  type ChapterAudioExt,
  type TakeFields,
  type TakeSegmentsView,
} from './take-fields.js';

export * from './take-fields.js';

/* ------------------------------------------------------------------ *
 * The sniffer (§6.1 step 1)
 * ------------------------------------------------------------------ */

/** Identify an audio file's container by its magic bytes. An `ID3` tag or an
    MPEG frame sync (byte 0 `0xFF`, top three bits of byte 1 set) is mp3;
    `ftyp` at offset 4 is m4a; `OggS` at offset 0 is ogg. Anything else
    (including an empty or short file) is `null`. A missing file is `null`. */
export async function sniffAudioFormat(path: string): Promise<ChapterAudioExt | null> {
  let head: Buffer;
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  if (head.length >= 3 && head.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  if (head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  if (head.length >= 4 && head.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  return null;
}

/* `readJson`, except an unparseable file answers `null` (absent) with a log,
   where `readJson` throws. The reconcile entry points (Accept, Reject,
   restore-unrecorded, the boot fsck) read segments and embeddings that main
   never parsed on those routes, so a corrupt file there must not block them.
   Every caller treats `null` as "no such file": nothing is minted into it,
   stamped from it or matched against it, and it is never rewritten. Any other
   read error (EBUSY, EPERM, ...) still throws. */
async function readJsonTolerant<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    console.warn(`[take] ignoring unparseable ${basename(path)}: ${err.message}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The state stamp (§4.4)
 * ------------------------------------------------------------------ */

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Stamp a chapter's take-derived `state.json` members from its LIVE segments
    file, written through `updateStateAtDir` (`book` -> `state-json`). The
    segments are read INSIDE the callback, so the decision is made from the
    post-wait disk. Never decodes audio.

    `takeChanged: false` (the same take): set every member the segments derive
    and leave every other member as it is. `takeChanged: true` (a different
    take): set every derived member and CLEAR each member the segments lack.
    A live take with no segments file (an unindexed take) clears every member
    except `duration`. A lock timeout propagates; the caller curates it. */
export async function stampStateFromLiveTake(
  handle: AnyBookHandle,
  slug: string,
  opts: { takeChanged: boolean },
): Promise<void> {
  assertHeld(handle, 'stampStateFromLiveTake');
  const root = audioDir(handle.bookDir);
  await updateStateAtDir(handle.bookDir, async (state) => {
    const segments = await readJson<TakeSegmentsView>(livePartPath(root, slug, 'segments'));
    return stampedState(state, slug, segments, opts.takeChanged);
  });
}

/* The pure half of the stamp: `state` with chapter `slug`'s take members set
   from `segments`, or `null` when nothing changes. Shared by
   `stampStateFromLiveTake` and `reconcileSlug`, which both run it INSIDE an
   `updateStateAtDir` callback (a nested `updateStateAtDir` would deadlock). */
function stampedState(
  state: BookStateJson,
  slug: string,
  segments: TakeSegmentsView | null,
  takeChanged: boolean,
): BookStateJson | null {
  const idx = state.chapters.findIndex((c) => c.slug === slug);
  if (idx < 0) return null;
  const derived: TakeFields = segments ? deriveTakeFields(segments) : {};
  const before = state.chapters[idx] as Record<string, unknown>;
  const next: Record<string, unknown> = { ...before };
  for (const field of TAKE_STATE_FIELDS) {
    const value = derived[field];
    if (value !== undefined) {
      next[field] = value;
    } else if (takeChanged && !(field === 'duration' && !segments)) {
      delete next[field];
    }
  }
  if (TAKE_STATE_FIELDS.every((f) => sameValue(before[f], next[f]))) return null;
  const chapters = state.chapters.slice();
  chapters[idx] = next as unknown as (typeof chapters)[number];
  return { ...state, chapters };
}

/* ------------------------------------------------------------------ *
 * Take identity (§4.1)
 * ------------------------------------------------------------------ */

/* Add `takeId` to a JSON sidecar, leaving every other member untouched
   (embeddings: `{ version, rows }` -> `rows` is not re-derived). Missing file
   is a no-op. */
async function stampIdIntoJson(path: string, takeId: string): Promise<void> {
  if (!existsSync(path)) return;
  const raw = await readJsonTolerant<Record<string, unknown>>(path);
  if (!raw || typeof raw !== 'object') return;
  await writeJsonAtomic(path, { ...raw, takeId });
}

/* The identity mirror: ONLY `audioTakeId` is written. Every other member (a raw
   `audioModelKey` from the old heal included) is left as it is, so a healthy
   legacy chapter is not rewritten by its first boot (§4.4: a stamp of the same
   take leaves such a field alone). */
async function mirrorTakeIdIntoState(handle: AnyBookHandle, slug: string, takeId: string): Promise<void> {
  await updateStateAtDir(handle.bookDir, (state) => {
    const idx = state.chapters.findIndex((c) => c.slug === slug);
    if (idx < 0) return null;
    if ((state.chapters[idx] as Record<string, unknown>).audioTakeId === takeId) return null;
    const chapters = state.chapters.slice();
    chapters[idx] = { ...chapters[idx], audioTakeId: takeId } as (typeof chapters)[number];
    return { ...state, chapters };
  });
}

/** Remove `audioTakeId` from the chapter's `state.json` entry, so state never
    names a take that no longer exists. For a caller that has just replaced the
    live take without stamping the new one (Reject, restore-unrecorded): the
    restored take's id reaches `state.json` through the mirror's repair on the
    next reconcile. Writes nothing when the member is already absent. A write
    failure is logged and swallowed (spec State-write table): the restore has
    landed, and the next reconcile's mirror repair overwrites a disagreeing id. */
export async function clearTakeIdMirror(handle: AnyBookHandle, slug: string): Promise<void> {
  assertHeld(handle, 'clearTakeIdMirror');
  try {
    await updateStateAtDir(handle.bookDir, (state) => {
      const idx = state.chapters.findIndex((c) => c.slug === slug);
      if (idx < 0) return null;
      if (!('audioTakeId' in (state.chapters[idx] as Record<string, unknown>))) return null;
      const chapters = state.chapters.slice();
      const { audioTakeId: _gone, ...rest } = chapters[idx] as Record<string, unknown>;
      chapters[idx] = rest as unknown as (typeof chapters)[number];
      return { ...state, chapters };
    });
  } catch (err) {
    console.warn(`[take] state.json audioTakeId clear failed for ${slug}:`, err);
  }
}

/** Lazily mint a take id for a take that lacks one. Idempotent: a take whose
    segments already carry a valid `takeId` is not rewritten.

    A LIVE take (`chapterAudioExists`) whose live segments lack a valid id gets
    one minted into the segments (a write failure throws) and the live
    embeddings if present. The live segments' id is then mirrored into
    `state.json` (`audioTakeId` only) whenever `state.json` lacks it or
    disagrees, minted now or not. A failure of THAT mirror is logged and
    swallowed: the segments carry the id, and the next reconcile repeats the
    mirror. A PREVIOUS take whose `.previous.segments.json` lacks
    an id gets its own id (and its embeddings), with no live file touched.

    `mirrorState: false` skips the `state.json` mirror, for a caller about to
    replace the live take (Reject, restore-unrecorded). */
export async function ensureTakeIdentity(
  handle: AnyBookHandle,
  slug: string,
  opts: { mirrorState?: boolean } = {},
): Promise<void> {
  assertHeld(handle, 'ensureTakeIdentity');
  const root = audioDir(handle.bookDir);

  if (chapterAudioExists(root, slug)) {
    const segPath = livePartPath(root, slug, 'segments');
    const segments = await readJsonTolerant<Record<string, unknown>>(segPath);
    let takeId: string | null = null;
    if (segments && !isTakeId(segments.takeId)) {
      takeId = mintTakeId();
      await writeJsonAtomic(segPath, { ...segments, takeId });
      await stampIdIntoJson(livePartPath(root, slug, 'embeddings'), takeId);
    } else if (segments) {
      takeId = segments.takeId as string;
    }
    /* Mirror on every reconcile, not only on a mint: a take that already carries
       an id (an orphan-promote, a Reject, a swallowed mirror failure) otherwise
       keeps a `state.json` that lacks or disagrees with it for good. A no-op when
       they already agree. */
    if (takeId && opts.mirrorState !== false) {
      try {
        await mirrorTakeIdIntoState(handle, slug, takeId);
      } catch (err) {
        console.warn(`[take] state.json identity mirror failed for ${slug}:`, err);
      }
    }
  }

  const prevSegPath = previousPartPath(root, slug, 'segments');
  const prevSegments = await readJsonTolerant<Record<string, unknown>>(prevSegPath);
  if (prevSegments && !isTakeId(prevSegments.takeId)) {
    const takeId = mintTakeId();
    await writeJsonAtomic(prevSegPath, { ...prevSegments, takeId });
    await stampIdIntoJson(previousPartPath(root, slug, 'embeddings'), takeId);
  }
}

/* ------------------------------------------------------------------ *
 * The A/B take functions (Phase 1 forms)
 *
 * Moved here from the old preserve helper and the old A/B audio steps
 * (both files deleted). Same names and signatures, so
 * callers only changed their import; the one change is that a previous take
 * keeps its REAL extension (`.previous.m4a`, `.previous.ogg`), where it used to
 * be forced to `.mp3` (H12, H13). Each is the Phase 1 form that `commitTake`
 * (Phase 2) and `restoreTake` / `acceptTake` (Phase 3) replace.
 * ------------------------------------------------------------------ */

/** `unlink` on the `renameWithRetry` backoff: the same transient Windows /
    OneDrive holds that delay a rename delay an unlink. A non-retryable code
    throws at once; ENOENT is the goal state of an unlink (the file is already
    gone), so it returns at once. */
async function unlinkWithRetry(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await unlink(path);
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ENOENT') return;
      if (!code || !RETRYABLE_CODES.has(code) || attempt === RENAME_RETRY_DELAYS_MS.length) throw e;
      await new Promise((r) => setTimeout(r, jitteredDelayMs(RENAME_RETRY_DELAYS_MS[attempt])));
    }
  }
}

/** Called by finalize AFTER the new take's audio is installed. Removes every
    live audio file whose extension differs from the new take's, so exactly one
    live file exists and it is the new take (mp3 is probed first, so an old mp3
    left beside a new m4a would be the one served). Needed when the preserve
    aborted (a stale previous could not be removed) and left the old live file
    in place. A file that cannot be removed is renamed to `<name>.stale`, which
    no probe reads; if even that fails it is logged and left. */
export async function discardStaleLiveAudio(
  audioRoot: string,
  slug: string,
  keepExt: ChapterAudioExt,
): Promise<void> {
  for (const f of liveAudioFiles(audioRoot, slug)) {
    if (f.ext === keepExt) continue;
    try {
      await unlinkWithRetry(f.path);
    } catch (err) {
      console.warn(`[take] stale live audio removal failed for ${slug}: ${(err as Error).message}`);
      try {
        await renameWithRetry(f.path, `${f.path}.stale`);
      } catch (err2) {
        console.warn(`[take] stale live audio demotion failed for ${slug}: ${(err2 as Error).message}`);
      }
    }
  }
}

export interface PreserveResult {
  /** True when an existing audio file was found and the rename succeeded.
      False on first render (nothing to preserve) and on rename failures. */
  preserved: boolean;
}

/** Phase 1 form (`commitTake`, Phase 2, replaces it). Called right before a
    fresh render clobbers the live take: renames the live audio to
    `.previous.<its own ext>` and the live segments to `.previous.segments.json`.

    - First render (no live audio): no-op.
    - A previous take's audio with a DIFFERENT extension (a format switch left
      `.previous.mp3` beside a live m4a) is removed first, so the old previous
      take does not survive beside the new one. Same-extension previous audio is
      overwritten by the rename, as before. The unlink retries on the `renameWithRetry` backoff;
      a final failure is logged and the preserve is abandoned with nothing
      renamed (`preserved: false`). The caller (finalize) then removes the old
      live file if its extension differs (`discardStaleLiveAudio`).
    - Best-effort: a rename failure is logged, never thrown. We must NEVER block
      the regen on preservation; losing the audition is much less bad than losing
      the new audio. The two renames are not atomic; the fsck pairs up a crash
      between them. */
export async function preserveExistingAsPrevious(
  audioRoot: string,
  slug: string,
): Promise<PreserveResult> {
  const existing = findChapterAudio(audioRoot, slug);
  if (!existing) return { preserved: false };

  for (const ext of CHAPTER_AUDIO_EXTS) {
    if (ext === existing.ext) continue;
    const stale = previousAudioPath(audioRoot, slug, ext);
    if (!existsSync(stale)) continue;
    try {
      await unlinkWithRetry(stale);
    } catch (err) {
      /* Fail closed: a stale `.previous.mp3` left beside the `.previous.m4a` we
         are about to write would win `findPreviousAudio` (mp3 is probed first),
         auditioning and restoring the wrong take. */
      console.warn(`[take] stale previous audio removal failed for ${slug}: ${(err as Error).message}`);
      return { preserved: false };
    }
  }

  const segmentsPath = livePartPath(audioRoot, slug, 'segments');
  const previousSegments = previousPartPath(audioRoot, slug, 'segments');

  try {
    /* Audio first — if this fails we abort before touching segments so the
       live pair is left untouched. */
    await renameWithRetry(existing.path, previousAudioPath(audioRoot, slug, existing.ext));
  } catch (err) {
    console.warn(`[take] audio rename failed for ${slug}: ${(err as Error).message}`);
    return { preserved: false };
  }

  if (existsSync(segmentsPath)) {
    try {
      await renameWithRetry(segmentsPath, previousSegments);
    } catch (err) {
      /* Audio moved but segments didn't — the audition works off the audio
         alone (no per-segment seek). Log and continue. */
      console.warn(`[take] segments rename failed for ${slug}: ${(err as Error).message}`);
    }
  }

  return { preserved: true };
}

/** Whether a preserved (`.previous.<ext>`) take's audio exists for the chapter.
    Phase 1 form. The revisions detector sets `hasPreviousAudio` from it. */
export function hasPreviousAudio(audioRoot: string, slug: string): boolean {
  return findPreviousAudio(audioRoot, slug) !== null;
}

/** ACCEPT — the new render wins. Phase 1 form (`acceptTake`, Phase 3,
    replaces it). Deletes the previous audio, whatever its extension, and
    `.previous.segments.json` (unlink errors swallowed, as today). 'none' when
    nothing was preserved. */
export async function acceptPreviousAudio(audioRoot: string, slug: string): Promise<'deleted' | 'none'> {
  const previous = findPreviousAudio(audioRoot, slug);
  if (!previous) return 'none';
  /* Delete both files — segments.json absence on its own isn't a fault. */
  await unlink(previous.path).catch(() => {});
  await unlink(previousPartPath(audioRoot, slug, 'segments')).catch(() => {});
  return 'deleted';
}

/** REJECT — the prior render wins. Phase 1 form (`restoreTake`, Phase 3,
    replaces it). Promotes the previous take over the live names, with the
    previous take's real extension. 'none' when nothing was preserved; throws
    when the audio rename fails (callers answer today's fixed 500).

    Residuals kept exactly as today (Phase 3's `restoreTake` fixes them, H1 and
    H2): the live take is deleted BEFORE the rename, and a failed segments
    rename is swallowed. */
export async function restorePreviousAudio(audioRoot: string, slug: string): Promise<'restored' | 'none'> {
  const previous = findPreviousAudio(audioRoot, slug);
  if (!previous) return 'none';

  /* Delete the live render first so the previous → live rename doesn't race a
     still-present current file. */
  const currentLive = findChapterAudio(audioRoot, slug);
  if (currentLive) await unlink(currentLive.path).catch(() => {});
  const liveSegments = livePartPath(audioRoot, slug, 'segments');
  if (existsSync(liveSegments)) await unlink(liveSegments).catch(() => {});

  try {
    await renameWithRetry(previous.path, liveAudioPath(audioRoot, slug, previous.ext));
  } catch (err) {
    console.error(`[take] failed to restore previous audio for ${slug}: ${(err as Error).message}`);
    throw err;
  }
  const previousSegments = previousPartPath(audioRoot, slug, 'segments');
  if (existsSync(previousSegments)) {
    await renameWithRetry(previousSegments, liveSegments).catch(() => {});
  }
  return 'restored';
}

/* ------------------------------------------------------------------ *
 * Lazy migration, steps 1-3 (§6.1) and the quarantine (OD8)
 *
 * `reconcileSlug` (below) calls `migrateSlugFiles`, then runs the identity
 * (step 4) and the re-stamp (step 5). Step 6 belongs to Phase 3.
 *
 * NO DECODE UNDER `book` (§4.4, R8-3): `decodeDurationSec` runs under the
 * caller's book-op only, never inside `updateStateAtDir` or `withBookLock`.
 * This code takes no lock of its own.
 * ------------------------------------------------------------------ */

/** `YYYY-MM-DD` in UTC. */
function isoDateUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** OD8: move files to `audio/.orphaned/<iso-date>-<jid>/<name>`. Never deletes
    and never overwrites: every target is checked absent BEFORE any file moves,
    and a present target throws with nothing moved. Directories are created
    only under an EXISTING `audio/` (non-recursive), so a vanished `audio/`
    throws ENOENT and the book folder is never recreated (N15). Each call is
    one event with its own subfolder (jid = `mintTakeId()`). Returns the event
    folder. */
export async function quarantineToOrphaned(
  handle: AnyBookHandle,
  files: string[],
  reason: string,
): Promise<string> {
  assertHeld(handle, 'quarantineToOrphaned');
  const root = audioDir(handle.bookDir);
  const orphaned = join(root, '.orphaned');
  const eventDir = join(orphaned, `${isoDateUtc()}-${mintTakeId()}`);

  const targets = files.map((f) => ({ from: f, to: join(eventDir, basename(f)) }));
  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.to) || existsSync(t.to)) {
      throw new Error(`[take] quarantine target already exists, refusing to overwrite: ${t.to}`);
    }
    seen.add(t.to);
  }

  /* Non-recursive on purpose: a missing `audio/` is ENOENT, not a recreated
     book folder. */
  try {
    await mkdir(orphaned);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
  }
  try {
    await mkdir(eventDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
  }
  for (const t of targets) {
    await renameWithRetry(t.from, t.to);
  }
  console.warn(
    `[take] quarantined ${files.map((f) => basename(f)).join(', ')} -> ${eventDir} (${reason})`,
  );
  return eventDir;
}

const DECODE_TIMEOUT_MS = 120_000;

/** The duration of a FULL decode of `path` (ffmpeg's last `time=` progress
    line), never a header estimate: a VBR mp3 without a Xing header reports a
    wrong length to ffprobe. Resolves null on any failure, including a timeout
    and a file with no audio. */
export function decodeDurationSec(path: string): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-i', path, '-vn', '-f', 'null', '-'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    const settle = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(null);
    }, DECODE_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', () => settle(null));
    child.on('close', (code) => {
      if (code !== 0) return settle(null);
      const text = Buffer.concat(chunks).toString('utf8');
      const all = [...text.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const last = all[all.length - 1];
      if (!last) return settle(null);
      settle(Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]));
    });
  });
}

export interface MigrationReport {
  /** Live files a step-2 decision kept live. Empty when nothing was ambiguous. */
  kept: string[];
  /** Step 3: wrong-name files renamed to their real extension. */
  renamed: Array<{ from: string; to: string }>;
  /** Step 2: a non-matching live file that became the previous take. */
  madePrevious: Array<{ from: string; to: string }>;
  /** Files moved to `audio/.orphaned/`, with the event folder name. */
  quarantined: Array<{ file: string; event: string }>;
}

/** A decoded duration within this of the segments' `durationSec` "matches". */
const DURATION_MATCH_TOLERANCE_SEC = 0.5;

/** Newest by mtime; ties fall to the earlier entry. */
async function newestByMtime(paths: string[]): Promise<string> {
  let best = paths[0];
  let bestM = (await stat(best)).mtimeMs;
  for (const p of paths.slice(1)) {
    const m = (await stat(p)).mtimeMs;
    if (m > bestM) {
      best = p;
      bestM = m;
    }
  }
  return best;
}

function previousAudioFiles(root: string, slug: string): Array<{ path: string; ext: ChapterAudioExt }> {
  return CHAPTER_AUDIO_EXTS.map((ext) => ({ path: previousAudioPath(root, slug, ext), ext })).filter((f) =>
    existsSync(f.path),
  );
}

/** §6.1 steps 1-3 for one slug, under the caller's book-op (the handle is
    asserted first). Idempotent: every step checks before it renames, and a
    target that already exists means the source is quarantined instead, so a
    second call on a clean slug changes nothing and returns an empty report.

    1. Inventory every live and previous audio file and sniff each (nothing is
       renamed here).
    2. Two or more live files: exactly one whose full-decode duration is within
       ±0.5 s of the live `segments.json` `durationSec` stays live; with no
       previous take, one non-match (the newest) becomes the previous take
       under its real extension, the rest are quarantined. Zero or several
       matches (or no numeric `durationSec`): keep the newest by mtime,
       quarantine the rest, and log the case.
    3. A live or previous file whose bytes disagree with its extension is
       renamed to the right extension if that target is absent, else
       quarantined. A file whose bytes are unrecognised is left alone. */
export async function migrateSlugFiles(handle: AnyBookHandle, slug: string): Promise<MigrationReport> {
  assertHeld(handle, 'migrateSlugFiles');
  const root = audioDir(handle.bookDir);
  const report: MigrationReport = { kept: [], renamed: [], madePrevious: [], quarantined: [] };

  const quarantine = async (files: string[], reason: string): Promise<void> => {
    if (files.length === 0) return;
    const eventDir = await quarantineToOrphaned(handle, files, reason);
    for (const f of files) report.quarantined.push({ file: basename(f), event: basename(eventDir) });
  };

  /* Step 1: inventory + sniff. Nothing is renamed here. */
  const live = liveAudioFiles(root, slug);
  const realExt = new Map<string, ChapterAudioExt>();
  for (const f of live) {
    const sniffed = await sniffAudioFormat(f.path);
    if (sniffed) realExt.set(f.path, sniffed);
  }

  /* Step 2: resolve two or more live files. */
  if (live.length >= 2) {
    const segments = await readJsonTolerant<{ durationSec?: unknown }>(livePartPath(root, slug, 'segments'));
    const expected =
      typeof segments?.durationSec === 'number' && Number.isFinite(segments.durationSec)
        ? segments.durationSec
        : null;
    const matches: string[] = [];
    if (expected !== null) {
      for (const f of live) {
        const dur = await decodeDurationSec(f.path);
        if (dur !== null && Math.abs(dur - expected) <= DURATION_MATCH_TOLERANCE_SEC) matches.push(f.path);
      }
    }
    const allPaths = live.map((f) => f.path);

    let keep: string;
    let rest: string[];
    if (matches.length === 1) {
      keep = matches[0];
      rest = allPaths.filter((p) => p !== keep);
      if (findPreviousAudio(root, slug) === null && rest.length > 0) {
        const demote = await newestByMtime(rest);
        const demoteExt = realExt.get(demote) ?? live.find((f) => f.path === demote)!.ext;
        const target = previousAudioPath(root, slug, demoteExt);
        if (!existsSync(target)) {
          await renameWithRetry(demote, target);
          report.madePrevious.push({ from: basename(demote), to: basename(target) });
          rest = rest.filter((p) => p !== demote);
        }
      }
      await quarantine(rest, `step 2: ${live.length} live audio files for ${slug}, one matches segments`);
    } else {
      keep = await newestByMtime(allPaths);
      rest = allPaths.filter((p) => p !== keep);
      console.warn(
        `[take] ${slug}: ${live.length} live audio files, ${matches.length} match segments durationSec ` +
          `${expected ?? 'none'}; keeping the newest (${basename(keep)})`,
      );
      await quarantine(rest, `step 2: ${live.length} live audio files for ${slug}, ${matches.length} matches`);
    }
    report.kept.push(basename(keep));
  }

  /* Step 3: a file whose bytes disagree with its extension. */
  const candidates: Array<{ path: string; ext: ChapterAudioExt; previous: boolean }> = [
    ...liveAudioFiles(root, slug).map((f) => ({ path: f.path, ext: f.ext, previous: false })),
    ...previousAudioFiles(root, slug).map((f) => ({ path: f.path, ext: f.ext, previous: true })),
  ];
  for (const c of candidates) {
    const sniffed = await sniffAudioFormat(c.path);
    if (!sniffed || sniffed === c.ext) continue;
    const target = c.previous ? previousAudioPath(root, slug, sniffed) : liveAudioPath(root, slug, sniffed);
    if (existsSync(target)) {
      await quarantine([c.path], `step 3: ${basename(c.path)} holds ${sniffed} bytes and ${basename(target)} exists`);
    } else {
      await renameWithRetry(c.path, target);
      report.renamed.push({ from: basename(c.path), to: basename(target) });
    }
  }
  return report;
}

/* ------------------------------------------------------------------ *
 * reconcileSlug (§6.1 steps 1-5, lazy migration)
 * ------------------------------------------------------------------ */

/** `state.json` records an `audioRenderedAt` that is not the live segments'
    `synthesizedAt`. Step 4's mirror writes `audioTakeId` only, so it never
    erases this mismatch. */
function isLegacyRejectShape(recorded: unknown, segments: TakeSegmentsView): boolean {
  return typeof recorded === 'string' && recorded.length > 0 && recorded !== segments.synthesizedAt;
}

/** H6 (spec W1): the legacy-reject shape also arises when a re-render's
    preserve and install renames both failed, leaving the NEW segments beside
    the OLD live audio with `state.json` still describing that audio. So before
    step 4 mints an id or step 5 stamps, a chapter in that shape has its live
    audio FULL-DECODED and compared with the segments' `durationSec` (the
    multi-live rule's tolerance). False means the segments do not describe this
    audio (a mismatch, or no way to tell): the caller touches nothing. The read of
    `state.json` is lock-free and the decode runs under the caller's book-op
    only, never inside `book` (R8-3). Any other chapter answers true without a
    decode. */
async function segmentsDescribeLiveAudio(handle: AnyBookHandle, root: string, slug: string): Promise<boolean> {
  const segments = await readJsonTolerant<TakeSegmentsView>(livePartPath(root, slug, 'segments'));
  if (!segments) return true;
  let recorded: unknown;
  try {
    const state = await readBookStateOrThrow(handle.bookDir);
    recorded = (state?.chapters.find((c) => c.slug === slug) as Record<string, unknown> | undefined)?.audioRenderedAt;
  } catch {
    return true; // step 5's own read reports an unreadable state
  }
  if (!isLegacyRejectShape(recorded, segments)) return true;
  const expected = segments.durationSec;
  const audio = liveAudioFiles(root, slug)[0];
  const decoded = audio ? await decodeDurationSec(audio.path) : null;
  if (
    typeof expected === 'number' &&
    Number.isFinite(expected) &&
    decoded !== null &&
    Math.abs(decoded - expected) <= DURATION_MATCH_TOLERANCE_SEC
  ) {
    return true;
  }
  console.warn(
    `[take] ${slug}: live segments (durationSec ${String(expected)}) do not describe the live audio ` +
      `(decoded ${decoded === null ? 'unreadable' : decoded.toFixed(2)} s); state.json and take ids left as they are`,
  );
  return false;
}

/** Bring one chapter slug's take up to the current model, under the caller's
    book-op (the handle is asserted first): `migrateSlugFiles` (steps 1-3),
    `ensureTakeIdentity` (step 4), then the `state.json` re-stamp (step 5).

    The re-stamp is decided from a read INSIDE the `updateStateAtDir` lock. A
    LEGACY REJECT (`state.json`'s `audioRenderedAt` differs from the live
    segments' `synthesizedAt`: a reject restored a take the state never
    learned of) is a full `stampedState(.., takeChanged: true)`, so a pending
    entry that named the rejected take stops matching. Any other chapter gets a
    FILL-ONLY pass (`healTakeFields`): absent members are filled, existing
    values are never rewritten, so a healthy chapter is a no-op.

    SEGMENTS DO NOT MAKE A TAKE LIVE (§4.2): with no live audio file the
    re-stamp is skipped, so `state.json` keeps describing the take that is on
    disk (finalize can die between writing its segments and its audio rename).
    A caller about to REPLACE the live take (Reject, restore-unrecorded) passes
    `restamp: false`: Phase 1 restores without stamping (Phase 3's
    `restoreTake` stamps the restored take), and a stamp from the take that
    request deletes would describe a take that is no longer there.

    Phase 1 holds no journal replay; Phase 2 adds it before `migrateSlugFiles`.
    A failed step-5 `state.json` write is logged and swallowed (spec State-write
    table); every other error propagates: the route entry points curate them,
    the fsck logs them. */
export async function reconcileSlug(
  handle: AnyBookHandle,
  slug: string,
  opts: { restamp?: boolean } = {},
): Promise<void> {
  assertHeld(handle, 'reconcileSlug');
  await migrateSlugFiles(handle, slug);
  const root = audioDir(handle.bookDir);
  const restamp = opts.restamp !== false;
  if (restamp && chapterAudioExists(root, slug) && !(await segmentsDescribeLiveAudio(handle, root, slug))) return;
  await ensureTakeIdentity(handle, slug, { mirrorState: restamp });
  if (!restamp || !chapterAudioExists(root, slug)) return;
  try {
    await updateStateAtDir(handle.bookDir, async (state) => {
      const idx = state.chapters.findIndex((c) => c.slug === slug);
      if (idx < 0) return null;
      const segments = await readJsonTolerant<TakeSegmentsView>(livePartPath(root, slug, 'segments'));
      if (!segments) return null;
      const before = state.chapters[idx] as Record<string, unknown>;
      const recorded = before.audioRenderedAt;
      /* A LEGACY REJECT: `state.json` records an `audioRenderedAt` that is not the
         live segments' `synthesizedAt`. Step 4's mirror writes `audioTakeId` only,
         so it never erases this mismatch. */
      if (isLegacyRejectShape(recorded, segments)) return stampedState(state, slug, segments, true);
      const healed = healTakeFields(
        before as { slug?: string } & TakeFields,
        deriveTakeFields(segments),
        new Set<string>(),
      ) as Record<string, unknown>;
      if (TAKE_STATE_FIELDS.every((f) => sameValue(before[f], healed[f]))) return null;
      const chapters = state.chapters.slice();
      chapters[idx] = healed as unknown as (typeof chapters)[number];
      return { ...state, chapters };
    });
  } catch (err) {
    /* Swallow and log (spec State-write table): the re-stamp is a repair, not part of
       what the caller asked for, and the next reconcile repeats it. A migration
       failure above still throws. */
    console.warn(`[take] state.json re-stamp failed for ${slug}:`, err);
  }
}
