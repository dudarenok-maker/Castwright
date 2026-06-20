/* Deterministic narrator-default heuristic (plan 221 Wave A; generalized to all
   languages 2026-06-20).

   The per-sentence attribution model mislabels third-person NARRATION as the
   named character (e.g. “She was lost.” -> stephanie), which would read
   narration in that character's voice. The spoken-vs-narration distinction is
   mechanical, so we decide it in code: any sentence that is NOT a spoken line is
   forced to narrator. Runs for English too (the model ignores the same rule in
   the skill prompt).

   A spoken line begins with a dialogue dash or any opening quote, OR contains a
   quoted span (double / guillemet / smart-single / boundary-anchored
   straight-single). Everything else is narration. Demote-only at the sentence
   level: it never reassigns a quoted line and never promotes narrator->character
   (it does lower line counts, which fold/reconcile consume downstream). Coverage
   is unaffected (the coverage guard keys on sentence text, not characterId).
   Pure: no I/O, no model calls. */

import type { SentenceOutput } from '../handoff/schemas.js';

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
  if (/^[«"“‘']/.test(t)) return true; // any opening quote: guillemet / straight+smart double / smart+straight single
  if (/«[^»]+»/.test(t) || /"[^"]+"/.test(t) || /“[^”]+”/.test(t) || /‘[^’]+’/.test(t)) return true; // embedded span: guillemet / straight+smart double / smart single
  // embedded STRAIGHT single, word-boundary-anchored: opens after start/space/bracket/dash, closes before space/punct.
  // Avoids apostrophes (don't, O'Brien, dogs') whose ' is never at a word boundary.
  if (/(?:^|[\s([{<«—–-])'(?=\S)[^']*?\S'(?=[\s.,!?;:)\]}>»]|$)/.test(t)) return true;
  return false;
}

/** Return a new sentence list where every non-spoken sentence's characterId is
    `narrator`. Spoken lines are returned unchanged. Pure — never mutates input. */
export function forceNarratorOnNonSpokenLines(sentences: SentenceOutput[]): SentenceOutput[] {
  return sentences.map((s) =>
    isSpokenLine(s.text) ? s : { ...s, characterId: NARRATOR_ID },
  );
}

/** Apply the narrator-default heuristic for ALL languages. Each non-spoken
    sentence whose model-assigned characterId is a real character is demoted to
    `narrator`; the FIRST such override in each contiguous demoted run has its
    confidence clamped to <= 0.5 so the Confirm-view low-confidence navigator
    gets one review stop per block (not one per sentence). Spoken lines and
    pre-existing-narrator lines are returned by reference, untouched. Pure. */
export function applyNarratorDefault(sentences: SentenceOutput[]): SentenceOutput[] {
  let clampedThisRun = false;
  return sentences.map((s) => {
    if (isSpokenLine(s.text)) {
      clampedThisRun = false;
      return s;
    }
    if (s.characterId === NARRATOR_ID) return s; // already narrator — not an override
    if (!clampedThisRun) {
      clampedThisRun = true;
      return { ...s, characterId: NARRATOR_ID, confidence: Math.min(s.confidence ?? 1, 0.5) };
    }
    return { ...s, characterId: NARRATOR_ID };
  });
}
