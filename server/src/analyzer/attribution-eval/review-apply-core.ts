/* Server-side port of the frontend script-review apply/match core
   (src/lib/script-review-apply.ts) so the attribution eval harness can reuse
   it without pulling in Redux. Ported verbatim, retyped to the server's
   `ScriptReviewOp` (../../handoff/schemas.js) in place of the frontend's
   `ReviewOp`. `dispatchAcceptedOps` is intentionally NOT ported — it dispatches
   Redux actions and has no place in an eval harness.

   review-apply-vectors.json (in __fixtures__/) is a SHARED fixture: the
   frontend test (src/lib/script-review-apply.test.ts) loads the SAME file and
   asserts its `planApply` produces an identical result, locking the two
   implementations against drift. */
import type { ScriptReviewOp } from '../../handoff/schemas.js';

export const REVIEW_EMOTIONS = ['neutral', 'whisper', 'angry', 'excited', 'sad'] as const;

export interface LiveSentence {
  id: number;
  chapterId: number;
  text: string;
  characterId: string;
  instruct?: string;
  vocalization?: boolean;
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
  ops: ScriptReviewOp[],
  live: LiveSentence[],
  roster: Set<string> = new Set(),
): { appliable: ScriptReviewOp[]; unappliable: Array<{ op: ScriptReviewOp; reason: string }> } {
  const byId = new Map(live.map((s) => [s.id, s]));
  const appliable: ScriptReviewOp[] = [];
  const unappliable: Array<{ op: ScriptReviewOp; reason: string }> = [];
  const STRUCTURAL = new Set(['split', 'extract_dialogue', 'merge']);
  const consumed = new Set<number>();
  const structTargets = new Set<number>();

  for (const op of ops.filter((o) => STRUCTURAL.has(o.op))) {
    if (op.op === 'merge') {
      // `Array.isArray` (not just `?? []`) so a non-array mergeIds the analyzer
      // might emit (e.g. a bare number) can't throw on the spread below — same
      // "malformed op must be unappliable, never crash" contract as the arity
      // guard a few lines down.
      const ids = [...(Array.isArray(op.mergeIds) ? op.mergeIds : [])].sort((a, b) => a - b);
      if (ids.some((id) => structTargets.has(id))) { unappliable.push({ op, reason: 'second structural op on the same id' }); continue; }
      const members = ids.map((id) => byId.get(id));
      // A `merge` the analyzer emitted with missing/empty/single mergeIds must
      // be rejected here: `[].some(m => !m)` is vacuously false, so an empty
      // `members` slipped this guard and `members[0]!.chapterId` below threw
      // `Cannot read properties of undefined` — a throw that aborted planApply
      // mid-hydration and (swallowed by hydrateScriptReview's fire-and-forget
      // dispatch) silently wiped the whole book's review view. Guard the arity.
      if (ids.length < 2 || members.some((m) => !m)) { unappliable.push({ op, reason: 'merge needs at least two existing members' }); continue; }
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

  const textTargets = new Set<number>(); // strip_tag / validate_instruct-vocalization collisions

  // strip_tag first so it deterministically wins a same-id text collision.
  const nonStructural = ops.filter((o) => !STRUCTURAL.has(o.op));
  const ordered = [
    ...nonStructural.filter((o) => o.op === 'strip_tag'),
    ...nonStructural.filter((o) => o.op !== 'strip_tag'),
  ];

  for (const op of ordered) {
    if (consumed.has(op.id)) { unappliable.push({ op, reason: 'id consumed by a structural op' }); continue; }
    const s = byId.get(op.id);
    if (!s) { unappliable.push({ op, reason: 'target id missing' }); continue; }

    if (op.op === 'strip_tag') {
      textTargets.add(op.id);
      appliable.push(op);
      continue;
    }

    if (op.op === 'fix_emotion') {
      if (!REVIEW_EMOTIONS.includes(op.emotion as never)) { unappliable.push({ op, reason: 'invalid emotion value' }); continue; }
      appliable.push(op);
      continue;
    }

    if (op.op === 'validate_instruct') {
      // Normalize: keep only the appliable halves.
      const norm: ScriptReviewOp = { ...op };
      // instruct half
      if (norm.newInstruct !== undefined) {
        const isStrip = norm.newInstruct.trim() === '';
        if (isStrip) {
          if (!s.instruct) delete norm.newInstruct; // strip on instruct-less = no-op, drop
        } else if (!s.instruct || s.instruct === norm.newInstruct.trim()) {
          delete norm.newInstruct; // repair needs an existing, different instruct
        }
      }
      // vocalization half — capture WHY it dropped so a collision is surfaced, not silent
      let vocalDropReason: string | null = null;
      if (norm.newVocalizationText !== undefined) {
        if (!s.vocalization) vocalDropReason = 'sentence is not a vocalization';
        else if (textTargets.has(op.id)) vocalDropReason = 'text already claimed by strip_tag'; // strip_tag wins
        if (vocalDropReason) {
          delete norm.newVocalizationText;
          delete norm.vocalization;
        } else {
          textTargets.add(op.id);
        }
      }
      const hasInstruct = norm.newInstruct !== undefined;
      const hasVocal = norm.newVocalizationText !== undefined;
      if (!hasInstruct && !hasVocal) {
        // A pure-strip-on-instruct-less instruct edit is a silent no-op (not surfaced).
        // A DROPPED vocalization edit (wrong sentence OR strip_tag collision) IS surfaced
        // as un-appliable — the collision test asserts this.
        if (vocalDropReason) unappliable.push({ op, reason: vocalDropReason });
        continue;
      }
      appliable.push(norm);
      continue;
    }

    // fs-58 Unit B — reattribute to an existing roster member must hit the roster.
    // (proposed/off-roster reattributions are handled by the async create→reassign
    // path before dispatch, so they're not gated here.)
    if (op.op === 'reattribute' && op.characterId != null && !roster.has(op.characterId)) {
      unappliable.push({ op, reason: 'reattribute characterId not in roster' });
      continue;
    }

    appliable.push(op); // any other non-structural op unchanged (reattribute, flag_nonstory)
  }
  return { appliable, unappliable };
}
