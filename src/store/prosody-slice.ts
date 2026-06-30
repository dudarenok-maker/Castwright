/* Prosody slice — transient UI-only progress for the two-pass prosody
   annotation run (Phase 3, fs-65).

   Progress is a per-book map so concurrent multi-book passes never collide.
   Like `notifications`, this slice is TRANSIENT: UI-only, no persistence.
   Its progress map IS broadcast cross-tab via the `sync:substage` message in
   broadcast-middleware (Generate-gate consistency); the inbound
   applyExternalSet/applyExternalClear reducers are deliberately NOT in the
   middleware's outbound match set so they can't re-broadcast (echo layer 2).
   Results land in the manuscript slice, not here. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface SubstageEntry {
  /** 0..100 integer percent. */
  progress: number;
  /** User-facing phase label, e.g. "Detecting emotions". */
  label: string;
}

export interface ProsodyState {
  activeStreams: Record<string, SubstageEntry>;
}

const initialState: ProsodyState = { activeStreams: {} };

export const prosodySlice = createSlice({
  name: 'prosody',
  initialState,
  reducers: {
    setActive: (s, a: PayloadAction<{ bookId: string; progress: number; label: string }>) => {
      s.activeStreams[a.payload.bookId] = {
        progress: Math.round(a.payload.progress * 100),
        label: a.payload.label,
      };
    },
    updateProgress: (s, a: PayloadAction<{ bookId: string; progress: number }>) => {
      const e = s.activeStreams[a.payload.bookId];
      if (e) e.progress = Math.round(a.payload.progress * 100);
    },
    clear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.activeStreams[a.payload.bookId];
    },
    /** Inbound from broadcast — NEVER add to the outbound match set. */
    applyExternalSet: (s, a: PayloadAction<{ bookId: string; entry: SubstageEntry }>) => {
      s.activeStreams[a.payload.bookId] = a.payload.entry;
    },
    applyExternalClear: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.activeStreams[a.payload.bookId];
    },
  },
});

export const prosodyActions = prosodySlice.actions;
