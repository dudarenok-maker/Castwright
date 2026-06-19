/* Layer B (#938) — drop the book's byline author from a chapter's detected roster
   before stage-2 attribution. Empirically (gemma4-e4b, Ночной дозор Ch1): once the
   "Protagonist"-roled author entity is gone, stage-2 attributes the protagonist's
   dialogue to the real protagonist on its own — no reclamation/anchor needed.

   The legit author-as-character case (a framed author's-note where the author
   genuinely speaks) is preserved by exempting chapters whose title marks an
   author's-note. Pure; mirrors fold-minor-cast.ts. */
import type { CharacterOutput } from '../handoff/schemas.js';
import { normaliseNameKey } from '../util/safe-id.js';

const NARRATOR_ID = 'narrator';

/* Bilingual author's-note chapter-title patterns. Start small; extend on real
   corpus data (same discipline as GENERIC_ROLE_RU). */
const AUTHOR_NOTE_TITLE_RX =
  /author'?s?\s+note|notes?\s+from\s+the\s+author|от\s+автора|предислови|послеслови|об\s+авторе/i;

export function isFramedAuthorNote(chapterTitle: string | undefined): boolean {
  if (!chapterTitle) return false;
  return AUTHOR_NOTE_TITLE_RX.test(chapterTitle);
}

export function dropBylineAuthorFromChapter(
  characters: CharacterOutput[],
  opts: { author?: string; chapterTitle?: string },
): { characters: CharacterOutput[]; dropped: string[] } {
  const authorKey = normaliseNameKey(opts.author);
  if (!authorKey) return { characters, dropped: [] };
  if (isFramedAuthorNote(opts.chapterTitle)) return { characters, dropped: [] };

  const dropped: string[] = [];
  const kept = characters.filter((c) => {
    if (c.id === NARRATOR_ID) return true;
    if (normaliseNameKey(c.name) === authorKey) {
      dropped.push(c.name);
      return false;
    }
    return true;
  });
  if (dropped.length === 0) return { characters, dropped: [] }; // preserve identity on no-op
  return { characters: kept, dropped };
}
