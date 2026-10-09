import { describe, it, expect } from 'vitest';
import { parseSubstagePhaseEvent } from './api';

describe('parseSubstagePhaseEvent engine tag (#3084 PR 3a)', () => {
  it('keeps an openai engine tag', () => {
    expect(parseSubstagePhaseEvent({ progress: 0.5, engine: 'openai' })?.engine).toBe('openai');
  });
  it('still keeps local and gemini, and drops anything else', () => {
    expect(parseSubstagePhaseEvent({ progress: 0.5, engine: 'local' })?.engine).toBe('local');
    expect(parseSubstagePhaseEvent({ progress: 0.5, engine: 'gemini' })?.engine).toBe('gemini');
    expect(parseSubstagePhaseEvent({ progress: 0.5, engine: 'coqui' })?.engine).toBeUndefined();
  });
});
