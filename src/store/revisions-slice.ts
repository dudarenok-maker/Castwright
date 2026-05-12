/* Revisions slice — pending A/B diffs awaiting accept/reject, plus drift events. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Revision, DriftEvent, RevisionsResponse } from '../lib/types';

export interface RevisionsState {
  pending: Revision[];
  drift: DriftEvent[];
  loaded: boolean;
}

const initialState: RevisionsState = { pending: [], drift: [], loaded: false };

export const revisionsSlice = createSlice({
  name: 'revisions',
  initialState,
  reducers: {
    acceptAllPending: (s) => { s.pending = []; },
    rejectAllPending: (s) => { s.pending = []; },
    dismissDrift: (s, a: PayloadAction<string>) => {
      s.drift = s.drift.filter(e => e.id !== a.payload);
    },
    applyPoll: (s, a: PayloadAction<RevisionsResponse>) => {
      s.pending = a.payload?.pending || [];
      s.drift   = a.payload?.drift   || [];
      s.loaded  = true;
    },
  },
});

export const revisionsActions = revisionsSlice.actions;
