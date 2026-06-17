/* Pure progress math for Stage-2 (attribution) per-chapter live progress.
   No I/O, no model calls — mirrors the projectChapterEstMsFromOutput family in
   analysis.ts so each piece is unit-testable in isolation. See
   docs/superpowers/specs/2026-06-17-attribution-sentence-progress-design.md. */

/** Heuristic per-chapter sentence total (the denominator seed). Splits on
    sentence-ending punctuation, mirroring stage2-chunk's sentence regex.
    Approximate by nature — the model may merge/split — so callers show it
    with a leading `~`. */
export function countSentencesHeuristic(body: string): number {
  const trimmed = body.trim();
  if (!trimmed) return 0;
  return trimmed.split(/(?<=[.!?]["')\]]?)\s+/).filter(Boolean).length;
}

/** Count attributed sentences in ONE section's streamed (possibly partial)
    JSON buffer, via the `"characterId":` key token (exactly one per sentence
    object). The buffer resets per section (the engine re-inits its buffer each
    section call), so this is the IN-FLIGHT section count only — completed
    sections are accounted exactly elsewhere. Counting the full key token (with
    colon) makes a stray substring in prose vanishingly unlikely. */
export function countStreamedSentences(buffer: string): number {
  if (!buffer) return 0;
  return (buffer.match(/"characterId"\s*:/g) ?? []).length;
}

/** Self-calibrate the denominator once ≥1 section is committed: the observed
    sentences-per-char from completed sections, applied to the remaining chars.
    Falls back to the static heuristic before any section completes (graceful
    degradation — the headline count still works, it is just less
    self-correcting). Never returns below the already-committed count. */
export function refineSentencesTotal(args: {
  committedSentences: number;
  committedChars: number;
  totalChars: number;
  heuristicTotal: number;
}): number {
  const { committedSentences, committedChars, totalChars, heuristicTotal } = args;
  if (committedSentences <= 0 || committedChars <= 0) return heuristicTotal;
  const rate = committedSentences / committedChars;
  const remainingChars = Math.max(0, totalChars - committedChars);
  const projected = Math.round(committedSentences + rate * remainingChars);
  return Math.max(projected, committedSentences);
}
