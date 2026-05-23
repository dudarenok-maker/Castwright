/* Rollback preservation for chapter audio. Called from the generation route
   right before it clobbers the live `audio/<slug>.mp3` + segments.json
   pair with a fresh render. Renames the existing pair to `.previous.*` so
   the revision-diff player can audition A (preserved) vs B (new) and the
   user can accept (delete `.previous.*`) or reject (restore over the new).

   Behaviour:
   - First render (no existing audio): no-op.
   - Subsequent render: renames both files. If a stale `.previous.*` pair
     exists from an earlier accept/reject that the user has already moved on
     from (i.e. they regenerated again), the rename overwrites it — that
     older pair is dead state.
   - Best-effort: a rename failure is logged but never throws. We must NEVER
     block the regen on preservation; losing the audition is much less bad
     than losing the new audio.
   - Atomicity caveat: two renames are not atomic on a single-disk POSIX fs.
     A crash between the two leaves a half-preserved state. Sibling fsck on
     book open (see workspace/scan.ts) detects and drops orphan halves. */

import { renameWithRetry } from './atomic-rename.js';
import { findChapterAudio } from './chapter-audio-file.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface PreserveResult {
  /** True when an existing audio file was found and the rename succeeded.
      False on first render (nothing to preserve) and on rename failures. */
  preserved: boolean;
}

export async function preserveExistingAsPrevious(
  audioRoot: string,
  slug: string,
): Promise<PreserveResult> {
  const existing = findChapterAudio(audioRoot, slug);
  if (!existing) return { preserved: false };

  const previousAudio = join(audioRoot, `${slug}.previous.mp3`);
  const segmentsPath = join(audioRoot, `${slug}.segments.json`);
  const previousSegments = join(audioRoot, `${slug}.previous.segments.json`);

  try {
    /* Audio first — if this fails we abort before touching segments so
       the live pair is left untouched. */
    await renameWithRetry(existing.path, previousAudio);
  } catch (err) {
    console.warn(
      `[preserve-previous-audio] audio rename failed for ${slug}: ${(err as Error).message}`,
    );
    return { preserved: false };
  }

  if (existsSync(segmentsPath)) {
    try {
      await renameWithRetry(segmentsPath, previousSegments);
    } catch (err) {
      /* Audio moved but segments didn't — the audition surface will work
         off the audio file alone (no per-segment seek for the preserved
         take). Log and continue. The sibling fsck will pair these up on
         next book open. */

      console.warn(
        `[preserve-previous-audio] segments rename failed for ${slug}: ${(err as Error).message}`,
      );
    }
  }

  return { preserved: true };
}

/** Probe whether a preserved (`.previous.mp3`) audio pair exists for the
    chapter. Used by the revisions detector to set `hasPreviousAudio` on
    pending revisions so the UI knows whether to render the A play button
    or fall back to "Original audio not preserved." */
export function hasPreviousAudio(audioRoot: string, slug: string): boolean {
  return existsSync(join(audioRoot, `${slug}.previous.mp3`));
}
