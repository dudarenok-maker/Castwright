/* Projects attributed sentence-level units onto chapter-body character
   positions — the foundation of a segmentation-invariant attribution metric.
   Uses normalizeForMatch (position-preserving: folds smart quotes/dashes/
   ellipsis, NEVER collapses whitespace or strips brackets) so the normalized
   [start,end) match can be mapped back to exact chapterText offsets. NEVER
   use scorer.ts's normalise() here — it collapses whitespace/strips bracket
   tags and has no positional correspondence back to the original text. */
import { normalizeForMatch } from './review-apply-core.js';

export interface CharProjection {
  speakerByChar: Array<string | null>; // length === chapterText.length
  spans: Array<{ start: number; end: number; speakerId: string }>; // [start,end) in chapterText
  dropped: number; // units whose text was NOT located at/after the cursor (skipped, chars stay null)
}

export function projectToChars(
  chapterText: string,
  units: Array<{ text: string; speakerId: string }>,
): CharProjection {
  // Build the normalized chapterText + its index map ONCE — same construction
  // as review-apply-core.ts's resolveAnchorOffset, but retained for the whole
  // text rather than discarded after locating a single anchor.
  // origEndForNormLen[k] = original index after k normalized chars.
  let norm = '';
  const origEndForNormLen: number[] = [0];
  for (let i = 0; i < chapterText.length; i++) {
    const piece = normalizeForMatch(chapterText[i]);
    for (let j = 0; j < piece.length; j++) origEndForNormLen.push(i + 1);
    norm += piece;
  }

  const speakerByChar: Array<string | null> = new Array(chapterText.length).fill(null);
  const spans: Array<{ start: number; end: number; speakerId: string }> = [];
  let dropped = 0;
  let normCursor = 0;

  for (const unit of units) {
    const nUnit = normalizeForMatch(unit.text);
    const matchStart = nUnit ? norm.indexOf(nUnit, normCursor) : -1;
    if (matchStart < 0) {
      dropped++;
      continue;
    }
    const matchEnd = matchStart + nUnit.length;
    // origEndForNormLen[k] is the original index AFTER k normalized chars, so
    // the original start is origEndForNormLen[matchStart] (chars before the
    // match) and the original end is origEndForNormLen[matchEnd].
    const start = origEndForNormLen[matchStart]!;
    const end = origEndForNormLen[matchEnd]!;
    for (let i = start; i < end; i++) speakerByChar[i] = unit.speakerId;
    spans.push({ start, end, speakerId: unit.speakerId });
    normCursor = matchEnd;
  }

  return { speakerByChar, spans, dropped };
}
