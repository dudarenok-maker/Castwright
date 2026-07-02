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
import {
  setActiveSubstage,
  updateSubstageProgress,
  type SetActiveSubstagePayload,
  type UpdateSubstageProgressPayload,
} from './analysis-substage-reducers';

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

export const prosodySlice = createSlice({
  name: 'prosody',
  initialState,
  reducers: {
    setActive: (s, a: PayloadAction<SetActiveSubstagePayload>) => {
      setActiveSubstage(s.activeStreams, a.payload);
    },
    updateProgress: (s, a: PayloadAction<UpdateSubstageProgressPayload>) => {
      updateSubstageProgress(s.activeStreams, a.payload);
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
