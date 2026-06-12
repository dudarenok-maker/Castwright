import { createSlice, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import { api } from '../lib/api';

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
