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
  /** Ids of books optimistically dismissed by the user. hydrate filters these
   *  out until the server confirms the book is gone (id is then cleared).
   *  This prevents a dismissed card from flickering back if the finish POST
   *  hasn't reflected in the next getContinueListening response yet. */
  dismissedIds: string[];
}

const initialState: ContinueListeningState = {
  items: [],
  dismissedIds: [],
};

export const continueListeningSlice = createSlice({
  name: 'continueListening',
  initialState,
  reducers: {
    /** Replace the shelf with a fresh server fetch result.
     *
     *  Self-terminating dismiss guard: any dismissedId NOT present in the
     *  incoming payload is cleared (the server confirmed it gone). Remaining
     *  dismissedIds filter the items so an in-flight optimistic dismiss isn't
     *  undone by a stale server response. */
    hydrate: (s, a: PayloadAction<ContinueItem[]>) => {
      const incomingIds = new Set(a.payload.map((i) => i.bookId));
      s.dismissedIds = s.dismissedIds.filter((id) => incomingIds.has(id));
      s.items = a.payload.filter((i) => !s.dismissedIds.includes(i.bookId));
    },
    /** fs-15 shelf controls — optimistically drop one book from the shelf
        (after the user marks it finished or hides it). Adds the bookId to
        dismissedIds (deduped) so subsequent hydrate calls keep it hidden
        until the server confirms it gone. */
    dismiss: (s, a: PayloadAction<string>) => {
      if (!s.dismissedIds.includes(a.payload)) s.dismissedIds.push(a.payload);
      s.items = s.items.filter((i) => i.bookId !== a.payload);
    },
    /** fs-15 failed-POST recovery — remove a bookId from dismissedIds so the
     *  next hydrate can restore the card (used when setShelfStatus fails). */
    undismiss: (s, a: PayloadAction<string>) => {
      s.dismissedIds = s.dismissedIds.filter((id) => id !== a.payload);
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
