import { describe, it, expect } from 'vitest';
import { emotionToInstruct } from './emotion-instruct';

describe('emotionToInstruct', () => {
  it('maps each expressive emotion to an English phrase', () => {
    expect(emotionToInstruct('whisper')).toMatch(/whisper/i);
    expect(emotionToInstruct('angry')).toMatch(/anger|angrily|raised/i);
    expect(emotionToInstruct('excited')).toMatch(/excit|energ/i);
    expect(emotionToInstruct('sad')).toMatch(/sad|subdued|downcast/i);
  });
  it('returns undefined for neutral / absent', () => {
    expect(emotionToInstruct('neutral')).toBeUndefined();
    expect(emotionToInstruct(undefined)).toBeUndefined();
  });
});
