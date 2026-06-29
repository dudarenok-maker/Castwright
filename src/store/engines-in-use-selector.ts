/* selectEnginesInUse — derive the set of TTS engines a given book will
   actually synthesise with, so the top bar can render only the pills that
   matter for the current view (Kokoro / Coqui / Qwen / Gemini).

   Today the engine is a per-book setting (`account.defaultTtsModelKey` is
   the user-wide default; book-specific overrides may arrive later) — so
   this selector usually returns a singleton set. The set shape is
   deliberate: when a future change lets characters override the engine
   (not just the voice within an engine), this expands to a union without
   churning every call site.

   Why not just read defaultTtsModelKey at the render site? Two reasons:
     1. Centralising the model-key-to-engine mapping keeps the pill
        components ignorant of model key naming. They ask "is Kokoro in
        use?" — `selectEnginesInUse` answers.
     2. The set shape mirrors the future-proof intent of `BACKLOG #15`'s
        "third consumer" extension — a per-character engine override
        becomes one extra source the selector unions into the result. */

import type { RootState } from './index';
import { engineForModelKey } from '../lib/tts-models';

export type EngineFamily = 'coqui' | 'kokoro' | 'qwen' | 'gemini';

/* `piper` exists in the engine taxonomy but has no pill (no Load/Stop
   control on Piper today). We map it to `coqui` for pill purposes since
   it shares the Coqui sidecar lifecycle. If Piper ever grows its own
   pill, add a 'piper' branch here. */
function engineFamilyForKey(key: string): EngineFamily {
  const engine = engineForModelKey(key as Parameters<typeof engineForModelKey>[0]);
  if (engine === 'kokoro') return 'kokoro';
  if (engine === 'qwen') return 'qwen';
  if (engine === 'gemini') return 'gemini';
  /* coqui + piper both ride the Coqui pill / sidecar lifecycle. */
  return 'coqui';
}

import { createSelector } from '@reduxjs/toolkit';

export const selectEnginesInUse = createSelector(
  [(s: RootState) => s.account?.defaultTtsModelKey, (s: RootState) => s.cast?.characters],
  (modelKey, characters): Set<EngineFamily> => {
    const result = new Set<EngineFamily>();
    if (modelKey) {
      result.add(engineFamilyForKey(modelKey));
    }
    if (characters?.some((c) => c.ttsEngine === 'qwen' || c.overrideTtsVoices?.qwen)) {
      result.add('qwen');
    }
    return result;
  },
);

/* selectDefaultTtsEngine — the user-wide default/primary engine derived from
   `account.defaultTtsModelKey`, independent of any loaded book or its cast.
   The top bar uses this to keep the default engine's Load/Stop pill reachable
   on book-less views (Books home, Voices, …) so the model can be pre-loaded
   right after launch — whereas the per-character additions in
   `selectEnginesInUse` (e.g. a Qwen-pinned cast member) stay gated behind an
   open book. Returns null when no default key has hydrated yet. */
export function selectDefaultTtsEngine(state: RootState): EngineFamily | null {
  const modelKey = state.account?.defaultTtsModelKey;
  return modelKey ? engineFamilyForKey(modelKey) : null;
}
