import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import type { ThunkAction, UnknownAction } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import { uiActions } from './ui-slice';
import { TOUR_STEPS, stepsForScreen, SAMPLE, type TourScreen } from '../lib/tour-steps';
import type { Stage } from '../lib/types';

export type TourMode = 'linear' | 'screen';

export interface TourState {
  active: boolean;
  mode: TourMode;
  tourId: string | null;
  stepIndex: number;
  /** Server-sourced completion timestamp; null = not completed. */
  completedAt: string | null;
}

const initialState: TourState = {
  active: false,
  mode: 'linear',
  tourId: null,
  stepIndex: 0,
  completedAt: null,
};

/** Boot-time read of server completion (mirrors fetchAccountSettings). */
export const fetchTourStatus = createAsyncThunk('tour/fetchStatus', async () => {
  return api.getTourStatus();
});

/** Stamp completion server-side; the reducer mirrors it locally. */
export const completeTour = createAsyncThunk('tour/complete', async () => {
  return api.completeTour();
});

export const tourSlice = createSlice({
  name: 'tour',
  initialState,
  reducers: {
    startTour: (s, a: PayloadAction<{ tourId: string; mode: TourMode }>) => {
      s.active = true;
      s.tourId = a.payload.tourId;
      s.mode = a.payload.mode;
      s.stepIndex = 0;
    },
    setStepIndex: (s, a: PayloadAction<number>) => {
      s.stepIndex = a.payload;
    },
    endTour: (s) => {
      s.active = false;
      s.tourId = null;
      s.stepIndex = 0;
      s.mode = 'linear';
    },
    /** Optimistic local stamp before/instead of the completeTour thunk's
        server round-trip. Kept as a building block for the finish flow. */
    markCompletedLocally: (s, a: PayloadAction<string>) => {
      s.active = false;
      s.tourId = null;
      s.stepIndex = 0;
      s.mode = 'linear';
      s.completedAt = a.payload;
    },
  },
  extraReducers: (b) => {
    b.addCase(fetchTourStatus.fulfilled, (s, a) => {
      s.completedAt = a.payload.completedAt;
    });
    b.addCase(completeTour.fulfilled, (s, a) => {
      s.completedAt = a.payload.completedAt;
      s.active = false;
      s.tourId = null;
      s.stepIndex = 0;
      s.mode = 'linear';
    });
  },
});

export const tourActions = tourSlice.actions;

// ── Navigation thunks ────────────────────────────────────────────────────────

interface TourThunkState {
  tour: TourState;
  ui: { stage: Stage };
}
type AppThunk = ThunkAction<void | Promise<void>, TourThunkState, unknown, UnknownAction>;

const VIEW_FOR_SCREEN: Record<Exclude<TourScreen, 'library'>, 'manuscript' | 'cast' | 'generate' | 'listen'> = {
  manuscript: 'manuscript', cast: 'cast', generate: 'generate', listen: 'listen',
};

/** Put ui on the screen a step needs, opening/closing the drawer to match. */
function navigateForStep(stepIndex: number): AppThunk {
  return (dispatch, getState) => {
    const step = TOUR_STEPS[stepIndex];
    if (!step) return;
    const { mode } = getState().tour;
    if (step.screen === 'library') {
      dispatch(uiActions.goHome());
      return;
    }
    if (mode === 'linear') {
      const stage = getState().ui.stage;
      if (stage.kind !== 'ready' || stage.bookId !== SAMPLE.bookId) {
        dispatch(uiActions.openBook({ id: SAMPLE.bookId, status: 'complete', manuscriptId: SAMPLE.bookId }));
      }
    }
    dispatch(uiActions.changeView(VIEW_FOR_SCREEN[step.screen]));
    dispatch(uiActions.setOpenProfileId(step.opensDrawer && mode === 'linear' ? SAMPLE.drawerCharacterId : null));
  };
}

export function goToStep(stepIndex: number): AppThunk {
  return (dispatch) => {
    if (stepIndex < 0 || stepIndex >= TOUR_STEPS.length) return;
    dispatch(navigateForStep(stepIndex));
    dispatch(tourSlice.actions.setStepIndex(stepIndex));
  };
}

export function nextStep(): AppThunk {
  return (dispatch, getState) => {
    const { stepIndex, mode, tourId } = getState().tour;
    if (mode === 'screen') {
      const slice = stepsForScreen(tourId as TourScreen);
      const posInSlice = slice.findIndex((s) => s.id === TOUR_STEPS[stepIndex].id);
      if (posInSlice === -1) { dispatch(tourSlice.actions.endTour()); return; }
      if (posInSlice + 1 >= slice.length) { dispatch(tourSlice.actions.endTour()); return; }
      dispatch(goToStep(TOUR_STEPS.indexOf(slice[posInSlice + 1])));
      return;
    }
    if (stepIndex + 1 >= TOUR_STEPS.length) { dispatch(finishTour()); return; }
    dispatch(goToStep(stepIndex + 1));
  };
}

export function prevStep(): AppThunk {
  return (dispatch, getState) => {
    const { stepIndex, mode, tourId } = getState().tour;
    if (mode === 'screen') {
      const slice = stepsForScreen(tourId as TourScreen);
      const posInSlice = slice.findIndex((s) => s.id === TOUR_STEPS[stepIndex].id);
      if (posInSlice <= 0) return; // already at the first step of the slice
      dispatch(goToStep(TOUR_STEPS.indexOf(slice[posInSlice - 1])));
      return;
    }
    if (stepIndex > 0) dispatch(goToStep(stepIndex - 1));
  };
}

/** Provision the sample, then start the linear tour at step 0. */
export function startLinearTour(): AppThunk {
  return async (dispatch, getState) => {
    const stage = getState().ui.stage;
    const haveSample = stage.kind === 'ready' && stage.bookId === SAMPLE.bookId;
    if (!haveSample) {
      try { await api.loadSample(SAMPLE.slug); } catch { /* already present / offline — proceed */ }
    }
    dispatch(tourSlice.actions.startTour({ tourId: 'linear', mode: 'linear' }));
    dispatch(goToStep(0));
  };
}

/** Run a single screen's mini-tour on whatever book is open (no provisioning). */
export function startScreenTour(screen: TourScreen): AppThunk {
  return (dispatch) => {
    const first = stepsForScreen(screen)[0];
    if (!first) return;
    dispatch(tourSlice.actions.startTour({ tourId: screen, mode: 'screen' }));
    dispatch(goToStep(TOUR_STEPS.indexOf(first)));
  };
}

/** Stamp completion server-side (the completeTour.fulfilled reducer mirrors it locally + ends). */
export function finishTour(): AppThunk {
  return async (dispatch) => {
    await dispatch(completeTour());
  };
}
