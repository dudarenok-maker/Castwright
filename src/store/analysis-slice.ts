/* Analysis slice — out-of-band snapshot of the in-flight analyzer run so a
   top-bar `AnalysisPill` (B3) can render live progress across navigation
   and Pause is wired through Redux instead of a per-view ref.

   The analysing view still owns its detailed local state (phase logs,
   live tickers, per-chapter rows, dropped quotes) for now — those are
   high-volume and the slice doesn't yet need to be the single source of
   truth for that surface. This slice is intentionally narrow: just the
   pill-relevant snapshot + paused flag.

   Mirrors `chapters.activeStream` in chapters-slice.ts:36-48. Cross-book
   guard is encoded in `applyAnalysisSnapshotTick` — a tick whose bookId
   doesn't match the current snapshot is ignored. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/* Snapshot of the in-flight analyzer run. Set by the analysing view (or
   the analysis-stream middleware) on start; updated on every Phase/ETA/
   completion tick; cleared on pause / completion / error. The pill in
   B3 reads from this — survives navigation because it lives in Redux,
   not in the analysing view's local state. */
export interface AnalysisStreamSnapshot {
  bookId: string | null;
  manuscriptId: string;
  bookTitle?: string;
  /** Engine the running analyzer is using, captured at setActiveStream
      time. The reverse-direction local-analyzer guard (see
      `src/hooks/use-reverse-local-analyzer-guard.tsx`) reads this to
      decide whether starting TTS would compete with this analysis
      for GPU. Captured on the snapshot (not read from
      `ui.selectedModel`) so a user model-switch mid-stream cannot
      misclassify the running analysis. */
  engine?: 'local' | 'gemini';
  /** Server-resolved analyzer model id, carried from the `model` field on SSE
      phase events (the same source the analysing view's PhaseModelChip reads).
      Captured so the global Status popover can show WHICH model the run is on —
      especially the local model id, which the user otherwise can't see.
      Undefined pre-stream (before the first phase tick). */
  model?: string;
  /** Active phase id (0 = detecting characters, 1 = parsing+attribution,
      2 = matching library). */
  phaseId: number;
  /** Server-supplied phase label (e.g. "Detecting characters"). */
  phaseLabel: string;
  /** 0..1 fraction within the active phase. */
  phaseProgress: number;
  /** Heartbeat's per-call elapsed ms for the active phase (reset when the
      phase advances). Drives the single-chapter subset pill's mapped progress
      (lib/reanalyse-progress.ts), where the server's coarse phaseProgress is
      frozen. Undefined on main runs / pre-existing cold-boot snapshots. */
  phaseElapsedMs?: number;
  /** Server's projected total-remaining wall-clock ms across the rest
      of the run, refined as each chapter completes. null until the
      first eta event lands. */
  remainingMs: number | null;
  /** ms since epoch of the most recent non-heartbeat tick. The pill
      uses this for the "X seconds since last update" stall indicator. */
  lastTickAt: number;
  /** Connection state observed by the slice. `running` is the happy
      path; `paused` is set on /pause; `halted` is set on terminal
      error events (attribution_drift, stage1_shrink_refused, etc.);
      `stalled` is a derived UI state — recomputed in the view. */
  state: 'running' | 'paused' | 'halted';
  /** Headline message for halted state (rendered as the pill subtitle). */
  haltReason?: string;
  /** Carried error code from the server's last terminal event so the
      pill / view can route to the right banner. */
  haltCode?: string;
  /** Series carry-over surface (plan 04 + plan 09). Populated by the
      server's one-shot `series-prior` SSE event at Phase 0 entry when
      the analyzer pre-seeded its per-chapter prompt with characters
      from prior books in the same series. `count` is the total;
      `names` is the first three for the analysing view's "Carried
      from <series>" pill copy. Undefined for standalones / first-
      in-series books (the server doesn't emit the event in that
      case). */
  seriesPrior?: {
    count: number;
    names: string[];
  };
  /** Discriminator for the in-flight job's shape (plan 32 D1).
      `'main'` = full-book sticky analysis run; `'subset'` = per-
      chapter retry. The pill renders "Retrying N chapters" copy
      when `kind === 'subset'` so the user knows they're watching a
      retry rather than a fresh analysis. Optional — undefined
      means main (cold-boot snapshots written before D1 omit it). */
  kind?: 'main' | 'subset';
  /** Set only when `kind === 'subset'`. The chapter ids being
      retried, captured at job creation. The pill reads `.length`
      for the retry count. */
  subsetChapterIds?: number[];
}

export interface AnalysisState {
  activeStream: AnalysisStreamSnapshot | null;
}

const initialState: AnalysisState = {
  activeStream: null,
};

export const analysisSlice = createSlice({
  name: 'analysis',
  initialState,
  reducers: {
    /* Open the snapshot. Dispatched when the analysing view fires its
       SSE (and, eventually, by the middleware that owns its own SSE
       for the pill). Mirrors chapters.setActiveStream. */
    setActiveStream(state, action: PayloadAction<AnalysisStreamSnapshot>) {
      state.activeStream = action.payload;
    },

    /* Apply a phase / log / eta / cast-update tick to the snapshot.
       Cross-book guard: if the snapshot is for a different
       manuscriptId, the tick is ignored (another tab's analysis can't
       clobber this tab's snapshot). */
    applyAnalysisSnapshotTick(
      state,
      action: PayloadAction<{
        manuscriptId: string;
        phaseId?: number;
        phaseLabel?: string;
        phaseProgress?: number;
        phaseElapsedMs?: number;
        remainingMs?: number;
        lastTickAt?: number;
        model?: string;
      }>,
    ) {
      const snap = state.activeStream;
      if (!snap) return;
      if (snap.manuscriptId !== action.payload.manuscriptId) return;
      if (typeof action.payload.model === 'string') snap.model = action.payload.model;
      const phaseChanged =
        typeof action.payload.phaseId === 'number' && action.payload.phaseId !== snap.phaseId;
      if (typeof action.payload.phaseId === 'number') snap.phaseId = action.payload.phaseId;
      if (typeof action.payload.phaseLabel === 'string')
        snap.phaseLabel = action.payload.phaseLabel;
      if (typeof action.payload.phaseProgress === 'number')
        snap.phaseProgress = action.payload.phaseProgress;
      /* Reset per-phase elapsed when the phase advances so the new phase's ease
         starts from 0; otherwise adopt the supplied heartbeat value. */
      if (phaseChanged) snap.phaseElapsedMs = action.payload.phaseElapsedMs ?? 0;
      else if (typeof action.payload.phaseElapsedMs === 'number')
        snap.phaseElapsedMs = action.payload.phaseElapsedMs;
      if (typeof action.payload.remainingMs === 'number')
        snap.remainingMs = action.payload.remainingMs;
      if (typeof action.payload.lastTickAt === 'number')
        snap.lastTickAt = action.payload.lastTickAt;
    },

    /* Thin lastTickAt-only refresh dispatched from the middleware on
       every analyzer heartbeat event. Mirrors the chapters-slice
       updateActiveStreamProgress reducer added in commit 06444ee — keeps
       `activeStream.lastTickAt` fresh while the user is on a different
       view, so the global AnalysisPill's stall heuristic doesn't trip on
       quiet phases (slow ML inference between phase transitions) when
       no onPhase / onEta ticks are arriving. Manuscript guard prevents a
       tab-B analysis from clobbering a tab-A snapshot. */
    bumpActiveStreamHeartbeat(
      state,
      action: PayloadAction<{ manuscriptId: string; lastTickAt: number }>,
    ) {
      const snap = state.activeStream;
      if (!snap) return;
      if (snap.manuscriptId !== action.payload.manuscriptId) return;
      snap.lastTickAt = action.payload.lastTickAt;
    },

    /* Flip to halted state with an error code + message. Used for
       attribution_drift / stage1_shrink_refused / cast_incomplete /
       aborted / unknown error events. */
    setHalted(
      state,
      action: PayloadAction<{ manuscriptId: string; code: string; message: string }>,
    ) {
      const snap = state.activeStream;
      if (!snap) return;
      if (snap.manuscriptId !== action.payload.manuscriptId) return;
      snap.state = 'halted';
      snap.haltCode = action.payload.code;
      snap.haltReason = action.payload.message;
    },

    /* Flip to paused state. Dispatched by the analysing view's Pause
       button; the middleware (B2) sees this and fires the actual
       POST /pause to the server. */
    setPaused(state, action: PayloadAction<{ manuscriptId: string }>) {
      const snap = state.activeStream;
      if (!snap) return;
      if (snap.manuscriptId !== action.payload.manuscriptId) return;
      snap.state = 'paused';
    },

    /* Tear down the snapshot — used on terminal success (result event),
       on the user explicitly leaving analysis state via cast confirm,
       or on a fresh: true displacement when a new run is starting. */
    clearActiveStream(state) {
      state.activeStream = null;
    },

    /* Cold-boot rehydration entry point. Like `setActiveStream` but
       only writes when the slot is currently null — protects against
       clobbering an already-running SSE-driven snapshot if the cold-
       boot fetch (Layout's library /active-analyses scan) resolves
       AFTER the analysing view has mounted and dispatched its own
       setActiveStream. Use `setActiveStream` directly for live
       streams; use this for disk-discovered paused/halted snapshots. */
    hydrateColdBoot(state, action: PayloadAction<AnalysisStreamSnapshot>) {
      if (state.activeStream !== null) return;
      state.activeStream = action.payload;
    },

    /* Apply the one-shot `series-prior` SSE event the server emits at
       Phase 0 entry. Cross-book guarded so a stale event from another
       tab can't poison this tab's snapshot. */
    setSeriesPrior(
      state,
      action: PayloadAction<{ manuscriptId: string; count: number; names: string[] }>,
    ) {
      const snap = state.activeStream;
      if (!snap) return;
      if (snap.manuscriptId !== action.payload.manuscriptId) return;
      snap.seriesPrior = {
        count: action.payload.count,
        names: action.payload.names,
      };
    },

    /* Cross-tab `BroadcastChannel` inbound hydrate (plan 63). Applied when
       a sibling tab broadcasts its post-mutation snapshot of this slice
       for `bookId`. Echo suppression lives in the middleware (the
       middleware tags outbound messages with a per-tab instanceId and
       drops inbound messages it sent itself); this reducer is pure and
       must not re-broadcast (the middleware also short-circuits on this
       action type). Cross-book isolation: when the inbound bookId
       doesn't match our current activeStream's bookId, the snapshot is
       still applied verbatim — the snapshot's own bookId field becomes
       the slice's truth, mirroring how the same-tab `setActiveStream`
       behaves. The middleware additionally guards on `currentBookId`
       at the slice level (manuscript / chapters) so cross-bookId
       contamination cannot leak into per-book per-chapter state. */
    applyExternalAnalysisSnapshot(state, action: PayloadAction<AnalysisStreamSnapshot | null>) {
      state.activeStream = action.payload;
    },
  },
});

export const analysisActions = analysisSlice.actions;
