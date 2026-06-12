import { describe, it, expect, vi } from 'vitest';

// Under vitest `api` is the REAL impl (USE_MOCKS=false); mock it so the thunks
// don't issue real fetches. Mirrors account-slice.test.ts:19.
vi.mock('../lib/api', () => ({
  api: {
    getTourStatus: vi.fn(async () => ({ completedAt: null })),
    completeTour: vi.fn(async () => ({ completedAt: '2026-06-12T00:00:00.000Z' })),
    loadSample: vi.fn(async () => ({ bookId: 'castwright__standalones__the-coalfall-commission' })),
  },
}));

import { tourSlice, tourActions, fetchTourStatus, completeTour } from './tour-slice';
import { configureStore } from '@reduxjs/toolkit';

const reducer = tourSlice.reducer;

describe('tour-slice reducers', () => {
  it('starts inactive with no step', () => {
    const s = reducer(undefined, { type: '@@init' });
    expect(s.active).toBe(false);
    expect(s.stepIndex).toBe(0);
    expect(s.completedAt).toBeNull();
  });

  it('startTour activates at step 0 with a tourId + mode', () => {
    const s = reducer(undefined, tourActions.startTour({ tourId: 'linear', mode: 'linear' }));
    expect(s.active).toBe(true);
    expect(s.tourId).toBe('linear');
    expect(s.mode).toBe('linear');
    expect(s.stepIndex).toBe(0);
  });

  it('setStepIndex / endTour', () => {
    let s = reducer(undefined, tourActions.startTour({ tourId: 'linear', mode: 'linear' }));
    s = reducer(s, tourActions.setStepIndex(3));
    expect(s.stepIndex).toBe(3);
    s = reducer(s, tourActions.endTour());
    expect(s.active).toBe(false);
  });

  it('markCompletedLocally stamps completedAt and deactivates', () => {
    let s = reducer(undefined, tourActions.startTour({ tourId: 'linear', mode: 'linear' }));
    s = reducer(s, tourActions.markCompletedLocally('2026-06-12T00:00:00.000Z'));
    expect(s.active).toBe(false);
    expect(s.completedAt).toBe('2026-06-12T00:00:00.000Z');
  });

  it('fetchTourStatus.fulfilled hydrates completedAt', async () => {
    const store = configureStore({ reducer: { tour: reducer } });
    await store.dispatch(fetchTourStatus());
    expect(store.getState().tour.completedAt).toBeNull();
  });

  it('completeTour.fulfilled stamps completedAt and deactivates', async () => {
    const store = configureStore({ reducer: { tour: reducer } });
    store.dispatch(tourActions.startTour({ tourId: 'linear', mode: 'linear' }));
    await store.dispatch(completeTour());
    const s = store.getState().tour;
    expect(s.completedAt).toBe('2026-06-12T00:00:00.000Z');
    expect(s.active).toBe(false);
    expect(s.tourId).toBeNull();
  });
});
