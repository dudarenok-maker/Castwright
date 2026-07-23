/* Projects attributed sentence-level units onto chapter-body character
   positions — the foundation of a segmentation-invariant attribution metric.
   Uses normalizeForMatch (position-preserving: folds smart quotes/dashes/
   ellipsis, NEVER collapses whitespace or strips brackets) so the normalized
   [start,end) match can be mapped back to exact chapterText offsets. NEVER
   use scorer.ts's normalise() here — it collapses whitespace/strips bracket
   tags and has no positional correspondence back to the original text.

   `stripTags` (opt-in) additionally removes inline `[...]` annotation tags
   (`[emphatic]`, `[structure: …]`) from BOTH the chapterText basis and each
   unit before matching, then maps located spans back to ORIGINAL chapterText
   positions. It exists for the TRUTH projection only (run-eval.ts): the raw
   hydrated `chapterText` carries inline tags the corrected/re-segmented truth
   lines don't, so a line differing only by a tag would otherwise be dropped
   from the char-recall denominator. Tag positions are never painted (they map
   to nothing), so they stay null — invisible to the metric, which only scores
   truth-attributed chars. Default (`stripTags` off) is byte-identical to the
   original projection. */
import { normalizeForMatch } from './review-apply-core.js';

export interface CharProjection {
  speakerByChar: Array<string | null>; // length === chapterText.length
  spans: Array<{ start: number; end: number; speakerId: string }>; // [start,end) in chapterText
  dropped: number; // units whose text was NOT located at/after the cursor (skipped, chars stay null)
}

/** Removes inline `[...]` annotation tags from `text`, collapsing any run of
    ASCII spaces/tabs the removal would leave (NOT newlines — paragraph breaks
    survive) so a word boundary stays a single separator. Returns the stripped
    string plus `map`, where `map[j]` is the ORIGINAL index of `stripped[j]` and
    `map[stripped.length] === text.length` is the exclusive-end sentinel. Tag
    chars and collapsed-away whitespace get NO map entry, so they never receive
    a painted speaker. A lone `[` with no closing `]` is treated as a literal
    char. */
export function stripInlineTags(text: string): { stripped: string; map: number[] } {
  let stripped = '';
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '[') {
      const close = text.indexOf(']', i + 1);
      if (close >= 0) {
        i = close + 1; // drop the whole [..] run — no map entry
        continue;
      }
      // no closing bracket → fall through, treat '[' as a literal char
    }
    if (ch === ' ' || ch === '\t') {
      // collapse: if the previously kept char is already a space, skip this one
      // so a removed tag between two spaces doesn't leave a double space.
      if (stripped.length > 0 && stripped[stripped.length - 1] === ' ') {
        i += 1;
        continue;
      }
      stripped += ' ';
      map.push(i);
      i += 1;
      continue;
    }
    stripped += ch;
    map.push(i);
    i += 1;
  }
  map.push(text.length); // exclusive-end sentinel
  return { stripped, map };
}

export function projectToChars(
  chapterText: string,
  units: Array<{ text: string; speakerId: string }>,
  opts?: { stripTags?: boolean },
): CharProjection {
  const stripTags = opts?.stripTags ?? false;
  // The matching basis: with stripTags, inline `[...]` tags are removed from
  // chapterText and `map` translates basis (stripped) indices back to original
  // chapterText positions. Without it, basis === chapterText and map is identity.
  const { stripped: basis, map } = stripTags
    ? stripInlineTags(chapterText)
    : { stripped: chapterText, map: null as number[] | null };
  const toOrig = (basisIdx: number): number => (map ? map[basisIdx]! : basisIdx);

  // Build the normalized basis + its index map ONCE — same construction as
  // review-apply-core.ts's resolveAnchorOffset, but retained for the whole text.
  // origEndForNormLen[k] = basis index after k normalized chars.
  let norm = '';
  const origEndForNormLen: number[] = [0];
  for (let i = 0; i < basis.length; i++) {
    const piece = normalizeForMatch(basis[i]!);
    for (let j = 0; j < piece.length; j++) origEndForNormLen.push(i + 1);
    norm += piece;
  }

  const speakerByChar: Array<string | null> = new Array(chapterText.length).fill(null);
  const spans: Array<{ start: number; end: number; speakerId: string }> = [];
  let dropped = 0;
  let normCursor = 0;

  for (const unit of units) {
    // Strip the unit the same way as the basis (and trim tag-created edge
    // whitespace) so a tag-only unit becomes empty and is dropped, not matched
    // as a zero-length span.
    const unitText = stripTags ? stripInlineTags(unit.text).stripped.trim() : unit.text;
    const nUnit = normalizeForMatch(unitText);
    const matchStart = nUnit ? norm.indexOf(nUnit, normCursor) : -1;
    if (matchStart < 0) {
      dropped++;
      continue;
    }
    const matchEnd = matchStart + nUnit.length;
    // origEndForNormLen[k] is the basis index AFTER k normalized chars, so the
    // basis start is origEndForNormLen[matchStart] and the basis end is
    // origEndForNormLen[matchEnd]; map both back to original chapterText coords.
    const basisStart = origEndForNormLen[matchStart]!;
    const basisEnd = origEndForNormLen[matchEnd]!;
    const start = toOrig(basisStart);
    const end = toOrig(basisEnd);
    // Paint the ORIGINAL positions of the surviving basis chars in the match —
    // tag/collapsed positions (no map entry) are skipped, staying null.
    for (let b = basisStart; b < basisEnd; b++) speakerByChar[toOrig(b)] = unit.speakerId;
    spans.push({ start, end, speakerId: unit.speakerId });
    normCursor = matchEnd;
  }

  return { speakerByChar, spans, dropped };
}
