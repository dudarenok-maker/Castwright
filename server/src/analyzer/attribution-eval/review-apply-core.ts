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

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Matching unit = a RUN: one extended grapheme cluster (a user-perceived
    character). That keeps a base with its combining marks (Mn, Mc and Me alike),
    Hangul jamo, emoji with a skin-tone modifier or variation selector, ZWJ
    sequences and regional-indicator flag pairs together, so a match boundary can
    never fall inside one. */
function splitRuns(text: string): string[] {
  return Array.from(GRAPHEMES.segment(text), (s) => s.segment);
}

/** A run's normalized form: the quote/dash/ellipsis fold applies to the run's
    FIRST code point only, the remaining code points are kept, then the whole run
    is NFC-normalized (so e + U+0301 composes to the same text as a precomposed é).
    No whitespace collapse (it would desync positions — the plan-review bug). */
function normRun(run: string): string {
  const first = String.fromCodePoint(run.codePointAt(0)!);
  const rest = run.slice(first.length);
  let folded = first;
  if (first === "‘" || first === "’") folded = "'";
  else if (first === "“" || first === "”") folded = '"';
  else if (first === "–" || first === "—") folded = '-';
  else if (first === "…") folded = '...';
  return (folded + rest).normalize('NFC');
}

export function normalizeForMatch(text: string): string {
  return splitRuns(text).map(normRun).join('');
}

/** Normalized text plus an offset map with norm.length + 1 entries. Only a run
    BOUNDARY has an original offset; every position strictly inside a run's
    normalized output (inside an ellipsis fold, between an astral char's halves,
    between a base and its mark) is null, so a match ending there is refused,
    never rounded. origAt[0] = 0. */
export function buildNormIndex(text: string): { norm: string; origAt: Array<number | null> } {
  let norm = '';
  const origAt: Array<number | null> = [0];
  let i = 0; // UTF-16 offset into the original text, just after the current run
  for (const run of splitRuns(text)) {
    i += run.length;
    const p = normRun(run);
    for (let j = 0; j < p.length - 1; j++) origAt.push(null);
    origAt.push(i);
    norm += p;
  }
  return { norm, origAt };
}

/** Returns the ORIGINAL-text offset of the END of a unique anchor match, or null.
    null also when the match ends INSIDE a run (fail closed) — every raw occurrence
    still counts toward uniqueness. */
export function resolveAnchorOffset(text: string, anchor: string): number | null {
  const { norm, origAt } = buildNormIndex(text);
  const nAnchor = normalizeForMatch(anchor);
  if (!nAnchor) return null;
  const first = norm.indexOf(nAnchor);
  if (first < 0 || first !== norm.lastIndexOf(nAnchor)) return null;
  return origAt[first + nAnchor.length] ?? null;
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
