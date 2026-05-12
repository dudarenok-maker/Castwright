/* UI slice — stage modeled as a discriminated union; transitions are guarded.

   Stage shape:
     { kind: 'books' }
     { kind: 'upload' }
     { kind: 'analysing', bookId?: string }
     { kind: 'confirm',   bookId: string }
     { kind: 'ready',     bookId: string, view: View,
                          currentChapterId: number, openProfileId: string|null }

   `view`, `currentChapterId`, `openProfileId` live INSIDE the ready variant —
   they're meaningless in any other stage, so the type prevents the impossible
   state of "manuscript view while still uploading".

   Transient overlays (handoffApp, regenChapter, currentTrack, etc.) stay flat
   at the slice top — they cut across stages and have their own lifecycles. */

const READY_DEFAULTS = { currentChapterId: 3, openProfileId: null };

const uiSlice = RTK.createSlice({
  name: 'ui',
  initialState: {
    stage: { kind: 'books' },
    // Cross-cutting transient state
    currentTrack: null,
    matchDetailFor: null,
    handoffApp: null,
    regenChapter: null,
    regenCharacterCtx: null,
    batchRegenIds: null,
    showRevisionPlayer: false,
    showDriftReport: false,
    previewMode: false,
  },
  reducers: {
    /* ── Stage transitions (guarded — reject from invalid prior stages) ───── */
    goHome: (s) => {
      s.stage = { kind: 'books' };
    },
    startNewBook: (s) => {
      if (s.stage.kind !== 'books') return;
      s.stage = { kind: 'upload' };
    },
    manuscriptUploaded: (s, a) => {
      if (s.stage.kind !== 'upload') return;
      s.stage = {
        kind: 'analysing',
        bookId: a.payload?.bookId,
        manuscriptId: a.payload?.manuscriptId ?? null,
      };
    },
    analysisComplete: (s, a) => {
      if (s.stage.kind !== 'analysing') return;
      const bookId = a.payload?.bookId || s.stage.bookId || 'ns';
      s.stage = { kind: 'confirm', bookId };
    },
    confirmCast: (s) => {
      if (s.stage.kind !== 'confirm') return;
      // After cast confirmation, land on manuscript so the user can verify
      // speaker attributions before kicking off generation.
      s.stage = { kind: 'ready', bookId: s.stage.bookId, view: 'manuscript', ...READY_DEFAULTS };
    },
    reanalyse: (s) => {
      if (s.stage.kind !== 'confirm') return;
      s.stage = { kind: 'analysing', bookId: s.stage.bookId };
    },
    openBook: (s, a) => {
      const { id, status } = a.payload;
      if (status === 'analysing')         s.stage = { kind: 'analysing', bookId: id };
      else if (status === 'cast_pending') s.stage = { kind: 'confirm',   bookId: id };
      else {
        const view = status === 'complete' ? 'listen'
                   : status === 'generating' ? 'generate'
                   : 'cast';
        s.stage = { kind: 'ready', bookId: id, view, ...READY_DEFAULTS };
      }
    },

    /* ── Ready-state mutations (no-ops outside `ready`) ──────────────────── */
    changeView: (s, a) => {
      if (s.stage.kind !== 'ready') return;
      s.stage.view = a.payload;
    },
    setCurrentChapterId: (s, a) => {
      if (s.stage.kind !== 'ready') return;
      s.stage.currentChapterId = a.payload;
    },
    setOpenProfileId: (s, a) => {
      if (s.stage.kind !== 'ready') return;
      s.stage.openProfileId = a.payload;
    },

    /* ── URL hydration: replace stage wholesale from a parsed hash ───────── */
    hydrateFromUrl: (s, a) => {
      const next = a.payload;
      if (next && next.kind) s.stage = next;
    },

    /* ── Cross-cutting overlays (unchanged) ──────────────────────────────── */
    setCurrentTrack:      (s, a) => { s.currentTrack = a.payload; },
    setMatchDetailFor:    (s, a) => { s.matchDetailFor = a.payload; },
    setHandoffApp:        (s, a) => { s.handoffApp = a.payload; },
    setRegenChapter:      (s, a) => { s.regenChapter = a.payload; },
    setRegenCharacterCtx: (s, a) => { s.regenCharacterCtx = a.payload; },
    setBatchRegenIds:     (s, a) => { s.batchRegenIds = a.payload; },
    setShowRevisionPlayer:(s, a) => { s.showRevisionPlayer = a.payload; },
    setShowDriftReport:   (s, a) => { s.showDriftReport = a.payload; },
    setPreviewMode:       (s, a) => { s.previewMode = a.payload; },
  },
});

/* ── Selectors — read derived bits without leaking the union shape everywhere */
const uiSelectors = {
  stageKind:   (s) => s.ui.stage.kind,
  bookId:      (s) => s.ui.stage.bookId ?? null,
  view:        (s) => s.ui.stage.kind === 'ready' ? s.ui.stage.view : null,
  chapterId:   (s) => s.ui.stage.kind === 'ready' ? s.ui.stage.currentChapterId : null,
  profileId:   (s) => s.ui.stage.kind === 'ready' ? s.ui.stage.openProfileId : null,
};

window.uiSlice     = uiSlice;
window.uiActions   = uiSlice.actions;
window.uiSelectors = uiSelectors;
