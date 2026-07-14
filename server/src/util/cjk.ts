/* Shared "is this a CJK character?" primitive (fs-59 W2 review follow-up,
   issue #1576). Two call sites (`analyzer/gemini.ts` token estimation and
   `analyzer/strip-front-matter.ts` narrative-line detection) each hand-rolled
   an equivalent codepoint-range regex (`[぀-ヿ㐀-䶿一-鿿]`) that had quietly
   drifted into a strict SUBSET of "CJK": it omits supplementary-plane Han,
   CJK Compatibility Ideographs, and halfwidth Katakana that the
   property-escape form below covers. Four other seams in the codebase
   (`tts/detect-language.ts`, `routes/import.ts`,
   `analyzer/dialogue-structure/name-matcher.ts`, `analyzer/stage2-chunk.ts`,
   `analyzer/stage2-coverage.ts`) already used the property-escape form —
   this module is the single source of truth so the two range-form sites
   can't diverge from it (or each other) again. */

/** Matches a single Han (CJK ideograph), Hiragana, or Katakana codepoint. */
export const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** True if `s` contains at least one CJK character. */
export function hasCjkChar(s: string): boolean {
  return CJK_CHAR_RE.test(s);
}

/** Count of CJK characters in `s`. */
export function countCjkChars(s: string): number {
  const m = s.match(new RegExp(CJK_CHAR_RE.source, 'gu'));
  return m ? m.length : 0;
}
