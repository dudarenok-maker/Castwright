/* TTS engines + models exposed in the UI selectors. The `id` matches the
   server's `modelKey` enum (see openapi.yaml VoiceSampleRequest); the server
   resolves engine prefix → provider and forwards the rest to the engine.

   Two-tier structure: the UI shows an Engine dropdown (Local / Gemini) and a
   Model dropdown filtered to that engine's options. When the user switches
   engine, the consumer should default to the engine group's first model. */

import type { TtsModelKey } from './types';

export type TtsEngineId = 'local' | 'gemini';

export interface TtsModelOption {
  id: TtsModelKey;
  label: string;
  hint?: string;
}

export interface TtsEngineGroup {
  id: TtsEngineId;
  label: string;
  hint?: string;
  models: TtsModelOption[];
}

export const TTS_ENGINES: TtsEngineGroup[] = [
  {
    id: 'local',
    label: 'Local (free)',
    hint: 'Runs on your machine via the TTS sidecar — no rate limits',
    models: [
      { id: 'kokoro-v1', label: 'Kokoro v1', hint: 'Default · 28 English voices · quality-tuned' },
      {
        id: 'coqui-xtts-v2',
        label: 'Coqui XTTS v2',
        hint: 'Alternate · 30 baked voices · zero-shot cloning',
      },
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini (cloud)',
    hint: 'Free tier · rate-limited',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash TTS' },
      { id: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash TTS', hint: 'Preview' },
    ],
  },
];

/* Flat list for legacy call sites (cast view's ttsLabel lookup etc.). New
   code should prefer iterating TTS_ENGINES so the engine grouping is
   visible. */
export const TTS_MODEL_OPTIONS: TtsModelOption[] = TTS_ENGINES.flatMap((g) => g.models);

/** Human-readable label for a model key. Falls back to the raw key when an
    unknown id appears (e.g. an older saved state pointing at a model we've
    since removed) so the UI shows *something* identifiable rather than
    blanking. */
export function ttsModelLabel(key: TtsModelKey): string {
  return TTS_MODEL_OPTIONS.find((m) => m.id === key)?.label ?? key;
}

import { FRONTEND_ACCOUNT_DEFAULTS } from './account-defaults';

/* Single source of truth for the frontend's TTS default — mirrors server's
   DEFAULT_USER_SETTINGS.defaultTtsModelKey via FRONTEND_ACCOUNT_DEFAULTS. */
export const DEFAULT_TTS_MODEL: TtsModelKey = FRONTEND_ACCOUNT_DEFAULTS.defaultTtsModelKey;

/* Mirror of the backend's engineForModelKey — keeps the UI honest about
   which sidecar/cloud it will hit when a sample is requested. Add new
   prefixes here in lockstep with server/src/tts/index.ts. */
export function engineForModelKey(key: TtsModelKey): 'coqui' | 'piper' | 'kokoro' | 'gemini' {
  if (key.startsWith('coqui-')) return 'coqui';
  if (key.startsWith('piper-')) return 'piper';
  if (key.startsWith('kokoro-')) return 'kokoro';
  return 'gemini';
}

/* Group id (UI-level) for a model key. 'local' for any non-Gemini engine,
   'gemini' otherwise. Used by the selector to pre-select the engine
   dropdown when hydrating from a saved modelKey. */
export function engineGroupForModelKey(key: TtsModelKey): TtsEngineId {
  return engineForModelKey(key) === 'gemini' ? 'gemini' : 'local';
}
