/* Slug choice for the analysis persist (#4230).

   A re-analysis that retitles an already-rendered chapter recomputes its slug
   from the new title, but the chapter's audio stays on disk under the OLD slug,
   so state.json would point at a slug with nothing under it and the chapter
   would read as unrendered. Owner decision (2026-11-17): when a take exists the
   persist keeps the existing slug and only the title changes; a chapter with no
   take still gets the recomputed slug.

   "A take exists" means a LIVE audio file exists at the chapter's current
   state.json slug (`<slug>.mp3|m4a|ogg` under the audio dir), i.e.
   `chapterAudioExists`. This is the same predicate as section 4.2 of
   docs/superpowers/specs/2026-11-13-chapter-take-lifecycle-design.md ("A live
   take exists iff at least one live audio file exists. Segments and sidecars do
   not make a take live."). `.previous.*` files and sidecars never count.

   Read-only fs (at most three existsSync probes), so it is safe inside the
   persist's `updateStateAtDir` callback and takes no lock. */

import { chapterAudioExists } from './chapter-take.js';

export function slugKeepingTake(
  prevChapters: readonly { id: number; slug: string }[],
  audioRoot: string,
  id: number,
  computedSlug: string,
): string {
  const prev = prevChapters.find((c) => c.id === id);
  if (!prev || typeof prev.slug !== 'string' || prev.slug === '') {
    return computedSlug;
  }
  if (chapterAudioExists(audioRoot, prev.slug)) return prev.slug;
  return computedSlug;
}
