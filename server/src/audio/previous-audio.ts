/* Plan 285 (#3400) — the A/B take audio steps, MOVED UNCHANGED from
   routes/chapter-audio.ts so the old routes (DELETE …/audio/previous,
   POST …/audio/previous/restore) and the new revision-ops routes run the same
   code. Behaviour is today's, residuals included (filed as #3456 "Chapter take
   lifecycle"): restore deletes the live take BEFORE the rename, swallows a
   failed segments rename, and `.previous` is always `.mp3`.

   No import of routes/generation.ts: the isGenerationActive 409 stays in the
   routes, in today's order. */

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { findChapterAudio, type ChapterAudioFile } from '../workspace/chapter-audio-file.js';

/** Mirror of findChapterAudio but for the `.previous.mp3` sibling. */
export function findPreviousChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null {
  const path = join(audioRoot, `${slug}.previous.mp3`);
  if (!existsSync(path)) return null;
  return { path, ext: 'mp3', mime: 'audio/mpeg', urlSuffix: 'audio.mp3' };
}

/** ACCEPT — the new render wins. Deletes the .previous pair (unlink errors
    swallowed, as today). 'none' when nothing was preserved. */
export async function acceptPreviousAudio(audioRoot: string, slug: string): Promise<'deleted' | 'none'> {
  const previous = findPreviousChapterAudio(audioRoot, slug);
  if (!previous) return 'none';
  /* Delete both files — segments.json absence on its own isn't a fault. */
  await unlink(previous.path).catch(() => {});
  await unlink(join(audioRoot, `${slug}.previous.segments.json`)).catch(() => {});
  return 'deleted';
}

/** REJECT — the prior render wins. Promotes .previous over the live names.
    'none' when nothing was preserved; throws when the audio rename fails
    (callers answer today's fixed 500). */
export async function restorePreviousAudio(audioRoot: string, slug: string): Promise<'restored' | 'none'> {
  const previous = findPreviousChapterAudio(audioRoot, slug);
  if (!previous) return 'none';

  /* Delete the live render first so the previous → live rename doesn't
     race a still-present current file. */
  const currentLive = findChapterAudio(audioRoot, slug);
  if (currentLive) await unlink(currentLive.path).catch(() => {});
  const liveSegments = join(audioRoot, `${slug}.segments.json`);
  if (existsSync(liveSegments)) await unlink(liveSegments).catch(() => {});

  try {
    await renameWithRetry(previous.path, join(audioRoot, `${slug}.${previous.ext}`));
  } catch (err) {
    console.error(`[chapter-audio] failed to restore previous audio for ${slug}: ${(err as Error).message}`);
    throw err;
  }
  const previousSegments = join(audioRoot, `${slug}.previous.segments.json`);
  if (existsSync(previousSegments)) {
    await renameWithRetry(previousSegments, liveSegments).catch(() => {});
  }
  return 'restored';
}
