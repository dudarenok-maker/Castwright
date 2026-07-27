/* Voices slice — mirrors the derived library returned by GET /api/voices
   plus the unmodified base-voice catalog from GET /api/voices/base.

   Voices are not stored independently of books: each one is a previously-cast
   character that the backend exposes by walking confirmed cast.json files.
   The slice just holds the latest snapshot for the views to read. */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { BaseVoice, TtsEngine, Voice, VoiceLibraryResponse } from '../lib/types';

/* A single engine's overrideTtsVoices slot, straight off the generated
   schema — includes `libraryUuid`/`provenance`, which `BaseVoice` (the wire
   shape `setOverride` takes) has no room for. */
type OverrideSlot = NonNullable<Voice['overrideTtsVoices']>[string];

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
       view; transient mismatches are cheap (next hydrate corrects them).
       `voiceId` here is actually the voice's `familyKey` (falling back to
       `id` for an older/local fixture with no familyKey) — matching by the
       bare `id` alone would flip the pin on the wrong voice whenever two
       unrelated books share a voiceId-less character's id (narrator,
       unknown-male, unknown-female). */
    setPinned: (s, a: PayloadAction<{ voiceId: string; pinned: boolean }>) => {
      const v = s.voices.find((v) => (v.familyKey ?? v.id) === a.payload.voiceId);
      if (v) v.pinned = a.payload.pinned || undefined;
    },
    /* Optimistic "Sampled" flip. Fired after a successful 12s audition synth
       so the Qwen Status pill advances Designed → Sampled immediately — the
       library only re-hydrates on book/stage/engine/genProgress change, none
       of which a sample triggers. The next GET /api/voices confirms it from
       the on-disk sample cache. */
    markSampled: (s, a: PayloadAction<{ voiceId: string }>) => {
      const v = s.voices.find((v) => v.id === a.payload.voiceId);
      if (v) v.sampled = true;
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
      /* fs-38 Wave 3c Task 4 — spread the existing slot (mirrors the server's
         applyOverrideToCastFiles, voices.ts:781) so setting a new name
         doesn't drop the slot's other fields — notably libraryUuid/
         provenance, which identify a consented clone. */
      map[override.engine] = { ...(map[override.engine] ?? {}), name: override.name };
      v.overrideTtsVoices = map;
      /* Project the active engine's slot back into the legacy field
         so legacy badge/UI code keeps working until it's migrated to
         read overrideTtsVoices directly. The Voice the UI is editing
         is normally for the active synth engine, so this is right
         99% of the time. */
      v.overrideTtsVoice = override;
    },
    /* fs-38 Wave 3c Task 26 carry-forward — restores a single engine's slot
       verbatim after a rejected optimistic write. The profile drawer's 409
       revert used to route through `setOverride` with just `{engine, name}`;
       after an optimistic full clear (`setOverride(null)`, which nulls the
       WHOLE map) that reconstructed the slot from an empty map, dropping
       `libraryUuid`/`provenance` and de-marking a consented clone. This
       writes the caller's exact prior slot back, marker included. */
    restoreOverride: (
      s,
      a: PayloadAction<{ voiceId: string; engine: TtsEngine; slot: OverrideSlot }>,
    ) => {
      const v = s.voices.find((v) => v.id === a.payload.voiceId);
      if (!v) return;
      const map = { ...(v.overrideTtsVoices ?? {}) };
      map[a.payload.engine] = a.payload.slot;
      v.overrideTtsVoices = map;
    },
    hydrateBaseVoices: (s, a: PayloadAction<BaseVoice[]>) => {
      s.baseVoicesLoaded = true;
      s.baseVoices = a.payload;
    },
  },
});

export const voicesActions = voicesSlice.actions;
