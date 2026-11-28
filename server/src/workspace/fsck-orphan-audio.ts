/* Sibling fsck for the chapter-audio rollback-preservation pair (plan 20).
 *
 * The preserve helper (`preserveExistingAsPrevious`, `chapter-take.ts`) renames two files —
 * `<slug>.{mp3,m4a,ogg}` and `<slug>.segments.json` — to `<slug>.previous.*` before
 * a regen clobbers the live render. The renames are sequential, not
 * atomic: a crash between them leaves a half-preserved state.
 *
 * The shapes this fsck meets, run once on server startup:
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
 *         failed first.
 *         Recovery: the take module's sweep moves it to `audio/.orphaned/`;
 *         nothing here deletes it.
 *
 *   (3) `<slug>.previous.<ext>` exists alongside a live take of any
 *       supported extension (`<slug>.{mp3,m4a,ogg}`).
 *       — Interpretation: valid pending-revision state. Leave alone.
 *
 * Before case 1, `fsckAllBooks` runs the take module on the book:
 * `reconcileBook` (book journals), then the per-chapter `reconcileSlug` (#4339)
 * on every chapter slug, then `sweepSlug` for any other slug that left something
 * behind. THAT step can replay a take journal, rename a wrong-named live file to
 * its real extension, demote or quarantine a duplicate live file to
 * `audio/.orphaned/`, mint ids into the live segments and embeddings, unlink
 * temp files and abandoned staged parts, and quarantine other leftovers (case 2
 * among them), so the live audio is touched by the fsck as a whole, though case 1
 * itself only renames the `.previous.*` halves.
 *
 * Safe to run on every server start: every operation is idempotent. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renameWithRetry } from './atomic-rename.js';
import { withBookOpAtDir } from './book-op-lock.js';
import {
  CHAPTER_AUDIO_EXTS,
  findChapterAudio,
  findPreviousAudio,
  listSweepSlugs,
  listTakeJournals,
  liveAudioPath,
  livePartPath,
  previousPartPath,
  reconcileBook,
  reconcileSlug,
  sweepSlug,
} from './chapter-take.js';
import { BOOKS_ROOT, audioDir, bookDirByDisplay, stateJsonPath } from './paths.js';
import { readStateJsonWithRecovery } from './state-migrate.js';

/* `<slug>.previous.<ext>` for every audio extension the take module knows. */
const PREV_AUDIO_RE = new RegExp('^(.+)\\.previous\\.(?:' + CHAPTER_AUDIO_EXTS.join('|') + ')$', 'i');
const PREV_SEGMENTS_RE = /^(.+)\.previous\.segments\.json$/i;

export interface FsckOrphanAudioResult {
  /** Per-(audioRoot, slug) entry that the fsck recovered or repaired.
      Empty in the no-op case (nothing on disk needed touching). */
  recovered: Array<{ audioRoot: string; slug: string; action: FsckAction }>;
  errors: Array<{ audioRoot: string; slug: string; action: FsckAction; message: string }>;
}

export type FsckAction = 'promoted-previous-to-live';

/** Walk a single book's audio root and promote half-preserved
    rollback pairs (case 1). Mutates the on-disk state; returns a report of
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

  return { recovered, errors };
}

/** File count and total bytes under `audio/.orphaned/`, recursively, or `null`
    when the folder does not exist (§6.1 step 2: the fsck logs this per book on
    every boot). Never throws: an unreadable entry is skipped. */
export function orphanedSummary(audioRoot: string): { files: number; bytes: number } | null {
  const dir = join(audioRoot, '.orphaned');
  if (!existsSync(dir)) return null;
  let files = 0;
  let bytes = 0;
  const walk = (d: string): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(d, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else {
          files += 1;
          bytes += st.size;
        }
      } catch {
        /* vanished mid-walk: not counted */
      }
    }
  };
  walk(dir);
  return { files, bytes };
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
          await withBookOpAtDir(walkedDir, async (handle) => {
            /* One listing for the book's span (R7-8). Book journals first; a
               failure is logged and the slugs still run. */
            const listing = await listTakeJournals(handle);
            try {
              await reconcileBook(handle, listing, { touches: 'book-wide' });
            } catch (err) {
              console.warn('[fsck-orphan-audio] book journal reconcile failed; continuing', err);
            }
            /* Replay, sweep and lazy migration (§6.1) for every chapter slug
               BEFORE case 1. A failure for one slug is logged and the walk
               continues. A replay stamp that fails here is one of them: there is
               nothing to fail into, and its journal stays. */
            let slugs: string[] = [];
            try {
              const st = await readStateJsonWithRecovery(stateJsonPath(handle.bookDir));
              slugs = (st?.chapters ?? []).map((c) => c.slug).filter((x): x is string => typeof x === 'string');
            } catch (err) {
              console.warn('[fsck-orphan-audio] could not read chapter slugs; skipping migration', err);
            }
            for (const slug of slugs) {
              try {
                await reconcileSlug(handle, slug, { listing });
              } catch (err) {
                console.warn(`[fsck-orphan-audio] reconcile failed for ${slug}; continuing`, err);
              }
            }
            /* Leftovers of a slug `state.json` no longer lists: sweep only. */
            for (const slug of await listSweepSlugs(handle)) {
              if (!slugs.includes(slug)) await sweepSlug(handle, slug, listing);
            }
            const result = await fsckOrphanAudio(audioDir(handle.bookDir));
            recovered.push(...result.recovered);
            errors.push(...result.errors);
            const orphaned = orphanedSummary(audioDir(handle.bookDir));
            if (orphaned) {
              console.log(
                `[fsck-orphan-audio] ${walkedDir}: .orphaned/ holds ${orphaned.files} file(s), ${orphaned.bytes} bytes`,
              );
            }
          });
        } catch (err) {
          console.warn('[fsck-orphan-audio] skipping a book this startup', err);
        }
      }
    }
  }

  return { recovered, errors };
}
