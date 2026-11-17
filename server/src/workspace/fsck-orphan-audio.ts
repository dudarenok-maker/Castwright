/* Sibling fsck for the chapter-audio rollback-preservation pair (plan 20).
 *
 * The preserve helper (`preserveExistingAsPrevious`, `chapter-take.ts`) renames two files —
 * `<slug>.{mp3,m4a,ogg}` and `<slug>.segments.json` — to `<slug>.previous.*` before
 * a regen clobbers the live render. The renames are sequential, not
 * atomic: a crash between them leaves a half-preserved state.
 *
 * Three recovery cases this fsck handles, run once on server startup:
 *
 *   (1) `<slug>.previous.{mp3,m4a,ogg}` exists, no live `<slug>.{mp3,m4a,ogg}` does.
 *       — Interpretation: the rename succeeded but the new render never
 *         landed (regen aborted / crashed before writing the new audio).
 *         Recovery: promote the preserved take back to live so the user
 *         doesn't see the chapter as missing audio.
 *
 *   (2) `<slug>.previous.segments.json` exists, no `<slug>.previous.<ext>`
 *       of any extension does.
 *       — Interpretation: orphan segments file. The audio was either
 *         already promoted out (accept/reject path) or the audio rename
 *         failed first. Either way the segments file is dead state.
 *         Recovery: delete the orphan.
 *
 *   (3) `<slug>.previous.<ext>` exists alongside a live take of any
 *       supported extension (`<slug>.{mp3,m4a,ogg}`).
 *       — Interpretation: valid pending-revision state. Leave alone.
 *
 * Safe to run on every server start: the operations are idempotent and
 * only ever rename / delete the `.previous.*` halves — the live audio
 * is never touched by this fsck. */

import { existsSync, readdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithRetry } from './atomic-rename.js';
import { withBookOpAtDir } from './book-op-lock.js';
import {
  CHAPTER_AUDIO_EXTS,
  findChapterAudio,
  findPreviousAudio,
  liveAudioPath,
  livePartPath,
  previousPartPath,
} from './chapter-take.js';
import { BOOKS_ROOT, audioDir, bookDirByDisplay } from './paths.js';

/* `<slug>.previous.<ext>` for every audio extension the take module knows. */
const PREV_AUDIO_RE = new RegExp('^(.+)\\.previous\\.(?:' + CHAPTER_AUDIO_EXTS.join('|') + ')$', 'i');
const PREV_SEGMENTS_RE = /^(.+)\.previous\.segments\.json$/i;

export interface FsckOrphanAudioResult {
  /** Per-(audioRoot, slug) entry that the fsck recovered or repaired.
      Empty in the no-op case (nothing on disk needed touching). */
  recovered: Array<{ audioRoot: string; slug: string; action: FsckAction }>;
  errors: Array<{ audioRoot: string; slug: string; action: FsckAction; message: string }>;
}

export type FsckAction =
  | 'promoted-previous-to-live'
  | 'dropped-orphan-segments';

/** Walk a single book's audio root and reconcile half-preserved
    rollback pairs. Mutates the on-disk state; returns a report of
    actions taken plus any per-action errors that didn't halt the
    sweep. The function never throws — it is fire-and-forget safe. */
export async function fsckOrphanAudio(audioRoot: string): Promise<FsckOrphanAudioResult> {
  const recovered: FsckOrphanAudioResult['recovered'] = [];
  const errors: FsckOrphanAudioResult['errors'] = [];

  if (!existsSync(audioRoot)) return { recovered, errors };

  let entries: string[];
  try {
    entries = readdirSync(audioRoot);
  } catch {
    return { recovered, errors };
  }

  const prevAudioSlugs = new Set<string>();
  const prevSegmentsSlugs = new Set<string>();
  for (const name of entries) {
    const audio = PREV_AUDIO_RE.exec(name);
    if (audio) {
      prevAudioSlugs.add(audio[1]);
      continue;
    }
    const seg = PREV_SEGMENTS_RE.exec(name);
    if (seg) prevSegmentsSlugs.add(seg[1]);
  }

  /* Case 1: previous audio alive without a live counterpart → promote
     it back to live. The corresponding segments file (if any) is
     promoted alongside. */
  for (const slug of prevAudioSlugs) {
    /* Any supported extension counts as live (#3457): an m4a/ogg book's
       live take is never `<slug>.mp3`. */
    if (findChapterAudio(audioRoot, slug)) continue; // case 3 — leave the pair alone
    /* The previous take keeps its real file type: `.previous.m4a` is promoted
       to `<slug>.m4a`, never to `<slug>.mp3` (H13). */
    const previous = findPreviousAudio(audioRoot, slug);
    if (!previous) continue;
    try {
      await renameWithRetry(previous.path, liveAudioPath(audioRoot, slug, previous.ext));
      if (prevSegmentsSlugs.has(slug)) {
        await renameWithRetry(
          previousPartPath(audioRoot, slug, 'segments'),
          livePartPath(audioRoot, slug, 'segments'),
        );
        prevSegmentsSlugs.delete(slug);
      }
      recovered.push({ audioRoot, slug, action: 'promoted-previous-to-live' });
    } catch (err) {
      errors.push({
        audioRoot,
        slug,
        action: 'promoted-previous-to-live',
        message: (err as Error).message,
      });
    }
  }

  /* Case 2: orphan segments without a matching audio (live OR previous)
     → drop. We re-check disk state because case 1 may have just
     promoted the matching previous segments. */
  for (const slug of prevSegmentsSlugs) {
    if (findPreviousAudio(audioRoot, slug)) continue; // pair survived — leave alone
    const orphan = previousPartPath(audioRoot, slug, 'segments');
    if (!existsSync(orphan)) continue; // already cleaned
    try {
      await unlink(orphan);
      recovered.push({ audioRoot, slug, action: 'dropped-orphan-segments' });
    } catch (err) {
      errors.push({
        audioRoot,
        slug,
        action: 'dropped-orphan-segments',
        message: (err as Error).message,
      });
    }
  }

  return { recovered, errors };
}

/** Walk every book on disk and run the fsck against its `audio/` root.
    Called once on server startup via a fire-and-forget pattern in
    `server/src/index.ts`; safe to invoke from anywhere. Returns the
    aggregated report so the caller can log a summary. */
export async function fsckAllBooks(): Promise<FsckOrphanAudioResult> {
  const recovered: FsckOrphanAudioResult['recovered'] = [];
  const errors: FsckOrphanAudioResult['errors'] = [];

  if (!existsSync(BOOKS_ROOT)) return { recovered, errors };

  const safeReaddir = (p: string): string[] => {
    try {
      return readdirSync(p);
    } catch {
      return [];
    }
  };

  for (const author of safeReaddir(BOOKS_ROOT)) {
    const authorDir = join(BOOKS_ROOT, author);
    for (const series of safeReaddir(authorDir)) {
      const seriesDir = join(authorDir, series);
      for (const title of safeReaddir(seriesDir)) {
        const walkedDir = bookDirByDisplay(author, series, title);
        /* #3711 — per-book step under book-op, on the folder the book lives in
           NOW: a rename queued ahead of the sweep must not leave the promote/drop
           renames landing in a vacated path. A throw for one book (its state
           turning unreadable under the lock, a lock timeout behind a slow
           holder) skips THAT book only; the next startup retries it (PR #3714
           review pass 3). */
        try {
          await withBookOpAtDir(walkedDir, async (bookDir) => {
            const result = await fsckOrphanAudio(audioDir(bookDir));
            recovered.push(...result.recovered);
            errors.push(...result.errors);
          });
        } catch (err) {
          console.warn('[fsck-orphan-audio] skipping a book this startup', err);
        }
      }
    }
  }

  return { recovered, errors };
}
