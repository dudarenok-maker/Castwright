import { describe, it, expect } from 'vitest';
import { NEEDS_QUESTION, needsAnswerLabel, engineDisplayName } from './engine-recommendation-copy';

describe('engine-recommendation-copy', () => {
  it('exposes the one guided question and answer labels', () => {
    expect(NEEDS_QUESTION).toMatch(/expressive|multilingual/i);
    expect(needsAnswerLabel('expressive-or-multilingual')).toMatch(/expressive|multilingual/i);
    expect(needsAnswerLabel('simple-english')).toMatch(/english/i);
  });
  it('maps engine ids to display names', () => {
    expect(engineDisplayName('kokoro')).toBe('Kokoro');
    expect(engineDisplayName('qwen')).toBe('Qwen3-TTS');
    expect(engineDisplayName('coqui')).toBe('Coqui XTTS v2');
  });
});
