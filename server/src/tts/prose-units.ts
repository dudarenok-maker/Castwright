/* Shared prose-unit floor (#2263 — chapter-aware language detection). Moved
   out of scripts/repair-missing-book-language.mts so the chapter-aware
   detector (detect-language.ts's `detectManuscriptLanguageFromChapters`,
   single-body-chapter path) and the repair script share ONE copy rather than
   drifting. See the repair script's own header for the full corpus this was
   measured against.

   A "prose unit" is a run of text closed by sentence-terminal punctuation —
   the CJK fullwidth forms are included so zh/ja prose isn't penalised for
   using different terminal marks than Latin scripts. One or more
   consecutive terminal marks ("...", "?!") close ONE unit, not one per
   mark. */
const SENTENCE_TERMINAL_RE = /[.!?…。！？]+/g;

export function countProseUnits(sample: string): number {
  return (sample.match(SENTENCE_TERMINAL_RE) ?? []).length;
}

/* Measured 2026-08-11 over all 20 live (cache-backed) books vs. the junk
   classes #2246 round 2 review evidenced — counted on the SAME post-strip,
   post-slice sample the callers' own sample-preparation pipeline produces
   (detectionSample() in the repair script; prepareSample() in
   detect-language.ts):

     thinnest real book (Unlocked)          130 prose units
     next thinnest (Юный дрессировщик)      213
     every other real book                242-394
     TOC-only sample                          1
     nav-only EPUB stub                       1
     OCR-noise sample                         1

   Floor = 20: 6.5x below the thinnest real book, 20x above every evidenced
   junk class. Do not re-derive or move this number — see the repair
   script's header for the corpus it came from. */
export const PROSE_UNIT_FLOOR = 20;
