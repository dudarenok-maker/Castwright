/* Compute the set of TTS engines a single chapter requires (plan 108, Wave 3).
 *
 * Engine is a per-character decision (`resolveCharacterEngine`): the narrator
 * may sit on the book default (Kokoro) while a bespoke character speaks through
 * Qwen. A chapter is "multi-TTS" when its speaking characters span more than
 * one engine — the queue surfaces this so the operator knows which engines a
 * chapter needs (and whether enabling dual-model mode avoids engine-swap
 * latency) before it runs.
 *
 * Pure helper — the route stamps the result onto each queue entry at enqueue
 * time from cast.json + the analysis cache for who speaks in the chapter. */

import type { TtsEngine } from './index.js';
import { resolveCharacterEngine, type HasTtsEngine } from './per-character-engine.js';

/** The distinct engines a chapter needs, given its speaking characters and the
    book's default engine. Each character maps through `resolveCharacterEngine`
    (its own `ttsEngine` ?? the default); the result is deduped + sorted so the
    output is stable for persistence + display. An empty `speakingCharacters`
    yields `[]` (unknown — the caller omits the field on the entry). */
export function chapterEngineSet(
  speakingCharacters: HasTtsEngine[],
  defaultEngine: TtsEngine,
): TtsEngine[] {
  const engines = new Set<TtsEngine>();
  for (const c of speakingCharacters) {
    engines.add(resolveCharacterEngine(c, defaultEngine));
  }
  return [...engines].sort();
}

/** A chapter is multi-TTS when its engine set spans more than one engine. */
export function isMultiTts(engines: TtsEngine[]): boolean {
  return engines.length > 1;
}
