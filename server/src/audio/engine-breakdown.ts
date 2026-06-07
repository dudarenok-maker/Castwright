/* Per-chapter engine breakdown for the drift signal (false-drift fix, 2026-06-07).

   Plan 35 detects engine drift by comparing a chapter's `audioModelKey` against
   the project's current engine. That stamp used to be the generation request's
   DEFAULT engine, which is wrong once per-character engine routing (plan 108)
   sends a chapter's audio to a different engine than the project default — e.g.
   a narration-only chapter whose narrator has `ttsEngine: 'qwen'`, regenerated
   while the project default is Kokoro: it renders 100% on Qwen but stamped
   `kokoro-v1`, producing a false "Generated with Kokoro" badge.

   These pure helpers derive the truth from the per-character render snapshots:
   - `engineBreakdownFromSnapshots` — distinct speaking characters per engine
     they ACTUALLY rendered in (fallback engine wins). Drives the mixed-engine
     "Kokoro (1), Qwen (6)" display and the corrected stamp below.
   - `effectiveAudioModelKey` — the chapter-wide drift stamp: the single engine's
     canonical key when uniform; the request key when mixed (a single key can't
     represent a genuinely multi-engine chapter, so drift falls back to today's
     behaviour and the breakdown carries the detail). */

import {
  canonicalModelKeyForEngine,
  type TtsEngine,
  type TtsModelKey,
} from '../tts/model-keys.js';

/** Minimal structural view of a render snapshot — the engine fields only. */
interface SnapshotEngineView {
  voiceEngine?: string;
  /** Engine it actually rendered in when it differs from `voiceEngine`
      (Qwen→Kokoro fallback). When set, it — not `voiceEngine` — is the truth. */
  renderedFallbackEngine?: string;
}

export type AudioEngineBreakdown = Partial<Record<TtsEngine, number>>;

/** Count distinct speaking characters per engine they actually rendered in.
    Snapshots without a resolvable engine are skipped. */
export function engineBreakdownFromSnapshots(
  snapshots: Record<string, SnapshotEngineView>,
): AudioEngineBreakdown {
  const breakdown: AudioEngineBreakdown = {};
  for (const snap of Object.values(snapshots)) {
    const engine = (snap.renderedFallbackEngine ?? snap.voiceEngine) as TtsEngine | undefined;
    if (!engine) continue;
    breakdown[engine] = (breakdown[engine] ?? 0) + 1;
  }
  return breakdown;
}

/** The chapter-wide model key to stamp for drift detection. When every speaking
    character rendered in ONE engine, return that engine's canonical key (the
    fix). When the chapter mixes engines (or has no speakers), keep the request
    key — the breakdown map carries the per-engine detail for display. */
export function effectiveAudioModelKey(
  breakdown: AudioEngineBreakdown,
  requestModelKey: TtsModelKey,
): TtsModelKey {
  const engines = Object.keys(breakdown) as TtsEngine[];
  return engines.length === 1
    ? canonicalModelKeyForEngine(engines[0], requestModelKey)
    : requestModelKey;
}
