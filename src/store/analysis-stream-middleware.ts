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
   subset (onPhase / onEta / onSeriesPrior / the non-story onWarning / AnalysisError /
   onComplete). Log lines, cast-update merges, chapter-failed rows,
   and heartbeats stay view-only — the middleware would either
   double-dispatch (idempotent but wasteful) or fight the view for
   ownership of stateful Redux reducers. The view + middleware BOTH
   dispatching the snapshot subset is intentional and idempotent: the
   slice's applyAnalysisSnapshotTick takes the latest tick.

   Pairs with docs/features/archive/32-sticky-analysis.md. */

import type { Dispatch, Middleware } from '@reduxjs/toolkit';
import { api, AnalysisError, type AnalysisFailureFix } from '../lib/api';
import { ANALYSIS_STREAM_FAILED, ANALYSIS_STREAM_NO_RESULT } from '../lib/analysis-stream-codes';
import { analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
import { notificationsActions } from './notifications-slice';
import { ANALYSIS_PHASES } from '../data/analysis-phases';
import { emitLanguageGuard } from '../lib/language-guard-bus';
import { deliverNonStoryOverflowWarning } from '../lib/analysis-warning-toast';
import { shouldSurfaceColdBootAnalysisPill } from '../lib/analysis-pill-gate';
import { isNotAFailureHaltCode } from '../lib/analysis-phase-state';

interface AnalysisRootState {
  analysis: { activeStream: AnalysisStreamSnapshot | null };
}

interface OpenHandle {
  manuscriptId: string;
  /* Discriminator for which server route the subscribe POST hits.
     'main' → POST /analysis (joins inFlightAnalysisByManuscript);
     'subset' → POST /analysis/chapters (joins
     inFlightSubsetByManuscript). Plan 32 follow-up — without the
     branch the middleware always hit the main route and either joined
     the wrong job or started a fresh one mid-subset-retry. */
  kind: 'main' | 'subset';
  controller: AbortController;
}

const PAUSE_TYPE = analysisActions.setPaused.type;
const HALTED_TYPE = analysisActions.setHalted.type;
const CLEAR_TYPE = analysisActions.clearActiveStream.type;
const SET_ACTIVE_TYPE = analysisActions.setActiveStream.type;
const APPLY_TICK_TYPE = analysisActions.applyAnalysisSnapshotTick.type;

/* Dampening for reopens after persistent failure (#3172 finding 27).
   When the middleware's socket fails to open, the heal on the next view tick
   lifts the halt and triggers a reopen. If that reopen fails again immediately,
   we must not retry on the VERY NEXT tick — that would oscillate halted/running
   on every single tick. Track whether we've already tried a reopen after a heal,
   and if so, dampen subsequent retries. */
const REOPEN_FAILURE_DAMPEN_TICKS = 2;

/* The one place the persistent reasoning-overflow toast is built. */
const overflowToast = (message: string, fixes: AnalysisFailureFix[] | undefined) =>
  notificationsActions.pushToast({
    kind: 'error',
    message,
    fixes,
    dedupeKey: 'analysis-stream',
  });

export const analysisStreamMiddleware: Middleware = (store) => {
  let handle: OpenHandle | null = null;
  /* Track if we've already attempted a reopen after the current halt. The first
     attempt (after heal) is allowed to proceed. If that fails, we dampen subsequent
     attempts. */
  let attemptedReopenAfterCurrentHalt = false;
  let reopenFailureDampenCount = 0;

  const dispatch = store.dispatch as Dispatch;

  /* #3435 decision A — a subscribe POST refused (`main_analysis_running` /
     `subset_analysis_running`) says the local snapshot is stale: another run
     owns the book. Re-read the server's snapshot and restore it in the layout's
     cold-boot shape (layout.tsx), confirmed-book gate included, or clear it
     when the server has none. Never setPaused: its hook fires /pause, which
     would abort the live subset. */
  const restoreFromServer = async (snap: AnalysisStreamSnapshot): Promise<void> => {
    const bookId = snap.bookId;
    /* Staleness guard, the equivalent of the catch branches' `handle !==
       localHandle`: a snapshot dispatched while the re-read is in flight (a
       Retry's subset snapshot, say) is newer than the server's answer, so the
       server one must not overwrite it. */
    const current = () => (store.getState() as AnalysisRootState).analysis.activeStream;
    const atStart = current();
    try {
      const server = bookId ? await api.getAnalysisState(bookId) : null;
      if (current() !== atStart) return;
      if (!server) {
        dispatch(analysisActions.clearActiveStream());
        return;
      }
      if (server.state !== 'running') {
        const book = bookId ? await api.getBookState(bookId) : null;
        if (current() !== atStart) return;
        if (!shouldSurfaceColdBootAnalysisPill(book?.state.castConfirmed ?? false, server.state)) {
          dispatch(analysisActions.clearActiveStream());
          return;
        }
      }
      dispatch(
        analysisActions.setActiveStream({
          bookId,
          manuscriptId: server.manuscriptId,
          bookTitle: snap.bookTitle,
          engine: server.engine,
          phaseId: server.phaseId,
          phaseLabel: server.phaseLabel,
          phaseProgress: server.phaseProgress,
          remainingMs: null,
          lastTickAt: server.lastTickAt,
          state: server.state,
          haltCode: server.haltCode,
          haltReason: server.haltReason,
          kind: server.kind,
          subsetChapterIds: server.subsetChapterIds,
        }),
      );
    } catch (err) {
      console.warn('[analysis-state] refusal re-read failed:', (err as Error)?.message);
    }
  };

  const closeHandle = (): void => {
    if (!handle) return;
    handle.controller.abort();
    handle = null;
    /* Note: we DO NOT clear pendingReopenFailure here. The flag should survive
       the close and only be cleared when openHandle commits to a fresh open. */
  };

  const openHandle = (snap: AnalysisStreamSnapshot): void => {
    const desiredKind: 'main' | 'subset' = snap.kind === 'subset' ? 'subset' : 'main';
    if (handle && handle.manuscriptId === snap.manuscriptId && handle.kind === desiredKind) return;
    if (handle) closeHandle();

    /* Dampen retries after a failed reopen to prevent oscillation (#3172 finding 27).
       Allow the first reopen attempt after a halt to proceed (attemptedReopenAfterCurrentHalt
       is false). If it fails, subsequent attempts are damped. */
    if (attemptedReopenAfterCurrentHalt && reopenFailureDampenCount > 0) {
      reopenFailureDampenCount--;
      return;
    }
    /* Mark that we're attempting a reopen after the current halt. */
    attemptedReopenAfterCurrentHalt = true;

    const manuscriptId = snap.manuscriptId;
    const controller = new AbortController();
    const localHandle: OpenHandle = { manuscriptId, kind: desiredKind, controller };
    handle = localHandle;

    const callbacks = {
      signal: controller.signal,
      onPhase: ({
        phaseId,
        progress,
        model,
      }: {
        phaseId: number;
        progress: number;
        model?: string;
      }) => {
        dispatch(
          analysisActions.applyAnalysisSnapshotTick({
            manuscriptId,
            phaseId,
            phaseLabel: ANALYSIS_PHASES[phaseId]?.label ?? 'Analysing',
            phaseProgress: progress,
            lastTickAt: Date.now(),
            model,
          }),
        );
      },
      onEta: ({ remainingMs }: { remainingMs: number }) => {
        dispatch(
          analysisActions.applyAnalysisSnapshotTick({
            manuscriptId,
            remainingMs,
            lastTickAt: Date.now(),
          }),
        );
      },
      onSeriesPrior: ({ count, names }: { count: number; names: string[] }) => {
        dispatch(analysisActions.setSeriesPrior({ manuscriptId, count, names }));
      },
      /* Throttled (~1 / 2s) LLM heartbeat. The middleware consumes it
         solely to bump `activeStream.lastTickAt` so the global
         AnalysisPill's stall heuristic stays honest while the user is on
         a different view — without it, quiet phases (slow ML inference
         between onPhase / onEta ticks) age the snapshot past
         STALL_THRESHOLD_MS and trip 'stalled' even though the run is
         fine. Mirrors the generation-stream heartbeat fix in commit
         06444ee. Does NOT update the in-view heartbeat text — that's
         still rendered by the analysing view via its own onHeartbeat
         subscription on the streamAnalysis call. */
      onHeartbeat: () => {
        dispatch(
          analysisActions.bumpActiveStreamHeartbeat({
            manuscriptId,
            lastTickAt: Date.now(),
          }),
        );
      },
      /* #3084 — the non-story overflow advisory only. With the Analysing view
         unmounted this stream is the sole consumer, so without it the warning
         is dropped. Same toast + dedupeKey as the view's own onWarning, so a
         double delivery collapses to one. Every other warning code stays
         view-only. */
      onWarning: (w: { code: string; message: string }) => deliverNonStoryOverflowWarning(dispatch, w),
      /* Intentionally NOT consumed by the middleware (view-only):
         onLog, onCastUpdate, onChapterFailed, onChapterResolved,
         onThrottle. */
    };

    /* Subscribe-only POST: no model / fresh / allowStage1Shrink. The
       view's POST owns the start decision; this one is guaranteed to
       take the server dispatcher's subscribe path because we wait for
       the first tick (proof the view's POST landed) before firing.
       Subset branch passes chapterIds because the route requires a
       non-empty, valid array to pass its own validation. The route DOES
       compare them against the existing job's subsetChapterIds (#3202):
       this reattach passes the snapshot's own chapter ids, so it matches
       and joins as before; a request naming a different chapter set gets
       a terminal `subset_in_progress` error instead. */
    void (async () => {
      try {
        if (desiredKind === 'subset') {
          const chapterIds = snap.subsetChapterIds ?? [];
          await api.runAnalysisForChapters(manuscriptId, chapterIds, callbacks);
        } else {
          await api.analyseManuscript(manuscriptId, callbacks);
        }
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
        /* Every branch below that dispatches setPaused / setHalted closes
           this handle as a side effect: the PAUSE_TYPE / HALTED_TYPE hooks
           in the action handler at the bottom of this file call
           closeHandle() when the slice flips. Only the branches that
           dispatch neither (stream_no_result, and the #3435 refusal codes)
           have to close explicitly. */
        /* Task 9d (#2407) — streaming shape. An unset book language is not a
           generic stream failure: route it to the language-guard host instead of
           the error toast, and re-run this SAME openHandle call (which re-issues
           the subscribe POST) once the language is saved. A dismissed guard falls
           back to the ordinary AnalysisError halted+toast path below, so the pill
           never sits spinning on a modal the user closed. */
        /* Defensive — this branch is unreachable as shipped: the pre-filter in
           openHandle catches language_unset before the subscribe POST ever starts,
           so a 200 with a detached throw that carries this code cannot occur here.
           Kept as a defence-in-depth fallback in case the pre-filter is later
           relaxed or bypassed. */
        if (e instanceof AnalysisError && e.code === 'language_unset') {
          const fail = (): void => {
            dispatch(analysisActions.setHalted({ manuscriptId, code: e.code, message: e.message }));
            dispatch(
              notificationsActions.pushToast({
                kind: 'error',
                message: e.message,
                dedupeKey: 'analysis-stream',
              }),
            );
          };
          if (
            emitLanguageGuard({
              selector: { manuscriptId },
              shape: 'sse',
              sseSource: 'analysis',
              onRetry: () => { closeHandle(); openHandle(snap); },
              onDismiss: fail,
            })
          )
            return;
          fail();
          return;
        }
        if (e instanceof AnalysisError && e.code === 'aborted') {
          dispatch(analysisActions.setPaused({ manuscriptId }));
          return;
        }
        /* A clean 200 that ended without a `result` frame says nothing
           about the RUN — only that this socket closed. On the subset route
           it is a designed exit (analysis.ts ends the job with no final
           event when other chapters still need retry, and the view's own
           subset catch already treats it as "not a real failure"); on the
           main route every job exit broadcasts its final frame to every
           subscriber, so a result-less end can only be a per-connection
           close. Either way the view's primary SSE stays the authority:
           close our handle and let the next tick's first-tick-opens
           contract re-subscribe. Declaring halted here painted a live,
           progressing run as dead — and permanently, because ticks never
           rewrite `state` (#3198 pass 5). */
        if (e instanceof AnalysisError && e.code === ANALYSIS_STREAM_NO_RESULT) {
          closeHandle();
          return;
        }
        /* #3435 decision A — the server refused this subscribe because another
           run owns the book (a subset beside a would-be main start, or the
           reverse). Not a failure of any run: close, then restore the snapshot
           from the server, with no halt and no toast. */
        if (
          e instanceof AnalysisError &&
          (e.code === 'main_analysis_running' || e.code === 'subset_analysis_running')
        ) {
          closeHandle();
          void restoreFromServer(snap);
          return;
        }
        /* #3084 F7 — the persistent "reasoning overflow" notification is
           pushed from the store, not from the analysing view, so it does not
           depend on the view being mounted when the terminal frame arrives
           (this stream survives navigation; the view's own SSE aborts on
           unmount). It is pushed from TWO places via the same `overflowToast`
           builder: here, and in the HALTED_TYPE hook below — the view's catch
           can dispatch setHalted first, which closes this handle and turns
           this stream's own copy of the error into a swallowed AbortError.
           Both arms share `dedupeKey: 'analysis-stream'` — the same key the
           `language_unset` branch above and the transport-failure branch
           below use — so the slice's own dedupe-by-key merge REPLACES this
           run's plain toast rather than stacking a second one. Only the
           reasoning-overflow arm carries `fixes`; ToastStack routes a
           `t.fixes` toast to <ReasoningOverflowToast>. Every other code
           still pushes exactly one plain toast. */
        if (e instanceof AnalysisError) {
          dispatch(
            analysisActions.setHalted({
              manuscriptId,
              code: e.code,
              message: e.message,
              fixes: e.fixes,
            }),
          );
          /* #3435 — a subset run that ends in a not-a-failure code
             (`cast_incomplete`, `stage1_shrink_refused`) is a needs-action stop,
             not an error: the halted snapshot carries the server's message for
             the needs-action line and the pill, and no red toast is raised. */
          if (localHandle.kind === 'subset' && isNotAFailureHaltCode(e.code)) return;
          dispatch(
            e.code === 'analyzer-reasoning-overflow'
              ? overflowToast(e.message, e.fixes)
              : notificationsActions.pushToast({
                  kind: 'error',
                  message: e.message,
                  dedupeKey: 'analysis-stream',
                }),
          );
          return;
        }
        /* Anything else is a transport failure on this connection — a
           `fetch` rejection when the box goes offline, a JSON.parse throw
           on a truncated frame. Halt loudly: when the analysing view is
           unmounted this is the only connection there is, and a silent
           close would leave the pill reading an ambiguous `stalled` 30s
           later (pass 4, 🔴 10). If the view's own connection is in fact
           still healthy, its next tick contradicts the halt and the slice
           lifts it (applyAnalysisSnapshotTick heals ANALYSIS_STREAM_FAILED).
           If we've already attempted a reopen after the heal and it failed,
           dampen subsequent attempts (#3172 finding 27). */
        if (attemptedReopenAfterCurrentHalt) {
          reopenFailureDampenCount = REOPEN_FAILURE_DAMPEN_TICKS;
        }
        dispatch(
          analysisActions.setHalted({
            manuscriptId,
            code: ANALYSIS_STREAM_FAILED,
            message: (e as Error).message,
          }),
        );
        dispatch(
          notificationsActions.pushToast({
            kind: 'error',
            message: (e as Error).message,
            dedupeKey: 'analysis-stream',
          }),
        );
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
         handle — there's nothing more to tick for.

         #3084 F7 — if the halted payload carries an analyzer-reasoning-overflow
         code with fixes, push the persistent overflow toast here. This covers the
         race where the view's catch dispatches setHalted first, triggering this
         hook before the middleware's own copy of the error arrives (which would
         then surface as AbortError and be swallowed without pushing). The slice's
         dedupe-by-key will collapse a double push. */
      const halted = a.payload as ReturnType<typeof analysisActions.setHalted>['payload'] | undefined;
      if (a.type === HALTED_TYPE && halted?.code === 'analyzer-reasoning-overflow' && halted.fixes?.length) {
        dispatch(overflowToast(halted.message, halted.fixes));
      }

      closeHandle();
      /* Note: we do NOT reset attemptedReopenAfterCurrentHalt or reopenFailureDampenCount
         here. The damping state needs to survive the close so subsequent ticks within
         the damping window are skipped. It's only reset when a new analysis starts
         (setActiveStream with a different manuscript) or via explicit clearActiveStream. */
      if (a.type === CLEAR_TYPE) {
        /* Only reset for CLEAR, not for HALTED. HALTED just closes the handle,
           but the next heal might retry within the damping window. */
        attemptedReopenAfterCurrentHalt = false;
        reopenFailureDampenCount = 0;
      }
      return result;
    }

    if (a.type === SET_ACTIVE_TYPE) {
      /* Displacement on (manuscriptId, kind). A new setActiveStream
         for a different manuscriptId means an earlier run was replaced
         (e.g. user navigated to a new book and started fresh
         analysis there). A new setActiveStream for the same
         manuscriptId but a different kind means the run shifted shape
         (main → subset for a Retry, or subset → main when restoring
         after retry completes). Either way: close the stale handle;
         the new handle opens on its own first tick. */
      const state = store.getState() as AnalysisRootState;
      const snap = state.analysis.activeStream;
      if (handle && snap) {
        const newKind: 'main' | 'subset' = snap.kind === 'subset' ? 'subset' : 'main';
        if (handle.manuscriptId !== snap.manuscriptId || handle.kind !== newKind) {
          closeHandle();
          /* Reset tracking for the new manuscript — it's starting fresh. */
          attemptedReopenAfterCurrentHalt = false;
          reopenFailureDampenCount = 0;
        }
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
        openHandle(snap);
      }
      return result;
    }

    return result;
  };
};
