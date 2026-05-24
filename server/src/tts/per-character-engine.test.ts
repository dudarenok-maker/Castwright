import { describe, it, expect } from 'vitest';
import { resolveCharacterEngine } from './per-character-engine.js';

describe('resolveCharacterEngine (plan 108)', () => {
  it('uses the character ttsEngine when set', () => {
    expect(resolveCharacterEngine({ ttsEngine: 'qwen' }, 'kokoro')).toBe('qwen');
  });

  it('falls back to the run default when ttsEngine is absent (back-compat)', () => {
    expect(resolveCharacterEngine({}, 'kokoro')).toBe('kokoro');
    expect(resolveCharacterEngine({ ttsEngine: null }, 'coqui')).toBe('coqui');
  });
});
