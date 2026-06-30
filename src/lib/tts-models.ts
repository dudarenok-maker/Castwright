/* TTS engines + models exposed in the UI selectors. The `id` matches the
   server's `modelKey` enum (see openapi.yaml VoiceSampleRequest); the server
   resolves engine prefix → provider and forwards the rest to the engine.

   Two-tier structure: the UI shows an Engine dropdown (Local / Gemini) and a
   Model dropdown filtered to that engine's options. When the user switches
   engine, the consumer should default to the engine group's first model. */

import type { TtsModelKey } from './types';

export type { TtsModelKey };
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
    hint: 'Runs on your machine via the voice-engine sidecar — no rate limits',
    models: [
      { id: 'kokoro-v1', label: 'Kokoro v1', hint: 'Default · 28 English voices · quality-tuned' },
      {
        id: 'qwen3-tts-0.6b',
        label: 'Qwen3-TTS 0.6B',
        hint: 'Bespoke per-character voices · designed from a persona',
      },
      {
        id: 'qwen3-tts-1.7b',
        label: 'Qwen3-TTS 1.7B',
        hint: 'Higher quality · better prosody & emotional control · slower',
      },
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

/* Defensive label fallback for model keys that may appear in persisted state
   but are NOT in TTS_MODEL_OPTIONS. Currently empty (1.7B is now exposed in
   TTS_ENGINES alongside 0.6B) — kept as an escape hatch for any future
   quality-tier-only key we'd deliberately exclude from the picker, plus
   stale-state resilience when an older saved default points at a model
   we've since removed. ttsModelLabel still resolves these via the lookup
   below. */
const EXTRA_MODEL_LABELS: Partial<Record<TtsModelKey, string>> = {};

/** Human-readable label for a model key. Falls back to the raw key when an
    unknown id appears (e.g. an older saved state pointing at a model we've
    since removed) so the UI shows *something* identifiable rather than
    blanking. */
export function ttsModelLabel(key: TtsModelKey): string {
  return TTS_MODEL_OPTIONS.find((m) => m.id === key)?.label ?? EXTRA_MODEL_LABELS[key] ?? key;
}

/** The Qwen tier(s) a book's cast will ACTUALLY render in. Per-character
    `ttsModelKey` overrides win over the run-default `modelKey` in synthesis
    (`synthesise-chapter.ts` `routeFor`), so the generation header must reflect
    the effective tier — not the global model picker (which is what made a
    1.7B-pinned cast misleadingly read "0.6B"). Returns one label when the whole
    cast resolves to a single tier, a "Mixed: A + B" label when tiers differ, and
    the plain run-default label when nothing is pinned (byte-identical to the
    pre-override header). */
export function effectiveEngineLabel(
  characters: ReadonlyArray<{ ttsModelKey?: string | null }>,
  modelKey: TtsModelKey,
): string {
  const anyPinned = characters.some((c) => c.ttsModelKey);
  if (!anyPinned) return ttsModelLabel(modelKey);
  const effective = new Set<string>(characters.map((c) => c.ttsModelKey ?? modelKey));
  if (effective.size === 1) return ttsModelLabel([...effective][0] as TtsModelKey);
  return `Mixed: ${[...effective]
    .map((k) => ttsModelLabel(k as TtsModelKey))
    .sort()
    .join(' + ')}`;
}

/* Short, engine-level labels (not model-level) for the mixed-engine chapter
   caption — "Kokoro (1), Qwen (6)". The model labels ("Kokoro v1") are too long
   to repeat per engine in a compact row caption. */
const TTS_ENGINE_LABELS: Record<string, string> = {
  kokoro: 'Kokoro',
  qwen: 'Qwen',
  coqui: 'Coqui',
  gemini: 'Gemini',
  piper: 'Piper',
};

/** Format a per-engine voice-count breakdown as "Kokoro (1), Qwen (6)", sorted
    alphabetically by engine label for stable display. Empty/missing → ''. */
export function formatEngineBreakdown(breakdown?: Record<string, number>): string {
  if (!breakdown) return '';
  return Object.entries(breakdown)
    .map(([engine, count]) => `${TTS_ENGINE_LABELS[engine] ?? engine} (${count})`)
    .sort((a, b) => a.localeCompare(b))
    .join(', ');
}

import { FRONTEND_ACCOUNT_DEFAULTS } from './account-defaults';

/* Single source of truth for the frontend's TTS default — mirrors server's
   DEFAULT_USER_SETTINGS.defaultTtsModelKey via FRONTEND_ACCOUNT_DEFAULTS. */
export const DEFAULT_TTS_MODEL: TtsModelKey = FRONTEND_ACCOUNT_DEFAULTS.defaultTtsModelKey;

/* Mirror of the backend's engineForModelKey — keeps the UI honest about
   which sidecar/cloud it will hit when a sample is requested. Add new
   prefixes here in lockstep with server/src/tts/index.ts. */
export function engineForModelKey(
  key: TtsModelKey,
): 'coqui' | 'piper' | 'kokoro' | 'qwen' | 'gemini' {
  if (key.startsWith('coqui-')) return 'coqui';
  if (key.startsWith('piper-')) return 'piper';
  if (key.startsWith('kokoro-')) return 'kokoro';
  if (key.startsWith('qwen')) return 'qwen';
  return 'gemini';
}

/* Group id (UI-level) for a model key. 'local' for any non-Gemini engine,
   'gemini' otherwise. Used by the selector to pre-select the engine
   dropdown when hydrating from a saved modelKey. */
export function engineGroupForModelKey(key: TtsModelKey): TtsEngineId {
  return engineForModelKey(key) === 'gemini' ? 'gemini' : 'local';
}
