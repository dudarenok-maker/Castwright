/* Voices slice — mirrors the derived library returned by GET /api/voices.

   Voices are not stored independently of books: each one is a previously-cast
   character that the backend exposes by walking confirmed cast.json files.
   The slice just holds the latest snapshot for the views to read. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Voice, VoiceLibraryResponse } from '../lib/types';

export interface VoicesState {
  loaded: boolean;
  voices: Voice[];
}

const initialState: VoicesState = {
  loaded: false,
  voices: [],
};

export const voicesSlice = createSlice({
  name: 'voices',
  initialState,
  reducers: {
    hydrate: (s, a: PayloadAction<VoiceLibraryResponse>) => {
      s.loaded = true;
      s.voices = a.payload.voices;
    },
    /* Optimistic pin toggle. PUT /api/voices/:id/pin still fires from the
       view; transient mismatches are cheap (next hydrate corrects them). */
    setPinned: (s, a: PayloadAction<{ voiceId: string; pinned: boolean }>) => {
      const v = s.voices.find(v => v.id === a.payload.voiceId);
      if (v) v.pinned = a.payload.pinned || undefined;
    },
  },
});

export const voicesActions = voicesSlice.actions;
