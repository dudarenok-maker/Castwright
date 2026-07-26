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

/** The per-character tier resolution shared by `effectiveEngineLabel` and
    `effectiveModelKey`. `ttsModelKey` is documented as "Ignored for non-Qwen
    characters" (openapi `CastCharacter.ttsModelKey`) — synthesis's `routeFor`
    (`synthesise-chapter.ts`) only reads it when the character actually
    resolves to the Qwen engine, so a character since moved to another engine
    can carry a stale leftover value that must NOT count as a pin — and must
    NOT contribute to the Set at all (folding it in as a fallback `modelKey`
    entry would falsely manufacture a "Mixed" tier out of a cast that's
    uniformly on Qwen plus an unrelated non-Qwen character). A character's
    engine resolves the same way `resolveCharacterEngine` does server-side:
    its own `ttsEngine` when set, else the run default. A cast with no
    Qwen-routed character at all (or an empty cast) falls back to the plain
    run-default `modelKey`, matching the pre-override behaviour. */
function effectiveModelKeySet(
  characters: ReadonlyArray<{ ttsModelKey?: string | null; ttsEngine?: string | null }>,
  modelKey: TtsModelKey,
): Set<string> {
  const defaultEngine = engineForModelKey(modelKey);
  const qwenTiers = characters
    .filter((c) => (c.ttsEngine ?? defaultEngine) === 'qwen')
    .map((c) => c.ttsModelKey ?? modelKey);
  return new Set<string>(qwenTiers.length > 0 ? qwenTiers : [modelKey]);
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
  characters: ReadonlyArray<{ ttsModelKey?: string | null; ttsEngine?: string | null }>,
  modelKey: TtsModelKey,
): string {
  const effective = effectiveModelKeySet(characters, modelKey);
  if (effective.size === 1) return ttsModelLabel([...effective][0] as TtsModelKey);
  return `Mixed: ${[...effective]
    .map((k) => ttsModelLabel(k as TtsModelKey))
    .sort()
    .join(' + ')}`;
}

/** The single model key `effectiveEngineLabel` resolves to, for callers that
    need a comparable key rather than a display string — namely engine-drift
    detection (generation.tsx), which was comparing recorded chapter audio
    against the raw run-default `modelKey` and so flagged a whole cast pinned
    to 1.7B as "drifted" against a stale 0.6B default (misreported as a
    downgrade). Falls back to the raw `modelKey` when the cast fans out across
    tiers (mirrors the label's "Mixed" case, which has no single key to give). */
export function effectiveModelKey(
  characters: ReadonlyArray<{ ttsModelKey?: string | null; ttsEngine?: string | null }>,
  modelKey: TtsModelKey,
): TtsModelKey {
  const effective = effectiveModelKeySet(characters, modelKey);
  return effective.size === 1 ? ([...effective][0] as TtsModelKey) : modelKey;
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

import type { TtsEngine } from './types';

/* Ordinal rank of the two Qwen quality tiers — 1.7B outranks 0.6B. Non-Qwen
   keys rank 0 (never meaningfully compared; callers only invoke this once both
   sides are known to be Qwen tiers). Mirror of server/src/tts/model-keys.ts. */
function qwenTierRank(key: TtsModelKey): number {
  return key === 'qwen3-tts-1.7b' ? 1 : 0;
}

/* The higher-ranked of two Qwen model keys. Mirror of the backend's
   higherQwenTier (server/src/tts/model-keys.ts): a per-character tier override
   is meant to ELEVATE one character above the run's default, so a character
   whose stored tier happens to be the lower one (stale, or simply never
   elevated) can never drag a run explicitly started at the higher tier back
   down. Ties keep `a`. */
export function higherQwenTier(a: TtsModelKey, b: TtsModelKey): TtsModelKey {
  return qwenTierRank(a) >= qwenTierRank(b) ? a : b;
}

/* THE frontend engine→modelKey mapper — mirror of the backend's
   canonicalModelKeyForEngine (server/src/tts/model-keys.ts). Resolves an engine
   CHOICE ('default' = use the session default; any real TtsEngine = a
   per-character override) to the concrete TtsModelKey that will ACTUALLY route.

   This is the only such mapper on the frontend. `sampleModelKeyForEngine`
   (formerly src/lib/tts-voice-mapping.ts) was a lossy second copy that returned
   the SESSION key for every non-Qwen engine — so a book on Coqui with a
   character overridden to Kokoro auditioned in Coqui (#1839). Add new engines
   here and in the server mirror together; there is nowhere else to add them.

   TWO CALLER SHAPES, and the difference matters:

   - Audition / design call sites pass TWO arguments. Their result is a shared
     CACHE KEY (server/src/tts/voice-sample-cache.ts) — the sample player and
     the design routes must land on one filename — so the tier must come from
     the session key alone. Passing a per-character tier there would split the
     key, since bulk design sends one modelKey for N characters.
   - The cloned-voice assign guard passes THREE, carrying a pending per-character
     1.7B pin. That guard reads only the ENGINE half
     (server/src/routes/voice-library.ts:886), so the tier is inert for it. */
export function modelKeyForEngineChoice(
  engineChoice: 'default' | TtsEngine,
  sessionModelKey: TtsModelKey,
  characterTier?: TtsModelKey | null,
): TtsModelKey {
  if (engineChoice === 'default') return sessionModelKey;
  switch (engineChoice) {
    case 'kokoro':
      return 'kokoro-v1';
    case 'qwen': {
      /* A non-Qwen session key carries no tier, so the 0.6B base is the floor. */
      const sessionTier: TtsModelKey = sessionModelKey.startsWith('qwen')
        ? sessionModelKey
        : 'qwen3-tts-0.6b';
      return higherQwenTier(characterTier ?? sessionTier, sessionTier);
    }
    case 'coqui':
      return 'coqui-xtts-v2';
    case 'piper':
      return 'piper-en-us-medium';
    case 'gemini':
      return sessionModelKey.startsWith('gemini-') ? sessionModelKey : 'gemini-2.5-flash';
    default:
      return sessionModelKey;
  }
}
