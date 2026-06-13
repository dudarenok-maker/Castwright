/* Continue-listening slice — holds the "resume shelf" item list.
 *
 * Populated by dispatching `hydrate` after a successful call to
 * `api.getContinueListening()`. The shelf is rendered in the library view
 * and lets users jump back into a book at the chapter they left off.
 *
 * State is in-memory only — the server's listen-progress records are the
 * source of truth; this slice just caches the last fetched list for
 * synchronous rendering. Pair with fs-15 / fs-16. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { components } from '../lib/api-types';

export type ContinueItem = components['schemas']['ContinueListeningItem'];

export interface ContinueListeningState {
  items: ContinueItem[];
}

const initialState: ContinueListeningState = {
  items: [],
};

export const continueListeningSlice = createSlice({
  name: 'continueListening',
  initialState,
  reducers: {
    /** Replace the shelf with a fresh server fetch result. */
    hydrate: (s, a: PayloadAction<ContinueItem[]>) => {
      s.items = a.payload;
    },
  },
});

export const continueListeningActions = continueListeningSlice.actions;

const EMPTY_ITEMS: ContinueItem[] = [];

/** Defensive selector: returns a stable empty array when the slice isn't
 *  registered (older test stores composed before this slice was added),
 *  matching how `selectListenProgress` guards against missing state. The
 *  stable reference prevents react-redux from emitting "different result
 *  with same parameters" warnings in those test stores. */
export const selectContinueListening = (s: {
  continueListening?: ContinueListeningState;
}): ContinueItem[] => s.continueListening?.items ?? EMPTY_ITEMS;
