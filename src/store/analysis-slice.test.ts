/* Pairs with docs/features/32-sticky-analysis.md.

   The analysis slice is intentionally narrow: an out-of-band snapshot for
   the (future B3) AnalysisPill, plus a paused/halted flag that the
   analysis-stream middleware (this file's sibling) translates into a
   server-side /analysis/pause POST. Tests cover the reducer surface,
   cross-book guard, and idempotency of the terminal transitions. */

import { describe, it, expect } from 'vitest';
import { analysisSlice, analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';

const baseSnapshot: AnalysisStreamSnapshot = {
  bookId: 'b1',
  manuscriptId: 'm1',
  bookTitle: 'the Coalfall Commission',
  phaseId: 0,
  phaseLabel: 'Detecting characters',
  phaseProgress: 0,
  remainingMs: null,
  lastTickAt: 1000,
  state: 'running',
};

describe('analysisSlice — activeStream snapshot reducers', () => {
  it('starts with activeStream: null', () => {
    const state = analysisSlice.reducer(undefined, { type: 'noop' });
    expect(state.activeStream).toBeNull();
  });

  it('setActiveStream sets the snapshot verbatim', () => {
    const state = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    expect(state.activeStream).toEqual(baseSnapshot);
  });

  it('clearActiveStream tears down the snapshot', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(s1, analysisActions.clearActiveStream());
    expect(s2.activeStream).toBeNull();
  });

  it('applyAnalysisSnapshotTick updates phase + progress + lastTickAt', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(s1, analysisActions.applyAnalysisSnapshotTick({
      manuscriptId: 'm1',
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.42,
      lastTickAt: 2500,
    }));
    expect(s2.activeStream).toMatchObject({
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.42,
      lastTickAt: 2500,
    });
    /* Unchanged fields preserved. */
    expect(s2.activeStream?.bookId).toBe('b1');
    expect(s2.activeStream?.state).toBe('running');
  });

  it('applyAnalysisSnapshotTick only updates fields supplied — undefined leaves prior values intact', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream({
      ...baseSnapshot, phaseId: 1, phaseProgress: 0.5, remainingMs: 30_000,
    }));
    /* eta-only tick. */
    const s2 = analysisSlice.reducer(s1, analysisActions.applyAnalysisSnapshotTick({
      manuscriptId: 'm1',
      remainingMs: 12_000,
      lastTickAt: 3000,
    }));
    expect(s2.activeStream?.remainingMs).toBe(12_000);
    expect(s2.activeStream?.phaseId).toBe(1);          // preserved
    expect(s2.activeStream?.phaseProgress).toBe(0.5);  // preserved
    expect(s2.activeStream?.lastTickAt).toBe(3000);    // updated
  });

  it('cross-book guard: applyAnalysisSnapshotTick for a different manuscriptId is a no-op', () => {
    /* Multi-tab safety. The pill snapshot is global per browser; another
       tab analysing a different book must not clobber this tab's
       snapshot just because both are dispatching ticks. */
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(s1, analysisActions.applyAnalysisSnapshotTick({
      manuscriptId: 'm_OTHER',
      phaseId: 2,
      phaseProgress: 0.99,
    }));
    expect(s2.activeStream).toEqual(baseSnapshot);
  });

  it('applyAnalysisSnapshotTick is a no-op when activeStream is null (no snapshot to update)', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.applyAnalysisSnapshotTick({
      manuscriptId: 'm1',
      phaseId: 1,
    }));
    expect(s1.activeStream).toBeNull();
  });

  it('setHalted flips state + carries the code + message; cross-book guarded', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(s1, analysisActions.setHalted({
      manuscriptId: 'm1',
      code: 'attribution_drift',
      message: 'Phase 1 demoted 60% of sentences.',
    }));
    expect(s2.activeStream).toMatchObject({
      state: 'halted',
      haltCode: 'attribution_drift',
      haltReason: 'Phase 1 demoted 60% of sentences.',
    });
    /* Wrong-manuscript halt does not touch the snapshot. */
    const s3 = analysisSlice.reducer(s2, analysisActions.setHalted({
      manuscriptId: 'm_OTHER',
      code: 'unknown',
      message: 'other tab',
    }));
    expect(s3.activeStream).toEqual(s2.activeStream);
  });

  it('setPaused flips state to paused; cross-book guarded', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(s1, analysisActions.setPaused({ manuscriptId: 'm1' }));
    expect(s2.activeStream?.state).toBe('paused');
    const s3 = analysisSlice.reducer(s2, analysisActions.setPaused({ manuscriptId: 'm_OTHER' }));
    expect(s3.activeStream?.state).toBe('paused'); // still paused, m_OTHER ignored
  });
});
