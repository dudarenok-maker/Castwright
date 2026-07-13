/* Deterministic narrator identity for every newly analysed book.

   The narrator is the same character in every book, so its name and voice are
   seeded from code, not the model: a localized display name (with a "Narrator"
   alias) and one fixed folkloric persona identical across languages. This gives
   the narrator a designed voice instead of the Kokoro-preset fallback, and a
   consistent identity across a multi-language series.

   Pure and idempotent. A user's rename or re-designed voice is left untouched
   here; its survival across a reparse is handled by the cast merge
   (store/merge-analysis-cast.ts). No I/O, no model calls. */

import type { CharacterOutput } from '../handoff/schemas.js';
import { getLanguageEntry, isDefaultNarratorName } from '../tts/language-registry.js';

const NARRATOR_IDS = new Set(['narrator', 'char-narrator']);
export const NARRATOR_DEFAULT_NAME = 'Narrator';

/** The one fixed folkloric narrator persona, verbatim from the accepted Coalfall
    Russian narrator. Seeded onto a new book's narrator so every book — in every
    language — starts from the same designed voice. */
export const FOLKLORIC_NARRATOR = {
  voiceStyle:
    'A middle-aged voice, neutral in gender, with a medium pitch and steady, ' +
    'mid-paced delivery; the timbre is rich, grounded, and resonant, carrying ' +
    'a measured, folkloric warmth suitable for audiobook narration.',
  gender: 'neutral',
  ageRange: 'adult',
  tone: { warmth: 40, pace: 50, authority: 60, emotion: 40 },
  attributes: ['formal', 'observational', 'measured', 'rhythmic'],
} as const;

/** Seed the narrator (`id` 'narrator'/'char-narrator') with a localized display
    name + "Narrator" alias, and the fixed folkloric voice identity when it has
    no `voiceStyle` yet. Pure and idempotent; returns a new array, never mutates
    the input. Non-narrator characters and the no-narrator case pass through. */
export function applyNarratorIdentity(
  characters: CharacterOutput[],
  language: string,
): CharacterOutput[] {
  const localized = getLanguageEntry(language)?.narratorName ?? NARRATOR_DEFAULT_NAME;
  return characters.map((c) => {
    if (!NARRATOR_IDS.has(c.id)) return c;
    const next: CharacterOutput = { ...c };

    // Name: replace only when the current name is still a default (English
    // "Narrator" or any language's localized default). A user rename survives.
    if (isDefaultNarratorName(c.name)) next.name = localized;

    // Alias: ensure "Narrator" is present exactly once (case-insensitive).
    const aliases = Array.isArray(c.aliases) ? [...c.aliases] : [];
    if (!aliases.some((a) => a.trim().toLowerCase() === 'narrator')) {
      aliases.push(NARRATOR_DEFAULT_NAME);
    }
    next.aliases = aliases;

    // Voice identity: seed as a unit only when no voiceStyle has been set yet.
    if (!c.voiceStyle) {
      next.voiceStyle = FOLKLORIC_NARRATOR.voiceStyle;
      next.gender = FOLKLORIC_NARRATOR.gender;
      next.ageRange = FOLKLORIC_NARRATOR.ageRange;
      next.tone = { ...FOLKLORIC_NARRATOR.tone };
      next.attributes = [...FOLKLORIC_NARRATOR.attributes];
    }
    return next;
  });
}
