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

import { open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { assertHeld, type BookHandle } from './book-op-lock.js';
import { updateStateAtDir } from './book-state-update.js';
import { audioDir } from './paths.js';
import { readJson, writeJsonAtomic } from './state-io.js';
import {
  TAKE_STATE_FIELDS,
  chapterAudioExists,
  deriveTakeFields,
  isTakeId,
  livePartPath,
  mintTakeId,
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
