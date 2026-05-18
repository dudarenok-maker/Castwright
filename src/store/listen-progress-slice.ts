/* Listen-progress slice — per-book resume bookmark.
 *
 * The slice stays in-memory only. The server file at
 * `.audiobook/listen-progress.json` is authoritative; this slice
 * mirrors it for the active book so the Listen view's "Resume at
 * MM:SS" pill and the MiniPlayer's on-mount seek can read state
 * synchronously without re-fetching on every render.
 *
 * Why not redux-persist? Two reasons:
 *   1. The server file already survives reloads.
 *   2. Persisting would put the bookmark in two places of truth;
 *      a stale rehydrate could clobber a fresh server-side write.
 *
 * Plan 47. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface ListenProgressRecord {
  chapterId: number;
  currentSec: number;
  updatedAt: string;
}

export interface ListenProgressState {
  byBook: Record<string, ListenProgressRecord>;
}

const initialState: ListenProgressState = { byBook: {} };

export const listenProgressSlice = createSlice({
  name: 'listenProgress',
  initialState,
  reducers: {
    /* Server fetch returns the record (or null when no session has
       been recorded yet). Null clears any local entry for the book. */
    hydrate: (
      s,
      a: PayloadAction<{ bookId: string; progress: ListenProgressRecord | null }>,
    ) => {
      const { bookId, progress } = a.payload;
      if (progress) s.byBook[bookId] = progress;
      else delete s.byBook[bookId];
    },
    /* Optimistic update after a debounced PUT. Server's response will
       arrive with a real updatedAt; the slice carries the local timer's
       Date.now() value until then so the Listen pill's MM:SS stays
       fresh during continuous playback. */
    update: (
      s,
      a: PayloadAction<{ bookId: string; chapterId: number; currentSec: number; updatedAt?: string }>,
    ) => {
      const { bookId, chapterId, currentSec, updatedAt } = a.payload;
      s.byBook[bookId] = {
        chapterId,
        currentSec,
        updatedAt: updatedAt ?? new Date().toISOString(),
      };
    },
    clear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.byBook[a.payload.bookId];
    },
  },
});

export const listenProgressActions = listenProgressSlice.actions;

/* Defensive selector: returns null when the slice isn't registered
   (older test stores composed before plan 47) or when no record
   exists for the book. Lets the Listen view + MiniPlayer call this
   unconditionally without a per-test fixup. */
export const selectListenProgress =
  (bookId: string | null) =>
  (s: { listenProgress?: ListenProgressState }): ListenProgressRecord | null => {
    if (!bookId) return null;
    return s.listenProgress?.byBook[bookId] ?? null;
  };
