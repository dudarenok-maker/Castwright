import { describe, it, expect } from 'vitest';
import { voiceKindFor } from './voice-kind.js';

describe('voiceKindFor', () => {
  it('maps qwen to designed', () => {
    expect(voiceKindFor('qwen')).toBe('designed');
  });
  it('maps a cloned coqui voice to cloned, a preset coqui to preset', () => {
    expect(voiceKindFor('coqui', { cloned: true })).toBe('cloned');
    expect(voiceKindFor('coqui')).toBe('preset');
  });
  it('maps kokoro and gemini to preset', () => {
    expect(voiceKindFor('kokoro')).toBe('preset');
    expect(voiceKindFor('gemini')).toBe('preset');
  });
  it('defaults null/undefined to preset', () => {
    expect(voiceKindFor(null)).toBe('preset');
    expect(voiceKindFor(undefined)).toBe('preset');
  });
});
