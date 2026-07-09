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

export const scriptReviewSlice = createSlice({
  name: 'scriptReview',
  initialState,
  reducers: {
    /** Replace the full review bucket for one book; default ALL ops selected. */
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
      const DEFAULT_OFF = new Set(['reattribute', 'flag_nonstory']); // fs-58 Unit B — higher-risk classes opt-in
      const selected: Record<string, boolean> = {};
      for (const o of ops) {
        selected[opKey(o.chapterId, o.id, o.op)] = !DEFAULT_OFF.has(o.op);
      }
      s.byBook[bookId] = { ops, unappliable, selected, manuscriptId, versionByChapter, visible: true };
    },

    /** Hydrate a bucket from the persisted ledger (Task 8). Unlike setReview
        (the live-run-completion path, which computes `selected` fresh from
        DEFAULT_OFF), the caller here has ALREADY merged the DEFAULT_OFF
        baseline with the ledger's persisted override map — the ledger only
        ever stores explicit overrides (design spec §4.2), so there's no
        recomputation to do inside the reducer. */
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
      s.byBook[bookId] = { ops, unappliable, selected, manuscriptId, versionByChapter, visible: true };
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

    /** Remove one book's bucket entirely (e.g. on modal close / dismiss). */
    clearReview: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.byBook[a.payload.bookId];
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
    /** Delete a book's bucket entirely — the same behavior as clearReview,
        under the name Task 12's discardReview thunk will call after a
        successful server discard. clearReview itself is removed in Task 12
        once every call site has migrated to hideReview/removeBucket. */
    removeBucket: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.byBook[a.payload.bookId];
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
      if (bucket.ops.length === 0) delete s.byBook[a.payload.bookId];
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

/** Like selectActiveReview, but returns undefined for a hidden bucket — use
    this to gate the modal's render, not selectActiveReview (which still
    answers "does this book have a pending review at all", used by the
    unresolved-findings badge in Task 10). */
export function selectVisibleReview(state: RootState, bookId: string): ScriptReviewBucket | undefined {
  const bucket = state.scriptReview.byBook[bookId];
  return bucket?.visible ? bucket : undefined;
}
