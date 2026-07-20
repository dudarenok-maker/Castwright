/* Script-review suggestions slice — dedicated, non-polled, bookId-keyed.
   MUST NOT be revisions.pending (that slice's applyPoll wholesale-replaces
   `pending` and would wipe active suggestions). Each book's bucket is
   independent so concurrent multi-book workflows coexist without collision.

   Op key shape: `${chapterId}:${id}:${op}` — chapterId is not on the base
   ReviewOp (it lives on the SSE envelope), so we define ReviewOpWithChapter
   which extends ReviewOp with the chapter context. setReview expects
   `ops: ReviewOpWithChapter[]` already tagged by the SSE consumer.

   The activeStreams progress map IS broadcast cross-tab via sync:substage;
   byBook results stay tab-local. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ReviewOp } from '../lib/script-review-apply';
import type { RootState } from './index';
import type { SubstageEntry } from './prosody-slice';
import {
  setActiveSubstage,
  updateSubstageProgress,
  type SetActiveSubstagePayload,
  type UpdateSubstageProgressPayload,
} from './analysis-substage-reducers';

/** ReviewOp extended with the chapterId from the SSE `ops` event envelope. */
export type ReviewOpWithChapter = ReviewOp & { chapterId: number };

/** Serialise an op to its lookup key. */
export function opKey(chapterId: number, id: number, op: string): string {
  return `${chapterId}:${id}:${op}`;
}

/** Every op class in canonical summary display order (mechanical first, then
    the two expand-only classes). Single source for both the taxonomy split
    below and selectReviewSummary's per-type ordering — a new op class is added
    here (and to EXPAND_ONLY if high-stakes) and nowhere else. */
const ALL_OP_TYPES: ReviewOp['op'][] = [
  'merge',
  'strip_tag',
  'split',
  'extract_dialogue',
  'fix_emotion',
  'validate_instruct',
  'reattribute',
  'flag_nonstory',
];
/** The high-stakes op classes: opt-in / unchecked by default, and never
    bulk-approvable from the summary (identity + story-exclusion edits). */
export const EXPAND_ONLY: ReadonlySet<ReviewOp['op']> = new Set(['reattribute', 'flag_nonstory']);
/** The mechanical op classes: checked by default and bulk-approvable per
    chapter/type from the summary — DERIVED as the complement of EXPAND_ONLY so
    the two lists can't drift. */
export const BULK_APPROVABLE: ReadonlySet<ReviewOp['op']> = new Set(
  ALL_OP_TYPES.filter((op) => !EXPAND_ONLY.has(op)),
);

export interface ScriptReviewBucket {
  ops: ReviewOpWithChapter[];
  unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
  /** Key = opKey(chapterId, id, op); value = whether this op is selected. */
  selected: Record<string, boolean>;
  /** The manuscript these ops' sentence ids belong to — a reparse changes
      this, which invalidates the bucket (see hydration in Task 8). One value
      for the whole bucket: readLedger already drops any entry whose
      manuscriptId doesn't match the book's current one before the client
      ever sees it, so every chapter remaining in a hydrated bucket shares
      this same value. */
  manuscriptId: string;
  /** Per-CHAPTER ledger version (design spec §4.2's version nonce is minted
      per ledger entry, i.e. per chapter — a whole-book bucket spans many
      chapters, each with its own). Keyed by chapterId. Echoed back on
      /resolve and the selection PATCH for that chapter so a stale write
      against a discarded-and-recreated entry no-ops server-side. */
  versionByChapter: Record<number, number>;
  /** Whether the results modal is currently shown. Closing (X/backdrop) sets
      this false WITHOUT touching ops/selected — only discardReview (Task 12)
      removes the bucket outright. */
  visible: boolean;
}

export interface ScriptReviewState {
  byBook: Record<string, ScriptReviewBucket | undefined>;
  activeStreams: Record<string, SubstageEntry>;
}

const initialState: ScriptReviewState = {
  byBook: {},
  activeStreams: {},
};

/** Shared per-chapter preserve-the-rest merge logic for setReview and
    mergeHydratedBucket (fs-58 follow-up #1481 — extracted to eliminate
    ~20 lines of verbatim duplication a code review flagged). Given the
    existing bucket (if any) and the incoming payload's own chapters,
    returns whichever OTHER (untouched) chapters' data should carry
    forward unchanged. Both reducers concatenate their own new
    ops/unappliable/selected/versionByChapter on top of what this
    returns — the two reducers differ only in how `selected` is derived
    (setReview computes it from DEFAULT_OFF; mergeHydratedBucket takes an
    already-resolved map) and in the final `visible` value, so those stay
    reducer-specific. */
function preserveUntouchedChapters(
  existing: ScriptReviewBucket | undefined,
  manuscriptId: string,
  ops: ReviewOpWithChapter[],
  unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>,
  versionByChapter: Record<number, number>,
): {
  preservedOps: ReviewOpWithChapter[];
  preservedUnappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
  preservedSelected: Record<string, boolean>;
  preservedVersionByChapter: Record<number, number>;
} {
  // Drop a stale existing bucket entirely if it belongs to a different
  // manuscript (reparse mid-session) — its sentence ids may no longer
  // be valid, mirroring readLedger's own manuscriptId-pruning (spec §4.2).
  const preserveExisting = existing && (!existing.manuscriptId || existing.manuscriptId === manuscriptId);

  const touchedChapterIds = new Set<number>(Object.keys(versionByChapter).map(Number));
  for (const o of ops) touchedChapterIds.add(o.chapterId);
  for (const u of unappliable) touchedChapterIds.add(u.op.chapterId);

  const preservedOps = preserveExisting
    ? existing!.ops.filter((o) => !touchedChapterIds.has(o.chapterId))
    : [];
  const preservedUnappliable = preserveExisting
    ? existing!.unappliable.filter((u) => !touchedChapterIds.has(u.op.chapterId))
    : [];
  const preservedSelected: Record<string, boolean> = {};
  if (preserveExisting) {
    for (const o of preservedOps) {
      const key = opKey(o.chapterId, o.id, o.op);
      if (key in existing!.selected) preservedSelected[key] = existing!.selected[key];
    }
  }
  const preservedVersionByChapter = preserveExisting ? { ...existing!.versionByChapter } : {};

  return { preservedOps, preservedUnappliable, preservedSelected, preservedVersionByChapter };
}

export const scriptReviewSlice = createSlice({
  name: 'scriptReview',
  initialState,
  reducers: {
    /** Merge this run's chapters into the existing bucket rather than
        replacing it wholesale — the bucket is a multi-chapter aggregate of
        every currently-unresolved chapter (Task 8/10), and a single-chapter
        or partial-whole-book run must not wipe OTHER chapters' still-
        unresolved findings out of the in-memory view (they're still sitting
        in the server ledger; only chapters THIS run actually touched are
        superseded, mirroring the server's own upsertChapterEntry semantics
        — a chapter only gets superseded when it produced a checkpoint). */
    setReview: (
      s,
      a: PayloadAction<{
        bookId: string;
        ops: ReviewOpWithChapter[];
        unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
        manuscriptId?: string;
        versionByChapter?: Record<number, number>;
      }>,
    ) => {
      const { bookId, ops, unappliable, manuscriptId = '', versionByChapter = {} } = a.payload;
      // fs-58 Unit B — higher-risk classes opt-in; taxonomy single-sourced as EXPAND_ONLY.
      const newSelected: Record<string, boolean> = {};
      for (const o of ops) {
        newSelected[opKey(o.chapterId, o.id, o.op)] = !EXPAND_ONLY.has(o.op);
      }

      const existing = s.byBook[bookId];
      const { preservedOps, preservedUnappliable, preservedSelected, preservedVersionByChapter } =
        preserveUntouchedChapters(existing, manuscriptId, ops, unappliable, versionByChapter);

      s.byBook[bookId] = {
        ops: [...preservedOps, ...ops],
        unappliable: [...preservedUnappliable, ...unappliable],
        selected: { ...preservedSelected, ...newSelected },
        manuscriptId,
        versionByChapter: { ...preservedVersionByChapter, ...versionByChapter },
        visible: true,
      };
    },

    /** Hydrate a bucket from the persisted ledger (Task 8). The payload here
        IS the complete, authoritative current state (the caller read the
        whole ledger, not a partial scope), so — unlike setReview above —
        a full replace of ops/unappliable/selected/versionByChapter is
        correct. What must NOT be forced is `visible`: this runs on every
        mount, so unconditionally setting visible:true would silently
        re-open a modal the user already explicitly hid via hideReview
        (backdrop/X, Task 12) the moment they navigate away and back —
        directly undermining the hide-vs-discard split. Preserve whatever
        visibility an existing bucket already has; only default to visible
        for a genuinely NEW bucket (nothing existed at this book yet). */
    hydrateBucket: (
      s,
      a: PayloadAction<{
        bookId: string;
        ops: ReviewOpWithChapter[];
        unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
        manuscriptId: string;
        versionByChapter: Record<number, number>;
        selected: Record<string, boolean>;
      }>,
    ) => {
      const { bookId, ops, unappliable, manuscriptId, versionByChapter, selected } = a.payload;
      const existing = s.byBook[bookId];
      s.byBook[bookId] = {
        ops,
        unappliable,
        selected,
        manuscriptId,
        versionByChapter,
        visible: existing ? existing.visible : true,
      };
    },

    /** Merge a re-hydrated ledger snapshot into an existing bucket per-chapter
        (fs-58 follow-up #1481) — for the reattach 404 fallback, where
        hydrateBucket's wholesale replace is unsafe: the fallback fires from
        inside ONE of potentially several concurrently-reattaching jobs
        (hydrateScriptReview's Promise.all), and its ledger snapshot,
        while a superset of what THAT job's own scope needed, is not
        necessarily a superset of a SIBLING job's still-in-flight chapter —
        that sibling's own eventual setReview dispatch could land either
        before or after this one. A wholesale hydrateBucket replace landing
        after would silently wipe the sibling's just-set ops out of the
        store even though they're safely checkpointed server-side. Mirrors
        setReview's touchedChapterIds preserve-the-rest merge logic, but —
        like hydrateBucket — accepts an already-computed `selected` map
        instead of deriving it from DEFAULT_OFF, since the caller already
        resolved persisted per-op overrides against the ledger. */
    mergeHydratedBucket: (
      s,
      a: PayloadAction<{
        bookId: string;
        ops: ReviewOpWithChapter[];
        unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
        manuscriptId: string;
        versionByChapter: Record<number, number>;
        selected: Record<string, boolean>;
      }>,
    ) => {
      const { bookId, ops, unappliable, manuscriptId, versionByChapter, selected } = a.payload;
      const existing = s.byBook[bookId];
      const { preservedOps, preservedUnappliable, preservedSelected, preservedVersionByChapter } =
        preserveUntouchedChapters(existing, manuscriptId, ops, unappliable, versionByChapter);

      s.byBook[bookId] = {
        ops: [...preservedOps, ...ops],
        unappliable: [...preservedUnappliable, ...unappliable],
        selected: { ...preservedSelected, ...selected },
        manuscriptId,
        versionByChapter: { ...preservedVersionByChapter, ...versionByChapter },
        visible: existing ? existing.visible : true,
      };
    },

    /** Flip the selected state of one op by key. */
    toggleOp: (s, a: PayloadAction<{ bookId: string; key: string }>) => {
      const { bookId, key } = a.payload;
      const bucket = s.byBook[bookId];
      if (!bucket || !(key in bucket.selected)) return;
      bucket.selected[key] = !bucket.selected[key];
    },

    /** Flip ALL ops of a given class (op.op value) for one book. When the
        class is currently ALL selected → deselect all; otherwise → select all. */
    toggleClass: (s, a: PayloadAction<{ bookId: string; op: ReviewOp['op'] }>) => {
      const { bookId, op: opClass } = a.payload;
      const bucket = s.byBook[bookId];
      if (!bucket) return;
      const classOps = bucket.ops.filter((o) => o.op === opClass);
      const allSelected = classOps.every(
        (o) => bucket.selected[opKey(o.chapterId, o.id, o.op)],
      );
      for (const o of classOps) {
        bucket.selected[opKey(o.chapterId, o.id, o.op)] = !allSelected;
      }
    },

    /** Set an explicit list of opKeys to `value` in one book's bucket — the
        primitive behind the summary's chapter- and type-level "Approve"
        controls. Only flips keys already present in `selected` (a key absent
        from the bucket is never created). */
    toggleKeys: (s, a: PayloadAction<{ bookId: string; keys: string[]; value: boolean }>) => {
      const bucket = s.byBook[a.payload.bookId];
      if (!bucket) return;
      for (const key of a.payload.keys) {
        if (key in bucket.selected) bucket.selected[key] = a.payload.value;
      }
    },

    /** Hide the modal without touching any data — the X button / backdrop
        click (design spec §6.2). */
    hideReview: (s, a: PayloadAction<{ bookId: string }>) => {
      const bucket = s.byBook[a.payload.bookId];
      if (bucket) bucket.visible = false;
    },
    /** Reopen a hidden bucket (the badge/re-run-gate "Review existing" path). */
    showReview: (s, a: PayloadAction<{ bookId: string }>) => {
      const bucket = s.byBook[a.payload.bookId];
      if (bucket) bucket.visible = true;
    },
    /** Remove specific applied ops (by opKey) from a book's bucket, deleting
        the whole bucket once none remain — the client-side mirror of the
        server's /resolve (Task 5), applied optimistically once the server
        call succeeds (Task 13). */
    resolveOpsLocally: (s, a: PayloadAction<{ bookId: string; opKeys: string[] }>) => {
      const bucket = s.byBook[a.payload.bookId];
      if (!bucket) return;
      const removed = new Set(a.payload.opKeys);
      bucket.ops = bucket.ops.filter((o) => !removed.has(opKey(o.chapterId, o.id, o.op)));
      for (const key of a.payload.opKeys) delete bucket.selected[key];
      // Finding 4 (PR review round 3): unappliable findings (e.g. a
      // reattribute whose target is currently invalid) can still be
      // genuinely pending even once ops empties — only delete the bucket
      // once BOTH are empty, or a still-unresolved-server-side finding
      // becomes silently invisible client-side.
      if (bucket.ops.length === 0 && bucket.unappliable.length === 0) delete s.byBook[a.payload.bookId];
    },

    /** Remove all ops/unappliable/selected/versionByChapter entries
        belonging to the given chapters, deleting the whole bucket once none
        remain — the client-side mirror of a scoped server /discard call
        (Task 11's re-run confirm gate can discard just the chapters being
        re-reviewed, not the whole bucket, now that the bucket is a
        multi-chapter aggregate — see the fix note on discardReview). */
    removeChaptersLocally: (s, a: PayloadAction<{ bookId: string; chapterIds: number[] }>) => {
      const bucket = s.byBook[a.payload.bookId];
      if (!bucket) return;
      const removed = new Set(a.payload.chapterIds);
      bucket.ops = bucket.ops.filter((o) => !removed.has(o.chapterId));
      bucket.unappliable = bucket.unappliable.filter((u) => !removed.has(u.op.chapterId));
      // Rebuild `selected` from the SURVIVING ops, mirroring setReview's own
      // preservedSelected idiom (opKey reconstruction from a surviving ops
      // array) rather than parsing the `${chapterId}:${id}:${op}` key string.
      const survivingSelected: Record<string, boolean> = {};
      for (const o of bucket.ops) {
        const key = opKey(o.chapterId, o.id, o.op);
        if (key in bucket.selected) survivingSelected[key] = bucket.selected[key];
      }
      bucket.selected = survivingSelected;
      for (const chapterId of a.payload.chapterIds) delete bucket.versionByChapter[chapterId];
      // Finding 1 (PR review round 4): mirror resolveOpsLocally's fix (round
      // 3) — unappliable findings can still be genuinely pending even once
      // ops empties; only delete the bucket once BOTH are empty.
      if (bucket.ops.length === 0 && bucket.unappliable.length === 0) delete s.byBook[a.payload.bookId];
    },

    /** Start or restart a review-progress stream for one book. progress is 0..1. */
    setActive: (s, a: PayloadAction<SetActiveSubstagePayload>) => {
      setActiveSubstage(s.activeStreams, a.payload);
    },
    /** Update the progress fraction (0..1) for an in-flight stream. No-op if not active. */
    updateProgress: (s, a: PayloadAction<UpdateSubstageProgressPayload>) => {
      updateSubstageProgress(s.activeStreams, a.payload);
    },
    /** Remove the active stream entry for one book (stream done or cancelled). */
    clear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.activeStreams[a.payload.bookId];
    },
    /** Cross-tab: apply an already-serialised SubstageEntry from another tab. */
    applyExternalSet: (s, a: PayloadAction<{ bookId: string; entry: SubstageEntry }>) => {
      s.activeStreams[a.payload.bookId] = a.payload.entry;
    },
    /** Cross-tab: clear the stream for a book as broadcast from another tab. */
    applyExternalClear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.activeStreams[a.payload.bookId];
    },
  },
});

export const scriptReviewActions = scriptReviewSlice.actions;

/** Returns only the active book's bucket (or undefined). */
export function selectActiveReview(
  state: RootState,
  bookId: string,
): ScriptReviewBucket | undefined {
  return state.scriptReview.byBook[bookId];
}

/** Count of currently-appliable, unresolved ops touching any of the given
    chapters — the "Review Script" button badge (design spec §6.3). */
export function unresolvedCountForChapters(bucket: ScriptReviewBucket | undefined, chapterIds: number[]): number {
  if (!bucket) return 0;
  const set = new Set(chapterIds);
  return bucket.ops.filter((o) => set.has(o.chapterId)).length;
}

export interface ReviewTypeGroup {
  op: ReviewOp['op'];
  count: number;
  /** opKeys the type-level "Approve" ticks — empty for EXPAND_ONLY types. */
  selectableKeys: string[];
  /** The ops in this chapter+type group, in bucket order — the op cards the
      accordion renders when the type is expanded. Carried here so the view
      doesn't re-scan `bucket.ops` per visible type on every render. */
  ops: ReviewOpWithChapter[];
}
export interface ReviewChapterSummary {
  chapterId: number;
  total: number;
  /** Union of every mechanical op's key in this chapter — the chapter-level
      "Approve all" set. Excludes EXPAND_ONLY ops. */
  selectableKeys: string[];
  /** Count of EXPAND_ONLY ops (reattribute/flag_nonstory) — the "N to review". */
  toReview: number;
  byType: ReviewTypeGroup[];
}
export interface ReviewSummary {
  totalOps: number;
  chapters: ReviewChapterSummary[];
}

/** Pure per-chapter/per-type aggregation over the flat appliable ops
    (`bucket.ops`, never `unappliable`) — the summary the accordion renders.
    No slice shape change; safe to recompute on every render. */
export function selectReviewSummary(bucket: ScriptReviewBucket | undefined): ReviewSummary {
  if (!bucket) return { totalOps: 0, chapters: [] };
  const byChapter = new Map<number, Map<string, ReviewOpWithChapter[]>>();
  for (const o of bucket.ops) {
    let types = byChapter.get(o.chapterId);
    if (!types) {
      types = new Map();
      byChapter.set(o.chapterId, types);
    }
    const arr = types.get(o.op);
    if (arr) arr.push(o);
    else types.set(o.op, [o]);
  }
  const chapters: ReviewChapterSummary[] = [...byChapter.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chapterId, types]) => {
      const byType: ReviewTypeGroup[] = [...types.entries()]
        .map(([op, ops]) => ({
          op: op as ReviewOp['op'],
          count: ops.length,
          selectableKeys: BULK_APPROVABLE.has(op as ReviewOp['op'])
            ? ops.map((o) => opKey(o.chapterId, o.id, o.op))
            : [],
          ops,
        }))
        .sort((a, b) => ALL_OP_TYPES.indexOf(a.op) - ALL_OP_TYPES.indexOf(b.op));
      const selectableKeys = byType.flatMap((t) => t.selectableKeys);
      const total = byType.reduce((n, t) => n + t.count, 0);
      return { chapterId, total, selectableKeys, toReview: total - selectableKeys.length, byType };
    });
  return { totalOps: bucket.ops.length, chapters };
}

/** Like selectActiveReview, but returns undefined for a hidden bucket — use
    this to gate the modal's render, not selectActiveReview (which still
    answers "does this book have a pending review at all", used by the
    unresolved-findings badge in Task 10). */
export function selectVisibleReview(state: RootState, bookId: string): ScriptReviewBucket | undefined {
  const bucket = state.scriptReview.byBook[bookId];
  return bucket?.visible ? bucket : undefined;
}
