/* Pairs with docs/features/32-sticky-analysis.md.

   Middleware bridges the slice's setPaused action to the server-side
   /analysis/pause endpoint via api.pauseAnalysis. The view's existing
   imperative abort tears down the per-tab fetch consumer; this
   middleware tears down the server-side analyzer loop. The two paths
   are independent and the contract is "setPaused fires the API call."

   Mocks api.pauseAnalysis so we can assert it's called with the right
   manuscriptId and only on the right action types. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { analysisSlice, analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';

const pauseAnalysisSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../lib/api', () => ({
  api: {
    pauseAnalysis: (args: { manuscriptId: string }) => pauseAnalysisSpy(args),
  },
}));

import { analysisStreamMiddleware } from './analysis-stream-middleware';

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
    middleware: getDefault => getDefault().concat(analysisStreamMiddleware),
  });
}

beforeEach(() => {
  pauseAnalysisSpy.mockClear();
});

describe('analysisStreamMiddleware — bridges setPaused to api.pauseAnalysis', () => {
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
    store.dispatch(analysisActions.applyAnalysisSnapshotTick({
      manuscriptId: 'm1', phaseId: 1, phaseProgress: 0.5,
    }));
    store.dispatch(analysisActions.setHalted({ manuscriptId: 'm1', code: 'unknown', message: 'x' }));
    store.dispatch(analysisActions.clearActiveStream());
    expect(pauseAnalysisSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire when setPaused payload is missing a manuscriptId (defense vs malformed dispatch)', () => {
    const store = buildStore();
    /* Bypass the typed creator to simulate a malformed dispatch — the
       middleware must guard against this rather than throw / call the
       endpoint with undefined. */
    store.dispatch({ type: analysisActions.setPaused.type, payload: {} });
    expect(pauseAnalysisSpy).not.toHaveBeenCalled();
  });

  it('passes through to subsequent middleware / reducers — setPaused still updates the slice state', () => {
    /* Regression for "middleware short-circuits and the reducer never
       runs": the middleware must call next(action) FIRST, then react. */
    const store = buildStore();
    store.dispatch(analysisActions.setActiveStream(baseSnapshot));
    store.dispatch(analysisActions.setPaused({ manuscriptId: 'm1' }));
    expect(store.getState().analysis.activeStream?.state).toBe('paused');
  });
});
