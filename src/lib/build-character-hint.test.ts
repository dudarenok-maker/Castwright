/* buildCharacterHint extraction — protects the contract that drawer +
   compare modal use to feed dirty edits into a sample request without
   mutating the source Character. */

import { describe, it, expect } from 'vitest';
import { buildCharacterHint } from './build-character-hint';
import type { Character } from './types';

const base: Character = {
  id: 'c1',
  name: 'Halloran',
  role: 'Witness',
  color: 'halloran',
  attributes: ['gruff', 'tired'],
  description: 'A weary detective.',
  gender: 'male',
  ageRange: 'adult',
  tone: { warmth: 30, pace: 40, authority: 70, emotion: 35 },
  evidence: [{ quote: 'A real spoken line.' }, { quote: '' }, { quote: 'Another line.' }],
};

describe('buildCharacterHint', () => {
  it('returns the expected shape and filters empty evidence quotes', () => {
    const hint = buildCharacterHint(base);
    expect(hint).toEqual({
      description: 'A weary detective.',
      role: 'Witness',
      gender: 'male',
      ageRange: 'adult',
      tone: { warmth: 30, pace: 40, authority: 70, emotion: 35 },
      evidence: ['A real spoken line.', 'Another line.'],
    });
  });

  it('omits evidence when there are no non-empty quotes', () => {
    const hint = buildCharacterHint({ ...base, evidence: [{ quote: '' }] });
    expect(hint.evidence).toBeUndefined();
  });

  it('overrides replace gender/ageRange/tone for the returned hint', () => {
    const hint = buildCharacterHint(base, {
      gender: 'female',
      ageRange: 'elderly',
      tone: { warmth: 80, pace: 50, authority: 50, emotion: 60 },
    });
    expect(hint.gender).toBe('female');
    expect(hint.ageRange).toBe('elderly');
    expect(hint.tone).toEqual({ warmth: 80, pace: 50, authority: 50, emotion: 60 });
  });

  it('does not mutate the input character when overrides are passed', () => {
    const original = JSON.parse(JSON.stringify(base));
    buildCharacterHint(base, { gender: 'female', tone: { warmth: 99 } });
    expect(base).toEqual(original);
  });

  it('falls back to stored fields when overrides are omitted', () => {
    const hint = buildCharacterHint(base, { tone: { warmth: 10 } });
    expect(hint.gender).toBe('male');
    expect(hint.ageRange).toBe('adult');
    expect(hint.tone).toEqual({ warmth: 10 });
  });
});
