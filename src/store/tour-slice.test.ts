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

import { tourSlice, tourActions, fetchTourStatus, completeTour, goToStep, nextStep, prevStep, startScreenTour } from './tour-slice';
import { uiSlice, uiActions } from './ui-slice';
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

describe('tour navigation thunks', () => {
  function mkStore() {
    return configureStore({ reducer: { tour: tourSlice.reducer, ui: uiSlice.reducer } });
  }

  it('goToStep("manuscript" step) navigates ui to that view', async () => {
    const store = mkStore();
    store.dispatch(uiActions.openBook({ id: 'b', status: 'complete', manuscriptId: 'm' }));
    store.dispatch(tourActions.startTour({ tourId: 'linear', mode: 'linear' }));
    await store.dispatch(goToStep(3)); // s4-line → manuscript
    const stage = store.getState().ui.stage;
    expect(stage.kind).toBe('ready');
    if (stage.kind === 'ready') expect(stage.view).toBe('manuscript');
    expect(store.getState().tour.stepIndex).toBe(3);
  });

  it('opensDrawer step sets openProfileId; stepping off it clears it', async () => {
    const store = mkStore();
    store.dispatch(uiActions.openBook({ id: 'b', status: 'complete', manuscriptId: 'm' }));
    store.dispatch(tourActions.startTour({ tourId: 'linear', mode: 'linear' }));
    await store.dispatch(goToStep(6)); // s7-drawer
    let stage = store.getState().ui.stage;
    if (stage.kind === 'ready') expect(stage.openProfileId).toBe('wren');
    await store.dispatch(goToStep(5)); // s6-roster
    stage = store.getState().ui.stage;
    if (stage.kind === 'ready') expect(stage.openProfileId).toBeNull();
  });

  it('screen-mode nextStep advances within the screen slice', async () => {
    const store = mkStore();
    store.dispatch(uiActions.openBook({ id: 'b', status: 'complete', manuscriptId: 'm' }));
    await store.dispatch(startScreenTour('cast'));
    expect(store.getState().tour.stepIndex).toBe(5); // s6-roster
    await store.dispatch(nextStep());
    expect(store.getState().tour.stepIndex).toBe(6); // s7-drawer
    await store.dispatch(nextStep());
    expect(store.getState().tour.stepIndex).toBe(7); // s8-fullcast
  });

  it('screen-mode nextStep ends the tour after the screen\'s last step', async () => {
    const store = mkStore();
    store.dispatch(uiActions.openBook({ id: 'b', status: 'complete', manuscriptId: 'm' }));
    await store.dispatch(startScreenTour('cast'));
    await store.dispatch(nextStep()); // 6
    await store.dispatch(nextStep()); // 7 (last cast step)
    await store.dispatch(nextStep()); // past end → endTour
    expect(store.getState().tour.active).toBe(false);
  });

  it('screen-mode stays on the current book (no sample teleport)', async () => {
    const store = mkStore();
    store.dispatch(uiActions.openBook({ id: 'mybook', status: 'complete', manuscriptId: 'm' }));
    await store.dispatch(startScreenTour('cast'));
    const stage = store.getState().ui.stage;
    expect(stage.kind).toBe('ready');
    if (stage.kind === 'ready') {
      expect(stage.bookId).toBe('mybook');          // did NOT switch to the sample
      expect(stage.view).toBe('cast');
      expect(stage.openProfileId).toBeNull();        // drawer not force-opened in screen mode
    }
  });

  it('screen-mode prevStep stays within the screen slice', async () => {
    const store = mkStore();
    store.dispatch(uiActions.openBook({ id: 'mybook', status: 'complete', manuscriptId: 'm' }));
    await store.dispatch(startScreenTour('cast'));   // s6 (index 5)
    await store.dispatch(nextStep());                // s7 (index 6)
    expect(store.getState().tour.stepIndex).toBe(6);
    await store.dispatch(prevStep());                // back to s6 (index 5) — NOT s5 manuscript
    expect(store.getState().tour.stepIndex).toBe(5);
    await store.dispatch(prevStep());                // already first in slice → no-op
    expect(store.getState().tour.stepIndex).toBe(5);
  });
});
