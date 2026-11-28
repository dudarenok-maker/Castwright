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
   `audio/render-integrity/embeddings-io.ts` and `verdicts-io.ts`,
   `book-op-lock.ts`, `revisions-store.ts` (which therefore takes take names
   from the leaf), and the leaves `book-lock.ts` and `book-dir-key.ts`.

   LOCKS (§5.A "Fence and lock placement"): entry points never lock
   `book-op` themselves. Each takes a live `BookHandle` from the caller's
   `withBookOp` and refuses a stale or hand-built one (`assertHeld`, as
   `moveBookFolder` does). The only locks taken here are `updateStateAtDir`'s
   `book` -> `state-json` pair, whose mutate callback takes no other lock, the
   `book` lock around a journal unlink (R7-1), under which nothing else is
   taken, and the `revisions` leaf lock the review record takes through
   `revisions-store.ts`. */

import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  engineBreakdownFromSnapshots,
  effectiveAudioModelKey,
  type AudioEngineBreakdown,
} from '../audio/engine-breakdown.js';
import { formatDuration } from '../audio/format-duration.js';
import { readEmbeddings, type EmbeddingRow } from '../audio/render-integrity/embeddings-io.js';
import { readVerdicts, type VerdictRow } from '../audio/render-integrity/verdicts-io.js';
import type { TtsModelKey } from '../tts/model-keys.js';
import { RENAME_RETRY_DELAYS_MS, jitteredDelayMs, renameWithRetry, RETRYABLE_CODES } from './atomic-rename.js';
import { canonicalDirKey } from './book-dir-key.js';
import { withBookLock } from './book-lock.js';
import { assertHeld, readBookStateOrThrow, type AnyBookHandle } from './book-op-lock.js';
import { updateStateAtDir } from './book-state-update.js';
import { audioDir } from './paths.js';
import { dropPendingForChapter, recordPending, type ChapterRef } from './revisions-store.js';
import type { BookStateJson } from './scan.js';
import { readJson, writeJsonAtomic } from './state-io.js';
import {
  CHAPTER_AUDIO_EXTS,
  TAKE_SIDECAR_SUFFIXES,
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
  mintJournalId,
  mintTakeId,
  parseTakeJournalName,
  previousAudioPath,
  previousPartPath,
  stagedPartPath,
  takeJournalPath,
  type ChapterAudioExt,
  type JournalId,
  type StagedSuffix,
  type TakeFields,
  type TakeId,
  type TakeSegmentsView,
  type TakeSidecarPart,
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
    except `duration`. A lock timeout propagates; the caller curates it.

    `clearGenerationState: true` (a commit) also removes the chapter's
    `generationState*` members, in the SAME write, and moves `updatedAt`. */
export async function stampStateFromLiveTake(
  handle: AnyBookHandle,
  slug: string,
  opts: { takeChanged: boolean; clearGenerationState?: boolean },
): Promise<void> {
  assertHeld(handle, 'stampStateFromLiveTake');
  const root = audioDir(handle.bookDir);
  await updateStateAtDir(handle.bookDir, async (state) => {
    const segments = await readJson<TakeSegmentsView>(livePartPath(root, slug, 'segments'));
    const stamped = stampedState(state, slug, segments, opts.takeChanged);
    return opts.clearGenerationState ? withoutGenerationState(state, stamped, slug) : stamped;
  });
}

const GENERATION_STATE_FIELDS = [
  'generationState',
  'generationError',
  'generationErrorCode',
  'generationRemediation',
] as const;

/* `stamped` (or `state`, when the stamp changed nothing) without chapter
   `slug`'s `generationState*` members; `null` when there is nothing to write. */
function withoutGenerationState(
  state: BookStateJson,
  stamped: BookStateJson | null,
  slug: string,
): BookStateJson | null {
  const base = stamped ?? state;
  const idx = base.chapters.findIndex((c) => c.slug === slug);
  if (idx < 0) return null;
  const chapter: Record<string, unknown> = { ...base.chapters[idx] };
  if (!stamped && !GENERATION_STATE_FIELDS.some((f) => f in chapter)) return null;
  for (const field of GENERATION_STATE_FIELDS) delete chapter[field];
  const chapters = base.chapters.slice();
  chapters[idx] = chapter as unknown as (typeof chapters)[number];
  return { ...base, chapters, updatedAt: new Date().toISOString() };
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
   take leaves such a field alone). The live segments are re-read inside the lock
   and nothing is written unless they still carry `takeId`: a finalize's segments
   write landing after the mint would otherwise leave state naming an id no file
   carries. */
async function mirrorTakeIdIntoState(
  handle: AnyBookHandle,
  slug: string,
  takeId: string,
  liveSegPath: string,
): Promise<void> {
  await updateStateAtDir(handle.bookDir, async (state) => {
    const idx = state.chapters.findIndex((c) => c.slug === slug);
    if (idx < 0) return null;
    const live = await readJsonTolerant<Record<string, unknown>>(liveSegPath);
    if (live?.takeId !== takeId) return null;
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
    replace the live take (Reject, restore-unrecorded).

    `onlyIfIdentity` is the identity `reconcileSlug`'s gate verified the live
    audio against; when the live segments read here no longer carry it (a
    finalize wrote new segments after the gate's decode), nothing is minted or
    mirrored. */
export async function ensureTakeIdentity(
  handle: AnyBookHandle,
  slug: string,
  opts: { mirrorState?: boolean; onlyIfIdentity?: string } = {},
): Promise<void> {
  assertHeld(handle, 'ensureTakeIdentity');
  const root = audioDir(handle.bookDir);

  if (chapterAudioExists(root, slug)) {
    const segPath = livePartPath(root, slug, 'segments');
    const segments = await readJsonTolerant<Record<string, unknown>>(segPath);
    if (opts.onlyIfIdentity !== undefined && segmentsIdentity(segments) !== opts.onlyIfIdentity) return;
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
        await mirrorTakeIdIntoState(handle, slug, takeId, segPath);
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
 * The per-slug take journal: the file layer (§5.A "Commit" step 3,
 * "Journal rules")
 *
 * `<slug>.take-journal.<jid>.json` in `audio/`. Phase 2's two per-slug
 * journals are `commit` and `replace` (the bundle overwrite: the commit's
 * shape with both local takes discarded). Any other `op` fails the schema.
 * ------------------------------------------------------------------ */

const TAKE_JOURNAL_OPS = ['commit', 'replace'] as const;

const TAKE_JOURNAL_PHASES = [
  'discard',
  'preserve',
  'discard-live',
  'install',
  'installed',
  'cleanup',
] as const;

export type TakeJournalPhase = (typeof TAKE_JOURNAL_PHASES)[number];

const TAKE_JOURNAL_ROLES = ['live', 'previous', 'staged'] as const;

/** Which of the three takes a journalled part belongs to. */
export type TakeJournalRole = (typeof TAKE_JOURNAL_ROLES)[number];

/** One part of a take. Audio carries its real extension. */
export type TakePartRef = { part: 'audio'; ext: ChapterAudioExt } | { part: TakeSidecarPart };

/** A part that was PRESENT when the journal was written, with its byte size
    from the same probe that listed it (E15). */
export type TakeJournalPart = TakePartRef & { size: number };

/** A part replay recorded as lost (R8-1, E15), with the file names it was
    looked for or quarantined under. */
export type TakeJournalLostPart = TakePartRef & { take: TakeJournalRole; basenames: string[] };

/** A leftover journal this one superseded (E10): the discard names it still
    owed unlinking, and whether it still owed an entry drop or review record. */
export interface TakeJournalSuperseded {
  jid: JournalId;
  discards: string[];
  dropEntry: boolean;
}

export interface TakeJournal {
  op: (typeof TAKE_JOURNAL_OPS)[number];
  /** The id in the journal's file name. */
  jid: JournalId;
  phase: TakeJournalPhase;
  newTakeId: TakeId;
  liveTakeId: TakeId | null;
  prevTakeId: TakeId | null;
  keepPrevious: boolean;
  parts: Record<TakeJournalRole, TakeJournalPart[]>;
  chapter: { id: number; slug: string; uuid?: string };
  clearGenerationState: true;
  /** Finalize's review input (A3). Absent: leave the review state alone.
      `null`: drop the pending entry. */
  review?: { characterId: string; triggeredBy: string } | null;
  preserved: boolean;
  oldDuration: string;
  newDuration: string;
  /** The review entry's identity stamps (E6); `null` when nothing becomes previous. */
  entry: {
    takeId: TakeId;
    renderedAt: string;
    previousTakeId: TakeId | null;
    previousRenderedAt: string | null;
  } | null;
  /** Oldest first (R9-3). */
  supersedes: TakeJournalSuperseded[];
  lost: TakeJournalLostPart[];
}

type Check = (value: unknown) => boolean;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString: Check = (v) => typeof v === 'string';
const isStringOrNull: Check = (v) => v === null || typeof v === 'string';
const isBoolean: Check = (v) => typeof v === 'boolean';
/* A file name inside `audio/`: replay renames and unlinks by it, so it can
   never name a path. */
const isFileName: Check = (v) =>
  typeof v === 'string' && v !== '' && v !== '.' && v !== '..' && !/[\\/]/.test(v);
const isOneOf =
  (allowed: readonly string[]): Check =>
  (v) =>
    typeof v === 'string' && allowed.includes(v);
const isListOf =
  (item: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(item);
/* Every named member passes its check; unnamed members are ignored. */
const hasShape =
  (shape: Record<string, Check>): Check =>
  (v) =>
    isObject(v) && Object.entries(shape).every(([key, check]) => check(v[key]));

const isPartRef: Check = (v) => {
  if (!isObject(v)) return false;
  if (v.part === 'audio') return isOneOf(CHAPTER_AUDIO_EXTS)(v.ext);
  return isOneOf(Object.keys(TAKE_SIDECAR_SUFFIXES))(v.part);
};
const isJournalPart: Check = (v) =>
  isPartRef(v) && hasShape({ size: (n) => Number.isInteger(n) && (n as number) >= 0 })(v);
const isLostPart: Check = (v) =>
  isPartRef(v) &&
  hasShape({ take: isOneOf(TAKE_JOURNAL_ROLES), basenames: isListOf(isFileName) })(v);

const TAKE_JOURNAL_SCHEMA: Record<keyof TakeJournal, Check> = {
  op: isOneOf(TAKE_JOURNAL_OPS),
  jid: isTakeId,
  phase: isOneOf(TAKE_JOURNAL_PHASES),
  newTakeId: isTakeId,
  liveTakeId: isStringOrNull,
  prevTakeId: isStringOrNull,
  keepPrevious: isBoolean,
  parts: hasShape({
    live: isListOf(isJournalPart),
    previous: isListOf(isJournalPart),
    staged: isListOf(isJournalPart),
  }),
  chapter: hasShape({
    id: Number.isInteger,
    slug: isFileName,
    uuid: (v) => v === undefined || typeof v === 'string',
  }),
  clearGenerationState: (v) => v === true,
  review: (v) =>
    v === undefined || v === null || hasShape({ characterId: isString, triggeredBy: isString })(v),
  preserved: isBoolean,
  oldDuration: isString,
  newDuration: isString,
  entry: (v) =>
    v === null ||
    hasShape({
      takeId: isString,
      renderedAt: isString,
      previousTakeId: isStringOrNull,
      previousRenderedAt: isStringOrNull,
    })(v),
  supersedes: isListOf(
    hasShape({ jid: isTakeId, discards: isListOf(isFileName), dropEntry: isBoolean }),
  ),
  lost: isListOf(isLostPart),
};

/* Why `value` is not a take journal, or `null` when it is one. */
function takeJournalSchemaError(value: unknown): string | null {
  if (!isObject(value)) return 'not a JSON object';
  const bad = Object.entries(TAKE_JOURNAL_SCHEMA).find(([key, check]) => !check(value[key]));
  return bad ? `invalid or missing "${bad[0]}"` : null;
}

/** Atomically write (or rewrite, at each phase) `slug`'s journal
    `journal.jid`, under the caller's book-op. A journal that would read back as
    unparseable, or that names another slug's chapter, is refused with nothing
    written. Returns the journal's path. */
export async function writeTakeJournal(
  handle: AnyBookHandle,
  slug: string,
  journal: TakeJournal,
): Promise<string> {
  assertHeld(handle, 'writeTakeJournal');
  const invalid =
    takeJournalSchemaError(journal) ??
    (journal.chapter.slug === slug ? null : '"chapter.slug" is not the journal\'s slug');
  if (invalid) throw new Error(`[take] refusing to write a take journal for ${slug}: ${invalid}`);
  const path = takeJournalPath(audioDir(handle.bookDir), slug, journal.jid);
  await writeJsonAtomic(path, journal);
  return path;
}

export type TakeJournalRead =
  | { kind: 'ok'; journal: TakeJournal }
  | { kind: 'unparseable'; reason: string };

/** Read one journal, keeping "unreadable" apart from "unparseable" (R6-3,
    R7-4). `unparseable` (the sweep quarantines it) means the bytes do not
    parse, or they parse and fail the schema, a name that disagrees with the
    content included. EVERY error from the read itself (EBUSY, EPERM, ENOENT,
    any other) propagates: it is a record-step failure, and such a journal is
    never quarantined. */
export async function readTakeJournal(path: string): Promise<TakeJournalRead> {
  /* The read sits OUTSIDE the try: only a parse failure is `unparseable`. */
  const raw = await readFile(path, 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw.startsWith('﻿') ? raw.slice(1) : raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { kind: 'unparseable', reason: err.message };
  }
  const invalid = takeJournalSchemaError(value);
  if (invalid) return { kind: 'unparseable', reason: invalid };
  const journal = value as TakeJournal;
  const named = parseTakeJournalName(basename(path));
  if (named && (named.jid !== journal.jid || named.slug !== journal.chapter.slug)) {
    return { kind: 'unparseable', reason: 'the file name disagrees with "jid" or "chapter.slug"' };
  }
  return { kind: 'ok', journal };
}

/** A per-slug journal as the directory listing names it. */
export interface TakeJournalRef {
  slug: string;
  jid: JournalId;
  path: string;
}

/** One `readdir` of a book's `audio/`: a span takes it once and shares it
    across its replay calls (R7-8). It is a snapshot of NAMES; no journal has
    been read. Every list holds file names inside `audioRoot`, sorted. */
export interface TakeJournalListing {
  audioRoot: string;
  /** Per-slug journals, grouped by the slug their names carry. */
  journals: ReadonlyMap<string, readonly TakeJournalRef[]>;
  /** Any other `.take-journal.` name: a book journal, or a name nothing parses. */
  otherJournals: readonly string[];
  /** `.next-*` staged parts. */
  next: readonly string[];
  /** `.discard-*` parts. */
  discard: readonly string[];
  /** `*.tmp-*` leftovers, a journal's own included. */
  tmp: readonly string[];
  /** `*.stale` names (`discardStaleLiveAudio`). */
  stale: readonly string[];
  /** `<slug>.relabel-<jid>-<k>.*` temp names. */
  relabelTemp: readonly string[];
}

const RELABEL_TEMP_NAME_RE = /\.relabel-[a-z2-7]{16}-\d+\./;

/** List `audio/` under the caller's book-op. An absent `audio/` is an empty
    listing; any other `readdir` error propagates. */
export async function listTakeJournals(handle: AnyBookHandle): Promise<TakeJournalListing> {
  assertHeld(handle, 'listTakeJournals');
  const audioRoot = audioDir(handle.bookDir);
  let names: string[];
  try {
    names = await readdir(audioRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    names = [];
  }
  const journals = new Map<string, TakeJournalRef[]>();
  const otherJournals: string[] = [];
  const next: string[] = [];
  const discard: string[] = [];
  const tmp: string[] = [];
  const stale: string[] = [];
  const relabelTemp: string[] = [];
  for (const name of names.sort()) {
    const journal = parseTakeJournalName(name);
    /* `.tmp-` first: the leftover of a staged or discarded file's write is a
       temp file, whatever else its name holds. */
    if (name.includes('.tmp-')) tmp.push(name);
    else if (journal) {
      const ofSlug = journals.get(journal.slug) ?? [];
      ofSlug.push({ ...journal, path: join(audioRoot, name) });
      journals.set(journal.slug, ofSlug);
    } else if (name.includes('.take-journal.')) otherJournals.push(name);
    else if (name.endsWith('.stale')) stale.push(name);
    else if (name.includes('.next-')) next.push(name);
    else if (name.includes('.discard-')) discard.push(name);
    else if (RELABEL_TEMP_NAME_RE.test(name)) relabelTemp.push(name);
  }
  return { audioRoot, journals, otherJournals, next, discard, tmp, stale, relabelTemp };
}

/** The `book` lock key for a handle's book (R8-4): the `bookId`, or, for an
    unaddressed handle and for its whole life, the canonical directory key (the
    book may gain an id while the handle is held). */
export function bookLockKeyFor(handle: AnyBookHandle): string {
  return 'kind' in handle ? canonicalDirKey(handle.bookDir) : handle.bookId;
}

/** Remove a journal, ALWAYS under `book` (R7-1): the scan heal reads a slug's
    segments and then checks for its journal under that lock, so a journal can
    never vanish between the two. A missing file is success. */
export async function unlinkTakeJournal(handle: AnyBookHandle, path: string): Promise<void> {
  assertHeld(handle, 'unlinkTakeJournal');
  await withBookLock(bookLockKeyFor(handle), () => unlinkWithRetry(path));
}

/* ------------------------------------------------------------------ *
 * Prepare: staging a new take (§5.A "Prepare"; N14, N15)
 *
 * NO LOCK is held, and the caller may have outlived the job's lease, so
 * nothing here takes or asserts a `BookHandle`. Nothing live is touched. NO
 * DIRECTORY IS EVER CREATED: every part is opened `wx` in the existing
 * `audio/`, so a book that moved answers ENOENT and is never recreated.
 * ------------------------------------------------------------------ */

const staging = new Set<TakeId>();

/** The take ids this process has staged and not yet released: the sweep keeps
    their `.next-*` parts. Process-local (A10). */
export const liveStaging: ReadonlySet<TakeId> = staging;

/** Called by the commit, or by the job's exit: `takeId`'s staged parts are no
    longer this process's to keep. */
export function releaseStaging(takeId: TakeId): void {
  staging.delete(takeId);
}

/** A segments file as the writer hands it over: any `takeId` in it is replaced. */
export type PreparedSegments = TakeSegmentsView & { durationSec: number; synthesizedAt: string };

/** QA repair's change to an existing verdict row (OD4). Not a file: it stays in
    memory and the commit applies it. */
export type VerdictPatch = Pick<
  VerdictRow,
  'sentenceIds' | 'cosine' | 'verdict' | 'severity' | 'fixable'
>;

/** A new take's payloads, already encoded and measured. An absent optional part
    is not staged. */
export interface PrepareTakeInput {
  slug: string;
  ext: ChapterAudioExt;
  audio: Uint8Array;
  segments: PreparedSegments;
  peaks?: object;
  lufs?: object;
  /** Fresh rows only. */
  embeddings?: { version: string; rows: readonly EmbeddingRow[] };
  /** Fresh verdicts only. */
  verdicts?: readonly VerdictRow[];
  verdictPatches?: readonly VerdictPatch[];
  /** Indices into `segments.segments` this write actually re-synthesised. A
      PARTIAL write passes them (a remix passes none), and the commit carries
      the other segments' embeddings and verdict rows forward from the live take
      (OD4). A full render passes `'all'` or leaves it out. */
  resynthesizedIndices?: Iterable<number> | 'all';
}

export interface StagedTakePart {
  suffix: StagedSuffix;
  path: string;
  size: number;
}

export interface StagedTake {
  slug: string;
  takeId: TakeId;
  ext: ChapterAudioExt;
  parts: StagedTakePart[];
  verdictPatches?: readonly VerdictPatch[];
  resynthesizedIndices?: readonly number[] | 'all';
  durationSec: number;
  segments: PreparedSegments & { takeId: TakeId };
  synthesizedAt: string;
}

const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2), 'utf8');

/* The embeddings file's stored form (`embeddings-io.ts`: each vector is the
   base64 of its Float32 buffer). `writeEmbeddings` cannot stage it: it creates
   directories and renames over whatever holds the name. */
function storedEmbeddingRows(rows: readonly EmbeddingRow[]) {
  return rows.map((r) => ({
    characterId: r.characterId,
    sentenceIds: r.sentenceIds,
    vec: Buffer.from(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength).toString('base64'),
  }));
}

/* Unlink every path, trying each even after a failure; returns the failures. */
async function unlinkEach(paths: readonly string[]): Promise<Error[]> {
  const failures: Error[] = [];
  for (const path of paths) {
    try {
      await unlinkWithRetry(path);
    } catch (err) {
      failures.push(err as Error);
    }
  }
  return failures;
}

/** Stage every part of a new take under `<slug>.next-<takeId>.<suffix>` and
    describe it for the commit. The signal is checked before each part. On any
    failure (an abort, a name already taken, `audio/` gone) the parts this call
    created are removed, the id is released and the error is thrown. */
export async function prepareTake(
  handle: AnyBookHandle | { bookDir: string },
  input: PrepareTakeInput,
  signal: AbortSignal,
): Promise<StagedTake> {
  const root = audioDir(handle.bookDir);
  const { slug, ext, verdictPatches } = input;
  /* Materialised once: a caller's iterable may only be walkable once, and a
     retried commit reads it again. */
  const given = input.resynthesizedIndices;
  const resynthesizedIndices = typeof given === 'object' ? [...given] : given;
  const takeId = mintTakeId();
  const segments = { ...input.segments, takeId };

  const payloads: Array<[StagedSuffix, Uint8Array]> = [
    [ext, input.audio],
    [TAKE_SIDECAR_SUFFIXES.segments, jsonBytes(segments)],
  ];
  if (input.peaks) payloads.push([TAKE_SIDECAR_SUFFIXES.peaks, jsonBytes(input.peaks)]);
  if (input.lufs) payloads.push([TAKE_SIDECAR_SUFFIXES.lufs, jsonBytes(input.lufs)]);
  if (input.embeddings) {
    const { version, rows } = input.embeddings;
    const stored = { version, rows: storedEmbeddingRows(rows), takeId };
    payloads.push([TAKE_SIDECAR_SUFFIXES.embeddings, jsonBytes(stored)]);
  }
  if (input.verdicts) payloads.push([TAKE_SIDECAR_SUFFIXES.verdicts, jsonBytes(input.verdicts)]);

  const parts: StagedTakePart[] = [];
  /* Only names this call's own `wx` open created: a file that was already
     there is not ours to remove. */
  const created: string[] = [];
  staging.add(takeId);
  try {
    for (const [suffix, data] of payloads) {
      if (signal.aborted) throw new DOMException('prepareTake aborted', 'AbortError');
      const path = stagedPartPath(root, slug, takeId, suffix);
      const fh = await open(path, 'wx');
      created.push(path);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      parts.push({ suffix, path, size: data.byteLength });
    }
  } catch (err) {
    for (const failure of await unlinkEach(created)) {
      console.warn(`[take] staged part removal failed for ${slug}: ${failure.message}`);
    }
    releaseStaging(takeId);
    throw err;
  }

  return {
    slug,
    takeId,
    ext,
    parts,
    ...(verdictPatches ? { verdictPatches } : {}),
    ...(resynthesizedIndices === undefined ? {} : { resynthesizedIndices }),
    durationSec: segments.durationSec,
    segments,
    synthesizedAt: segments.synthesizedAt,
  };
}

/** Unlink every staged part (a missing one is fine), for every exit that does
    not commit. Every part is tried; the first failure is then thrown. The id
    stays in `liveStaging` until `releaseStaging`. */
export async function discardStaged(staged: StagedTake): Promise<void> {
  const [failure] = await unlinkEach(staged.parts.map((p) => p.path));
  if (failure) throw failure;
}

/* ------------------------------------------------------------------ *
 * reconcileSlug (§6.1 steps 1-5, lazy migration)
 * ------------------------------------------------------------------ */

/** The identity of a live segments file: its `[synthesizedAt, durationSec]`.
    Absent segments have an identity of their own (`'absent'`), so a caller that
    bound to "no segments" at the gate refuses segments that appear after it
    rather than treating the absence as nothing to check. */
function segmentsIdentity(segments: { synthesizedAt?: unknown; durationSec?: unknown } | null): string {
  if (!segments) return 'absent';
  return JSON.stringify([segments.synthesizedAt ?? null, segments.durationSec ?? null]);
}

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
    multi-live rule's tolerance). `null` means the caller touches nothing: the
    segments do not describe this audio (a mismatch, or no way to tell), or
    `state.json` could not be read (a read that fails is no verdict). Otherwise
    the answer carries the identity of the segments it read and whether they
    were a legacy-reject shape verified by a decode (`legacy`; any other chapter
    answers without a decode). The locked callers act only on segments that
    still carry that identity, and stamp the legacy shape only if `legacy`
    (the read here is lock-free). The decode
    runs under the caller's book-op only, never inside `book` (R8-3). */
async function segmentsDescribeLiveAudio(
  handle: AnyBookHandle,
  root: string,
  slug: string,
): Promise<{ identity: string; legacy: boolean } | null> {
  const segments = await readJsonTolerant<TakeSegmentsView>(livePartPath(root, slug, 'segments'));
  if (!segments) return { identity: segmentsIdentity(null), legacy: false };
  let recorded: unknown;
  try {
    const state = await readBookStateOrThrow(handle.bookDir);
    recorded = (state?.chapters.find((c) => c.slug === slug) as Record<string, unknown> | undefined)?.audioRenderedAt;
  } catch (err) {
    console.warn(`[take] ${slug}: state.json unreadable while checking the live audio; left as is:`, err);
    return null;
  }
  if (!isLegacyRejectShape(recorded, segments)) return { identity: segmentsIdentity(segments), legacy: false };
  const expected = segments.durationSec;
  let decoded: number | null = null;
  if (typeof expected === 'number' && Number.isFinite(expected)) {
    const audio = liveAudioFiles(root, slug)[0];
    decoded = audio ? await decodeDurationSec(audio.path) : null;
    if (decoded !== null && Math.abs(decoded - expected) <= DURATION_MATCH_TOLERANCE_SEC) {
      return { identity: segmentsIdentity(segments), legacy: true };
    }
  }
  console.warn(
    `[take] ${slug}: live segments (durationSec ${String(expected)}) do not describe the live audio ` +
      `(decoded ${decoded === null ? 'unreadable' : decoded.toFixed(2)} s); state.json and take ids left as they are`,
  );
  return null;
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
  let verified: { identity: string; legacy: boolean } | null = null;
  if (restamp && chapterAudioExists(root, slug)) {
    verified = await segmentsDescribeLiveAudio(handle, root, slug);
    if (!verified) return;
  }
  await ensureTakeIdentity(handle, slug, {
    mirrorState: restamp,
    ...(verified ? { onlyIfIdentity: verified.identity } : {}),
  });
  if (!restamp || !chapterAudioExists(root, slug)) return;
  try {
    await updateStateAtDir(handle.bookDir, async (state) => {
      const idx = state.chapters.findIndex((c) => c.slug === slug);
      if (idx < 0) return null;
      const segments = await readJsonTolerant<TakeSegmentsView>(livePartPath(root, slug, 'segments'));
      if (!segments) return null;
      /* Segments written after the gate's read were never checked against the audio. */
      if (verified && segmentsIdentity(segments) !== verified.identity) return null;
      const before = state.chapters[idx] as Record<string, unknown>;
      const recorded = before.audioRenderedAt;
      /* A LEGACY REJECT: `state.json` records an `audioRenderedAt` that is not the
         live segments' `synthesizedAt`. Step 4's mirror writes `audioTakeId` only,
         so it never erases this mismatch. */
      if (isLegacyRejectShape(recorded, segments)) {
        /* Stamp only a shape the gate verified by decode (a legacy shape that
           appeared after the gate's read was not). */
        return verified?.legacy ? stampedState(state, slug, segments, true) : null;
      }
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

/* ------------------------------------------------------------------ *
 * The A/B review record (a take mutation; finalize and the commit share it)
 * ------------------------------------------------------------------ */

/** Plan 286 (OD29) — what a write did with A/B review state. */
export type ReviewOutcome = 'recorded' | 'none' | 'failed';

/** The A/B review intent: absent leaves the review state alone, `null` drops
    the chapter's pending entry, an object records one when a take became
    previous. */
export type TakeReviewRequest = { characterId: string; triggeredBy: string } | null | undefined;

/** Plan 285 — best-effort with respect to the render that has already
    landed, and a DELIBERATE swallow of LockAcquisitionTimeoutError
    (CLAUDE.md's swallow list): an error is logged in full and surfaces
    ONLY as `'failed'` — no store text (whose lock key embeds the absolute
    workspace path) may reach an SSE body. Plan 286 (OD29) — three outcomes,
    so a client can tell a recorded entry from "nothing to review". */
export async function applyReview(input: {
  bookDir: string;
  chapter: { id: number; slug: string; uuid?: string };
  review: TakeReviewRequest;
  /** `null`: nothing became previous, so there is nothing to review.
      `renderedAt` is what state.json's `audioRenderedAt` carries for the new
      take. */
  entry: { id: string; oldDuration: string; newDuration: string; renderedAt: string } | null;
  /** The store's chapter list, read inside the swallow. */
  chapters: () => readonly ChapterRef[] | Promise<readonly ChapterRef[]>;
}): Promise<ReviewOutcome | undefined> {
  const { bookDir, chapter, review, entry } = input;
  if (review === undefined) return undefined;
  try {
    const chapters = await input.chapters();
    if (review !== null && entry) {
      await recordPending(bookDir, chapters, {
        id: entry.id,
        chapterId: chapter.id,
        characterId: review.characterId,
        triggeredBy: review.triggeredBy,
        triggeredAgo: 'just now',
        oldDuration: entry.oldDuration,
        newDuration: entry.newDuration,
        confidence: 1,
        playable: true,
        hasPreviousAudio: true,
        segments: [],
        origin: 'server',
        /* Identity stamps (#3400): a restructure whose best-effort drop failed must not let this
           entry act on whichever chapter later inherits the id. */
        ...(chapter.uuid ? { chapterUuid: chapter.uuid } : {}),
        renderedAt: entry.renderedAt,
      });
      return 'recorded';
    }
    await dropPendingForChapter(bookDir, chapters, chapter.id);
    return 'none';
  } catch (err) {
    console.error(
      `[take] could not record A/B review state for ${chapter.slug}; the new take is live without its review entry`,
      err,
    );
    return 'failed';
  }
}

/* ------------------------------------------------------------------ *
 * The OD4 carry-forward (§5.A OD4, Commit step 4)
 *
 * A partial write re-synthesises some segments. The others' embedding and
 * verdict rows are copied from the live take; a re-synthesised segment's live
 * rows describe audio that no longer exists, so they are dropped and replaced
 * where the job has something for them.
 * ------------------------------------------------------------------ */

interface SegmentRef {
  characterId: string;
  sentenceIds: number[];
}

const sentenceKey = (sentenceIds: readonly number[]): string => sentenceIds.join(',');

/* The embedding row's key: the shape of `aggregate.ts`'s `segKey`, which this
   module does not import (scoring is due to call into this module, #4321, and
   the edge back would then be a cycle). */
const embeddingKey = (r: SegmentRef): string => `${r.characterId}:${sentenceKey(r.sentenceIds)}`;

/** The embeddings half of the carry-forward: `liveRows` without the
    re-synthesised segments' rows, plus `freshRows` attached to them.
    `changed` is false when the result is `liveRows` itself.

    #3362 pass-6 (🟠G): without the drop, the next scoreBook run joins the OLD
    take's vector to the segment's new stamp, scoring a take it was never
    measured against. Pass-7 (🟠H): dropping without putting the fresh vectors
    back made a whole-character re-record read as embed-failed. */
export function carryForwardEmbeddingRows(
  liveRows: readonly EmbeddingRow[],
  segments: readonly SegmentRef[],
  resynthesized: ReadonlySet<number>,
  freshRows: readonly EmbeddingRow[],
): { rows: EmbeddingRow[]; changed: boolean } {
  const droppedKeys = new Set([...resynthesized].map((i) => embeddingKey(segments[i])));
  const kept = liveRows.filter((r) => !droppedKeys.has(embeddingKey(r)));
  /* #3362 pass-9 🟠I — the fresh rows come from the CURRENT analysis cache,
     so after a cast merge their characterId is the merge target while the
     segment (and the dropped row) still carry the render-time raw id. Attach
     each fresh row to the resynthesized segment it replaces by sentenceIds
     (one sentence per segment, unique in a chapter) and write it under that
     segment's OWN raw id, so the row key equals the key the drop removed.
     A row matching no resynthesized segment is ignored; a second row for a
     segment already filled is ignored too (first wins — no duplicate). */
  const segBySentenceIds = new Map<string, SegmentRef>();
  for (const i of resynthesized) segBySentenceIds.set(sentenceKey(segments[i].sentenceIds), segments[i]);
  const seen = new Set<string>();
  const added: EmbeddingRow[] = [];
  for (const r of freshRows) {
    const key = sentenceKey(r.sentenceIds);
    const seg = segBySentenceIds.get(key);
    if (!seg || seen.has(key)) continue;
    seen.add(key);
    added.push({ ...r, characterId: seg.characterId });
  }
  return { rows: [...kept, ...added], changed: kept.length !== liveRows.length || added.length > 0 };
}

/* The verdict half. A verdict row's `characterId` is the id scoring resolved,
   not necessarily the segment's raw one, so rows are matched by sentence ids.
   A patch (QA repair's Edit 6b) keeps the live row it names, patched; every
   other re-synthesised segment's row is dropped. `stagedRows` (fresh verdicts,
   or this function's own earlier output on a retried commit) add only
   re-synthesised segments the result does not already cover, so a second run
   over its own output changes nothing. */
function carryForwardVerdictRows(
  liveRows: readonly VerdictRow[],
  stagedRows: readonly VerdictRow[],
  segments: readonly SegmentRef[],
  resynthesized: ReadonlySet<number>,
  patches: readonly VerdictPatch[],
): VerdictRow[] {
  const resynthKeys = new Set([...resynthesized].map((i) => sentenceKey(segments[i].sentenceIds)));
  const patched = new Map<number, VerdictPatch>();
  for (const patch of patches) {
    if (patch.sentenceIds.length === 0) continue;
    const idx = liveRows.findIndex(
      (r) => r.sentenceIds.length > 0 && patch.sentenceIds.every((id) => r.sentenceIds.includes(id)),
    );
    if (idx >= 0) patched.set(idx, patch);
  }
  const rows = liveRows.flatMap((row, i) => {
    const patch = patched.get(i);
    if (patch) {
      const { cosine, verdict, severity, fixable } = patch;
      return [{ ...row, cosine, verdict, severity, fixable }];
    }
    return resynthKeys.has(sentenceKey(row.sentenceIds)) ? [] : [row];
  });
  const covered = new Set(rows.map((r) => sentenceKey(r.sentenceIds)));
  const added = stagedRows.filter((r) => {
    const key = sentenceKey(r.sentenceIds);
    return resynthKeys.has(key) && !covered.has(key);
  });
  return [...rows, ...added];
}

/* ------------------------------------------------------------------ *
 * Commit (§5.A "Commit" steps 1-8 and "Failure handling")
 *
 * All of it runs inside the caller's book-op span. Up to the `installed`
 * journal write any failure rolls back; from there the take is committed (D2),
 * every later step parks its error, and the first is rethrown after cleanup.
 * ------------------------------------------------------------------ */

export interface CommitTakeOptions {
  /** A partial writer's base: the live take id it was prepared against (OD2).
      A full render passes `undefined` and skips the compare-and-swap. */
  base: TakeId | undefined;
  /** The live take id when a full render started (R3-1), or `null`. */
  startTakeId: TakeId | null | undefined;
  signal: AbortSignal;
  review?: TakeReviewRequest;
  /** Accepted and not read: no rule of the Phase 2 commit uses it. */
  keepPreviousHint?: boolean;
}

export type CommitTakeResult =
  | {
      outcome: 'committed';
      newTakeId: TakeId;
      reviewOutcome?: ReviewOutcome;
      durationSec: number;
      audioQa?: TakeFields['audioQa'];
      audioModelKey: TtsModelKey;
      audioEngines: AudioEngineBreakdown;
      segmentCount: number;
    }
  /** A partial writer's base is no longer the live take; nothing was touched. */
  | { outcome: 'changed' }
  /** A live or staged file was held. Everything is back where it was and the
      staged set is kept: commit the same `StagedTake` again. */
  | { outcome: 'retry'; cause: 'held-file' };

const SIDECAR_PARTS = Object.keys(TAKE_SIDECAR_SUFFIXES) as TakeSidecarPart[];

const takeIdOf = (segments: { takeId?: unknown } | null): string | null =>
  typeof segments?.takeId === 'string' ? segments.takeId : null;

function partSuffix(ref: TakePartRef): StagedSuffix {
  return ref.part === 'audio' ? ref.ext : TAKE_SIDECAR_SUFFIXES[ref.part];
}

function partOfSuffix(suffix: StagedSuffix): TakePartRef {
  const part = SIDECAR_PARTS.find((p) => TAKE_SIDECAR_SUFFIXES[p] === suffix);
  return part ? { part } : { part: 'audio', ext: suffix as ChapterAudioExt };
}

/* Where a part of the live or the previous take sits. */
function slugPartPath(root: string, slug: string, role: 'live' | 'previous', ref: TakePartRef): string {
  if (ref.part === 'audio') {
    return role === 'live' ? liveAudioPath(root, slug, ref.ext) : previousAudioPath(root, slug, ref.ext);
  }
  return role === 'live' ? livePartPath(root, slug, ref.part) : previousPartPath(root, slug, ref.part);
}

/** Why a part was discarded: the old previous take, a live take that is not
    becoming previous, or a leftover live audio of another extension. */
type DiscardRole = 'prev' | 'live' | 'stale';

const discardPrefix = (slug: string, jid: JournalId): string => `${slug}.discard-${jid}.`;

function discardPath(
  root: string,
  slug: string,
  jid: JournalId,
  role: DiscardRole,
  suffix: StagedSuffix,
): string {
  return join(root, `${discardPrefix(slug, jid)}${role}.${suffix}`);
}

async function sizedPart(ref: TakePartRef, path: string): Promise<TakeJournalPart> {
  return { ...ref, size: (await stat(path)).size };
}

/* The PRESENT parts of the live or the previous take, audio first. The live
   take's audio is the one a probe serves (a second live file is step 6's
   leftover); every previous audio file belongs to the old previous take. */
async function probeSlugParts(
  root: string,
  slug: string,
  role: 'live' | 'previous',
): Promise<TakeJournalPart[]> {
  const audio = role === 'live' ? liveAudioFiles(root, slug).slice(0, 1) : previousAudioFiles(root, slug);
  const refs: TakePartRef[] = [
    ...audio.map((f) => ({ part: 'audio' as const, ext: f.ext })),
    ...SIDECAR_PARTS.map((part) => ({ part })),
  ];
  return Promise.all(
    refs
      .map((ref) => ({ ref, path: slugPartPath(root, slug, role, ref) }))
      .filter(({ path }) => existsSync(path))
      .map(({ ref, path }) => sizedPart(ref, path)),
  );
}

/* Every staged part; one that is gone throws ENOENT. */
function probeStagedParts(staged: StagedTake): Promise<TakeJournalPart[]> {
  return Promise.all(staged.parts.map((p) => sizedPart(partOfSuffix(p.suffix), p.path)));
}

/* Step 0, PLACEHOLDER: #4831 replaces it with the full step 0 (journal replay,
   supersession and the failure classes). `ensureTakeIdentity`'s failures never
   stop a full render (R8-2): it commits without the id. */
async function commitStep0(handle: AnyBookHandle, slug: string, partial: boolean): Promise<void> {
  await reconcileSlug(handle, slug);
  try {
    await ensureTakeIdentity(handle, slug);
  } catch (err) {
    if (partial) throw err;
    console.warn(`[take] ${slug}: take id not minted before the commit:`, err);
  }
}

function resynthesizedSet(staged: StagedTake, segmentCount: number): Set<number> {
  const indices = staged.resynthesizedIndices;
  if (indices === undefined) {
    throw new Error(`[take] a partial write of ${staged.slug} must pass resynthesizedIndices`);
  }
  if (indices === 'all') return new Set(Array.from({ length: segmentCount }, (_, i) => i));
  if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= segmentCount)) {
    throw new Error(`[take] resynthesizedIndices of ${staged.slug} names a segment the staged file lacks`);
  }
  return new Set(indices);
}

const stagedSegmentList = (staged: StagedTake): SegmentRef[] =>
  (staged.segments as { segments?: SegmentRef[] }).segments ?? [];

interface OpenedCommit {
  journal: TakeJournal;
  journalPath: string;
  /** The re-synthesised segments of a partial write; `null` for a full render. */
  resynthesized: Set<number> | null;
}

/* Steps 0-3: replay, refuse an abort, compare-and-swap, and write the journal.
   Step 4's CHOICE of what becomes previous is made here, because the journal
   records it. `null`: the base is no longer the live take. Nothing of either
   take has moved when this returns or throws. */
async function openCommit(
  handle: AnyBookHandle,
  staged: StagedTake,
  opts: CommitTakeOptions,
): Promise<OpenedCommit | null> {
  const { slug } = staged;
  const root = audioDir(handle.bookDir);
  const partial =
    opts.base !== undefined ||
    (staged.resynthesizedIndices !== undefined && staged.resynthesizedIndices !== 'all');

  await commitStep0(handle, slug, partial);
  /* Step 1 (H8). */
  if (opts.signal.aborted) throw new DOMException('commitTake aborted', 'AbortError');
  /* Step 2 (OD2). */
  const liveSegments = await readJsonTolerant<TakeSegmentsView>(livePartPath(root, slug, 'segments'));
  if (opts.base !== undefined && takeIdOf(liveSegments) !== opts.base) return null;
  const resynthesized = partial ? resynthesizedSet(staged, stagedSegmentList(staged).length) : null;

  /* Step 3. `state.json` is read before the stamp: `oldDuration` is the take's
     that is about to be replaced. */
  const state = await readBookStateOrThrow(handle.bookDir);
  const chapter = state?.chapters.find((c) => c.slug === slug) as
    | { id: number; uuid?: string; duration?: string }
    | undefined;
  if (!chapter) throw new Error(`[take] state.json names no chapter for ${slug}`);

  const previousSegments = await readJsonTolerant<TakeSegmentsView>(previousPartPath(root, slug, 'segments'));
  const hasLive = chapterAudioExists(root, slug);
  const hasPrevious = findPreviousAudio(root, slug) !== null;
  const liveTakeId = hasLive ? takeIdOf(liveSegments) : null;
  const prevTakeId = hasPrevious ? takeIdOf(previousSegments) : null;
  /* R3-1, a full render only: another render committed meanwhile, and the
     previous take is the user's pre-render audio. */
  const committedMeanwhile =
    !partial &&
    hasPrevious &&
    isTakeId(opts.startTakeId) &&
    liveTakeId !== opts.startTakeId &&
    prevTakeId === opts.startTakeId;
  /* Interim only-copy rule: with no live take the previous one is the only
     copy. Phase 3 (#4321) removes this. */
  const onlyCopy = !hasLive && hasPrevious;
  const keepPrevious = committedMeanwhile || onlyCopy;
  const preserved = hasLive && !keepPrevious;
  /* E6: the entry's stamps describe whichever take ends up previous. */
  const becomesPrevious = preserved
    ? { takeId: liveTakeId, segments: liveSegments }
    : keepPrevious
      ? { takeId: prevTakeId, segments: previousSegments }
      : null;

  const journal: TakeJournal = {
    op: 'commit',
    jid: mintJournalId(),
    phase: 'discard',
    newTakeId: staged.takeId,
    liveTakeId,
    prevTakeId,
    keepPrevious,
    parts: {
      live: await probeSlugParts(root, slug, 'live'),
      previous: await probeSlugParts(root, slug, 'previous'),
      staged: await probeStagedParts(staged),
    },
    chapter: { id: chapter.id, slug, ...(chapter.uuid ? { uuid: chapter.uuid } : {}) },
    clearGenerationState: true,
    ...(opts.review === undefined ? {} : { review: opts.review }),
    preserved,
    oldDuration: chapter.duration ?? '',
    newDuration: formatDuration(staged.durationSec),
    entry: becomesPrevious
      ? {
          takeId: staged.takeId,
          renderedAt: staged.synthesizedAt,
          previousTakeId: becomesPrevious.takeId,
          previousRenderedAt: becomesPrevious.segments?.synthesizedAt ?? null,
        }
      : null,
    supersedes: [],
    lost: [],
  };
  const journalPath = await writeTakeJournal(handle, slug, journal);
  return { journal, journalPath, resynthesized };
}

interface Move {
  from: string;
  to: string;
}

/* Every commit and rollback rename: a target that is present is a fault, never
   something to overwrite. Each completed move is logged for the rollback. */
async function moveRefusing(from: string, to: string, done: Move[]): Promise<void> {
  if (existsSync(to)) throw new Error(`[take] rename target already exists: ${basename(to)}`);
  await renameWithRetry(from, to);
  done.push({ from, to });
}

interface CommitMoves {
  done: Move[];
  /** A step-5 or step-6 rename met a held file, which is retryable. */
  heldFile: boolean;
}

/* A step-5 or step-6 rename. */
async function moveOrNoteHeld(from: string, to: string, moves: CommitMoves): Promise<void> {
  try {
    await moveRefusing(from, to, moves.done);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EBUSY' || code === 'EPERM') moves.heldFile = true;
    throw err;
  }
}

/* Step 4: the old previous take, all parts, is renamed away (F9: never
   unlinked before cleanup). */
async function discardOldPrevious(root: string, journal: TakeJournal, moves: CommitMoves): Promise<void> {
  if (journal.keepPrevious) return;
  const { slug } = journal.chapter;
  for (const ref of journal.parts.previous) {
    await moveRefusing(
      slugPartPath(root, slug, 'previous', ref),
      discardPath(root, slug, journal.jid, 'prev', partSuffix(ref)),
      moves.done,
    );
  }
}

/* Replace (or add) one staged part with `value`, keeping the descriptor true so
   the install, the sweep of a failed commit and a retry all see it. */
async function writeStagedJson(
  root: string,
  staged: StagedTake,
  suffix: StagedSuffix,
  value: unknown,
): Promise<void> {
  const path = stagedPartPath(root, staged.slug, staged.takeId, suffix);
  await writeJsonAtomic(path, value);
  const { size } = await stat(path);
  const part = staged.parts.find((p) => p.suffix === suffix);
  if (part) part.size = size;
  else staged.parts.push({ suffix, path, size });
}

/* An unparseable sidecar has nothing to carry. Any other read error fails the
   commit: committing past it would drop the untouched segments' rows. */
async function readRows<T>(path: string, read: (path: string) => Promise<T | null>): Promise<T | null> {
  try {
    return await read(path);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    console.warn(`[take] ignoring unparseable ${basename(path)}: ${err.message}`);
    return null;
  }
}

/* Step 4, a partial writer: copy from the live take, inside the span, and write
   the result over the staged files. */
async function carryForwardSidecars(
  root: string,
  staged: StagedTake,
  resynthesized: ReadonlySet<number>,
): Promise<void> {
  const segments = stagedSegmentList(staged);
  const stagedPathOf = (suffix: StagedSuffix) => staged.parts.find((p) => p.suffix === suffix)?.path;

  const embSuffix = TAKE_SIDECAR_SUFFIXES.embeddings;
  const liveEmb = await readRows(livePartPath(root, staged.slug, 'embeddings'), readEmbeddings);
  const stagedEmbPath = stagedPathOf(embSuffix);
  const freshEmb = stagedEmbPath ? await readEmbeddings(stagedEmbPath) : null;
  const version = liveEmb?.version ?? freshEmb?.version;
  if (version !== undefined) {
    const { rows } = carryForwardEmbeddingRows(
      liveEmb?.rows ?? [],
      segments,
      resynthesized,
      freshEmb?.rows ?? [],
    );
    await writeStagedJson(root, staged, embSuffix, {
      version,
      rows: storedEmbeddingRows(rows),
      takeId: staged.takeId,
    });
  }

  const verdictSuffix = TAKE_SIDECAR_SUFFIXES.verdicts;
  const liveVerdicts = await readRows(livePartPath(root, staged.slug, 'verdicts'), readVerdicts);
  const stagedVerdictPath = stagedPathOf(verdictSuffix);
  const stagedVerdicts = stagedVerdictPath ? await readVerdicts(stagedVerdictPath) : null;
  const rows = carryForwardVerdictRows(
    liveVerdicts ?? [],
    stagedVerdicts ?? [],
    segments,
    resynthesized,
    staged.verdictPatches ?? [],
  );
  /* No file at all when no row survives: a verdict file marks a chapter scored. */
  if (rows.length > 0 || stagedVerdictPath) await writeStagedJson(root, staged, verdictSuffix, rows);
}

/* Step 5: the LIVE AUDIO MOVES FIRST (D4: it is the only file ffmpeg can hold,
   so a held file fails before anything else of the live take has moved), then
   each other live part. They become the previous take, or are discarded. */
async function moveLiveAside(
  handle: AnyBookHandle,
  journal: TakeJournal,
  moves: CommitMoves,
): Promise<void> {
  const root = audioDir(handle.bookDir);
  const { slug } = journal.chapter;
  journal.phase = journal.keepPrevious ? 'discard-live' : 'preserve';
  await writeTakeJournal(handle, slug, journal);
  /* `parts.live` lists the audio first. */
  for (const ref of journal.parts.live) {
    const to = journal.preserved
      ? slugPartPath(root, slug, 'previous', ref)
      : discardPath(root, slug, journal.jid, 'live', partSuffix(ref));
    await moveOrNoteHeld(slugPartPath(root, slug, 'live', ref), to, moves);
  }
}

/* Step 6: every staged part onto its (now free) live name. The segments go last,
   so live segments carrying the new id mean the other parts are in. A live audio
   of another extension left over (N4) is moved out of the probe's way. */
async function installStaged(
  handle: AnyBookHandle,
  journal: TakeJournal,
  ext: ChapterAudioExt,
  moves: CommitMoves,
): Promise<void> {
  const root = audioDir(handle.bookDir);
  const { slug } = journal.chapter;
  journal.phase = 'install';
  await writeTakeJournal(handle, slug, journal);
  const ordered = [...journal.parts.staged].sort(
    (a, b) => Number(a.part === 'segments') - Number(b.part === 'segments'),
  );
  for (const ref of ordered) {
    await moveOrNoteHeld(
      stagedPartPath(root, slug, journal.newTakeId, partSuffix(ref)),
      slugPartPath(root, slug, 'live', ref),
      moves,
    );
  }
  for (const f of liveAudioFiles(root, slug)) {
    if (f.ext === ext) continue;
    await moveOrNoteHeld(f.path, discardPath(root, slug, journal.jid, 'stale', f.ext), moves);
  }
}

/* Failure handling before `installed`: undo this span's renames in reverse
   (installed parts back to `.next-*`, `.previous.*` back to live, discards back
   to previous), then unlink the journal, under `book`. */
async function rollBackCommit(
  handle: AnyBookHandle,
  journalPath: string,
  done: readonly Move[],
): Promise<void> {
  for (const { from, to } of [...done].reverse()) await moveRefusing(to, from, []);
  await unlinkTakeJournal(handle, journalPath);
}

/* The chapter list a review write is checked against, as `state.json` is now. */
async function chapterRefs(bookDir: string, chapter: TakeJournal['chapter']): Promise<readonly ChapterRef[]> {
  const state = await readBookStateOrThrow(bookDir);
  return state?.chapters ?? [{ id: chapter.id, slug: chapter.slug }];
}

/* Step 7, after the `installed` write: the stamp, then (only if it succeeded,
   E6) the superseded entry drop and this commit's own review record. A failed
   stamp is PARKED; the old entry no longer describes the live and previous
   pair, so it is still dropped. */
async function recordInstalledTake(
  handle: AnyBookHandle,
  journal: TakeJournal,
  park: (err: unknown) => void,
): Promise<{ stamped: boolean; reviewOutcome?: ReviewOutcome }> {
  const { bookDir } = handle;
  const { chapter, entry } = journal;
  const chapters = () => chapterRefs(bookDir, chapter);
  const dropEntry = () => applyReview({ bookDir, chapter, review: null, entry: null, chapters });
  try {
    await stampStateFromLiveTake(handle, chapter.slug, { takeChanged: true, clearGenerationState: true });
  } catch (err) {
    park(err);
    await dropEntry();
    return { stamped: false, reviewOutcome: 'none' };
  }
  if (journal.supersedes.some((s) => s.dropEntry)) await dropEntry();
  const reviewOutcome = await applyReview({
    bookDir,
    chapter,
    review: journal.review,
    entry: entry
      ? {
          id: `revision:${chapter.id}:${journal.newTakeId}`,
          oldDuration: journal.oldDuration,
          newDuration: journal.newDuration,
          renderedAt: entry.renderedAt,
        }
      : null,
    chapters,
  });
  return { stamped: true, reviewOutcome };
}

/* Step 8. The journal goes LAST: only after a successful stamp, with its own
   discards and every superseded journal gone. */
async function cleanUpCommit(
  handle: AnyBookHandle,
  journal: TakeJournal,
  journalPath: string,
  stamped: boolean,
  park: (err: unknown) => void,
): Promise<void> {
  const root = audioDir(handle.bookDir);
  const { slug } = journal.chapter;
  /* A parked stamp leaves the journal at `installed`, so replay stamps again. */
  if (stamped) {
    journal.phase = 'cleanup';
    await writeTakeJournal(handle, slug, journal).catch(park);
  }

  let discardsGone = false;
  try {
    const prefix = discardPrefix(slug, journal.jid);
    const own = (await readdir(root)).filter((name) => name.startsWith(prefix));
    const failures = await unlinkEach(own.map((name) => join(root, name)));
    failures.forEach(park);
    discardsGone = failures.length === 0;
  } catch (err) {
    park(err);
  }

  /* Oldest first, stopping at the first failure (R10-3): no journal is unlinked
     while it names one that is still present. */
  let chainGone = true;
  for (const old of journal.supersedes) {
    try {
      const [failure] = await unlinkEach(old.discards.map((name) => join(root, name)));
      if (failure) throw failure;
      await unlinkTakeJournal(handle, takeJournalPath(root, slug, old.jid));
    } catch (err) {
      park(err);
      chainGone = false;
      break;
    }
  }

  if (stamped && discardsGone && chainGone) await unlinkTakeJournal(handle, journalPath).catch(park);
}

/* The exit of a commit that will not be retried and left no journal. */
async function abandonStaged(staged: StagedTake): Promise<void> {
  try {
    await discardStaged(staged);
  } catch (err) {
    console.warn(`[take] staged part removal failed for ${staged.slug}:`, err);
  }
  releaseStaging(staged.takeId);
}

/** Commit a prepared take (§5.A "Commit"), inside the caller's `withBookOp`
    span. No lock is taken here beyond the stamp's `book` -> `state-json`, the
    review record's `revisions` and the journal unlink's `book`.

    - `changed`: a partial writer's `base` is not the live take.
    - `retry`: a file was held at step 5 or 6; everything is rolled back and the
      staged set is KEPT, still in `liveStaging`.
    - `committed`: the take is live and recorded.

    Any other failure before `installed` rolls back, removes the staged set and
    throws. A rollback that cannot finish leaves the journal (and what it names)
    for the next reconcile and throws the original error. At or after
    `installed` the take is committed (D2): the remaining steps run, then the
    first parked error is thrown; ask `takeCommitted`. */
export async function commitTake(
  handle: AnyBookHandle,
  staged: StagedTake,
  opts: CommitTakeOptions,
): Promise<CommitTakeResult> {
  assertHeld(handle, 'commitTake');
  const root = audioDir(handle.bookDir);
  const { slug } = staged;

  let opened: OpenedCommit | null;
  try {
    opened = await openCommit(handle, staged, opts);
  } catch (err) {
    await abandonStaged(staged);
    throw err;
  }
  if (!opened) {
    await abandonStaged(staged);
    return { outcome: 'changed' };
  }
  const { journal, journalPath, resynthesized } = opened;

  const moves: CommitMoves = { done: [], heldFile: false };
  try {
    await discardOldPrevious(root, journal, moves);
    if (resynthesized) {
      await carryForwardSidecars(root, staged, resynthesized);
      /* Journalled with the next phase write, before any staged part moves. */
      journal.parts.staged = await probeStagedParts(staged);
    }
    await moveLiveAside(handle, journal, moves);
    await installStaged(handle, journal, staged.ext, moves);
    /* From this write on the take is committed (D2). */
    journal.phase = 'installed';
    await writeTakeJournal(handle, slug, journal);
  } catch (err) {
    try {
      await rollBackCommit(handle, journalPath, moves.done);
    } catch (rollbackErr) {
      console.error(`[take] ${slug}: rollback failed; the journal is left for the next reconcile:`, rollbackErr);
      releaseStaging(staged.takeId);
      throw err;
    }
    if (moves.heldFile) {
      console.warn(`[take] ${slug}: commit rolled back on a held file:`, err);
      return { outcome: 'retry', cause: 'held-file' };
    }
    await abandonStaged(staged);
    throw err;
  }

  const parked: unknown[] = [];
  const park = (err: unknown): void => {
    console.warn(`[take] ${slug}: the take is committed; a later step failed:`, err);
    parked.push(err);
  };
  try {
    const { stamped, reviewOutcome } = await recordInstalledTake(handle, journal, park);
    await cleanUpCommit(handle, journal, journalPath, stamped, park);
    /* Last of all, the parked error. */
    if (parked.length > 0) throw parked[0];
    const audioEngines = engineBreakdownFromSnapshots(staged.segments.characterSnapshots ?? {});
    return {
      outcome: 'committed',
      newTakeId: staged.takeId,
      ...(reviewOutcome === undefined ? {} : { reviewOutcome }),
      durationSec: staged.durationSec,
      audioQa: staged.segments.qa,
      audioModelKey: effectiveAudioModelKey(audioEngines, staged.segments.modelKey as TtsModelKey),
      audioEngines,
      segmentCount: stagedSegmentList(staged).length,
    };
  } finally {
    releaseStaging(staged.takeId);
  }
}

/** Whether the take `newTakeId` is committed for `slug` (D2): the live segments
    carry its id, or a journal for it sits at `installed` or later. Never decided
    from `state.json`, whose stamp may be the step that failed. */
export async function takeCommitted(
  handle: AnyBookHandle,
  slug: string,
  newTakeId: TakeId,
): Promise<boolean> {
  assertHeld(handle, 'takeCommitted');
  const root = audioDir(handle.bookDir);
  const live = await readJsonTolerant<{ takeId?: unknown }>(livePartPath(root, slug, 'segments'));
  if (takeIdOf(live) === newTakeId) return true;
  const { journals } = await listTakeJournals(handle);
  for (const { path } of journals.get(slug) ?? []) {
    const read = await readTakeJournal(path);
    if (
      read.kind === 'ok' &&
      read.journal.newTakeId === newTakeId &&
      (read.journal.phase === 'installed' || read.journal.phase === 'cleanup')
    ) {
      return true;
    }
  }
  return false;
}
