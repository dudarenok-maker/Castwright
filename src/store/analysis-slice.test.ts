/* Pairs with docs/features/archive/32-sticky-analysis.md.

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
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 1,
        phaseLabel: 'Parsing and attribution',
        phaseProgress: 0.42,
        lastTickAt: 2500,
      }),
    );
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

  it('applyAnalysisSnapshotTick captures the server model id and preserves it across ticks that omit it', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm1', model: 'qwen3.5:9b' }),
    );
    expect(s2.activeStream?.model).toBe('qwen3.5:9b');
    /* A later eta-only tick (no model field) must NOT wipe the captured model. */
    const s3 = analysisSlice.reducer(
      s2,
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm1', remainingMs: 5000 }),
    );
    expect(s3.activeStream?.model).toBe('qwen3.5:9b');
  });

  it('applyAnalysisSnapshotTick only updates fields supplied — undefined leaves prior values intact', () => {
    const s1 = analysisSlice.reducer(
      undefined,
      analysisActions.setActiveStream({
        ...baseSnapshot,
        phaseId: 1,
        phaseProgress: 0.5,
        remainingMs: 30_000,
      }),
    );
    /* eta-only tick. */
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        remainingMs: 12_000,
        lastTickAt: 3000,
      }),
    );
    expect(s2.activeStream?.remainingMs).toBe(12_000);
    expect(s2.activeStream?.phaseId).toBe(1); // preserved
    expect(s2.activeStream?.phaseProgress).toBe(0.5); // preserved
    expect(s2.activeStream?.lastTickAt).toBe(3000); // updated
  });

  it('tracks phaseElapsedMs and resets it when the phase advances (subset pill mapping)', () => {
    const s1 = analysisSlice.reducer(
      undefined,
      analysisActions.setActiveStream({ ...baseSnapshot, phaseId: 0, phaseElapsedMs: 0 }),
    );
    /* Heartbeat within phase 0 accumulates elapsed. */
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm1', phaseId: 0, phaseElapsedMs: 8000 }),
    );
    expect(s2.activeStream?.phaseElapsedMs).toBe(8000);
    /* Phase advances to 1 → elapsed resets even though this tick omits it. */
    const s3 = analysisSlice.reducer(
      s2,
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm1', phaseId: 1, phaseProgress: 0.02 }),
    );
    expect(s3.activeStream?.phaseElapsedMs).toBe(0);
    /* Heartbeats within phase 1 accumulate again. */
    const s4 = analysisSlice.reducer(
      s3,
      analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'm1', phaseId: 1, phaseElapsedMs: 3000 }),
    );
    expect(s4.activeStream?.phaseElapsedMs).toBe(3000);
  });

  it('cross-book guard: applyAnalysisSnapshotTick for a different manuscriptId is a no-op', () => {
    /* Multi-tab safety. The pill snapshot is global per browser; another
       tab analysing a different book must not clobber this tab's
       snapshot just because both are dispatching ticks. */
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm_OTHER',
        phaseId: 2,
        phaseProgress: 0.99,
      }),
    );
    expect(s2.activeStream).toEqual(baseSnapshot);
  });

  it('applyAnalysisSnapshotTick is a no-op when activeStream is null (no snapshot to update)', () => {
    const s1 = analysisSlice.reducer(
      undefined,
      analysisActions.applyAnalysisSnapshotTick({
        manuscriptId: 'm1',
        phaseId: 1,
      }),
    );
    expect(s1.activeStream).toBeNull();
  });

  /* Heartbeat-only refresh — mirror of the chapters-slice
     updateActiveStreamProgress lastTickAt-only bump from commit 06444ee.
     Keeps the AnalysisPill's stall heuristic honest during quiet phases
     when no onPhase / onEta ticks are arriving and the user is on a
     different view. */
  it('bumpActiveStreamHeartbeat refreshes only lastTickAt; everything else preserved', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.bumpActiveStreamHeartbeat({ manuscriptId: 'm1', lastTickAt: 9999 }),
    );
    expect(s2.activeStream?.lastTickAt).toBe(9999);
    /* All other fields untouched. */
    expect(s2.activeStream).toMatchObject({
      ...baseSnapshot,
      lastTickAt: 9999,
    });
  });

  it('cross-book guard: bumpActiveStreamHeartbeat for a different manuscriptId is a no-op', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.bumpActiveStreamHeartbeat({ manuscriptId: 'm_OTHER', lastTickAt: 9999 }),
    );
    expect(s2.activeStream).toEqual(baseSnapshot);
  });

  it('bumpActiveStreamHeartbeat is a no-op when activeStream is null', () => {
    const s1 = analysisSlice.reducer(
      undefined,
      analysisActions.bumpActiveStreamHeartbeat({ manuscriptId: 'm1', lastTickAt: 1234 }),
    );
    expect(s1.activeStream).toBeNull();
  });

  it('setHalted flips state + carries the code + message; cross-book guarded', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.setHalted({
        manuscriptId: 'm1',
        code: 'attribution_drift',
        message: 'Phase 1 demoted 60% of sentences.',
      }),
    );
    expect(s2.activeStream).toMatchObject({
      state: 'halted',
      haltCode: 'attribution_drift',
      haltReason: 'Phase 1 demoted 60% of sentences.',
    });
    /* Wrong-manuscript halt does not touch the snapshot. */
    const s3 = analysisSlice.reducer(
      s2,
      analysisActions.setHalted({
        manuscriptId: 'm_OTHER',
        code: 'unknown',
        message: 'other tab',
      }),
    );
    expect(s3.activeStream).toEqual(s2.activeStream);
  });

  it('setPaused flips state to paused; cross-book guarded', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(s1, analysisActions.setPaused({ manuscriptId: 'm1' }));
    expect(s2.activeStream?.state).toBe('paused');
    const s3 = analysisSlice.reducer(s2, analysisActions.setPaused({ manuscriptId: 'm_OTHER' }));
    expect(s3.activeStream?.state).toBe('paused'); // still paused, m_OTHER ignored
  });

  it('setSeriesPrior populates the snapshot field with count + names; cross-book guarded', () => {
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.setSeriesPrior({
        manuscriptId: 'm1',
        count: 41,
        names: ['Wren', 'Marlow', 'Oduvan'],
      }),
    );
    expect(s2.activeStream?.seriesPrior).toEqual({
      count: 41,
      names: ['Wren', 'Marlow', 'Oduvan'],
    });
    /* Cross-book: another tab's series-prior event must not poison this tab. */
    const s3 = analysisSlice.reducer(
      s2,
      analysisActions.setSeriesPrior({
        manuscriptId: 'm_OTHER',
        count: 99,
        names: ['Wrong'],
      }),
    );
    expect(s3.activeStream?.seriesPrior?.count).toBe(41);
  });

  it('setSeriesPrior is a no-op when activeStream is null', () => {
    /* The server emits the event only after the slice's activeStream
       is set (the view dispatches setActiveStream before opening the
       SSE), so this case is defensive — a malformed action that lands
       early must not throw. */
    const s1 = analysisSlice.reducer(
      undefined,
      analysisActions.setSeriesPrior({
        manuscriptId: 'm1',
        count: 5,
        names: ['x', 'y'],
      }),
    );
    expect(s1.activeStream).toBeNull();
  });

  it('hydrateColdBoot writes the snapshot when activeStream is currently null', () => {
    const state = analysisSlice.reducer(
      undefined,
      analysisActions.hydrateColdBoot({ ...baseSnapshot, state: 'paused' }),
    );
    expect(state.activeStream).toMatchObject({
      bookId: 'b1',
      manuscriptId: 'm1',
      state: 'paused',
    });
  });

  it('hydrateColdBoot is a no-op when activeStream is already set (live SSE wins)', () => {
    /* The cold-boot fetch can resolve AFTER the analysing view has
       mounted and dispatched its own setActiveStream. The live snapshot
       always wins — overwriting it with a stale disk snapshot would
       reset progress / engine / kind to the on-disk values, causing
       a visible flicker and (worse) misreporting the live engine to
       the reverse-direction local-analyzer guard. */
    const live: AnalysisStreamSnapshot = {
      ...baseSnapshot,
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.42,
      state: 'running',
    };
    const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(live));
    const s2 = analysisSlice.reducer(
      s1,
      analysisActions.hydrateColdBoot({
        ...baseSnapshot,
        bookId: 'b_OTHER',
        manuscriptId: 'm_OTHER',
        phaseId: 0,
        phaseLabel: 'Detecting characters',
        phaseProgress: 0,
        state: 'paused',
      }),
    );
    expect(s2.activeStream).toEqual(live);
  });

  /* Cross-tab BroadcastChannel hydrate (plan 63). The middleware
     translates inbound channel messages into this reducer; tests for
     the middleware live in `broadcast-middleware.test.ts`. Here we
     pin the reducer's contract: it replaces activeStream verbatim,
     including null (sibling tab cleared the stream). */
  describe('applyExternalAnalysisSnapshot — cross-tab inbound', () => {
    it('replaces activeStream verbatim with the inbound snapshot', () => {
      const sibling: AnalysisStreamSnapshot = {
        ...baseSnapshot,
        bookId: 'b_SIBLING',
        manuscriptId: 'm_SIBLING',
        phaseProgress: 0.8,
      };
      const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
      const s2 = analysisSlice.reducer(
        s1,
        analysisActions.applyExternalAnalysisSnapshot(sibling),
      );
      expect(s2.activeStream).toEqual(sibling);
    });

    it('accepts null to mirror a sibling clearActiveStream', () => {
      const s1 = analysisSlice.reducer(undefined, analysisActions.setActiveStream(baseSnapshot));
      const s2 = analysisSlice.reducer(s1, analysisActions.applyExternalAnalysisSnapshot(null));
      expect(s2.activeStream).toBeNull();
    });
  });
});
