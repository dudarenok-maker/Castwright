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

/** Combine committed (exact, per completed section) + in-flight (marker count
    for the current section) into the displayed numerator, and pair it with a
    self-calibrated denominator that never sits below the numerator. */
export function sentenceProgressForTick(args: {
  committedSentences: number;
  committedChars: number;
  inflightSentences: number;
  totalChars: number;
  heuristicTotal: number;
}): { sentencesDone: number; sentencesTotal: number } {
  const sentencesDone = args.committedSentences + args.inflightSentences;
  const refined = refineSentencesTotal({
    committedSentences: args.committedSentences,
    committedChars: args.committedChars,
    totalChars: args.totalChars,
    heuristicTotal: args.heuristicTotal,
  });
  return { sentencesDone, sentencesTotal: Math.max(refined, sentencesDone) };
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

const MIN_REFINE_ELAPSED_MS = 8_000; // mirrors projectChapterEstMsFromOutput
const MIN_FRACTION = 0.02;

/** Project chapter total time from the sentence fraction. Null when too early
    (mirrors the byte projector's guards) so the caller keeps the prior value. */
export function projectChapterEstMsFromSentences(
  elapsedMs: number,
  done: number,
  total: number,
): number | null {
  if (elapsedMs < MIN_REFINE_ELAPSED_MS) return null;
  if (done < 1 || total <= 0) return null;
  const frac = Math.min(0.95, done / total);
  if (frac < MIN_FRACTION) return null;
  return Math.round(elapsedMs / frac);
}

/** Clamp an estimate into the per-chapter band: a floor that always sits just
    above elapsed (never "over budget"; reuse the refineCastChapterEstMs idiom),
    a fallback to the last good value when the candidate is null, and a ceiling
    that is never the whole-stage estimate (so the stage total can't leak into a
    chapter row). IMPORTANT: pass `stageEstMs = 0` to DISABLE the ceiling — the
    caller does this for a single-chapter book, where the chapter estimate
    legitimately equals the stage estimate and a 0.9× ceiling would force it
    permanently ~10% low. */
export function clampChapterEstMs(
  candidate: number | null,
  elapsedMs: number,
  lastGood: number,
  stageEstMs: number,
): number {
  const floor = Math.round(elapsedMs * 1.1) + 3000;
  const base = candidate ?? (lastGood > 0 ? lastGood : floor);
  const ceiling = stageEstMs > 0 ? stageEstMs * 0.9 : base;
  return Math.max(floor, Math.min(base, ceiling));
}

/** Choose the per-chapter estimate for a tick and clamp it to the band.
    Precedence: sentence projection → byte projection → last-good. Pure: the
    projection results are computed by the caller and passed in (the byte
    projector lives in analysis.ts), so this stays free of route state. */
export function selectChapterEstMs(args: {
  elapsedMs: number;
  bySentenceMs: number | null;
  byBytesMs: number | null;
  lastGoodMs: number;
  stageEstMs: number;
}): number {
  const candidate = args.bySentenceMs ?? args.byBytesMs;
  return clampChapterEstMs(candidate, args.elapsedMs, args.lastGoodMs, args.stageEstMs);
}
