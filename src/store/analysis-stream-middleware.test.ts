/* Pairs with docs/features/archive/32-sticky-analysis.md.

   Pre-D1 this file pinned only the pause-bridge: setPaused →
   api.pauseAnalysis. D1 grew the middleware into a full reconcile
   loop with openHandle / closeHandle, so this test file pins both
   limbs:

   1. Pause-bridge: setPaused fires api.pauseAnalysis AND closes the
      local handle (the second part is new — the middleware now owns
      its own SSE that needs tearing down on pause).

   2. First-tick opens the handle: the middleware does NOT fire its
      SSE on setActiveStream (that would race the view's start-decision
      POST). Instead, the first applyAnalysisSnapshotTick — proof the
      view's POST landed and the server-side job is alive — opens the
      subscribe-only SSE.

   3. Terminal events close the handle: clearActiveStream (result),
      setHalted (any halted code), setPaused (already covered).

   4. Cross-manuscript displacement: a setActiveStream for a different
      manuscriptId aborts the old handle; the new one opens on its own
      first tick. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { analysisSlice, analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
import { notificationsSlice } from './notifications-slice';

const pauseAnalysisSpy = vi.fn().mockResolvedValue(undefined);
const analyseManuscriptMock = vi.fn();
const runAnalysisForChaptersMock = vi.fn();

vi.mock('../lib/api', () => {
  /* Re-derive AnalysisError inside the factory so `e instanceof AnalysisError`
     in the middleware lines up with what tests throw. Vitest hoists vi.mock
     to the top of the file, so the class must be defined here (referencing
     a top-level class would hit a TDZ error). Shape mirrors the
     `AnalysisError` class in src/lib/api.ts — same positional constructor
     (message, code, detail?, prevCharCount?, nextCharCount?, remediation?). */
  class AnalysisError extends Error {
    code: string;
    detail?: string;
    prevCharCount?: number;
    nextCharCount?: number;
    remediation?: string;
    constructor(
      message: string,
      code: string,
      detail?: string,
      prev?: number,
      next?: number,
      remediation?: string,
    ) {
      super(message);
      this.name = 'AnalysisError';
      this.code = code;
      this.detail = detail;
      this.prevCharCount = prev;
      this.nextCharCount = next;
      this.remediation = remediation;
    }
  }
  return {
    api: {
      pauseAnalysis: (args: { manuscriptId: string }) => pauseAnalysisSpy(args),
      analyseManuscript: (manuscriptId: string, opts: unknown) =>
        analyseManuscriptMock(manuscriptId, opts),
      runAnalysisForChapters: (manuscriptId: string, chapterIds: number[], opts: unknown) =>
        runAnalysisForChaptersMock(manuscriptId, chapterIds, opts),
    },
    AnalysisError,
  };
});

import { analysisStreamMiddleware } from './analysis-stream-middleware';
import { AnalysisError } from '../lib/api';
import { ANALYSIS_STREAM_FAILED, ANALYSIS_STREAM_NO_RESULT } from '../lib/analysis-stream-codes';

interface CapturedAnalysisCall {
  manuscriptId: string;
  kind: 'main' | 'subset';
  chapterIds?: number[];
  signal: AbortSignal;
  onPhase?: (e: { phaseId: number; progress: number }) => void;
  onEta?: (e: { remainingMs: number }) => void;
  onSeriesPrior?: (e: { count: number; names: string[] }) => void;
  onHeartbeat?: (e: unknown) => void;
  resolve: () => void;
  reject: (e: unknown) => void;
}

let captured: CapturedAnalysisCall[] = [];

function lastCall(): CapturedAnalysisCall {
  const c = captured[captured.length - 1];
  if (!c) throw new Error('expected at least one api.analyseManuscript call');
  return c;
}

const baseSnapshot: AnalysisStreamSnapshot = {
  bookId: 'b1',
  manuscriptId: 'm1',
  phaseId: 0,
  phaseLabel: 'Detecting characters',
  phaseProgress: 0,
  remainingMs: null,
  lastTickAt: 1,
  state: 'running',
};

function buildStore() {
  return configureStore({
    reducer: { analysis: analysisSlice.reducer, notifications: notificationsSlice.reducer },
    middleware: (getDefault) => getDefault().concat(analysisStreamMiddleware),
  });
}

beforeEach(() => {
  pauseAnalysisSpy.mockClear();
  analyseManuscriptMock.mockReset();
  runAnalysisForChaptersMock.mockReset();
  captured = [];
  const makeImpl =
    (kindMarker: 'main' | 'subset') =>
    (
      manuscriptId: string,
      chapterIdsOrOpts: number[] | { signal: AbortSignal },
      maybeOpts?: {
        signal: AbortSignal;
        onPhase?: (e: { phaseId: number; progress: number }) => void;
        onEta?: (e: { remainingMs: number }) => void;
        onSeriesPrior?: (e: { count: number; names: string[] }) => void;
        onHeartbeat?: (e: unknown) => void;
      },
    ) => {
      const opts = (kindMarker === 'subset' ? maybeOpts : chapterIdsOrOpts) as {
        signal: AbortSignal;
        onPhase?: (e: { phaseId: number; progress: number }) => void;
        onEta?: (e: { remainingMs: number }) => void;
        onSeriesPrior?: (e: { count: number; names: string[] }) => void;
        onHeartbeat?: (e: unknown) => void;
      };
      const chapterIds = kindMarker === 'subset' ? (chapterIdsOrOpts as number[]) : undefined;
      return new Promise<void>((resolve, reject) => {
        const entry: CapturedAnalysisCall = {
          manuscriptId,
          kind: kindMarker,
          chapterIds,
          signal: opts.signal,
          onPhase: opts.onPhase,
          onEta: opts.onEta,
          onSeriesPrior: opts.onSeriesPrior,
          onHeartbeat: opts.onHeartbeat,
          resolve: () => resolve(),
          reject: (e: unknown) => reject(e),
        };
        captured.push(entry);
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
  analyseManuscriptMock.mockImplementation(makeImpl('main'));
  runAnalysisForChaptersMock.mockImplementation(makeImpl('subset'));
});

describe('analysisStreamMiddleware — pause-bridge (pre-D1 contract, still pinned)', () => {
  it('fires api.pauseAnalysis when the slice flips to paused', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(analysisActions.setPaused({ manuscriptId: 'm1' }));
    expect(pauseAnalysisSpy).toHaveBeenCalledTimes(1);
    expect(pauseAnalysisSpy).toHaveBeenCalledWith({ manuscriptId: 'm1' });
  });

  it('does NOT fire api.pauseAnalysis for non-pause actions', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 1,
        phaseProgress: 0.5,
      }),
    );
    store.dispatch(
      analysisActions.setHalted({ manuscriptId: 'm1', code: 'unknown', message: 'x' }),
    );
    store.dispatch(analysisActions.clearActiveStream());
    expect(pauseAnalysisSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire when setPaused payload is missing a manuscriptId (defense vs malformed dispatch)', () => {
    const store = buildStore();
    store.dispatch({ type: analysisActions.setPaused.type, payload: {} });
    expect(pauseAnalysisSpy).not.toHaveBeenCalled();
  });

  it('passes through to subsequent middleware / reducers — setPaused still updates the slice state', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(analysisActions.setPaused({ manuscriptId: 'm1' }));
    expect(store.getState().analysis.activeStream?.state).toBe('paused');
  });
});

describe('analysisStreamMiddleware — middleware-owned SSE (D1)', () => {
  it('does NOT open the handle on setActiveStream alone (waits for first tick)', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    expect(analyseManuscriptMock).not.toHaveBeenCalled();
  });

  it('opens the handle on the first applyAnalysisSnapshotTick', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(analyseManuscriptMock).toHaveBeenCalledTimes(1);
    const args = analyseManuscriptMock.mock.calls[0];
    expect(args[0]).toBe('m1');
    const opts = args[1] as {
      signal: AbortSignal;
      model?: string;
      fresh?: boolean;
      allowStage1Shrink?: boolean;
    };
    /* Subscribe-only: middleware MUST NOT pass start-decision opts.
       The view's POST owns those. */
    expect(opts.model).toBeUndefined();
    expect(opts.fresh).toBeUndefined();
    expect(opts.allowStage1Shrink).toBeUndefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('does NOT re-open the handle on subsequent ticks for the same manuscriptId', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.2,
      }),
    );
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 1,
        phaseProgress: 0.0,
      }),
    );
    expect(analyseManuscriptMock).toHaveBeenCalledTimes(1);
  });

  it('stays open across slice-irrelevant actions (no close on noise)', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(captured).toHaveLength(1);
    /* Dispatch a series of additional ticks (simulating live SSE events
       from the view's path); the handle should not be torn down. */
    for (let i = 0; i < 5; i++) {
      store.dispatch(
        analysisActions.applyAnalysisSnapshotTick({
          manuscriptId: 'm1',
          phaseId: 0,
          phaseProgress: 0.1 + i * 0.1,
          lastTickAt: 1000 + i,
        }),
      );
    }
    expect(captured[0]?.signal.aborted).toBe(false);
  });

  it('closes the handle on setPaused (aborts the SSE in addition to the pause API call)', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(captured[0]?.signal.aborted).toBe(false);
    store.dispatch(analysisActions.setPaused({ manuscriptId: 'm1' }));
    expect(captured[0]?.signal.aborted).toBe(true);
    expect(pauseAnalysisSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the handle on clearActiveStream (terminal success)', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    store.dispatch(analysisActions.clearActiveStream());
    expect(captured[0]?.signal.aborted).toBe(true);
  });

  it('closes the handle on setHalted (any halted code)', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    store.dispatch(
      analysisActions.setHalted({
        manuscriptId: 'm1',
        code: 'attribution_drift',
        message: 'x',
      }),
    );
    expect(captured[0]?.signal.aborted).toBe(true);
  });

  it('dispatches phase ticks from the SSE onPhase callback', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    lastCall().onPhase?.({ phaseId: 1, progress: 0.42 });
    const snap = store.getState().analysis.activeStream;
    expect(snap?.phaseId).toBe(1);
    expect(snap?.phaseProgress).toBeCloseTo(0.42);
    /* phaseLabel comes from ANALYSIS_PHASES (id 1 = "Parsing and attribution"). */
    expect(snap?.phaseLabel).toBe('Parsing and attribution');
  });

  it('dispatches ETA ticks from the SSE onEta callback', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    lastCall().onEta?.({ remainingMs: 12345 });
    expect(store.getState().analysis.activeStream?.remainingMs).toBe(12345);
  });

  it('dispatches setSeriesPrior from the SSE onSeriesPrior callback', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    lastCall().onSeriesPrior?.({ count: 3, names: ['Wren', 'Marlow', 'Maerin'] });
    const snap = store.getState().analysis.activeStream;
    expect(snap?.seriesPrior).toEqual({ count: 3, names: ['Wren', 'Marlow', 'Maerin'] });
  });

  it('clears the snapshot when the SSE resolves cleanly (terminal result)', async () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    lastCall().resolve();
    /* Let the catch/then chain settle. */
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().analysis.activeStream).toBeNull();
  });

  it('flips state to paused when the SSE rejects with AnalysisError code=aborted', async () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    lastCall().reject(new AnalysisError('paused', 'aborted'));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().analysis.activeStream?.state).toBe('paused');
    /* The setPaused dispatch closes the handle via the PAUSE_TYPE hook —
       the catch branch has no explicit closeHandle() of its own. */
    expect(captured[0]?.signal.aborted).toBe(true);
  });

  it('flips state to halted when the SSE rejects with AnalysisError code=attribution_drift', async () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    lastCall().reject(new AnalysisError('drift', 'attribution_drift'));
    await Promise.resolve();
    await Promise.resolve();
    const snap = store.getState().analysis.activeStream;
    expect(snap?.state).toBe('halted');
    expect(snap?.haltCode).toBe('attribution_drift');
    /* The setHalted dispatch closes the handle via the HALTED_TYPE hook. */
    expect(captured[0]?.signal.aborted).toBe(true);
  });

  it('does NOT poison the snapshot when an AbortError surfaces from the SSE (clean cancel)', async () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    /* setPaused aborts the SSE — the rejection lands as an AbortError
       (the fetch consumer surfaces it that way). The middleware must
       swallow it; setPaused already updated state to 'paused' via
       next(action) before the abort fired, and any subsequent
       dispatch in the catch would clobber the paused state. */
    store.dispatch(analysisActions.setPaused({ manuscriptId: 'm1' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().analysis.activeStream?.state).toBe('paused');
  });

  describe('connection-level failures on the middleware\'s own SSE (#3198)', () => {
    /* The middleware's subscribe stream is a SECOND connection alongside
       the view's. What its failure means depends on the code api.ts
       attached (src/lib/analysis-stream-codes.ts):

       - `stream_no_result` — a clean 200 that ended with no `result`
         frame. Says nothing about the run (the subset route ends this way
         by design; the main route broadcasts every final frame to every
         subscriber), so it must be a QUIET close: no halt, no toast, and
         the next tick re-subscribes. Round 5 stamped a fabricated 500 on
         this case and halted — permanently, since ticks never rewrote
         `state` — painting a live run as dead (pass 5, 🔴 17).
       - `stream_failed` (non-2xx on the subscribe POST) and any plain
         Error (fetch rejection, truncated frame) — terminal for THIS
         connection: halt + toast, because when the view is unmounted this
         is the only connection there is (pass 4, 🔴 10). If the view's
         connection is in fact alive, its next tick lifts the halt (slice
         heal, tested below).

       Each test names the mutation that reddens it; a test that stays
       green under its own mutation is the defect this file has shipped
       before (pass 5, 🟠 19). */

    async function openAndReject(
      kind: 'main' | 'subset',
      err: unknown,
    ): Promise<{ store: ReturnType<typeof buildStore>; first: CapturedAnalysisCall }> {
      const store = buildStore();
      store.dispatch(
        analysisActions.setActiveStream(
          kind === 'subset' ? { ...baseSnapshot, kind: 'subset', subsetChapterIds: [4] } : baseSnapshot,
        ),
      );
      store.dispatch(
        analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm1', phaseId: 0, phaseProgress: 0.1 }),
      );
      const first = captured[0]!;
      first.reject(err);
      await Promise.resolve();
      await Promise.resolve();
      return { store, first };
    }

    it.each(['main', 'subset'] as const)(
      '%s route: a clean end without a result (stream_no_result) is a quiet close — no halt, no toast, re-subscribes on the next tick',
      async (kind) => {
        /* Mutation: delete the `ANALYSIS_STREAM_NO_RESULT` branch in the
           middleware's catch → falls into the generic AnalysisError branch →
           `state` reads 'halted' and a toast lands → red. */
        const { store, first } = await openAndReject(
          kind,
          new AnalysisError('Analysis stream ended without a result event.', ANALYSIS_STREAM_NO_RESULT),
        );
        expect(first.signal.aborted).toBe(true);
        const snap = store.getState().analysis.activeStream;
        expect(snap?.state).toBe('running');
        expect(snap?.haltCode).toBeUndefined();
        expect(store.getState().notifications.toasts).toHaveLength(0);
        /* Reconnect path intact: the next tick re-opens because the handle
           was closed (pass 3, 🟠 3 — a silent branch that forgets
           closeHandle() never re-subscribes again). */
        store.dispatch(
          analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm1', phaseId: 0, phaseProgress: 0.2 }),
        );
        expect(captured).toHaveLength(2);
        expect(captured[1]?.kind).toBe(kind);
      },
    );

    it('a non-2xx subscribe POST (stream_failed) is terminal: halted with the real reason + one toast', async () => {
      /* Mutation: widen the quiet-close branch to `e.code === ANALYSIS_STREAM_FAILED`
         as well → state stays 'running', no toast → red. This is the
         classification boundary: a clean no-result end is quiet, a refused
         POST is not. */
      const { store, first } = await openAndReject(
        'main',
        new AnalysisError('Analysis stream failed (500).', ANALYSIS_STREAM_FAILED),
      );
      expect(first.signal.aborted).toBe(true);
      const snap = store.getState().analysis.activeStream;
      expect(snap?.state).toBe('halted');
      expect(snap?.haltCode).toBe(ANALYSIS_STREAM_FAILED);
      expect(snap?.haltReason).toBe('Analysis stream failed (500).');
      expect(store.getState().notifications.toasts).toHaveLength(1);
    });

    it('a plain Error (fetch rejection / truncated frame) is terminal: halted as stream_failed + one toast, handle closed', async () => {
      /* Mutation: delete the plain-Error fallthrough at the end of the
         middleware's catch (restore a bare `closeHandle()`) → `state` stays
         'running', `haltCode` undefined, 0 toasts → red. This is the branch
         pass 5 measured as uncovered (🟠 19 item 2), and the behaviour
         pass 4 found silenced (🔴 10). */
      const { store, first } = await openAndReject('main', new TypeError('Failed to fetch'));
      expect(first.signal.aborted).toBe(true);
      const snap = store.getState().analysis.activeStream;
      expect(snap?.state).toBe('halted');
      expect(snap?.haltCode).toBe(ANALYSIS_STREAM_FAILED);
      expect(snap?.haltReason).toBe('Failed to fetch');
      const toasts = store.getState().notifications.toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toMatchObject({ kind: 'error', message: 'Failed to fetch' });
    });

    it('a live tick after a connection-level halt lifts it and re-subscribes (the halt is not permanent)', async () => {
      /* PROBE_K from pass 5, as a test: fail the middleware's socket, then
         deliver the ticks the view's own healthy SSE would. The run is
         provably alive, so the snapshot must read 'running' again — with the
         stale haltReason gone — and the middleware must have re-opened.
         Mutation: delete the `ANALYSIS_STREAM_FAILED` heal in
         applyAnalysisSnapshotTick → `state` stays 'halted' after four
         advancing ticks → red. */
      const { store } = await openAndReject('main', new TypeError('Failed to fetch'));
      expect(store.getState().analysis.activeStream?.state).toBe('halted');
      for (let i = 1; i <= 4; i++) {
        store.dispatch(
          analysisActions.applyAnalysisSnapshotTick({
            manuscriptId: 'm1',
            phaseId: 1,
            phaseProgress: i * 0.2,
            lastTickAt: 1000 + i,
          }),
        );
      }
      const snap = store.getState().analysis.activeStream;
      expect(snap?.state).toBe('running');
      expect(snap?.haltCode).toBeUndefined();
      expect(snap?.haltReason).toBeUndefined();
      expect(snap?.phaseId).toBe(1);
      expect(snap?.phaseProgress).toBeCloseTo(0.8);
      /* Re-subscribed on the first of those ticks (handle was closed by the
         HALTED_TYPE hook), and only once. */
      expect(captured).toHaveLength(2);
    });

    it('a tick does NOT lift an analyzer-level halt (attribution_drift is a verdict on the run, not on a socket)', async () => {
      /* Control for the heal above: only ANALYSIS_STREAM_FAILED is lifted.
         Mutation: drop the `haltCode === ANALYSIS_STREAM_FAILED` term from the
         heal → this reads 'running' → red. */
      const { store } = await openAndReject('main', new AnalysisError('drift', 'attribution_drift'));
      store.dispatch(
        analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm1', phaseId: 1, phaseProgress: 0.5 }),
      );
      const snap = store.getState().analysis.activeStream;
      expect(snap?.state).toBe('halted');
      expect(snap?.haltCode).toBe('attribution_drift');
    });

    it('does NOT oscillate halted→running→halted on every tick under persistent failure (#3172 finding 27)', async () => {
      /* PROBE_M from pass 6: persistent middleware-side failure (the socket keeps
         failing on every reconnect attempt) paired with a healthy view socket
         that keeps ticking should NOT flip the card halted/streaming on every
         single tick. Without damping, the cycle is:
         1. first tick: open fails, dispatch halt
         2. second tick: heal lifts halt, re-open fails, dispatch halt
         3. third tick: heal lifts halt, re-open fails, dispatch halt
         ...repeat forever, yielding 6 complete cycles + 7 POSTs in just 6 ticks.
         With damping, the second failure should NOT immediately re-open on the
         next tick, so the halt survives briefly and the oscillation stops. */
      vi.useFakeTimers();
      try {
        const store = buildStore();
        store.dispatch(analysisActions.setActiveStream(baseSnapshot));
        store.dispatch(
          analysisActions.applyAnalysisSnapshotTick({
            manuscriptId: 'm1',
            phaseId: 0,
            phaseProgress: 0.1,
          }),
        );
        expect(captured).toHaveLength(1);
        /* First open fails immediately. */
        lastCall().reject(new TypeError('Failed to fetch'));
        await Promise.resolve();
        await Promise.resolve();
        expect(store.getState().analysis.activeStream?.state).toBe('halted');
        expect(captured).toHaveLength(1); // only the failed open

        /* First tick AFTER the heal — middleware should NOT immediately re-open
           on the very next tick if the reopen fails again within a short window.
           With damping, we expect at most one re-open attempt on the first
           healing tick, then the damping window prevents further retries on
           subsequent ticks. */
        for (let i = 0; i < 6; i++) {
          const prevCapturedCount = captured.length;
          store.dispatch(
            analysisActions.applyAnalysisSnapshotTick({
              manuscriptId: 'm1',
              phaseId: 0,
              phaseProgress: 0.1 + i * 0.05,
              lastTickAt: 1000 + i,
            }),
          );
          const healedState = store.getState().analysis.activeStream;
          expect(healedState?.state, `tick ${i}: state should be healed`).toBe('running');

          if (captured.length > prevCapturedCount) {
            /* If there was a new open attempt, it will fail; reject it. */
            const lastCall = captured[captured.length - 1]!;
            lastCall.reject(new TypeError('Failed to fetch'));
            await Promise.resolve();
            await Promise.resolve();
          }
          /* Don't advance time — stay within the damping window. This simulates
             rapid ticks within the damping period. Without damping, the middleware
             would try to reopen on every single tick (7 total: 1 initial + 6).
             With damping, it should try again only on the first healing tick (so
             2 total: 1 initial + 1 after heal), then skip subsequent ticks. */
        }

        /* Without damping, we'd see 6 more POST attempts (one per tick) for 7 total.
           With damping set to skip 2 ticks after failure, we skip ticks 1-2, then try again
           on tick 3, which fails and resets the damping. So we expect: 1 initial + 1 after
           first heal + 1 more after damping expires = 3 total. The key is that we're NOT
           oscillating on every tick (7 total). */
        expect(captured.length, `Should significantly dampen oscillation; without damping would see 7 attempts`).toBeLessThan(6);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('handles cross-manuscript displacement (close old handle, open new on first tick)', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(captured).toHaveLength(1);
    const firstSignal = captured[0]?.signal;

    /* New analysis on a different manuscript. setActiveStream lands;
       middleware closes the old handle. New handle opens on its own
       first tick. */
    store.dispatch(
      analysisActions.setActiveStream({ ...baseSnapshot, manuscriptId: 'm2', bookId: 'b2' }),
    );
    expect(firstSignal?.aborted).toBe(true);
    expect(captured).toHaveLength(1); // no new SSE yet

    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm2',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(captured).toHaveLength(2);
    expect(captured[1]?.manuscriptId).toBe('m2');
  });

  it('does NOT clear the snapshot when a displaced handle resolves late', async () => {
    /* Regression: when the old run's SSE eventually resolves AFTER
       the slice has already moved on to a new manuscript, the late
       clearActiveStream dispatch must not poison the new snapshot.
       Same shape as the abort displacement above but for clean
       resolution. */
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    const firstCall = lastCall();
    /* Displace: new manuscript snapshot. Middleware aborts the old
       SSE — the AbortError catches in the IIFE swallow it. */
    store.dispatch(
      analysisActions.setActiveStream({ ...baseSnapshot, manuscriptId: 'm2', bookId: 'b2' }),
    );
    /* Resolve the OLD call cleanly (simulating a race where the server
       sent `result` just before our abort landed). The middleware
       must notice it's been displaced and NOT clear the m2 snapshot. */
    firstCall.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const snap = store.getState().analysis.activeStream;
    expect(snap?.manuscriptId).toBe('m2');
  });
});

describe('analysisStreamMiddleware — subset-retry route (plan 32 follow-up)', () => {
  /* The main route's sticky behaviour landed in D1; subset retries
     followed the same in-flight-map shape on the server but the
     middleware only knew the main route. Result: a navigation away
     mid-subset-retry would have the middleware's subscribe POST land
     on the main route's dispatcher and either join the wrong job or
     start a fresh main run. These specs pin the corrected behaviour:
     when the snapshot carries kind === 'subset', the middleware
     subscribes via api.runAnalysisForChapters with the snapshot's
     chapterIds — landing on the subset dispatcher which joins the
     existing subset job. */

  const subsetSnapshot: AnalysisStreamSnapshot = {
    ...baseSnapshot,
    kind: 'subset',
    subsetChapterIds: [4, 7],
  };

  it('routes the subscribe POST to runAnalysisForChapters when kind === subset', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(subsetSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(runAnalysisForChaptersMock).toHaveBeenCalledTimes(1);
    expect(analyseManuscriptMock).not.toHaveBeenCalled();
    const args = runAnalysisForChaptersMock.mock.calls[0];
    expect(args[0]).toBe('m1');
    expect(args[1]).toEqual([4, 7]);
    const opts = args[2] as { signal: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('stays on the main route when kind is undefined (legacy snapshot)', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(analyseManuscriptMock).toHaveBeenCalledTimes(1);
    expect(runAnalysisForChaptersMock).not.toHaveBeenCalled();
  });

  it('dispatches phase ticks from the subset SSE onPhase callback', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(subsetSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    lastCall().onPhase?.({ phaseId: 1, progress: 0.42 });
    const snap = store.getState().analysis.activeStream;
    expect(snap?.phaseId).toBe(1);
    expect(snap?.phaseProgress).toBeCloseTo(0.42);
  });

  it('closes the subset handle on setPaused', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(subsetSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(captured[0]?.signal.aborted).toBe(false);
    store.dispatch(analysisActions.setPaused({ manuscriptId: 'm1' }));
    expect(captured[0]?.signal.aborted).toBe(true);
  });

  it('re-opens the handle when kind flips on the same manuscriptId', () => {
    /* Real-world flow: main run is alive, user clicks Retry on a
       failed chapter; the view dispatches setActiveStream with
       kind=subset on the SAME manuscriptId. The middleware must
       treat this as displacement (close the main handle, open a
       subset one on the next tick) rather than no-op. */
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(analyseManuscriptMock).toHaveBeenCalledTimes(1);
    const mainSignal = captured[0]?.signal;

    /* Shift to subset on the same manuscriptId. The SET_ACTIVE_TYPE
       handler must close the main handle; the new subset handle
       opens on its own first tick. */
    store.dispatch(analysisActions.setActiveStream(subsetSnapshot));
    expect(mainSignal?.aborted).toBe(true);
    expect(captured).toHaveLength(1);

    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(runAnalysisForChaptersMock).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(2);
    expect(captured[1]?.kind).toBe('subset');
    expect(captured[1]?.chapterIds).toEqual([4, 7]);
  });

  it('passes an empty chapterIds array through when the snapshot omits subsetChapterIds', () => {
    /* Defensive: a snapshot tagged kind=subset but missing chapterIds
       (malformed dispatch or cold-boot rehydration where the field
       was absent on disk). The middleware should pass [] through
       rather than throwing or accidentally calling the main route —
       the server will 400 the request and the middleware's error
       handler will surface the error via setHalted. */
    const store = buildStore();
    store.dispatch(
      analysisActions.setActiveStream({
        ...subsetSnapshot,
        subsetChapterIds: undefined,
      }),
    );
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(runAnalysisForChaptersMock).toHaveBeenCalledTimes(1);
    expect(runAnalysisForChaptersMock.mock.calls[0][1]).toEqual([]);
  });
});

describe('analysisStreamMiddleware — heartbeat keeps cross-view snapshot fresh (bug 6 analysis mirror)', () => {
  /* Mirror of the chapters-slice cross-book heartbeat shipped in commit
     06444ee. During quiet phases (slow ML inference between onPhase /
     onEta events) the analysis SSE only emits throttled onHeartbeat
     ticks. Pre-fix, those heartbeats were view-only — when the user
     navigated away from the analysing view the snapshot's lastTickAt
     froze and the global AnalysisPill flipped to "stalled" even though
     the run was fine. The middleware now consumes onHeartbeat and
     dispatches bumpActiveStreamHeartbeat to keep the cross-view stall
     heuristic honest. */
  it('subscribes to onHeartbeat on the analysis SSE call', () => {
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
      }),
    );
    expect(captured[0]?.onHeartbeat).toBeInstanceOf(Function);
  });

  it('a fired heartbeat refreshes activeStream.lastTickAt', () => {
    const store = buildStore();
    /* Snapshot starts at lastTickAt: 1 (per baseSnapshot fixture). */
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 0,
        phaseProgress: 0.1,
        /* This tick itself bumps lastTickAt — but only because it carries
           lastTickAt in its payload via the middleware's onPhase wiring.
           Heartbeats arrive *between* phase ticks, when the snapshot
           would otherwise age past STALL_THRESHOLD_MS. */
      }),
    );
    /* Move the wall clock forward and fire a heartbeat. */
    const before = store.getState().analysis.activeStream?.lastTickAt ?? 0;
    const fixedNow = before + 10_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      captured[0]?.onHeartbeat?.({ phaseId: 0, sample: 'chunk' });
    } finally {
      vi.restoreAllMocks();
    }
    expect(store.getState().analysis.activeStream?.lastTickAt).toBe(fixedNow);
  });

  it('heartbeat for a different manuscriptId is dropped by the cross-book guard', () => {
    /* Defensive — should never happen in practice (handle owns the
       manuscriptId), but pinning the slice-level guard so a future
       refactor that loosens the middleware doesn't silently let
       cross-tab heartbeats clobber the wrong snapshot. */
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    const initialLastTick = store.getState().analysis.activeStream?.lastTickAt;
    /* Dispatch a heartbeat directly through the slice action with a
       mismatched manuscriptId — confirms the slice's own guard fires. */
    store.dispatch(
      analysisActions.bumpActiveStreamHeartbeat({
        manuscriptId: 'm_OTHER',
        lastTickAt: 999_999,
      }),
    );
    expect(store.getState().analysis.activeStream?.lastTickAt).toBe(initialLastTick);
  });
});
