/* Build a stub Revision for the profile-change preview gate. The
   generation-stream middleware fires this when a preview chapter's
   `chapters/regenerateChapterIds` render reaches `chapter_complete`
   (`revisions/markRevisionPlayable` for the chapter the user is previewing),
   so it's built with `playable: true` — the new take is already on disk and
   the A/B player can play both sides immediately.

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
      Defaults to a generic "voice change" tag. */
  triggeredBy?: string;
  /** Whether the new take is already on disk. The preview gate builds the
      stub on chapter_complete, so it passes `true`; defaults `false` for any
      caller that enqueues a stub before the render lands. */
  playable?: boolean;
}

export function buildPendingRevisionStub({
  chapter,
  character,
  triggeredBy,
  playable = false,
}: BuildArgs): Revision {
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
    playable,
    /* Optimistic — flips false in the UI when the previous-audio fetch
       404s post-render. */
    hasPreviousAudio: true,
    segments: [],
  };
}
