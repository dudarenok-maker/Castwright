/* Change-log slice — append-only audit trail of user-visible edits.

   Each `regenerate` confirm (chapter / character / batch-character) and any
   future editorial action dispatches `appendLogEvent`; the Activity view
   reads `s.changeLog.events` and renders them grouped by date.

   Hydrated from disk via `hydrateFromBookState` (called by the layout once
   per book open), persisted by the persistence middleware as the
   `changeLog` slice. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { CHANGE_LOG_EVENTS } from '../data/change-log';
import type { ChangeLogEvent } from '../lib/types';

export interface ChangeLogState {
  /** Newest first — appendLogEvent unshifts. */
  events: ChangeLogEvent[];
}

/* Demo seed so the Activity view isn't blank before the first real action.
   Hydration from book-state overwrites this whenever a book opens. */
const initialState: ChangeLogState = {
  events: CHANGE_LOG_EVENTS,
};

export const changeLogSlice = createSlice({
  name: 'changeLog',
  initialState,
  reducers: {
    appendLogEvent: (s, a: PayloadAction<ChangeLogEvent>) => {
      s.events.unshift(a.payload);
    },
    hydrateFromBookState: (s, a: PayloadAction<ChangeLogEvent[] | null | undefined>) => {
      s.events = a.payload && a.payload.length > 0 ? a.payload : [];
    },
    reset: (s) => { s.events = []; },
  },
});

export const changeLogActions = changeLogSlice.actions;
