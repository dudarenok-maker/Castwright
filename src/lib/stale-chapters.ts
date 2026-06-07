/* fs-34 — shared "which rendered chapters does this character speak in" helper.
   Extracted from the cast-save stale-audio handler in layout.tsx so the new
   emotion-edit + variant-design/remove staleness triggers reuse the SAME
   predicate (a `done` chapter whose `characters` map includes the id) instead
   of diverging. The hook dispatches `setStaleAudio` so the existing banner
   (plan 114) fires for emotion/variant changes too. */

import { useAppDispatch, useAppSelectorShallow } from '../store';
import { uiActions } from '../store/ui-slice';
import type { Chapter } from './types';

export function renderedChaptersForCharacter(characterId: string, chapters: Chapter[]): number[] {
  return chapters
    .filter((ch) => ch.state === 'done' && ch.characters && characterId in ch.characters)
    .map((ch) => ch.id);
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
