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
