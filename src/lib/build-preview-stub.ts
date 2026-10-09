/* Build a stub Revision for the profile-change / generation preview gate.
   The generation-stream middleware fires this when a preview chapter's
   render completes without a server entry recorded (plan 286 Task 24:
   `chapters/previewChapterComplete` with `reviewOutcome` `'none'` or
   `'failed'`), or when the active cache has no entry for the chapter yet.

   `hasPreviousAudio` comes from the caller's own `getChapterAudioPrevious`
   check (`openPreview`, generation-stream-middleware.ts) — never assumed
   here, since a first render (`reviewOutcome: 'none'`) legitimately has no
   preserved take. */

import type { Revision, Chapter, Character } from './types';

interface BuildArgs {
  chapter: Pick<Chapter, 'id' | 'title' | 'duration'>;
  character: Pick<Character, 'id' | 'name'>;
  /** Whether a `.previous.*` take exists for this chapter — decides the A
      card's "Original audio not preserved" fallback. */
  hasPreviousAudio: boolean;
  /** Optional reason — surfaces in the diff player's "Triggered by" line.
      Defaults to a generic "voice change" tag. */
  triggeredBy?: string;
}

export function buildPreviewStub({
  chapter,
  character,
  hasPreviousAudio,
  triggeredBy,
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
    playable: true,
    hasPreviousAudio,
    segments: [],
  };
}
