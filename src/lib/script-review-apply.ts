import type { Dispatch } from '@reduxjs/toolkit';
import { manuscriptActions } from '../store/manuscript-slice';

export const REVIEW_EMOTIONS = ['neutral', 'whisper', 'angry', 'excited', 'sad'] as const;

export interface ReviewOp {
  id: number;
  op: 'strip_tag' | 'split' | 'extract_dialogue' | 'merge' | 'fix_emotion';
  newText?: string;
  anchor?: string;
  anchorEnd?: string;
  pieceCharacterIds?: string[];
  mergeIds?: number[];
  emotion?: string;
  rationale: string;
  confidence?: number;
}

/** NFC + quote/dash/ellipsis folds ONLY — every fold maps 1 original char to a
    known number of normalized chars, so an index map is exact. No whitespace
    collapse (it would desync positions — the plan-review bug). */
function normChar(c: string): string {
  if (c === "‘" || c === "’") return "'";
  if (c === "“" || c === "”") return '"';
  if (c === "–" || c === "—") return '-';
  if (c === "…") return '...';
  return c.normalize('NFC');
}
export function normalizeForMatch(text: string): string {
  let out = '';
  for (const ch of text) out += normChar(ch);
  return out;
}

/** Returns the ORIGINAL-text offset of the END of a unique anchor match, or null. */
export function resolveAnchorOffset(text: string, anchor: string): number | null {
  // Build normalized string + a map from each normalized index to the original index AFTER it.
  let norm = '';
  const origEndForNormLen: number[] = [0]; // origEndForNormLen[k] = original index after k normalized chars
  for (let i = 0; i < text.length; i++) {
    const piece = normChar(text[i]);
    for (let j = 0; j < piece.length; j++) origEndForNormLen.push(i + 1);
    norm += piece;
  }
  const nAnchor = normalizeForMatch(anchor);
  if (!nAnchor) return null;
  const first = norm.indexOf(nAnchor);
  if (first < 0 || first !== norm.lastIndexOf(nAnchor)) return null;
  return origEndForNormLen[first + nAnchor.length];
}

export function planApply(
  ops: ReviewOp[],
  live: Array<{ id: number; chapterId: number; text: string; characterId: string }>,
): { appliable: ReviewOp[]; unappliable: Array<{ op: ReviewOp; reason: string }> } {
  const byId = new Map(live.map((s) => [s.id, s]));
  const appliable: ReviewOp[] = [];
  const unappliable: Array<{ op: ReviewOp; reason: string }> = [];
  const STRUCTURAL = new Set(['split', 'extract_dialogue', 'merge']);
  const consumed = new Set<number>();
  const structTargets = new Set<number>();

  for (const op of ops.filter((o) => STRUCTURAL.has(o.op))) {
    if (op.op === 'merge') {
      const ids = [...(op.mergeIds ?? [])].sort((a, b) => a - b);
      if (ids.some((id) => structTargets.has(id))) { unappliable.push({ op, reason: 'second structural op on the same id' }); continue; }
      const members = ids.map((id) => byId.get(id));
      if (members.some((m) => !m)) { unappliable.push({ op, reason: 'merge member missing' }); continue; }
      const ch = members[0]!.chapterId;
      const sameChar = members.every((m) => m!.characterId === members[0]!.characterId);
      const sameChapter = members.every((m) => m!.chapterId === ch);
      const adjacent = ids.every((id, k) => k === 0 || id === ids[k - 1] + 1);
      if (!sameChar || !adjacent || !sameChapter) { unappliable.push({ op, reason: 'merge members not adjacent / same character / same chapter' }); continue; }
      ids.forEach((id) => { consumed.add(id); structTargets.add(id); });
      appliable.push(op);
    } else {
      if (structTargets.has(op.id)) { unappliable.push({ op, reason: 'second structural op on the same id' }); continue; }
      const s = byId.get(op.id);
      if (!s) { unappliable.push({ op, reason: 'target id missing' }); continue; }
      if (resolveAnchorOffset(s.text, op.anchor ?? '') === null) { unappliable.push({ op, reason: 'anchor not found or not unique' }); continue; }
      if (op.op === 'extract_dialogue' && resolveAnchorOffset(s.text, op.anchorEnd ?? '') === null) { unappliable.push({ op, reason: 'extract anchorEnd not found or not unique' }); continue; }
      consumed.add(op.id); structTargets.add(op.id); appliable.push(op);
    }
  }

  for (const op of ops.filter((o) => !STRUCTURAL.has(o.op))) {
    if (consumed.has(op.id)) { unappliable.push({ op, reason: 'id consumed by a structural op' }); continue; }
    if (!byId.has(op.id)) { unappliable.push({ op, reason: 'target id missing' }); continue; }
    if (op.op === 'fix_emotion' && !REVIEW_EMOTIONS.includes(op.emotion as never)) { unappliable.push({ op, reason: 'invalid emotion value' }); continue; }
    appliable.push(op);
  }
  return { appliable, unappliable };
}

export function dispatchAcceptedOps(
  dispatch: Dispatch,
  accepted: ReviewOp[],
  live: Array<{ id: number; chapterId: number; text: string; characterId: string }>,
  { onBoundaryMove }: { onBoundaryMove: (chapterId: number) => void },
): void {
  const byId = new Map(live.map((s) => [s.id, s]));
  for (const op of accepted) {
    const target = byId.get(op.op === 'merge' ? (op.mergeIds?.[0] ?? op.id) : op.id);
    if (!target) continue;
    const chapterId = target.chapterId;
    switch (op.op) {
      case 'strip_tag':
        dispatch(manuscriptActions.setSentenceText({ chapterId, sentenceId: op.id, text: op.newText ?? target.text }));
        break;
      case 'fix_emotion':
        dispatch(manuscriptActions.setSentenceEmotion({ chapterId, sentenceId: op.id, emotion: op.emotion ?? 'neutral' }));
        break;
      case 'split': {
        const off = resolveAnchorOffset(target.text, op.anchor ?? '');
        if (off === null) continue;
        dispatch(manuscriptActions.splitSentence({ chapterId, sentenceId: op.id, offsets: [off], characterIds: op.pieceCharacterIds ?? [target.characterId, target.characterId] }));
        break;
      }
      case 'extract_dialogue': {
        const start = resolveAnchorOffset(target.text, op.anchor ?? '');
        const end = resolveAnchorOffset(target.text, op.anchorEnd ?? '');
        if (start === null || end === null || end <= start) continue;
        dispatch(manuscriptActions.splitSentence({ chapterId, sentenceId: op.id, offsets: [start, end], characterIds: op.pieceCharacterIds ?? [target.characterId, target.characterId, target.characterId] }));
        break;
      }
      case 'merge':
        dispatch(manuscriptActions.mergeSentences({ chapterId, sentenceIds: op.mergeIds ?? [] }));
        break;
    }
    onBoundaryMove(chapterId);
  }
}
