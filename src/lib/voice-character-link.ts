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
   of a freshly-analysed book and the library panel cards stay inert. */

import type { Character, Voice } from './types';

export function findVoiceForCharacter(c: Character, library: Voice[]): Voice | undefined {
  if (c.voiceId) {
    const explicit = library.find(v => v.id === c.voiceId);
    if (explicit) return explicit;
  }
  return library.find(v => v.id === c.id);
}

export function findCharacterForVoice(v: Voice, characters: Character[]): Character | undefined {
  const explicit = characters.find(c => c.voiceId === v.id);
  if (explicit) return explicit;
  return characters.find(c => c.id === v.id);
}
