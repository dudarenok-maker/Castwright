/* The voice library and the cast slice each carry half of a bidirectional
   link. Server-side (server/src/routes/voices.ts) every library Voice is
   derived from a character with `id = character.voiceId ?? character.id`,
   so the rule for joining the two sides is:

     1. If the character has an explicit `voiceId`, match that against
        Voice.id first — that preserves library-reuse semantics, where one
        character may point at a voice from a different book entirely.
     2. Otherwise fall back to Voice.id === Character.id. The analyzer
        schema doesn't emit `voiceId`, so freshly-analysed characters always
        rely on this fallback.

   Without (2) the cast Voice column shows "No library voice" on every row
   of a freshly-analysed book and the library panel cards stay inert.

   Rule (2) has a real collision, though: the analyzer assigns the SAME
   literal id ('narrator', 'unknown-male', 'unknown-female') to every book's
   narrator and auto-folded background-bucket character, and neither ever
   gets an explicit voiceId. Two unrelated books' narrators both fall back
   to bare id 'narrator', so the aggregated `library` array can carry two
   entries with that same id — one this character's own (`source:
   'current'`), one an unrelated book's (`source: 'library'`). A plain
   `.find()` would return whichever happens to be array-first. Preferring a
   `source: 'current'` match first removes that ambiguity: the character
   being looked up always belongs to the currently-open book, so its own
   voice (if the fallback found anything at all) is always the right one. */

import type { Character, Voice } from './types';

export function findVoiceForCharacter(c: Character, library: Voice[]): Voice | undefined {
  if (c.voiceId) {
    const explicit = library.find((v) => v.id === c.voiceId);
    if (explicit) return explicit;
  }
  const currentBookMatch = library.find((v) => v.id === c.id && v.source === 'current');
  if (currentBookMatch) return currentBookMatch;
  return library.find((v) => v.id === c.id);
}

export function findCharacterForVoice(
  v: Voice,
  characters: Character[],
  /** Restrict the bare-id fallback to a voice that actually belongs to the
      CURRENTLY-OPEN book (`v.source === 'current'`). Opt-in (default false)
      because not every caller's `characters` is that book's own roster —
      the cross-book duplicate-review flow (views/voices.tsx) intentionally
      matches a voice against an arbitrary OTHER book's roster it fetched on
      demand, where `source` describes the globally-open book, not that
      roster. Only the cast view's voice-library panel needs this: its
      `characters` IS always the open book's own cast, so a same-id foreign
      voice (the narrator/unknown-male/unknown-female collision) must never
      resolve to one of ITS characters. */
  restrictToCurrentBook = false,
): Character | undefined {
  const explicit = characters.find((c) => c.voiceId === v.id);
  if (explicit) return explicit;
  if (restrictToCurrentBook && v.source !== 'current') return undefined;
  return characters.find((c) => c.id === v.id);
}

/* When the voices view merges two duplicate roster entries (e.g. "Wren"
   + "Wren Sparrow"), the longer/fuller name should survive — the shorter
   becomes an alias on the survivor (Character.aliases). `a` is the
   first-selected character, `b` the second; the return order is
   { target, source } so the caller passes `source.id` and `target.id`
   straight into api.mergeCharacters without re-ordering.

   Selection rule:
     1. Substring containment, case-insensitive — "Wren" ⊂
        "Wren Sparrow" makes the containing name the survivor. This is
        the use case the OpenAPI Character.aliases schema explicitly
        describes.
     2. Longer trimmed name wins. Ties on a non-empty trimmed length
        fall to (3).
     3. Stable tiebreaker: `a` is the survivor (i.e. the first-selected
        card). The voices pill renders selection in click order, so the
        user can re-pick to flip the survivor when names are
        ambiguous. */
export function pickMergeSurvivor(
  a: Character,
  b: Character,
): { target: Character; source: Character } {
  const aName = a.name.trim();
  const bName = b.name.trim();
  const aLower = aName.toLowerCase();
  const bLower = bName.toLowerCase();
  if (aLower && bLower && aLower !== bLower) {
    if (aLower.includes(bLower)) return { target: a, source: b };
    if (bLower.includes(aLower)) return { target: b, source: a };
  }
  if (aName.length > bName.length) return { target: a, source: b };
  if (bName.length > aName.length) return { target: b, source: a };
  return { target: a, source: b };
}
