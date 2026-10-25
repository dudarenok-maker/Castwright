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
import { ANALYSIS_STREAM_FAILED } from '../lib/analysis-stream-codes';
/* #3084 F7 — the structured "how to fix" entry shape (derived from the
   generated OpenAPI schema by src/lib/api.ts, which is the frontend's single
   alias for it). Type-only: the slice stays free of api.ts at runtime. */
import type { AnalysisFailureFix } from '../lib/api';
import type { AnalysisEngine } from '../lib/model-id';
import { combineSnapshotGpus } from '../lib/analyzer-endpoints';
import { STALL_THRESHOLD_MS } from './chapters-slice';

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
  engine?: AnalysisEngine;
  /** #3084 — card tag of the endpoint(s) the run uses ('none' | 'any' | 'cuda:N'),
      captured with `engine`. Absent for Ollama/Gemini runs and for cold-boot snapshots,
      where the reverse guard treats an openai run as 'any'. */
  gpu?: string;
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
  /** #3084 F7 — structured "how to fix" list carried from the terminal
      `error` event (both the view's own stream and the middleware's
      copy it here). This is the SAME halted-run state a user who
      navigates away and back in the session sees: the analysing view
      renders these as the run-level "How to fix:" list when it has no
      live `error` object of its own. Undefined for every halt code the
      classifier has nothing actionable for. */
  haltFixes?: AnalysisFailureFix[];
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
  /** #3774 — set only when `kind === 'subset'`: what started the run. An
      `'include'` run holds the book under a Cancel rollback that a job started
      alongside it would block; a `'reanalyse'` run needs no such guard. Lets the
      Generate view re-derive that block after a remount. Absent on cold-boot
      snapshots (never treated as an include). */
  subsetOrigin?: 'include' | 'reanalyse';
  /** #3774 — evidence the server registered this run: a server tick landed on the
      snapshot, it was rebuilt from the server's own answer (hydrate / restore), or
      `/busy` reported `analysis` while it was held. Until then a quiet snapshot is
      only the click-to-registration window (the job registers after two POSTs and
      two bounded waits), not a dead run, so it is never judged stale. Preserved
      through ticks like `subsetOrigin`. */
  serverConfirmed?: boolean;
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
       clobber this tab's snapshot).

       A tick is proof the run is alive — it only ever comes from a live
       SSE connection for this manuscript (the view's or the middleware's).
       So a tick contradicts a CONNECTION-level halt: the middleware
       declares `stream_failed` when ITS socket dies, and if the view's
       socket is still delivering ticks the run is fine and the halt was
       about the wrong thing. Lift it. Analyzer-level halts
       (attribution_drift, cast_incomplete, …) are a verdict on the run
       and end the stream, so no tick can follow them; paused is untouched
       (a late buffered tick after Pause must not un-pause). Without this,
       a halt set by one dead socket stayed on a run that was visibly
       progressing (#3198 pass 5, PROBE_K). */
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
        /** #3084 wave 3d review pass 4 (J) — the run's engine and endpoint card after a fallback switch
            (the server's `analysisEngine`/`analysisGpu`). Moves the snapshot's start-time capture, which
            the reverse guard and the generation hold read, to what the run now holds. */
        engine?: AnalysisEngine;
        gpu?: string;
      }>,
    ) {
      const snap = state.activeStream;
      if (!snap) return;
      if (snap.manuscriptId !== action.payload.manuscriptId) return;
      snap.serverConfirmed = true;
      if (snap.state === 'halted' && snap.haltCode === ANALYSIS_STREAM_FAILED) {
        snap.state = 'running';
        snap.haltCode = undefined;
        snap.haltReason = undefined;
      }
      if (typeof action.payload.model === 'string') snap.model = action.payload.model;
      if (action.payload.engine !== undefined) {
        /* A switch may only WIDEN what a running analysis holds, never narrow it (fail closed): a mixed-split
           run stamps only the switched-to targets, while the other phase still holds its own card. So the
           incoming engine is combined with the snapshot's by the server's precedence (Ollama > endpoint >
           Gemini), and an endpoint card is combined with the one already held. A cold-boot `openai` seed
           carries no card, which reads as `any` (unknown holds everything). */
        const prior = snap.engine;
        const incoming = action.payload.engine;
        const engine: AnalysisEngine =
          prior === 'local' || incoming === 'local' ? 'local' : prior === 'openai' || incoming === 'openai' ? 'openai' : 'gemini';
        if (engine === 'local') snap.gpu = prior === 'local' ? snap.gpu : undefined;
        else if (engine === 'gemini') snap.gpu = undefined;
        else
          snap.gpu = combineSnapshotGpus([
            prior === 'openai' ? (snap.gpu ?? 'any') : undefined,
            incoming === 'openai' ? action.payload.gpu : undefined,
          ]);
        snap.engine = engine;
      }
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
      snap.serverConfirmed = true;
    },

    /* #3774 — `/busy` reported an `analysis` job while this book's include
       snapshot was held: the run's lease is registered, so its quiet time counts
       from here. */
    markAnalysisServerConfirmed(state, action: PayloadAction<{ bookId: string }>) {
      const snap = state.activeStream;
      if (!snap || snap.bookId !== action.payload.bookId) return;
      snap.serverConfirmed = true;
    },

    /* Flip to halted state with an error code + message. Used for
       attribution_drift / stage1_shrink_refused / cast_incomplete /
       aborted / unknown error events. #3084 F7 — `fixes` is optional and
       rides the SAME halted-run record (never a separate one): the
       analysing view reads `activeStream.haltFixes` when it has no live
       error object of its own. */
    setHalted(
      state,
      action: PayloadAction<{
        manuscriptId: string;
        code: string;
        message: string;
        fixes?: AnalysisFailureFix[];
      }>,
    ) {
      const snap = state.activeStream;
      if (!snap) return;
      if (snap.manuscriptId !== action.payload.manuscriptId) return;
      snap.state = 'halted';
      snap.haltCode = action.payload.code;
      snap.haltReason = action.payload.message;
      snap.haltFixes = action.payload.fixes;
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

/** #3435 decision A — true while this manuscript's MAIN analysis run is live:
    the snapshot is for this manuscript, is not a subset run, and is running.
    Retry, Re-analyse and Include are disabled ("Pause the analysis first")
    while it is, because the server refuses a subset run beside a main one.
    Typed structurally so this module needn't import the store's RootState. */
export function selectMainAnalysisLive(state: { analysis: AnalysisState }, manuscriptId: string | null | undefined): boolean {
  const snap = state.analysis.activeStream;
  return !!snap && !!manuscriptId && snap.manuscriptId === manuscriptId && snap.kind !== 'subset' && snap.state === 'running';
}

/** #3774 — true when the held snapshot is a running include-origin subset run
    for this book that has gone quiet (no tick for longer than
    STALL_THRESHOLD_MS). A live run is ticked every few seconds, so a copy this
    quiet is a stale mirror (the tab that started it closed or reloaded) — but
    only once the server also reports no live subset run, which is the caller's
    check. Quiet time only counts once the run is known to have registered
    (`serverConfirmed`): before that the snapshot is the click-to-registration
    window, in which `/busy` truthfully reports no analysis for a LIVE include.
    Shared by the layout's per-book hydrate and the Generate view's busy
    poll so the two ends of the same rule cannot drift. */
export function isStaleIncludeSnapshot(
  held: AnalysisStreamSnapshot | null | undefined,
  bookId: string,
  now: number,
): boolean {
  return (
    !!held &&
    held.bookId === bookId &&
    held.kind === 'subset' &&
    held.state === 'running' &&
    held.subsetOrigin === 'include' &&
    held.serverConfirmed === true &&
    now - held.lastTickAt > STALL_THRESHOLD_MS
  );
}
