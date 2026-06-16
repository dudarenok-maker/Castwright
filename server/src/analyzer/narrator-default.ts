/* Deterministic narrator-default heuristic (plan 221, Wave A).

   The per-sentence attribution model — especially on non-Latin scripts —
   mislabels third-person NARRATION as the named character (e.g. "Егор засунул
   руки в карманы" → `egor`), which would read narration in that character's
   voice. The spoken-vs-narration distinction is mechanical, so we decide it in
   code instead of trusting the model: any sentence that is NOT a spoken line is
   forced to `narrator`.

   A "spoken line" = begins with a dialogue dash (—/–/-) or an opening quote
   («/"/“), OR contains a quoted span. Everything else is narration. This
   deliberately LEAVES dashed narrative tags ("— сказал юноша") to the model +
   language preamble (they look spoken), and never touches dialogue lines, so it
   cannot break speaker attribution — it only ever changes a non-spoken line to
   `narrator`. Coverage is unaffected (the coverage guard keys on sentence text,
   not characterId). Empirically (server/repro-heuristic.mts) this took the
   model's narration-block correctness from 0–1/6 to 6/6 on every run with zero
   dialogue damage. Pure: no I/O, no model calls. */

import type { SentenceOutput } from '../handoff/schemas.js';
import { isNonEnglish } from '../tts/language.js';

const NARRATOR_ID = 'narrator';

/** True when the sentence text reads as spoken dialogue: a leading dialogue
    dash / opening quote, or an embedded quoted span. Also matches the named
    HTML dash entities `&mdash;`/`&ndash;` — some EPUB toolchains emit these and
    `stripHtml` (parsers/html-utils.ts) only decodes a small named-entity set, so
    the dash can survive literally in the body the model echoes. Without this,
    real dialogue prefixed by `&mdash;` would be wrongly forced to narrator. */
export function isSpokenLine(text: string): boolean {
  const t = (text ?? '').trimStart();
  if (!t) return false;
  if (/^(&mdash;|&ndash;|[-–—])/i.test(t)) return true; // dash entities + literal dashes
  if (/^[«"“]/.test(t)) return true; // opening guillemet / straight / smart quote
  if (/«[^»]+»/.test(t) || /"[^"]+"/.test(t) || /“[^”]+”/.test(t)) return true; // embedded quoted span
  return false;
}

/** Return a new sentence list where every non-spoken sentence's characterId is
    `narrator`. Spoken lines are returned unchanged. Pure — never mutates input. */
export function forceNarratorOnNonSpokenLines(sentences: SentenceOutput[]): SentenceOutput[] {
  return sentences.map((s) =>
    isSpokenLine(s.text) ? s : { ...s, characterId: NARRATOR_ID },
  );
}

/** Apply the narrator-default heuristic only for non-English books. For English
    (and missing language) returns the SAME array reference (no-op) so the
    English path is byte-identical. */
export function applyNonEnglishNarratorDefault(
  sentences: SentenceOutput[],
  language: string | undefined,
): SentenceOutput[] {
  if (!isNonEnglish(language ?? '')) return sentences;
  return forceNarratorOnNonSpokenLines(sentences);
}
