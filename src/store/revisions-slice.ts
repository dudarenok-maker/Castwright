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
  /** Write-only audit log of per-segment selections at accept time. Keyed by
      revision id. The future TTS regen flow will consume this to re-render
      only the rejected segments; today nothing reads it back. Persisted
      because losing it would force the user to redo the diff if regen ever
      needs to know which take they kept. */
  acceptedSelections: Record<string, Record<number, 'A' | 'B'>>;
  loaded: boolean;
}

const initialState: RevisionsState = {
  pending: [],
  drift: [],
  dismissed: [],
  acceptedSelections: {},
  loaded: false,
};

export const revisionsSlice = createSlice({
  name: 'revisions',
  initialState,
  reducers: {
    acceptAllPending: (s) => { s.pending = []; },
    rejectAllPending: (s) => { s.pending = []; },
    /** Per-item accept: drops one revision from pending and records the
        user's segment selection. The selection is parked on the slice and
        rides the persistence patch out to revisions.json — no in-app
        consumer reads it yet (future TTS regen will). */
    acceptRevision: (s, a: PayloadAction<{ revisionId: string; selection: Record<number, 'A' | 'B'> }>) => {
      s.pending = s.pending.filter(r => r.id !== a.payload.revisionId);
      s.acceptedSelections[a.payload.revisionId] = a.payload.selection;
    },
    /** Per-item reject: drops one revision from pending. No selection
        captured — reject means "this revision is unwelcome, throw it away
        wholesale", not "I have feelings about specific segments." */
    rejectRevision: (s, a: PayloadAction<string>) => {
      s.pending = s.pending.filter(r => r.id !== a.payload);
    },
    dismissDrift: (s, a: PayloadAction<string>) => {
      s.drift = s.drift.filter(e => e.id !== a.payload);
      if (!s.dismissed.includes(a.payload)) s.dismissed.push(a.payload);
    },
    /* Runtime poll: refresh pending/drift but DON'T touch dismissed or
       acceptedSelections — the server response (RevisionsResponse) doesn't
       include either, and overwriting with empty would lose state until
       the next disk hydrate. */
    applyPoll: (s, a: PayloadAction<RevisionsResponse>) => {
      s.pending = a.payload?.pending || [];
      s.drift   = a.payload?.drift   || [];
      s.loaded  = true;
    },
    /* Disk hydrate on book open. Carries dismissed + acceptedSelections so
       subsequent edits union with prior persisted state rather than
       overwriting it in revisions.json. */
    hydrateFromBookState: (
      s,
      a: PayloadAction<{
        pending?: Revision[];
        drift?: DriftEvent[];
        dismissed?: string[];
        acceptedSelections?: Record<string, Record<number, 'A' | 'B'>>;
      } | null | undefined>,
    ) => {
      const payload = a.payload;
      if (!payload) { s.loaded = true; return; }
      s.pending            = payload.pending            ?? [];
      s.drift              = payload.drift              ?? [];
      s.dismissed          = payload.dismissed          ?? [];
      s.acceptedSelections = payload.acceptedSelections ?? {};
      s.loaded = true;
    },
  },
});

export const revisionsActions = revisionsSlice.actions;
