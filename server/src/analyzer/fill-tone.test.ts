import { describe, it, expect } from 'vitest';
import type { CharacterOutput } from '../handoff/schemas.js';
import { fillToneFromAttributes } from './fill-tone.js';

const c = (over: Partial<CharacterOutput>): CharacterOutput => ({
  id: 'a',
  name: 'A',
  role: 'r',
  color: 'c',
  ...over,
}) as CharacterOutput;

describe('fillToneFromAttributes', () => {
  it('derives a non-neutral tone from EN + RU descriptors', () => {
    const out = fillToneFromAttributes(c({ attributes: ['weary', 'прагматичный'] }));
    expect(out.tone).toBeDefined();
    expect(out.tone!.pace).toBeLessThan(50); // weary → slower
    expect(out.tone!.authority).toBeGreaterThan(50); // pragmatic → more authority
    [out.tone!.warmth, out.tone!.pace, out.tone!.authority, out.tone!.emotion].forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    });
  });

  it('fills only missing axes; leaves present axes untouched', () => {
    const out = fillToneFromAttributes(c({ tone: { warmth: 80 }, attributes: ['playful'] }));
    expect(out.tone!.warmth).toBe(80); // preserved
    expect(out.tone!.emotion).toBeGreaterThan(50); // playful → more emotion (was missing)
  });

  it('yields neutral 50s when there are no usable attributes', () => {
    const out = fillToneFromAttributes(c({}));
    expect(out.tone).toEqual({ warmth: 50, pace: 50, authority: 50, emotion: 50 });
  });
});
