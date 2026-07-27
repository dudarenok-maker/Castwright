/* fe-31 (#506) — preview a character's designed Qwen emotion variant straight
   from the manuscript quote chip. Reuses the same cache scope the design route
   wrote (`${baseScope}__${emotion}` + the variant voiceId). The caller passes
   in the modelKey resolved via modelKeyForEngineChoice('qwen', ttsModelKey) —
   the same call the designer (EmotionVariantDesigner via profile-drawer's
   effectiveSampleModelKey) makes — so the chip plays at the session's Qwen
   tier, matching the tier the variant was actually designed and cached at
   (a cache hit, no re-synth, on a warm sidecar). When the character has no
   variant for the chosen emotion we play the BASE voice instead and report
   it, so the caller can surface a "renders neutral" hint (this also serves
   fs-25's 5e missing-variant path). Non-Qwen engines never reach here —
   emotion variants are Qwen-only.

   Deliberately NOT folded into emotion-variant-designer.tsx's inline playVariant:
   that one only auditions a known variant and has the designer's session-id
   bookkeeping; this one adds the base-voice fallback the chip needs. */

import { playSampleWithAutoLoad } from './play-sample-with-auto-load';
import { buildCharacterHint } from './build-character-hint';
import { resolveTtsVoiceForCharacter } from './tts-voice-mapping';
import { sampleScopeFor } from './sample-scope';
import { gradientForTtsVoice } from './voice-palette';
import type { Character, Emotion, TtsModelKey, Voice } from './types';

export interface EmotionVariantPlayResult {
  /** True when the character had no variant for this emotion, so the BASE voice
      played instead (the chip shows a "renders neutral" note). */
  fellBackToBase: boolean;
}

/** Read a character's designed variant voiceId for a non-neutral emotion. */
export function variantVoiceIdFor(
  character: Character,
  emotion: Exclude<Emotion, 'neutral'>,
): string | undefined {
  return character.overrideTtsVoices?.qwen?.variants?.[emotion]?.name;
}

export async function playEmotionVariantSample(
  character: Character,
  emotion: Exclude<Emotion, 'neutral'>,
  playback: { play: (url: string) => Promise<void> },
  /** Resolved via modelKeyForEngineChoice('qwen', ttsModelKey) at the call
      site — the same tier the design route cached the variant at. */
  modelKey: TtsModelKey,
  bookId?: string,
): Promise<EmotionVariantPlayResult> {
  const baseScope = sampleScopeFor(character, bookId);
  const variantVoiceId = variantVoiceIdFor(character, emotion);
  const fellBackToBase = !variantVoiceId;

  /* Variant present → its own scope + voiceId reproduce the design-route cache
     key. Absent → audition the base voice (the neutral identity). */
  const scope = variantVoiceId ? `${baseScope}__${emotion}` : baseScope;
  const stubTtsVoice = resolveTtsVoiceForCharacter(character, 'qwen');
  const voiceName = variantVoiceId ?? stubTtsVoice.name;

  const subject: Voice = {
    id: scope,
    character: character.name,
    bookTitle: '',
    bookId: '',
    attributes: character.attributes ?? [],
    gradient: gradientForTtsVoice(voiceName, scope),
    usedIn: 0,
    source: 'current',
    ttsVoice: stubTtsVoice,
    overrideTtsVoices: { qwen: { name: voiceName } },
  } as Voice;

  await playSampleWithAutoLoad({
    args: {
      voiceId: scope,
      voice: subject,
      modelKey,
      characterHint: buildCharacterHint(character),
    },
    playback,
  });

  return { fellBackToBase };
}
