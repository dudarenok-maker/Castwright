import { describe, it, expect } from 'vitest';
import { designWillGeneratePersona } from './design-persona';

describe('designWillGeneratePersona', () => {
  const roster = [
    { id: 'a', voiceStyle: 'a warm alto' },
    { id: 'b', voiceStyle: '   ' },
    { id: 'c' },
  ];

  it('is false when every target already has a voice description', () => {
    expect(designWillGeneratePersona(roster, ['a'])).toBe(false);
  });

  it('is true when any target has a blank, whitespace-only or absent voice description', () => {
    expect(designWillGeneratePersona(roster, ['a', 'b'])).toBe(true);
    expect(designWillGeneratePersona(roster, ['c'])).toBe(true);
  });

  it('is false with no targets', () => {
    expect(designWillGeneratePersona(roster, [])).toBe(false);
  });

  it('assumes a target the roster does not hold needs one', () => {
    expect(designWillGeneratePersona(roster, ['ghost'])).toBe(true);
    expect(designWillGeneratePersona(undefined, ['a'])).toBe(true);
  });
});
