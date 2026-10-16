/**
 * #3524 — the ONE place a character's CURRENT cast.json voice is derived, shared by
 * `scoreBook` (aggregate.ts) and the qa-repair route (chapter-qa-repair.ts) so the two
 * cannot disagree about which voice a persisted reference must have been built from.
 */
import { buildHintFromCast, toVoiceLike, type CastCharacter } from '../../tts/synthesise-chapter.js';
import { pickVoiceForEngine } from '../../tts/voice-mapping.js';
import { resolveCharacterEngine } from '../../tts/per-character-engine.js';
import { ALL_TTS_ENGINES, engineForModelKey, type TtsEngine } from '../../tts/model-keys.js';
import { isNonEnglish, resolveEligibleEngines } from '../../tts/language.js';
import { resolveClonedRetargetEngine } from '../../tts/clone-engines.js';
import { getResolvedTtsModelKey } from '../../workspace/user-settings.js';

/** The book's CURRENT default engine, read at call time (never a chapter snapshot's engine). */
export function currentDefaultEngine(): TtsEngine {
  return engineForModelKey(getResolvedTtsModelKey());
}

/** The engine a character renders on now: its own `ttsEngine`, else `defaultEngine`.
 *  With `bookLanguage` on a non-English book, generation's retarget runs first
 *  (generation.ts, mirrored by chapter-qa-repair.ts): a character without an
 *  eligible `ttsEngine` renders on the eligible clone-capable engine carrying its
 *  cloned slot, else on 'qwen'. */
export function currentCharacterEngine(
  character: CastCharacter,
  defaultEngine: TtsEngine,
  bookLanguage?: string,
): TtsEngine {
  if (bookLanguage != null && isNonEnglish(bookLanguage)) {
    const eligibleEngines = resolveEligibleEngines(bookLanguage, ALL_TTS_ENGINES);
    if (character.ttsEngine && eligibleEngines.includes(character.ttsEngine)) return character.ttsEngine;
    return resolveClonedRetargetEngine(character, eligibleEngines, defaultEngine) ?? 'qwen';
  }
  return resolveCharacterEngine(character, defaultEngine);
}

/** The voice name `character` resolves to now — `undefined` when none (undesigned voice). */
export function currentCastVoiceName(
  character: CastCharacter,
  defaultEngine: TtsEngine,
  bookLanguage?: string,
): string | undefined {
  const name = pickVoiceForEngine(
    currentCharacterEngine(character, defaultEngine, bookLanguage),
    toVoiceLike(character),
    buildHintFromCast(character),
  );
  return name || undefined;
}
