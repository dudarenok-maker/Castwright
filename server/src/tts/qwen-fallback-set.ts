/* Compute which speaking characters in a chapter would SILENTLY fall back from
 * Qwen to Kokoro (plan: per-chapter loud fallback gate).
 *
 * A character routed to the Qwen engine that has NO designed Qwen voice
 * (`pickVoiceForEngine('qwen', …) === ''`) renders in Kokoro with a generic
 * profile voice instead of a bespoke designed voice — see `applyQwenFallback`
 * in synthesise-chapter.ts. That fallback used to be silent (the segment was
 * merely stamped `renderedFallbackEngine='kokoro'`). The generation worker now
 * uses this helper to detect the undesigned-voice fallback set BEFORE synth so
 * it can pause the chapter and ask the user to confirm or skip.
 *
 * SCOPE: this covers ONLY the per-character undesigned-voice case while Qwen is
 * healthy. The whole-cast `qwenUnavailable` case (Qwen not installed / load
 * failed) already raises its own loud all-cast warning in generation.ts
 * (`qwen_unavailable_kokoro_fallback`, plan 135) — the worker skips this helper
 * entirely when `qwenUnavailable`, so the two paths never double-report. */

import { buildHintFromCast, toVoiceLike, type CastCharacter } from './synthesise-chapter.js';
import { pickVoiceForEngine } from './voice-mapping.js';
import { resolveCharacterEngine } from './per-character-engine.js';
import type { TtsEngine } from './index.js';

export interface QwenFallbackChar {
  id: string;
  name?: string;
}

/** The characters in `speakingCharacters` that resolve to the Qwen engine but
 *  carry no designed Qwen voice — i.e. those that would silently render in
 *  Kokoro. Sorted by id for stable display + persistence.
 *
 *  `speakingCharacters` MUST be narrowed to the chapter's actual speakers
 *  (cast members whose id appears in the chapter's sentences) and MUST be the
 *  hydrated cast (a reused Qwen voice only carries its designed name after
 *  `hydrateCastReusedVoices`). Callers pass `qwenUnavailable === false` runs
 *  only — see the module note. */
export function computeQwenKokoroFallbackSet(
  speakingCharacters: CastCharacter[],
  defaultEngine: TtsEngine,
): QwenFallbackChar[] {
  const out: QwenFallbackChar[] = [];
  for (const c of speakingCharacters) {
    if (resolveCharacterEngine(c, defaultEngine) !== 'qwen') continue;
    const voice = pickVoiceForEngine('qwen', toVoiceLike(c), buildHintFromCast(c));
    if (voice === '') out.push({ id: c.id, name: c.name });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
