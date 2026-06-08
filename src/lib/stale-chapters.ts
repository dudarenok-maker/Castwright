/* fs-34 — shared "which rendered chapters does this character speak in" helper.
   Extracted from the cast-save stale-audio handler in layout.tsx so the new
   emotion-edit + variant-design/remove staleness triggers reuse the SAME
   predicate (a `done` chapter whose `characters` map includes the id) instead
   of diverging. The hook dispatches `setStaleAudio` so the existing banner
   (plan 114) fires for emotion/variant changes too. */

import { useAppDispatch, useAppSelectorShallow } from '../store';
import { uiActions } from '../store/ui-slice';
import type { Chapter, ChangeLogEvent } from './types';

export function renderedChaptersForCharacter(characterId: string, chapters: Chapter[]): number[] {
  return chapters
    .filter((ch) => ch.state === 'done' && ch.characters && characterId in ch.characters)
    .map((ch) => ch.id);
}

/* Bug 2 — a rendered chapter whose sentence→speaker assignments were changed
   AFTER it was generated is stale and needs regenerating. Derived (not a stored
   flag) from two pieces of already-persisted state, so the indicator survives a
   reload: the change-log `boundary_move` events (one is appended/bumped for every
   sentence reassignment) and the chapter's `audioRenderedAt` render stamp.

   This is the "optimistic now" half of the indicator: time-based, so a
   reassign-then-undo still reads stale until regenerated. The precise per-sentence
   net-diff is a filed follow-up. Correctness precondition: EVERY reassignment path
   must emit a `boundary_move` (see manuscript.tsx). */

/** The ISO time of the most recent sentence-reassignment logged for a chapter, or
    undefined if none. `events` are newest-first (the change-log unshifts), so the
    first match is the latest. */
export function latestReassignAt(
  chapterId: number,
  events: ChangeLogEvent[],
): string | undefined {
  return events.find((e) => e.type === 'boundary_move' && e.chapterId === chapterId)?.at;
}

/** True when a `done` chapter's audio predates its latest sentence reassignment. */
export function isChapterStaleFromReassign(chapter: Chapter, events: ChangeLogEvent[]): boolean {
  if (chapter.state !== 'done' || !chapter.audioRenderedAt) return false;
  const reassignedAt = latestReassignAt(chapter.id, events);
  return reassignedAt != null && reassignedAt > chapter.audioRenderedAt;
}

/** Returns a callback that marks a character's rendered audio stale (no-op when
    the character speaks in no `done` chapter). Reads chapters from the store. */
export function useMarkCharacterStaleIfRendered(): (character: {
  id: string;
  name: string;
}) => void {
  const dispatch = useAppDispatch();
  /* Optional-chained so a partial test store (no chapters slice) is a safe
     no-op rather than a render-time crash. */
  const chapters = useAppSelectorShallow((s) => s.chapters?.chapters);
  return (character) => {
    const chapterIds = renderedChaptersForCharacter(character.id, chapters ?? []);
    if (chapterIds.length > 0) {
      dispatch(
        uiActions.setStaleAudio({
          characterId: character.id,
          characterName: character.name,
          chapterIds,
        }),
      );
    }
  };
}
