/* Resolve the TTS engine for a single character (plan 108).

   Engine used to be one global choice per generation run (the request's
   modelKey → one engine for the whole book). Plan 108 makes it a PER-CHARACTER
   decision: the narrator can stay on Kokoro while a bespoke character speaks
   through Qwen, all in one chapter. Each cast member may carry its own
   `ttsEngine`; absent it, the character falls back to the project/book default
   engine — so a cast with no per-character engines behaves exactly as before
   (backward compatible). */

import type { TtsEngine } from './index.js';
import { canonicalModelKeyForEngine, higherQwenTier, type TtsModelKey } from './model-keys.js';

export interface HasTtsEngine {
  /** Optional per-character engine override. When unset, the character uses
      the generation run's default engine. */
  ttsEngine?: TtsEngine | null;
}

/** The engine a character should be synthesised with: its own `ttsEngine` when
    set, else the run's default. Pure + total over the union. */
export function resolveCharacterEngine(
  character: HasTtsEngine,
  projectDefaultEngine: TtsEngine,
): TtsEngine {
  return character.ttsEngine ?? projectDefaultEngine;
}

export interface HasQwenTier extends HasTtsEngine {
  /** fs-56 per-character Qwen quality-tier override — see model-keys.ts's
      `higherQwenTier` for the elevate-only precedence rule. */
  ttsModelKey?: TtsModelKey | null;
}

/** Which Qwen base tier(s) a cast will actually need this run, resolved with
    the SAME elevate-only precedence `synthesise-chapter.ts`'s `routeFor` uses
    (`higherQwenTier`) — a character's own tier can only raise it above
    `runDefaultQwenModelKey`, never pull it below. Used by the run-start VRAM
    hygiene step (generation.ts) to decide which resident tier(s) to keep;
    computing this with plain `c.ttsModelKey` (ignoring the run default) let
    that step evict the tier routeFor was about to request, forcing a cold
    mid-run reload it exists specifically to avoid (side-11 follow-up). */
export function computeUsedQwenTiers(
  characters: HasQwenTier[],
  projectDefaultEngine: TtsEngine,
  runDefaultQwenModelKey: TtsModelKey,
): { keep06: boolean; keep17: boolean } {
  let keep06 = false;
  let keep17 = false;
  for (const c of characters) {
    if (resolveCharacterEngine(c, projectDefaultEngine) !== 'qwen') continue;
    const key = resolveCharacterQwenTier(c, runDefaultQwenModelKey);
    if (key === 'qwen3-tts-0.6b') keep06 = true;
    if (key === 'qwen3-tts-1.7b') keep17 = true;
  }
  return { keep06, keep17 };
}

/** The Qwen quality tier a character renders under, resolved with the SAME
    elevate-only precedence `synthesise-chapter.ts`'s `routeFor` uses: a per-
    character `ttsModelKey` can only RAISE the character above `runModelKey`,
    never lower it; a character with no `ttsModelKey` rides the run default.
    Callers gate on the character routing to Qwen. Single definition shared by
    `routeFor` (the synth path), `computeUsedQwenTiers` (run-start VRAM hygiene),
    and `buildCharacterSnapshots` (the per-character render-tier stamp) so the
    three can never drift — a drift is exactly what let the srv-36 audition
    render on the wrong tier (0.6B co-resident with a 1.7B render → 8GB OOM). */
export function resolveCharacterQwenTier(
  character: HasQwenTier,
  runModelKey: TtsModelKey,
): TtsModelKey {
  return character.ttsModelKey
    ? higherQwenTier(canonicalModelKeyForEngine('qwen', character.ttsModelKey), runModelKey)
    : runModelKey;
}
