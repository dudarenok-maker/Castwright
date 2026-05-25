/* Profile inference contract — guards the compare modal's ability to
   label why two cast members landed on the same resolved voice.

   The server's voice-mapping.ts is the source of truth; this client port
   must stay in sync with it. These tests pin the gender / register / tone
   inference rules that downstream UI labels depend on. */

import { describe, it, expect } from 'vitest';
import {
  inferProfile,
  resolveProfileForCharacter,
  resolveTtsVoiceForCharacter,
  sampleModelKeyForEngine,
  QWEN_MODEL_KEY,
  COQUI_PROFILE_VOICES,
} from './tts-voice-mapping';
import type { Character } from './types';

describe('inferProfile', () => {
  it('maps explicit male + elderly into the male-deep bucket', () => {
    expect(inferProfile({ id: 'x', gender: 'male', ageRange: 'elderly' })).toBe('male-deep');
  });

  it('maps explicit male + child into the male-light bucket', () => {
    expect(inferProfile({ id: 'x', gender: 'male', ageRange: 'child' })).toBe('male-light');
  });

  it('maps explicit female + adult with no register hints into female-mid', () => {
    expect(inferProfile({ id: 'x', gender: 'female', ageRange: 'adult' })).toBe('female-mid');
  });

  it('routes the narrator id with high warmth to narrator-warm when gender is absent', () => {
    expect(
      inferProfile({
        id: 'narrator',
        name: 'Narrator',
        tone: { warmth: 70, pace: 50, authority: 40, emotion: 50 },
      }),
    ).toBe('narrator-warm');
  });

  it('routes the narrator id to narrator-cool when warmth is low', () => {
    expect(
      inferProfile({
        id: 'narrator',
        name: 'Narrator',
        tone: { warmth: 20, pace: 50, authority: 80, emotion: 30 },
      }),
    ).toBe('narrator-cool');
  });

  it('respects explicit female gender even on the narrator id', () => {
    /* The narrator short-circuit only fires when no gender is set —
       once the user picks one, the bucket should follow gender×register. */
    expect(
      inferProfile({
        id: 'narrator',
        name: 'Narrator',
        gender: 'female',
      }),
    ).toBe('female-mid');
  });

  it('respects explicit female gender over attribute-derived male tokens', () => {
    expect(
      inferProfile({
        id: 'x',
        gender: 'female',
        attributes: ['his', 'man'],
        description: 'He spoke gruffly.',
      }),
    ).toBe('female-mid');
  });
});

const sampleCharacter: Character = {
  id: 'c1',
  name: 'Halloran',
  role: 'Detective',
  color: 'halloran',
  attributes: ['gruff'],
  gender: 'male',
  ageRange: 'elderly',
};

describe('resolveProfileForCharacter', () => {
  it('returns the same bucket inferProfile picks from the character mapping', () => {
    expect(resolveProfileForCharacter(sampleCharacter)).toBe('male-deep');
  });

  it('agrees with resolveTtsVoiceForCharacter — picked voice belongs to the returned bucket', () => {
    const profile = resolveProfileForCharacter(sampleCharacter);
    const voice = resolveTtsVoiceForCharacter(sampleCharacter, 'coqui');
    expect(COQUI_PROFILE_VOICES[profile]).toContain(voice.name);
  });
});

describe('sampleModelKeyForEngine', () => {
  it('routes Qwen to the bespoke Qwen model key regardless of the project key', () => {
    expect(sampleModelKeyForEngine('qwen', 'kokoro-v1')).toBe(QWEN_MODEL_KEY);
    expect(sampleModelKeyForEngine('qwen', 'coqui-xtts-v2')).toBe('qwen3-tts-0.6b');
  });

  it('keeps the project model key for every non-Qwen engine', () => {
    expect(sampleModelKeyForEngine('kokoro', 'kokoro-v1')).toBe('kokoro-v1');
    expect(sampleModelKeyForEngine('coqui', 'coqui-xtts-v2')).toBe('coqui-xtts-v2');
    expect(sampleModelKeyForEngine('gemini', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
  });
});
