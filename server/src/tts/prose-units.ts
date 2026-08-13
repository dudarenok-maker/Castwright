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

/* #2256 — PROSE_UNIT_FLOOR closes the three UNPUNCTUATED junk classes above
   (they collapse to 1 unit, since they contain no terminator at all) but not
   a PUNCTUATED one: a long numbered table of contents or a periods-and-page-
   numbers index accumulates enough terminators to clear 20 units purely by
   having many short entries, none of which is real prose (#2251's own
   review comment measured a 1200-unit numbered TOC and a 1000-unit repeated-
   heading sample this way). A per-unit LENGTH metric can't separate that
   from a real CJK manuscript — the same comment measured a real zh book and
   a repeated "Chapter One." heading at the same 11-letters-per-unit median;
   there is no length threshold that keeps one and drops the other, because a
   CJK sentence really is that short in letters.

   Lexical variety survives where length doesn't: junk repeats a tiny
   vocabulary (a handful of character names, an index's term list, "Chapter"/
   "One") across hundreds of entries, while real prose — short-clause CJK
   included — keeps introducing new words. Guiraud's R (distinct word TYPES
   / sqrt(total word TOKENS)) is the length-corrected version of that
   ratio — plain type-token ratio trends down with sample length on its own
   (Heaps' law), which would unfairly penalise a long real novel against a
   short junk sample; dividing by sqrt(tokens) instead of tokens corrects for
   that. A "word token" is a run of Unicode letters (`/\p{L}+/gu`,
   case-folded) — digits and punctuation never count as a token, so a TOC's
   page numbers contribute to neither side of the ratio.

   That alone has two real gaps, both intentionally left open rather than
   chased:

   1. A punctuated list built from a WIDE, mostly-non-repeating vocabulary
      (e.g. many distinct chapter TITLES with no entry numbering at all) can
      reach a Guiraud's R close to real short prose. Not what closes the
      evidenced classes here — every evidenced shape (a numbered TOC, a
      page-numbered index) needs its number to be usable as a TOC or an
      index at all, so DIGIT_TOKEN_SHARE_CEILING catches those regardless of
      vocabulary width (see below) — a title-only list with no numbering at
      all is a softer, unevidenced edge, the same caveat #2251's review
      comment made about punctuated junk generally.
   2. Guiraud's R over the RAW sample decays with length even for real
      prose that happens to repeat verbatim — which is exactly how this
      repo's OWN test suite builds "thick" chapter fixtures
      (`Array(300).fill(REAL_SENTENCE).join(' ')`). Computed raw, a real
      sentence repeated 300 times scores LOWER than the evidenced junk
      classes, which would make the gate reject real content. guiraudR/
      digitTokenShare below fix this: both dedupe EXACT (normalised) prose
      units before measuring, so a real sentence repeated any number of
      times measures as ONE occurrence of itself — genuine junk's
      repetition is what's supposed to be invisible to dedup, not real
      prose's. A numbered TOC or index is barely affected by dedup (each
      entry's own number keeps it nominally distinct); a repeated heading
      with no number collapses straight to its own (tiny) vocabulary either
      way.

   Word tokens are matched by WORD_TOKEN_RE: a run of non-CJK Unicode
   letters, OR a single Han/Hiragana/Katakana character. CJK doesn't use
   whitespace, so treating a whole punctuation-delimited CJK clause as ONE
   token (a plain `/\p{L}+/gu`) undercounts its lexical variety severely —
   per-CHARACTER tokenisation is what countWords' own CJK branch already
   assumes (server/src/parsers/front-matter.ts's CJK_CHARS_PER_WORD). Digits
   and punctuation are never tokens either way, so a TOC's page numbers
   contribute to neither side of guiraudR's ratio.

   Measured 2026-08-13, read-only, against:
     - the 7 real books written by the 2026-08-11 repair run (Keeper of the
       Lost Cities series, replayed through a fresh manuscript re-parse
       exactly as the repair script's own manuscriptChaptersFor would) — R
       from 14.6 (Bonus Keefe Story, the shortest) to 24.8 (Unlocked),
       digitTokenShare from 0 to 0.0021 — real prose essentially never
       repeats a whole sentence verbatim, so dedup is a no-op here
     - this repo's OWN test-suite convention of building a chapter via
       `Array(N).fill(oneRealSentence).join(' ')` (detect-language.test.ts,
       N up to 300) — post-dedup this measures as just that ONE sentence's
       own richness, R from 4.36 (a single Russian sentence) to 5.69 (a
       single Chinese one, character-tokenised), regardless of N
     - REAL_CJK_PROSE (24 distinct real sentences, no dedup effect) — R=12.4
     - reconstructions of the three residual junk shapes from #2251's review
       comment (a numbered TOC, repeated "Chapter One." headings, a
       periods-and-page-numbers index), at every scale from just-clearing
       PROSE_UNIT_FLOOR up to 1000 entries — a numbered TOC dedupes to its
       fixed cast-name vocabulary regardless of entry count (constant
       R=2.45); repeated headings dedupe to one heading regardless of count
       (constant R=1.41); the index barely dedupes at all (each entry's own
       page number keeps it distinct) and decays with scale exactly like
       the un-deduped measurement did (R 1.83 down to 0.32) — the worst
       (highest) junk R measured, across every shape and scale, is 2.45
     - a deliberately adversarial edge (not evidenced): a numbered TOC or
       index shrunk to the SMALLEST size that still clears PROSE_UNIT_FLOOR
       (20 entries) with a WIDE, non-repeating vocabulary — R up to 4.47,
       above LEXICAL_RICHNESS_FLOOR. digitTokenShare (50%, unaffected by
       vocabulary width — the entry NUMBER is what makes it a TOC/index at
       all) closes this one; it is why the two floors are independent gates
       rather than one combined score

   LEXICAL_RICHNESS_FLOOR = 3: sits between the worst evidenced-shape junk
   (2.45, a numbered TOC, constant at every scale) and the thinnest sample
   that must still pass (4.36, this repo's own single-sentence test-fixture
   convention) — a real but tight ~1.2x/~1.5x margin on each side, driven by
   how short this repo's canonical test sentences are; the actual 7-book
   corpus clears it by 3.2x-5.5x more. DIGIT_TOKEN_SHARE_CEILING = 0.1:
   ~48x above the thickest real sample (0.0021) and 5x below every numbered
   junk shape measured (0.5), independent of vocabulary width. Do not
   re-derive or move either number without re-measuring against the same
   corpus. */
export const LEXICAL_RICHNESS_FLOOR = 3;
export const DIGIT_TOKEN_SHARE_CEILING = 0.1;

const WORD_TOKEN_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{L}+/gu;

/** Collapses EXACT (trimmed, case-folded, whitespace-normalised) duplicate
 *  prose units to their first occurrence, joined back with a space — so a
 *  real sentence repeated N times measures, for guiraudR/digitTokenShare
 *  purposes, as ONE occurrence of itself rather than N. Genuine junk's
 *  repetition survives this unaffected: a numbered TOC/index entry carries
 *  its own number, so dedup barely reduces it (see this file's own header);
 *  a repeated heading with no number collapses to one occurrence either
 *  way, which is exactly the shape both floors are meant to catch. */
function dedupeProseUnits(sample: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of sample.split(SENTENCE_TERMINAL_RE)) {
    const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw.trim());
  }
  return out.join(' ');
}

/** Guiraud's R — distinct word types / sqrt(total word tokens), over the
 *  sample's DEDUPED prose units (see dedupeProseUnits). 0 for a token-less
 *  sample (never a real winner: the script pre-pass / franc gates upstream
 *  already require letters to reach here). */
export function guiraudR(sample: string): number {
  const tokens = dedupeProseUnits(sample).toLowerCase().match(WORD_TOKEN_RE) ?? [];
  if (tokens.length === 0) return 0;
  return new Set(tokens).size / Math.sqrt(tokens.length);
}

/** Share of whitespace-delimited tokens that contain at least one digit
 *  character, over the sample's DEDUPED prose units (see dedupeProseUnits)
 *  — a numbered table of contents or a page-numbered index is dense in
 *  these by construction (every usable entry needs its own number, so
 *  dedup barely thins them); real narrative prose is not. 0 for an empty
 *  sample. */
export function digitTokenShare(sample: string): number {
  const tokens = dedupeProseUnits(sample).trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const withDigit = tokens.filter((t) => /\d/.test(t)).length;
  return withDigit / tokens.length;
}
