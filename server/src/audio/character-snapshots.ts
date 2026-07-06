/* Build the per-character `CharacterSnapshot` map that lands in a chapter's
   `<slug>.segments.json`. The drift detector (routes/revisions.ts) diffs these
   snapshots against the live cast to decide which chapters a voice change
   stranded, so the shape here is load-bearing.

   Extracted from generation.ts so the fs-26 splice path produces byte-identical
   snapshots (same resolved voice name, same sorted attributes, same per-
   character engine) — a re-recorded or re-mixed chapter must update the
   detector exactly as a full regen does. Pure: no fs, no synthesis. */

import { toVoiceLike, buildHintFromCast, type CastCharacter } from '../tts/synthesise-chapter.js';
import { pickVoiceForEngine } from '../tts/voice-mapping.js';
import { resolveCharacterEngine, resolveCharacterQwenTier } from '../tts/per-character-engine.js';
import { canonicalModelKeyForEngine, type TtsEngine, type TtsModelKey } from '../tts/index.js';
import type { CharacterSnapshot } from './segments-io.js';

/** Snapshot every character that actually spoke in a render.
    @param characters   the full cast
    @param speakingIds  ids of characters with at least one rendered segment
    @param defaultEngine the run's default engine (per-character engine wins)
    @param fallbackByChar characterId → engine it ACTUALLY rendered in when it
           differs from its configured engine (Qwen→Kokoro fallback).
    @param runModelKey the run's request model key — used to resolve each
           character's EFFECTIVE render tier (via `resolveCharacterQwenTier`,
           the same elevate-only rule `routeFor` synthesises under), stamped
           onto the snapshot so the srv-36 audition centroid renders on that
           exact tier rather than a hardcoded 0.6B (the 8GB co-residency OOM). */
export function buildCharacterSnapshots(
  characters: CastCharacter[],
  speakingIds: Set<string>,
  defaultEngine: TtsEngine,
  fallbackByChar: Map<string, string>,
  runModelKey: TtsModelKey,
): Record<string, CharacterSnapshot> {
  const snapshots: Record<string, CharacterSnapshot> = {};
  for (const c of characters) {
    if (!speakingIds.has(c.id)) continue;
    const charEngine = resolveCharacterEngine(c, defaultEngine);
    const resolvedVoiceName = pickVoiceForEngine(charEngine, toVoiceLike(c), buildHintFromCast(c));
    /* The model key this character ACTUALLY renders under: for Qwen, the
       elevate-only per-character tier; for any other engine, that engine's
       canonical key. Mirrors `routeFor` by construction (shared helper). */
    const modelKey: TtsModelKey =
      charEngine === 'qwen'
        ? resolveCharacterQwenTier(c, runModelKey)
        : canonicalModelKeyForEngine(charEngine, runModelKey);
    snapshots[c.id] = {
      tone: c.tone,
      gender: c.gender,
      ageRange: c.ageRange,
      voiceId: c.voiceId,
      voiceEngine: charEngine,
      modelKey,
      resolvedVoiceName: resolvedVoiceName || undefined,
      renderedFallbackEngine: fallbackByChar.get(c.id),
      /* Sorted for stable comparison — the analyzer's attribute order isn't
         deterministic across runs, so without the sort an order-only change
         would look like drift to the detector. */
      attributes:
        Array.isArray(c.attributes) && c.attributes.length
          ? [...c.attributes].sort((a, b) => a.localeCompare(b))
          : undefined,
    };
  }
  return snapshots;
}
