/* The chapter take module (spec 2026-11-13-chapter-take-lifecycle-design.md,
   §4 "Take identity and fields" and §5.A "Ownership", OD1 Option A).

   One module owns every take path, every take mutation and every take field in
   `state.json`. Phase 1 (#4319) lands its first part: the sniffer, the stamp and
   the lazy identity. Nothing calls it yet, so there is no behaviour change.

   R10-2 LEAF RULE: `scan.ts` and every module it reaches import take names
   from `take-fields.ts` ONLY, never from this file. This file may import
   `scan.ts` types, `book-state-update.ts`, `audio/segments-io.ts`,
   `audio/render-integrity/embeddings-io.ts` and `book-op-lock.ts`.

   LOCKS (§5.A "Fence and lock placement"): entry points never lock
   themselves. Each takes a live `BookHandle` from the caller's `withBookOp`
   and refuses a stale or hand-built one (`assertHeld`, as `moveBookFolder`
   does). The only lock taken here is `updateStateAtDir`'s `book` -> `state-json`
   pair, and its mutate callback takes no other lock. */

import { open, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { renameWithRetry } from './atomic-rename.js';
import { assertHeld, type BookHandle } from './book-op-lock.js';
import { updateStateAtDir } from './book-state-update.js';
import { audioDir } from './paths.js';
import { readJson, writeJsonAtomic } from './state-io.js';
import {
  CHAPTER_AUDIO_EXTS,
  TAKE_STATE_FIELDS,
  chapterAudioExists,
  deriveTakeFields,
  findChapterAudio,
  findPreviousAudio,
  isTakeId,
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
  handle: BookHandle,
  slug: string,
  opts: { takeChanged: boolean },
): Promise<void> {
  assertHeld(handle, 'stampStateFromLiveTake');
  const root = audioDir(handle.bookDir);
  await updateStateAtDir(handle.bookDir, async (state) => {
    const idx = state.chapters.findIndex((c) => c.slug === slug);
    if (idx < 0) return null;
    const segments = await readJson<TakeSegmentsView>(livePartPath(root, slug, 'segments'));
    const derived: TakeFields = segments ? deriveTakeFields(segments) : {};
    const before = state.chapters[idx] as Record<string, unknown>;
    const next: Record<string, unknown> = { ...before };
    for (const field of TAKE_STATE_FIELDS) {
      const value = derived[field];
      if (value !== undefined) {
        next[field] = value;
      } else if (opts.takeChanged && !(field === 'duration' && !segments)) {
        delete next[field];
      }
    }
    if (TAKE_STATE_FIELDS.every((f) => sameValue(before[f], next[f]))) return null;
    const chapters = state.chapters.slice();
    chapters[idx] = next as unknown as (typeof chapters)[number];
    return { ...state, chapters };
  });
}

/* ------------------------------------------------------------------ *
 * Take identity (§4.1)
 * ------------------------------------------------------------------ */

/* Add `takeId` to a JSON sidecar, leaving every other member untouched
   (embeddings: `{ version, rows }` -> `rows` is not re-derived). Missing file
   is a no-op. */
async function stampIdIntoJson(path: string, takeId: string): Promise<void> {
  if (!existsSync(path)) return;
  const raw = await readJson<Record<string, unknown>>(path);
  if (!raw || typeof raw !== 'object') return;
  await writeJsonAtomic(path, { ...raw, takeId });
}

/** Lazily mint a take id for a take that lacks one. Idempotent: a take whose
    segments already carry a valid `takeId` is not rewritten.

    A LIVE take (`chapterAudioExists`) whose live segments lack a valid id gets
    one minted into the segments (a write failure throws) and the live
    embeddings if present, then mirrored into `state.json` via
    `stampStateFromLiveTake(.., { takeChanged: false })`. A failure of THAT
    mirror is logged and swallowed: the segments carry the id, and the scan heal
    repairs `state.json`. A PREVIOUS take whose `.previous.segments.json` lacks
    an id gets its own id (and its embeddings), with no live file touched. */
export async function ensureTakeIdentity(handle: BookHandle, slug: string): Promise<void> {
  assertHeld(handle, 'ensureTakeIdentity');
  const root = audioDir(handle.bookDir);

  if (chapterAudioExists(root, slug)) {
    const segPath = livePartPath(root, slug, 'segments');
    const segments = await readJson<Record<string, unknown>>(segPath);
    if (segments && !isTakeId(segments.takeId)) {
      const takeId = mintTakeId();
      await writeJsonAtomic(segPath, { ...segments, takeId });
      await stampIdIntoJson(livePartPath(root, slug, 'embeddings'), takeId);
      try {
        await stampStateFromLiveTake(handle, slug, { takeChanged: false });
      } catch (err) {
        console.warn(`[take] state.json identity mirror failed for ${slug}:`, err);
      }
    }
  }

  const prevSegPath = previousPartPath(root, slug, 'segments');
  const prevSegments = await readJson<Record<string, unknown>>(prevSegPath);
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
      overwritten by the rename, as before. An unlink failure is logged and
      skipped.
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
      await unlink(stale);
    } catch (err) {
      console.warn(`[take] stale previous audio removal failed for ${slug}: ${(err as Error).message}`);
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
