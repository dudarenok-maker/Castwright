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
  /** 1-based sequential position among the chapters THIS PASS processes. */
  chapterIndex?: number;
  /** Count of chapters this pass processes. */
  totalChapters?: number;
  /** Pace-based ETA in ms for the rest of the operation. Absent until a
      pacing rate has been observed (never on the very first chapter). */
  estRemainingMs?: number;
}

export interface ProsodyState {
  activeStreams: Record<string, SubstageEntry>;
}

const initialState: ProsodyState = { activeStreams: {} };

interface SetActivePayload {
  bookId: string;
  progress: number;
  label: string;
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
}
interface UpdateProgressPayload {
  bookId: string;
  progress: number;
  label?: string;
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
}

export const prosodySlice = createSlice({
  name: 'prosody',
  initialState,
  reducers: {
    setActive: (s, a: PayloadAction<SetActivePayload>) => {
      const { bookId, progress, label, chapterIndex, totalChapters, estRemainingMs } = a.payload;
      s.activeStreams[bookId] = {
        progress: Math.round(progress * 100),
        label,
        ...(chapterIndex !== undefined ? { chapterIndex } : {}),
        ...(totalChapters !== undefined ? { totalChapters } : {}),
        ...(estRemainingMs !== undefined ? { estRemainingMs } : {}),
      };
    },
    updateProgress: (s, a: PayloadAction<UpdateProgressPayload>) => {
      const e = s.activeStreams[a.payload.bookId];
      if (!e) return;
      e.progress = Math.round(a.payload.progress * 100);
      if (a.payload.label !== undefined) e.label = a.payload.label;
      if (a.payload.chapterIndex !== undefined) e.chapterIndex = a.payload.chapterIndex;
      if (a.payload.totalChapters !== undefined) e.totalChapters = a.payload.totalChapters;
      if (a.payload.estRemainingMs !== undefined) e.estRemainingMs = a.payload.estRemainingMs;
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
