/* Resolve the TTS engine for a single character (plan 108).

   Engine used to be one global choice per generation run (the request's
   modelKey → one engine for the whole book). Plan 108 makes it a PER-CHARACTER
   decision: the narrator can stay on Kokoro while a bespoke character speaks
   through Qwen, all in one chapter. Each cast member may carry its own
   `ttsEngine`; absent it, the character falls back to the project/book default
   engine — so a cast with no per-character engines behaves exactly as before
   (backward compatible). */

import type { TtsEngine } from './index.js';

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
