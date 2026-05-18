/* Sibling fsck for the chapter-audio rollback-preservation pair (plan 20).
 *
 * The preserve helper (`preserve-previous-audio.ts`) renames two files —
 * `<slug>.mp3` and `<slug>.segments.json` — to `<slug>.previous.*` before
 * a regen clobbers the live render. The renames are sequential, not
 * atomic: a crash between them leaves a half-preserved state.
 *
 * Three recovery cases this fsck handles, run once on server startup:
 *
 *   (1) `<slug>.previous.mp3` exists, `<slug>.mp3` does NOT.
 *       — Interpretation: the rename succeeded but the new render never
 *         landed (regen aborted / crashed before writing the new audio).
 *         Recovery: promote the preserved take back to live so the user
 *         doesn't see the chapter as missing audio.
 *
 *   (2) `<slug>.previous.segments.json` exists, `<slug>.previous.mp3`
 *       does NOT.
 *       — Interpretation: orphan segments file. The audio was either
 *         already promoted out (accept/reject path) or the audio rename
 *         failed first. Either way the segments file is dead state.
 *         Recovery: delete the orphan.
 *
 *   (3) Both `<slug>.previous.mp3` and `<slug>.mp3` exist.
 *       — Interpretation: valid pending-revision state. Leave alone.
 *
 * Safe to run on every server start: the operations are idempotent and
 * only ever rename / delete the `.previous.*` halves — the live `.mp3`
 * is never touched by this fsck. */

import { existsSync, readdirSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithRetry } from './atomic-rename.js';
import { BOOKS_ROOT, audioDir, bookDirByDisplay } from './paths.js';

const PREV_MP3_RE = /^(.+)\.previous\.mp3$/i;
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

  const prevMp3Slugs = new Set<string>();
  const prevSegmentsSlugs = new Set<string>();
  for (const name of entries) {
    const mp3 = PREV_MP3_RE.exec(name);
    if (mp3) {
      prevMp3Slugs.add(mp3[1]);
      continue;
    }
    const seg = PREV_SEGMENTS_RE.exec(name);
    if (seg) prevSegmentsSlugs.add(seg[1]);
  }

  /* Case 1: previous audio alive without a live counterpart → promote
     it back to live. The corresponding segments file (if any) is
     promoted alongside. */
  for (const slug of prevMp3Slugs) {
    const livePath = join(audioRoot, `${slug}.mp3`);
    if (existsSync(livePath)) continue; // case 3 — leave the pair alone
    try {
      await renameWithRetry(join(audioRoot, `${slug}.previous.mp3`), livePath);
      if (prevSegmentsSlugs.has(slug)) {
        await renameWithRetry(
          join(audioRoot, `${slug}.previous.segments.json`),
          join(audioRoot, `${slug}.segments.json`),
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
    const previousMp3 = join(audioRoot, `${slug}.previous.mp3`);
    if (existsSync(previousMp3)) continue; // pair survived — leave alone
    const orphan = join(audioRoot, `${slug}.previous.segments.json`);
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
        const bookDir = bookDirByDisplay(author, series, title);
        const result = await fsckOrphanAudio(audioDir(bookDir));
        recovered.push(...result.recovered);
        errors.push(...result.errors);
      }
    }
  }

  return { recovered, errors };
}
