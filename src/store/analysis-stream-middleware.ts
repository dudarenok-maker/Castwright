/* Analysis-stream middleware — owns the SSE handle that keeps the
   AnalysisPill snapshot ticking across every navigation.

   Pre-D1 this file was a 44-line pause-bridge: setPaused → POST /pause.
   The view owned the only SSE, so navigating away from the analysing
   view froze the pill at the last view-side tick — visible regression
   on the pill's whole reason for existing. D1 keeps the pause-bridge
   AND grows the file into a full reconcile loop with openHandle /
   closeHandle, mirroring src/store/generation-stream-middleware.ts.

   Trigger choice — open on first applyAnalysisSnapshotTick, NOT on
   setActiveStream. setActiveStream is dispatched synchronously by the
   analysing view JUST BEFORE its own POST; if the middleware fired its
   POST on that action, it could race the view's POST and reach the
   server-side dispatcher (server/src/routes/analysis.ts) before the
   view did — meaning the middleware's options-less POST would START
   a fresh job and the view's `fresh: true` / `model: ...` opts would
   be dropped (the server would see the job already exists and take
   the subscribe path for the view). Triggering on the first
   applyAnalysisSnapshotTick instead proves the server-side job is
   already alive (the view's POST landed and the server emitted at
   least one tick) — the middleware's subsequent POST is guaranteed to
   take the subscribe path.

   Failure window: navigating away within the ~10-100ms between
   setActiveStream and the first tick means the middleware never opens
   its handle and the pill freezes at the seed snapshot until the user
   returns to the analysing view. Acceptable for v1 (sticky-analysis
   B-series doc) — the navigation pattern that triggers this is rare.

   What the middleware consumes vs leaves to the view: snapshot-only
   subset (onPhase / onEta / onSeriesPrior / AnalysisError /
   onComplete). Log lines, cast-update merges, chapter-failed rows,
   and heartbeats stay view-only — the middleware would either
   double-dispatch (idempotent but wasteful) or fight the view for
   ownership of stateful Redux reducers. The view + middleware BOTH
   dispatching the snapshot subset is intentional and idempotent: the
   slice's applyAnalysisSnapshotTick takes the latest tick.

   Pairs with docs/features/32-sticky-analysis.md. */

import type { Dispatch, Middleware } from '@reduxjs/toolkit';
import { api, AnalysisError } from '../lib/api';
import { analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
import { ANALYSIS_PHASES } from '../data/analysis-phases';

interface AnalysisRootState {
  analysis: { activeStream: AnalysisStreamSnapshot | null };
}

interface OpenHandle {
  manuscriptId: string;
  controller: AbortController;
}

const PAUSE_TYPE = analysisActions.setPaused.type;
const HALTED_TYPE = analysisActions.setHalted.type;
const CLEAR_TYPE = analysisActions.clearActiveStream.type;
const SET_ACTIVE_TYPE = analysisActions.setActiveStream.type;
const APPLY_TICK_TYPE = analysisActions.applyAnalysisSnapshotTick.type;

export const analysisStreamMiddleware: Middleware = (store) => {
  let handle: OpenHandle | null = null;

  const dispatch = store.dispatch as Dispatch;

  const closeHandle = (): void => {
    if (!handle) return;
    handle.controller.abort();
    handle = null;
  };

  const openHandle = (manuscriptId: string): void => {
    if (handle && handle.manuscriptId === manuscriptId) return;
    if (handle) closeHandle();

    const controller = new AbortController();
    const localHandle: OpenHandle = { manuscriptId, controller };
    handle = localHandle;

    /* Subscribe-only POST: no model / fresh / allowStage1Shrink. The
       view's POST owns the start decision; this one is guaranteed to
       take the server dispatcher's subscribe path because we wait for
       the first tick (proof the view's POST landed) before firing. */
    void (async () => {
      try {
        await api.analyseManuscript(manuscriptId, {
          signal: controller.signal,
          onPhase: ({ phaseId, progress }) => {
            dispatch(analysisActions.applyAnalysisSnapshotTick({
              manuscriptId,
              phaseId,
              phaseLabel: ANALYSIS_PHASES[phaseId]?.label ?? 'Analysing',
              phaseProgress: progress,
              lastTickAt: Date.now(),
            }));
          },
          onEta: ({ remainingMs }) => {
            dispatch(analysisActions.applyAnalysisSnapshotTick({
              manuscriptId,
              remainingMs,
              lastTickAt: Date.now(),
            }));
          },
          onSeriesPrior: ({ count, names }) => {
            dispatch(analysisActions.setSeriesPrior({ manuscriptId, count, names }));
          },
          /* Intentionally NOT consumed by the middleware (view-only):
             onLog, onCastUpdate, onChapterFailed, onChapterResolved,
             onHeartbeat, onThrottle. */
        });
        /* Terminal success — the server's `result` event ended the
           stream cleanly. Only clear if we're still the active handle
           (a displacement to a different manuscript may have aborted
           us mid-flight; that case dispatches its own clearActiveStream
           via the view). */
        if (handle === localHandle) {
          dispatch(analysisActions.clearActiveStream());
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') return;
        /* If we got displaced (closeHandle called for a different
           manuscript), don't poison the new snapshot with the old
           run's terminal state. */
        if (handle !== localHandle) return;
        if (e instanceof AnalysisError && e.code === 'aborted') {
          dispatch(analysisActions.setPaused({ manuscriptId }));
          return;
        }
        if (e instanceof AnalysisError) {
          dispatch(analysisActions.setHalted({ manuscriptId, code: e.code, message: e.message }));
          return;
        }
        dispatch(analysisActions.setHalted({
          manuscriptId,
          code: 'unknown',
          message: (e as Error)?.message ?? 'Analysis failed.',
        }));
      }
    })();
  };

  return (next) => (action) => {
    const result = next(action);
    const a = action as { type?: string; payload?: { manuscriptId?: string } };

    if (a.type === PAUSE_TYPE) {
      const manuscriptId = a.payload?.manuscriptId;
      if (typeof manuscriptId !== 'string' || !manuscriptId) return result;
      /* Fire-and-forget — server endpoint is idempotent. Tear down the
         local handle too: the view's existing imperative abort still
         tears down its own SSE; the middleware needs to do the same
         for its handle. */
      void api.pauseAnalysis({ manuscriptId });
      closeHandle();
      return result;
    }

    if (a.type === HALTED_TYPE || a.type === CLEAR_TYPE) {
      /* Slice already updated by next(action). Tear down the local
         handle — there's nothing more to tick for. */
      closeHandle();
      return result;
    }

    if (a.type === SET_ACTIVE_TYPE) {
      /* Cross-manuscript displacement only. A new setActiveStream for
         a DIFFERENT manuscriptId means an earlier run was replaced
         (e.g. user navigated to a new book and started fresh
         analysis there). Close the stale handle; the new handle
         opens on its own first tick. */
      const state = store.getState() as AnalysisRootState;
      const snap = state.analysis.activeStream;
      if (handle && snap && handle.manuscriptId !== snap.manuscriptId) {
        closeHandle();
      }
      return result;
    }

    if (a.type === APPLY_TICK_TYPE) {
      /* First-tick-opens contract. If there's an active snapshot in
         the slice and we haven't yet opened a handle, the view's
         first tick is our proof that the server-side job is alive
         and we can safely subscribe via a second POST. */
      const state = store.getState() as AnalysisRootState;
      const snap = state.analysis.activeStream;
      if (snap && !handle) {
        openHandle(snap.manuscriptId);
      }
      return result;
    }

    return result;
  };
};
