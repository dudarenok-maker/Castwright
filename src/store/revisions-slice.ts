/* Revisions slice — pending A/B diffs awaiting accept/reject, plus drift events. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Revision, DriftEvent, RevisionsResponse } from '../lib/types';

export interface RevisionsState {
  pending: Revision[];
  drift: DriftEvent[];
  /** Ids of drift events the user has dismissed. The backend revisions
      detector reads this from disk and filters its output, so a dismissed
      event won't reappear on the next poll. Slice carries it so subsequent
      dismissals in the same session don't overwrite the persisted list. */
  dismissed: string[];
  loaded: boolean;
}

const initialState: RevisionsState = { pending: [], drift: [], dismissed: [], loaded: false };

export const revisionsSlice = createSlice({
  name: 'revisions',
  initialState,
  reducers: {
    acceptAllPending: (s) => { s.pending = []; },
    rejectAllPending: (s) => { s.pending = []; },
    dismissDrift: (s, a: PayloadAction<string>) => {
      s.drift = s.drift.filter(e => e.id !== a.payload);
      if (!s.dismissed.includes(a.payload)) s.dismissed.push(a.payload);
    },
    /* Runtime poll: refresh pending/drift but DON'T touch dismissed —
       the server response (RevisionsResponse) doesn't include dismissed,
       and overwriting with an empty list would lose state until the next
       disk hydrate. */
    applyPoll: (s, a: PayloadAction<RevisionsResponse>) => {
      s.pending = a.payload?.pending || [];
      s.drift   = a.payload?.drift   || [];
      s.loaded  = true;
    },
    /* Disk hydrate on book open. Carries dismissed so subsequent dismissals
       union with prior ones rather than overwriting them in revisions.json. */
    hydrateFromBookState: (s, a: PayloadAction<{ pending?: Revision[]; drift?: DriftEvent[]; dismissed?: string[] } | null | undefined>) => {
      const payload = a.payload;
      if (!payload) { s.loaded = true; return; }
      s.pending   = payload.pending   ?? [];
      s.drift     = payload.drift     ?? [];
      s.dismissed = payload.dismissed ?? [];
      s.loaded = true;
    },
  },
});

export const revisionsActions = revisionsSlice.actions;
