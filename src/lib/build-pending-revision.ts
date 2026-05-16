/* Build a stub Revision for the enqueue-on-regen path. The generation-stream
   middleware fires this when `chapters/regenerateCharacter` (or its batch
   sibling) dispatches, BEFORE the new render is on disk. The stub sits in
   `revisions.pending` with `playable: false` so the toolbar pending badge
   surfaces the in-flight regen, and the diff player renders a "Rendering…"
   state until chapter_complete arrives.

   `hasPreviousAudio` is conservatively `true` because the generation route
   ALWAYS calls preserveExistingAsPrevious (which no-ops on first renders).
   For first-render regenerations the live `.previous.*` files won't exist,
   so a follow-up `getChapterAudioPrevious` will 404 and the UI flips the A
   card to "Original audio not preserved". We stay optimistic in the slice
   to avoid extra round-trips at dispatch time. */

import type { Revision, Chapter, Character } from './types';

interface BuildArgs {
  chapter: Pick<Chapter, 'id' | 'title' | 'duration'>;
  character: Pick<Character, 'id' | 'name'>;
  /** Optional reason — surfaces in the diff player's "Triggered by" line.
      Defaults to a generic "regenerate" tag. */
  triggeredBy?: string;
}

export function buildPendingRevisionStub({ chapter, character, triggeredBy }: BuildArgs): Revision {
  /* id encodes (chapterId, characterId) so enqueuePending's dedupe collapses
     a regen-restart for the same target into the same slot. The trailing
     epoch is intentionally NOT in the id — we want the dedupe to bite. */
  const id = `revision:${chapter.id}:${character.id}`;
  return {
    id,
    chapterId: chapter.id,
    characterId: character.id,
    triggeredBy: triggeredBy ?? `${character.name} voice change`,
    triggeredAgo: 'just now',
    oldDuration: chapter.duration ?? '',
    newDuration: chapter.duration ?? '',
    confidence: 1,
    playable: false,
    /* Optimistic — flips false in the UI when the previous-audio fetch
       404s post-render. */
    hasPreviousAudio: true,
    segments: [],
  };
}
