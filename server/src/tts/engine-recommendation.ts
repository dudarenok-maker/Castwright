/* fe-51 (Part B) — language-aware voice-engine recommendation. Pure over authored
   capability (voice-engine-registry) + derived multilingual (ENGINE_LANGUAGE_SUPPORT)
   + detected VRAM. Precomputes BOTH answers to the wizard's one guided question so
   the client renders off the models-status payload with no extra round-trip.

   Capability is a HARD filter (never recommend an engine that can't meet the need);
   VRAM is a SOFT preference (caveat only, never reorders). Qwen leads the capable
   branch, Coqui is the optional alternate (#1614). */
import { VOICE_ENGINES, type VoiceEngineId, type VoiceEngineEntry } from './voice-engine-registry.js';
import { ENGINE_LANGUAGE_SUPPORT } from './voice-mapping.js';
import { DEFAULT_LANGUAGE } from './language.js';

export type NeedsAnswer = 'expressive-or-multilingual' | 'simple-english';

export interface EngineRecommendation {
  engine: VoiceEngineId;
  modelKey: VoiceEngineEntry['defaultModelKey'];
  reason: string;
  caveat: string | null;
  alternate: VoiceEngineId | null;
}

export interface RecommendationSet {
  expressiveOrMultilingual: EngineRecommendation;
  simpleEnglish: EngineRecommendation;
}

/* CPU caveat for a low/no-VRAM Qwen recommendation. Honest per the product owner:
   Qwen runs on CPU (slower) via the voice-engine device setting; Kokoro is the fast
   English-only escape hatch. This is a caveat, NOT a downgrade — the CPU-only case
   still LEADS Qwen (deliberate revision of the spec's case-4 "CPU-only → Kokoro",
   because Kokoro can't serve a non-English book at all and the one guided question
   can't tell non-English from expressive-English). */
const CAVEAT_VRAM =
  "May not fit this GPU's memory — you can run Qwen on CPU (slower) via the voice-engine " +
  'device setting, or pick Kokoro below for fast English-only voices.';

const byId = new Map<VoiceEngineId, VoiceEngineEntry>(VOICE_ENGINES.map((e) => [e.id, e]));

/** Derived, not stored: an engine is multilingual if it supports any language
    beyond English in ENGINE_LANGUAGE_SUPPORT ('*' or a non-'en' entry). */
export function isMultilingualEngine(id: VoiceEngineId): boolean {
  const support = ENGINE_LANGUAGE_SUPPORT[id];
  if (support === '*') return true;
  return support.some((lang) => lang !== DEFAULT_LANGUAGE);
}

export function recommendEngines(vramTotalMb: number | null): RecommendationSet {
  // Capable = expressive OR multilingual (DERIVED — a future qualifying engine joins
  // automatically), ordered by authored capablePreferenceRank (Qwen 0, Coqui 1).
  const capable = VOICE_ENGINES.filter(
    (e) => e.expressive || isMultilingualEngine(e.id),
  ).sort((a, b) => a.capablePreferenceRank - b.capablePreferenceRank);

  const lead = capable[0];
  const alternate: VoiceEngineId | null = capable[1]?.id ?? null;

  const fits = vramTotalMb != null && vramTotalMb >= lead.genVramFloorMb;

  const kokoro = byId.get('kokoro')!;

  return {
    expressiveOrMultilingual: {
      engine: lead.id,
      modelKey: lead.defaultModelKey,
      reason: 'Expressive and multilingual — the multi-cast default.',
      caveat: fits ? null : CAVEAT_VRAM,
      alternate,
    },
    simpleEnglish: {
      engine: 'kokoro',
      modelKey: kokoro.defaultModelKey,
      reason: 'Fast and light — runs comfortably on low VRAM or CPU.',
      caveat: null,
      alternate: null,
    },
  };
}
