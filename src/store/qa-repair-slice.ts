import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/* Plan 179 — tracks in-flight per-chapter audio-QA repairs. The work itself
   runs in `qa-repair-runner-middleware` (one repair SSE per chapter), so a
   repair survives the row it was started from unmounting. This slice is the
   only thing the Listen-view button reads: it needs to know whether THIS
   chapter is already repairing so it can't be double-fired.

   Deliberately thinner than `splice-slice`: a repair is a single-chapter,
   fire-and-forget action with no batch to report progress against, so there's
   nothing to count. */

/** `${bookId}:${chapterId}` — a repair is scoped to one chapter of one book,
    and two books can repair concurrently. */
export type QaRepairKey = string;

export const qaRepairKey = (bookId: string, chapterId: number): QaRepairKey =>
  `${bookId}:${chapterId}`;

/** Payload of `qaRepair/start`. The middleware reads this to drive the SSE. */
export interface QaRepairRequest {
  bookId: string;
  chapterId: number;
}

export interface QaRepairState {
  running: Record<QaRepairKey, true>;
}

const initialState: QaRepairState = { running: {} };

export const qaRepairSlice = createSlice({
  name: 'qaRepair',
  initialState,
  reducers: {
    /** Kick off a repair. The middleware reacts to this action's payload; the
        reducer just marks the chapter busy so the button can disable. */
    start: (s, a: PayloadAction<QaRepairRequest>) => {
      s.running[qaRepairKey(a.payload.bookId, a.payload.chapterId)] = true;
    },
    finish: (s, a: PayloadAction<QaRepairRequest>) => {
      delete s.running[qaRepairKey(a.payload.bookId, a.payload.chapterId)];
    },
  },
});

export const qaRepairActions = qaRepairSlice.actions;

/** True while this chapter has a repair in flight. */
export const selectQaRepairRunning =
  (bookId: string, chapterId: number) =>
  (s: { qaRepair?: QaRepairState }): boolean =>
    s.qaRepair?.running[qaRepairKey(bookId, chapterId)] === true;
