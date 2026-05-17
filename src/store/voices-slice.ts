/* Voices slice — mirrors the derived library returned by GET /api/voices
   plus the unmodified base-voice catalog from GET /api/voices/base.

   Voices are not stored independently of books: each one is a previously-cast
   character that the backend exposes by walking confirmed cast.json files.
   The slice just holds the latest snapshot for the views to read. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { BaseVoice, Voice, VoiceLibraryResponse } from '../lib/types';

export interface VoicesState {
  loaded: boolean;
  voices: Voice[];
  /** Catalog of raw model voices each engine exposes, surfaced in the
      "Base voices" tab and the Profile Drawer override picker. Loaded
      lazily when the Voices view mounts. */
  baseVoices: BaseVoice[];
  baseVoicesLoaded: boolean;
}

const initialState: VoicesState = {
  loaded: false,
  voices: [],
  baseVoices: [],
  baseVoicesLoaded: false,
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
      const v = s.voices.find((v) => v.id === a.payload.voiceId);
      if (v) v.pinned = a.payload.pinned || undefined;
    },
    /* Optimistic override write. The matching PUT /api/voices/:id/override
       fires from the view; we leave the `ttsVoice` field untouched here
       because the engine-aware resolution lives server-side — the next
       hydrate refreshes ttsVoice with whatever picker output reflects the
       current engine. The local state is enough for the UI to flip the
       "Manual" / "Auto" badge instantly.

       Payload semantics mirror the server route:
       - `override = { engine, name }` → set `overrideTtsVoices[engine] = {name}`,
         leaving other engine slots untouched.
       - `override = null` → clear EVERY engine slot. (Per-slot clearing
         isn't surfaced yet; if a UI needs it later, add a separate
         action with an explicit `engine` field.) */
    setOverride: (s, a: PayloadAction<{ voiceId: string; override: BaseVoice | null }>) => {
      const v = s.voices.find((v) => v.id === a.payload.voiceId);
      if (!v) return;
      const override = a.payload.override;
      if (override === null) {
        v.overrideTtsVoices = null;
        v.overrideTtsVoice = null;
        return;
      }
      const map = { ...(v.overrideTtsVoices ?? {}) };
      map[override.engine] = { name: override.name };
      v.overrideTtsVoices = map;
      /* Project the active engine's slot back into the legacy field
         so legacy badge/UI code keeps working until it's migrated to
         read overrideTtsVoices directly. The Voice the UI is editing
         is normally for the active synth engine, so this is right
         99% of the time. */
      v.overrideTtsVoice = override;
    },
    hydrateBaseVoices: (s, a: PayloadAction<BaseVoice[]>) => {
      s.baseVoicesLoaded = true;
      s.baseVoices = a.payload;
    },
  },
});

export const voicesActions = voicesSlice.actions;
