/* The server-side palette is a mirror of src/lib/voice-palette.ts; this
   test pins the two MUST-AGREE invariants (per-voice gradient, and
   Coqui↔Gemini bucket+slot identity) so a future edit to one side breaks
   here instead of producing a UI that flickers when the same character
   flips between stub-derived and server-derived data. */

import { describe, it, expect } from 'vitest';
import { gradientForTtsVoice, BUCKET_GRADIENTS } from './voice-palette.js';
import { COQUI_PROFILE_VOICES, GEMINI_PROFILE_VOICES } from './voice-mapping.js';

describe('gradientForTtsVoice (server mirror)', () => {
  it('returns the bucket+slot gradient for known Coqui and Gemini voices', () => {
    expect(gradientForTtsVoice('Viktor Menelaos')).toEqual(BUCKET_GRADIENTS['male-mid'][1]);
    expect(gradientForTtsVoice('Charon')).toEqual(BUCKET_GRADIENTS['male-deep'][0]);
    expect(gradientForTtsVoice('Aoede')).toEqual(BUCKET_GRADIENTS['female-light'][0]);
  });

  it('Coqui and Gemini voices at the same bucket+slot share a gradient', () => {
    expect(gradientForTtsVoice('Damien Black')).toEqual(gradientForTtsVoice('Charon'));
    expect(gradientForTtsVoice('Daisy Studious')).toEqual(gradientForTtsVoice('Kore'));
    expect(gradientForTtsVoice('Asya Anara')).toEqual(gradientForTtsVoice('Algenib'));
  });

  it('every routed Coqui voice resolves to a defined gradient', () => {
    for (const [profile, names] of Object.entries(COQUI_PROFILE_VOICES)) {
      names.forEach((name, idx) => {
        expect(gradientForTtsVoice(name), `${name} (${profile})`).toEqual(
          BUCKET_GRADIENTS[profile as keyof typeof BUCKET_GRADIENTS][idx as 0 | 1],
        );
      });
    }
  });

  it('every routed Gemini voice resolves to a defined gradient', () => {
    for (const [profile, names] of Object.entries(GEMINI_PROFILE_VOICES)) {
      names.forEach((name, idx) => {
        expect(gradientForTtsVoice(name), `${name} (${profile})`).toEqual(
          BUCKET_GRADIENTS[profile as keyof typeof BUCKET_GRADIENTS][idx as 0 | 1],
        );
      });
    }
  });

  it('unknown names fall back to a stable hash of the seed', () => {
    const a = gradientForTtsVoice('Some Custom Voice', 'voice-1');
    const b = gradientForTtsVoice('Some Custom Voice', 'voice-1');
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
  });
});
