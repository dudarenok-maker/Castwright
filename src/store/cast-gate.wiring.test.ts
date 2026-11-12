/* Plan 291 (#4031, round 2) — the cast gate's liveness query must reach the
   analysis-stream middleware through the REAL store's middleware order
   (store/index.ts): every middleware in front of it has to hand `next`'s
   return value back, or the gate reads every stream as dead. */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return {
    ...mod,
    api: {
      ...mod.api,
      /* The handle's subscribe POST stays open; nothing settles it. */
      analyseManuscript: () => new Promise(() => {}),
      getBookBusy: () => new Promise(() => {}),
    },
  };
});

import { store } from './index';
import { analysisActions, isAnalysisStreamLive } from './analysis-slice';

describe('cast gate wiring (real store)', () => {
  it('isAnalysisStreamLive reaches the stream middleware and answers true for the owning tab after a tick', () => {
    const live = () => store.dispatch(isAnalysisStreamLive('wire-b')) as unknown;
    store.dispatch(
      analysisActions.setActiveStream({
        bookId: 'wire-b',
        manuscriptId: 'wire-m',
        phaseId: 0,
        phaseLabel: 'Detecting characters',
        phaseProgress: 0,
        remainingMs: null,
        lastTickAt: 1,
        state: 'running',
      }),
    );
    expect(live()).toBe(false);
    store.dispatch(analysisActions.applyAnalysisSnapshotTick({ manuscriptId: 'wire-m', phaseId: 0, phaseProgress: 0.1 }));
    expect(live()).toBe(true);
    store.dispatch(analysisActions.clearActiveStream());
    expect(live()).toBe(false);
  });
});
