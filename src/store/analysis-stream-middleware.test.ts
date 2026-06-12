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

const pauseAnalysisSpy = vi.fn().mockResolvedValue(undefined);
const analyseManuscriptMock = vi.fn();
const runAnalysisForChaptersMock = vi.fn();

vi.mock('../lib/api', () => {
  /* Re-derive AnalysisError inside the factory so `e instanceof AnalysisError`
     in the middleware lines up with what tests throw. Vitest hoists vi.mock
     to the top of the file, so the class must be defined here (referencing
     a top-level class would hit a TDZ error). Shape mirrors
     src/lib/api.ts:664-680. */
  class AnalysisError extends Error {
    code: string;
    detail?: string;
    prevCharCount?: number;
    nextCharCount?: number;
    constructor(message: string, code: string, detail?: string, prev?: number, next?: number) {
      super(message);
      this.name = 'AnalysisError';
      this.code = code;
      this.detail = detail;
      this.prevCharCount = prev;
      this.nextCharCount = next;
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
    reducer: { analysis: analysisSlice.reducer },
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
