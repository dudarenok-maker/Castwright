/* Prosody slice — transient UI-only progress state for the two-pass prosody
   annotation run (Phase 3, fs-65).

   Like `notifications`, this slice is TRANSIENT: UI-only, no persistence,
   no cross-tab broadcast. Add ONLY the reducer to the store map in index.ts
   (do NOT add to persistence-middleware or broadcast-middleware).

   `activeStream` is singular — concurrent multi-book shows one active stream.
   The auto-trigger (Task 13) and the manual DetectEmotionsButton (optional)
   both drive the pill via the actions below. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface ProsodyActiveStream {
  bookId: string;
  /** 0..100 integer percent. */
  progress: number;
  /** Human-readable label shown beside the percent, e.g. "Phase 3 — Detecting prosody". */
  label: string;
}

export interface ProsodyState {
  activeStream: ProsodyActiveStream | null;
}

const initialState: ProsodyState = { activeStream: null };

export const prosodySlice = createSlice({
  name: 'prosody',
  initialState,
  reducers: {
    setActive: (s, a: PayloadAction<{ bookId: string; progress: number; label: string }>) => {
      s.activeStream = { bookId: a.payload.bookId, progress: Math.round(a.payload.progress * 100), label: a.payload.label };
    },
    updateProgress: (s, a: PayloadAction<{ bookId: string; progress: number }>) => {
      if (s.activeStream && s.activeStream.bookId === a.payload.bookId) {
        s.activeStream.progress = Math.round(a.payload.progress * 100);
      }
    },
    clear: (s) => {
      s.activeStream = null;
    },
  },
});

export const prosodyActions = prosodySlice.actions;
