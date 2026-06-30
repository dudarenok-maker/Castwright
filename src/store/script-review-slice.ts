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
      }>,
    ) => {
      const { bookId, ops, unappliable } = a.payload;
      const DEFAULT_OFF = new Set(['reattribute', 'flag_nonstory']); // fs-58 Unit B — higher-risk classes opt-in
      const selected: Record<string, boolean> = {};
      for (const o of ops) {
        selected[opKey(o.chapterId, o.id, o.op)] = !DEFAULT_OFF.has(o.op);
      }
      s.byBook[bookId] = { ops, unappliable, selected };
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

    /** Start or restart a review-progress stream for one book. progress is 0..1. */
    setActive: (s, a: PayloadAction<{ bookId: string; progress: number; label: string }>) => {
      s.activeStreams[a.payload.bookId] = {
        progress: Math.round(a.payload.progress * 100),
        label: a.payload.label,
      };
    },
    /** Update the progress fraction (0..1) for an in-flight stream. No-op if not active. */
    updateProgress: (s, a: PayloadAction<{ bookId: string; progress: number }>) => {
      const e = s.activeStreams[a.payload.bookId];
      if (e) e.progress = Math.round(a.payload.progress * 100);
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
