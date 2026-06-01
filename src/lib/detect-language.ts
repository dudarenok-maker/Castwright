/* fs-2 — heuristic manuscript-language detection (client-side).

   v1 knows English ↔ Russian only. We count Cyrillic letters as a fraction of
   ALL letters (ignoring whitespace, digits, punctuation, so a Russian text with
   lots of dialogue dashes/quotes still reads as Russian). At ≥30% Cyrillic the
   manuscript is Russian; otherwise English. This only seeds the confirm-view
   selector — the user can always override before confirming, and the field is
   an open BCP-47 string so adding a language later is a UI change, not a
   contract change. */

export const CYRILLIC_THRESHOLD = 0.3;

const CYRILLIC_RE = /[Ѐ-ӿ]/g;
/* Any letter in any script — Latin, Cyrillic, accented, etc. Uses the Unicode
   letter property so non-ASCII Latin (é, ñ) still counts toward the denominator
   and doesn't inflate the Cyrillic fraction. */
const LETTER_RE = /\p{L}/gu;

/** Detect a manuscript's BCP-47 language from a text sample. Returns `'ru'`
    when ≥30% of the letters are Cyrillic, else `'en'`. Empty / letter-less
    input → `'en'`. Sample a prefix for very long manuscripts — the ratio is
    stable well before the whole book. */
export function detectLanguage(text: string, sampleChars = 20_000): string {
  const sample = text.length > sampleChars ? text.slice(0, sampleChars) : text;
  const letters = sample.match(LETTER_RE)?.length ?? 0;
  if (letters === 0) return 'en';
  const cyrillic = sample.match(CYRILLIC_RE)?.length ?? 0;
  return cyrillic / letters >= CYRILLIC_THRESHOLD ? 'ru' : 'en';
}
