import type { Dispatch } from '@reduxjs/toolkit';
import { manuscriptActions } from '../store/manuscript-slice';

export const REVIEW_EMOTIONS = ['neutral', 'whisper', 'angry', 'excited', 'sad'] as const;

/* fs-58 — per-model requests-per-day caps for the whole-book script-review
   sweep. A whole-book run fires ONE script-review request per chapter, so a
   book with more chapters than the selected model's RPD cap will exhaust the
   free-tier quota mid-run. We mirror the server caps here (they live in
   server/src/analyzer/rate-limit.ts BUILTIN_LIMITS — keep in lockstep when
   they change) because rate-limit.ts is a server module not importable
   client-side. A model absent from this map (notably any LOCAL Ollama model)
   has no daily cap → no warning. */
export const REVIEW_MODEL_RPD: Record<string, number> = {
  'gemini-3.5-flash-lite': 500,
  'gemini-3.1-flash-lite': 500,
  'gemini-3.6-flash': 20,
  'gemini-3.5-flash': 20,
  'gemini-3-flash-preview': 20,
  'gemini-2.5-flash': 20,
  'gemma-4-31b-it': 14400,
  'gemma-4-26b-a4b-it': 14400,
};

export interface RpdWarning {
  chapterCount: number;
  /** The matched model's daily request cap. */
  rpd: number;
  model: string;
}

/* Pure helper: should a whole-book sweep of `chapterCount` chapters with
   `model` warn the user that they'll blow the daily quota? Returns the
   warning payload when chapterCount exceeds the model's RPD cap, else null.
   A model with no entry in REVIEW_MODEL_RPD (e.g. a local Ollama model, or
   undefined when the server default is local) is uncapped → null. */
export function rpdWarningFor(chapterCount: number, model: string | undefined): RpdWarning | null {
  if (!model) return null;
  const rpd = REVIEW_MODEL_RPD[model];
  if (rpd === undefined) return null;
  if (chapterCount <= rpd) return null;
  return { chapterCount, rpd, model };
}

export interface ReviewOp {
  id: number;
  op:
    | 'strip_tag'
    | 'split'
    | 'extract_dialogue'
    | 'merge'
    | 'fix_emotion'
    | 'validate_instruct'
    | 'reattribute'
    | 'flag_nonstory';
  newText?: string;
  newInstruct?: string;
  newVocalizationText?: string;
  vocalization?: boolean;
  anchor?: string;
  anchorEnd?: string;
  pieceCharacterIds?: string[];
  mergeIds?: number[];
  emotion?: string;
  // fs-58 Unit B — reattribute targets (exactly one is set):
  characterId?: string;
  proposed?: { name: string; gender?: string; ageRange?: string };
  rationale: string;
  confidence?: number;
}

/* Frontend copy of the anchor-matching core, mirrored by
   server/src/analyzer/attribution-eval/review-apply-core.ts and locked against
   drift by the shared fixture __fixtures__/anchor-offset-vectors.json (#4226). */

let graphemes: Intl.Segmenter | undefined;

/** Built lazily, never at module load: this module is in the app's eager import
    graph, and a browser without Intl.Segmenter (Firefox < 125) must still start.
    Absent => null, and resolveAnchorOffset fails closed. */
function getGraphemes(): Intl.Segmenter | null {
  if (graphemes) return graphemes;
  if (typeof Intl.Segmenter !== 'function') return null;
  graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return graphemes;
}

/** Matching unit = a RUN: one extended grapheme cluster (a user-perceived
    character). That keeps a base with its combining marks (Mn, Mc and Me alike),
    Hangul jamo, emoji with a skin-tone modifier or variation selector, ZWJ
    sequences and regional-indicator flag pairs together, so a match boundary can
    never fall inside one. */
function splitRuns(text: string): string[] {
  const g = getGraphemes();
  if (!g) throw new Error('Intl.Segmenter is unavailable');
  return Array.from(g.segment(text), (s) => s.segment);
}

/** A run's normalized form: the quote/dash/ellipsis fold applies to EVERY code
    point of the run (a Prepend char can cluster with a following quote or
    ellipsis), then the whole run is NFC-normalized (so e + U+0301 composes to the same text as a precomposed é).
    No whitespace collapse (it would desync positions — the plan-review bug). */
function normRun(run: string): string {
  let folded = '';
  for (const ch of run) {
    if (ch === "‘" || ch === "’") folded += "'";
    else if (ch === "“" || ch === "”") folded += '"';
    else if (ch === "–" || ch === "—") folded += '-';
    else if (ch === "…") folded += '...';
    else folded += ch;
  }
  return folded.normalize('NFC');
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
  if (!getGraphemes()) return null; // no Intl.Segmenter: fail closed
  const { norm, origAt } = buildNormIndex(text);
  const nAnchor = normalizeForMatch(anchor);
  if (!nAnchor) return null;
  const first = norm.indexOf(nAnchor);
  if (first < 0 || first !== norm.lastIndexOf(nAnchor)) return null;
  return origAt[first + nAnchor.length] ?? null;
}

export function planApply(
  ops: ReviewOp[],
  live: Array<{ id: number; chapterId: number; text: string; characterId: string; instruct?: string; vocalization?: boolean }>,
  roster: Set<string> = new Set(),
): { appliable: ReviewOp[]; unappliable: Array<{ op: ReviewOp; reason: string }> } {
  const byId = new Map(live.map((s) => [s.id, s]));
  const appliable: ReviewOp[] = [];
  const unappliable: Array<{ op: ReviewOp; reason: string }> = [];
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
      const norm: ReviewOp = { ...op };
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

export function dispatchAcceptedOps(
  dispatch: Dispatch,
  accepted: ReviewOp[],
  live: Array<{ id: number; chapterId: number; text: string; characterId: string; instruct?: string; vocalization?: boolean }>,
  { onBoundaryMove }: { onBoundaryMove: (chapterId: number) => void },
): void {
  const byId = new Map(live.map((s) => [s.id, s]));
  for (const op of accepted) {
    const target = byId.get(op.op === 'merge' ? (op.mergeIds?.[0] ?? op.id) : op.id);
    if (!target) continue;
    const chapterId = target.chapterId;
    let changedTextOrStructure = true; // strip_tag/split/extract/merge/fix_emotion all stale on every engine
    switch (op.op) {
      case 'strip_tag':
        dispatch(manuscriptActions.setSentenceText({ chapterId, sentenceId: op.id, text: op.newText ?? target.text }));
        break;
      case 'fix_emotion':
        dispatch(manuscriptActions.setSentenceEmotion({ chapterId, sentenceId: op.id, emotion: op.emotion ?? 'neutral' }));
        break;
      case 'validate_instruct': {
        if (op.newInstruct !== undefined)
          dispatch(manuscriptActions.setSentenceInstruct({ chapterId, sentenceId: op.id, instruct: op.newInstruct }));
        if (op.newVocalizationText !== undefined)
          dispatch(manuscriptActions.setSentenceText({ chapterId, sentenceId: op.id, text: op.newVocalizationText, vocalization: op.vocalization }));
        // Carve-out: bump boundary_move ONLY when the text actually changed (vocalization
        // half dispatched). An instruct-only edit changes no text and must rely solely on
        // the precise instructHash path, or it would engine-blind false-stale Kokoro.
        changedTextOrStructure = op.newVocalizationText !== undefined;
        break;
      }
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
      case 'reattribute':
        // On-roster only here — proposed/off-roster ops are handled by the
        // async create→reassign path (apply-proposed.ts) BEFORE this runs.
        if (op.characterId) {
          dispatch(manuscriptActions.setSentenceCharacter({ chapterId, sentenceId: op.id, characterId: op.characterId }));
        }
        break;
      case 'flag_nonstory':
        dispatch(manuscriptActions.setSentenceExcluded({ chapterId, sentenceId: op.id, excluded: true }));
        break;
    }
    if (changedTextOrStructure) onBoundaryMove(chapterId);
  }
}
