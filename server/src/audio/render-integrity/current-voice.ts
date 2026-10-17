/**
 * #3524 — the ONE place a character's CURRENT cast.json voice is derived from an engine,
 * shared by `scoreBook` (aggregate.ts) and the qa-repair route (chapter-qa-repair.ts).
 *
 * The two callers share the derivation, but not the input: qa-repair passes the engine its
 * request re-records in; `scoreBook` resolves "the engine actually rendered" — the
 * character's own `ttsEngine`, else the scoring run's model key (only for a character that
 * run rendered lines for), else the engine stamped on its most recently rendered lines (what
 * Resume scoring uses, and what every character the run did not render keeps). They agree whenever the
 * book was last rendered on the engine the repair request names, and may differ otherwise
 * (a default switched after the last render): qa-repair then gates against the voice it is
 * about to produce, and scoring against the voice already on disk.
 */
import { buildHintFromCast, toVoiceLike, type CastCharacter } from '../../tts/synthesise-chapter.js';
import { pickVoiceForEngine } from '../../tts/voice-mapping.js';
import { resolveCharacterEngine } from '../../tts/per-character-engine.js';
import { ALL_TTS_ENGINES, type TtsEngine } from '../../tts/model-keys.js';
import { isNonEnglish, resolveEligibleEngines } from '../../tts/language.js';
import { resolveClonedRetargetEngine } from '../../tts/clone-engines.js';

/** The engine a character renders on now: its own `ttsEngine`, else `defaultEngine`
 *  (`undefined` when neither is known). With `bookLanguage` on a non-English book,
 *  generation's retarget runs first (generation.ts, mirrored by chapter-qa-repair.ts): a
 *  character without an eligible `ttsEngine` renders on the eligible clone-capable engine
 *  carrying its cloned slot, else on 'qwen'. */
export function currentCharacterEngine(
  character: CastCharacter,
  defaultEngine: TtsEngine | undefined,
  bookLanguage?: string,
): TtsEngine | undefined {
  if (bookLanguage != null && isNonEnglish(bookLanguage)) {
    const eligibleEngines = resolveEligibleEngines(bookLanguage, ALL_TTS_ENGINES);
    if (character.ttsEngine && eligibleEngines.includes(character.ttsEngine)) return character.ttsEngine;
    return resolveClonedRetargetEngine(character, eligibleEngines, defaultEngine) ?? 'qwen';
  }
  return defaultEngine ? resolveCharacterEngine(character, defaultEngine) : (character.ttsEngine ?? undefined);
}

/** The voice name `character` resolves to now — `undefined` when none (undesigned voice,
 *  or no engine known). */
export function currentCastVoiceName(
  character: CastCharacter,
  defaultEngine: TtsEngine | undefined,
  bookLanguage?: string,
): string | undefined {
  const engine = currentCharacterEngine(character, defaultEngine, bookLanguage);
  if (!engine) return undefined;
  const name = pickVoiceForEngine(engine, toVoiceLike(character), buildHintFromCast(character));
  return name || undefined;
}
