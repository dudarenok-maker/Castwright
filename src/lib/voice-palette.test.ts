import { describe, it, expect } from 'vitest';
import { gradientForTtsVoice, BUCKET_GRADIENTS } from './voice-palette';
import { COQUI_PROFILE_VOICES, GEMINI_PROFILE_VOICES } from './tts-voice-mapping';

describe('gradientForTtsVoice', () => {
  it('returns the bucket+slot gradient for a Coqui voice name', () => {
    expect(gradientForTtsVoice('Viktor Menelaos')).toEqual(BUCKET_GRADIENTS['male-mid'][1]);
    expect(gradientForTtsVoice('Damien Black')).toEqual(BUCKET_GRADIENTS['male-deep'][0]);
    expect(gradientForTtsVoice('Claribel Dervla')).toEqual(BUCKET_GRADIENTS['female-light'][0]);
  });

  it('returns the bucket+slot gradient for a Gemini voice name', () => {
    expect(gradientForTtsVoice('Charon')).toEqual(BUCKET_GRADIENTS['male-deep'][0]);
    expect(gradientForTtsVoice('Aoede')).toEqual(BUCKET_GRADIENTS['female-light'][0]);
    expect(gradientForTtsVoice('Sulafat')).toEqual(BUCKET_GRADIENTS['narrator-warm'][1]);
  });

  it('Coqui and Gemini voices in the same bucket+slot share a gradient', () => {
    /* Two characters that hash to the same slot should keep the same swatch
       when the user toggles between engines — the engine swaps the audio,
       not the visual identity. */
    expect(gradientForTtsVoice('Damien Black')).toEqual(gradientForTtsVoice('Charon'));
    expect(gradientForTtsVoice('Aaron Dreschner')).toEqual(gradientForTtsVoice('Puck'));
    expect(gradientForTtsVoice('Alison Dietlinde')).toEqual(gradientForTtsVoice('Callirrhoe'));
    expect(gradientForTtsVoice('Asya Anara')).toEqual(gradientForTtsVoice('Algenib'));
  });

  it('two different voices within the same bucket get different gradients', () => {
    expect(gradientForTtsVoice('Damien Black')).not.toEqual(gradientForTtsVoice('Wulf Carlevaro'));
    expect(gradientForTtsVoice('Claribel Dervla')).not.toEqual(
      gradientForTtsVoice('Alison Dietlinde'),
    );
  });

  it('every routed Coqui voice maps to a defined gradient', () => {
    for (const profile of Object.keys(COQUI_PROFILE_VOICES) as Array<
      keyof typeof COQUI_PROFILE_VOICES
    >) {
      for (const name of COQUI_PROFILE_VOICES[profile]) {
        const grad = gradientForTtsVoice(name);
        expect(grad, `${name} (${profile}) should resolve to a bucket gradient`).toEqual(
          BUCKET_GRADIENTS[profile][COQUI_PROFILE_VOICES[profile].indexOf(name) as 0 | 1],
        );
      }
    }
  });

  it('every routed Gemini voice maps to a defined gradient', () => {
    for (const profile of Object.keys(GEMINI_PROFILE_VOICES) as Array<
      keyof typeof GEMINI_PROFILE_VOICES
    >) {
      for (const name of GEMINI_PROFILE_VOICES[profile]) {
        const grad = gradientForTtsVoice(name);
        expect(grad, `${name} (${profile}) should resolve to a bucket gradient`).toEqual(
          BUCKET_GRADIENTS[profile][GEMINI_PROFILE_VOICES[profile].indexOf(name) as 0 | 1],
        );
      }
    }
  });

  it('unknown voice names fall back to a stable hash gradient', () => {
    const a = gradientForTtsVoice('Some Custom Voice', 'seed-a');
    const b = gradientForTtsVoice('Some Custom Voice', 'seed-a');
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });

  it('uses the fallback seed when no name is provided', () => {
    const a = gradientForTtsVoice(undefined, 'voice-id-1');
    const b = gradientForTtsVoice(undefined, 'voice-id-1');
    const c = gradientForTtsVoice(undefined, 'voice-id-2');
    expect(a).toEqual(b);
    /* Not asserting a !== c — the 8-entry fallback palette has collisions —
       but the call must still return a valid 2-tuple. */
    expect(c).toHaveLength(2);
  });
});
