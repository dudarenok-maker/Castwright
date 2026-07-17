/* #1679 — Read-only scene-break annotation. After stage-2 attribution finishes,
   find the word-free separator lines (`* * *`, `⁂`, dash rules, `<hr>`-derived
   `* * *`) that survive in the chapter body, and flag the first sentence of the
   scene each one opens with `sceneBreakBefore = true`.

   Binding is MARKER-ANCHORED (issue #1679, Russian-hardening decision): the
   separator line's body offset is literal and exact, but the scene-opening
   sentence's text is often NOT locatable in the body on restructure-heavy books
   (dash-prefixed / split dialogue that the model re-emitted). So instead of
   requiring the opener itself to locate, we anchor on the exact separator offset
   plus the LAST sentence that reliably located BEFORE it, and flag the next
   sentence in reading order — the true opener even when its text didn't match.
   Where the opener DOES locate (clean English prose) this agrees exactly with a
   naive "first sentence after the marker" rule.

   Pure display aid: mutates ONLY the flag. Worst case is a divider placed a
   sentence or two off, or (leading separator) dropped — never a corrupted
   sentence, id, order, or attribution. */

import { locateSentenceOffsets } from './dialogue-structure/aligner.js';
import { hasAttributableContent } from './stage2-coverage.js';
import type { SentenceOutput } from '../handoff/schemas.js';

/** Blank-line-delimited paragraph units. A unit with visible text but zero
    attributable content (`* * *`, `⁂`, `---`, `―`) is a scene separator; a
    page-number unit (`42`) is NOT (digits are attributable). Returns each
    separator unit's start offset in the raw body. */
function separatorOffsets(body: string): number[] {
  const offsets: number[] = [];
  const delimiter = /\n[ \t]*\n/g;
  let unitStart = 0;
  let m: RegExpExecArray | null;
  const consider = (from: number, to: number) => {
    const unit = body.slice(from, to);
    if (unit.trim().length > 0 && !hasAttributableContent(unit)) offsets.push(from);
  };
  while ((m = delimiter.exec(body)) !== null) {
    consider(unitStart, m.index);
    unitStart = m.index + m[0].length;
  }
  consider(unitStart, body.length);
  return offsets;
}

export function annotateSceneBreaks(sentences: SentenceOutput[], body: string): void {
  const separators = separatorOffsets(body);
  if (separators.length === 0 || sentences.length === 0) return;

  // Parallel array of each sentence's raw body offset (or null when unlocatable).
  // locateSentenceOffsets advances its cursor only on a match, so the non-null
  // offsets are monotonically increasing in index order.
  const offsets = locateSentenceOffsets(sentences, body);

  for (const sep of separators) {
    // Last sentence that located strictly before this separator.
    let lastBefore = -1;
    for (let i = 0; i < sentences.length; i++) {
      const off = offsets[i];
      if (off != null && off < sep) lastBefore = i;
    }
    // Leading separator: nothing located before it (chapter-top marker) → drop,
    // so a `* * *` at the very start doesn't flag sentence 0.
    if (lastBefore === -1) continue;

    // Marker-anchored bind: the opener is the next sentence in reading order,
    // whether or not its own text located. Clamp to range.
    const target = lastBefore + 1;
    if (target < sentences.length) sentences[target].sceneBreakBefore = true;
  }
}
