/* Script-review suggestions slice — dedicated, non-polled, bookId-keyed.
   MUST NOT be revisions.pending (that slice's applyPoll wholesale-replaces
   `pending` and would wipe active suggestions). Each book's bucket is
   independent so concurrent multi-book workflows coexist without collision.

   Op key shape: `${chapterId}:${id}:${op}` — chapterId is not on the base
   ReviewOp (it lives on the SSE envelope), so we define ReviewOpWithChapter
   which extends ReviewOp with the chapter context. setReview expects
   `ops: ReviewOpWithChapter[]` already tagged by the SSE consumer. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ReviewOp } from '../lib/script-review-apply';
import type { RootState } from './index';

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
}

const initialState: ScriptReviewState = {
  byBook: {},
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
      const selected: Record<string, boolean> = {};
      for (const o of ops) {
        selected[opKey(o.chapterId, o.id, o.op)] = true;
      }
      s.byBook[bookId] = { ops, unappliable, selected };
    },

    /** Flip the selected state of one op by key. */
    toggleOp: (s, a: PayloadAction<{ bookId: string; key: string }>) => {
      const { bookId, key } = a.payload;
      const bucket = s.byBook[bookId];
      if (!bucket) return;
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
