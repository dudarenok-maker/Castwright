/* Revisions slice — pending A/B diffs awaiting the user's accept/reject.
   Drift events live here too: same conceptual surface (changes that need review). */
const revisionsSlice = RTK.createSlice({
  name: 'revisions',
  initialState: { pending: [], drift: [], loaded: false },
  reducers: {
    acceptAllPending: (s) => { s.pending = []; },
    rejectAllPending: (s) => { s.pending = []; },
    dismissDrift: (s, a) => { s.drift = s.drift.filter(e => e.id !== a.payload); },
    /* From GET /api/books/:bookId/revisions — polled. */
    applyPoll: (s, a) => {
      s.pending = a.payload?.pending || [];
      s.drift   = a.payload?.drift   || [];
      s.loaded  = true;
    },
  },
});
window.revisionsSlice = revisionsSlice;
window.revisionsActions = revisionsSlice.actions;
