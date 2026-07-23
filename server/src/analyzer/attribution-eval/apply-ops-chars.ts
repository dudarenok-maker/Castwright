/* Task 4: applies accepted script-review ops to the pipeline's final
   char-position speaker array, producing the "reviewed" char array — so the
   final→reviewed attribution diff is a direct char-array comparison. Only
   three op classes act (reattribute / split / extract_dialogue); everything
   else is a no-op here. Ops are expected to already be `planApply`-accepted
   (review-apply-core.ts, Task 5 wiring), so anchors normally resolve — every
   op is still guarded defensively: a null offset, an out-of-range id, or a
   degenerate/inverted sub-span skips that op without mutating anything. */
import { resolveAnchorOffset } from './review-apply-core.js';
import type { ScriptReviewOp } from '../../handoff/schemas.js';

export interface FinalSentenceForApply {
  id: number;
  text: string;
  characterId: string;
}

export interface FinalSpanForApply {
  id: number;
  start: number;
  end: number;
}

export function applyOpsToCharArray(
  finalByChar: Array<string | null>,
  finalSentences: FinalSentenceForApply[],
  finalSpans: FinalSpanForApply[],
  acceptedOps: ScriptReviewOp[],
): Array<string | null> {
  const reviewed = finalByChar.slice();
  const sentenceById = new Map(finalSentences.map((s) => [s.id, s]));
  const spanById = new Map(finalSpans.map((sp) => [sp.id, sp]));

  for (const op of acceptedOps) {
    const span = spanById.get(op.id);
    const sentence = sentenceById.get(op.id);
    if (!span || !sentence) continue; // target id missing from this projection
    const { start, end } = span;
    if (end <= start) continue; // degenerate span

    if (op.op === 'reattribute') {
      // Off-roster `proposed` reattributions are dumped by the CLI (Task 7),
      // not applied here.
      if (op.characterId == null) continue;
      for (let i = start; i < end; i++) reviewed[i] = op.characterId;
      continue;
    }

    if (op.op === 'split') {
      const pieces = op.pieceCharacterIds;
      if (!pieces || pieces.length < 2) continue; // same-speaker default -> no-op
      const off = resolveAnchorOffset(sentence.text, op.anchor ?? '');
      if (off == null) continue;
      const splitAt = start + off;
      if (splitAt <= start || splitAt >= end) continue; // degenerate/inverted piece
      for (let i = start; i < splitAt; i++) reviewed[i] = pieces[0]!;
      for (let i = splitAt; i < end; i++) reviewed[i] = pieces[1]!;
      continue;
    }

    if (op.op === 'extract_dialogue') {
      const pieces = op.pieceCharacterIds;
      if (!pieces || pieces.length < 2) continue;
      const offStart = resolveAnchorOffset(sentence.text, op.anchor ?? '');
      const offEnd = resolveAnchorOffset(sentence.text, op.anchorEnd ?? '');
      if (offStart == null || offEnd == null) continue;
      const midStart = start + offStart;
      const midEnd = start + offEnd;
      if (midEnd <= midStart || midStart < start || midEnd > end) continue; // degenerate/inverted middle
      for (let i = midStart; i < midEnd; i++) reviewed[i] = pieces[1]!;
      continue;
    }

    // Any other op class (strip_tag, merge, fix_emotion, validate_instruct,
    // flag_nonstory, ...) doesn't touch the char array.
  }

  return reviewed;
}
