import { describe, it, expect } from 'vitest';
import { parseLabelledChapter } from './schema.js';

describe('parseLabelledChapter', () => {
  it('accepts a well-formed labelled chapter', () => {
    const ok = { chapterText: 'Hello. World.', lines: [{ text: 'Hello.', speakerId: 'narrator' }] };
    expect(parseLabelledChapter(ok).lines).toHaveLength(1);
  });
  it('rejects a line missing speakerId', () => {
    const bad = { chapterText: 'x', lines: [{ text: 'x' }] };
    expect(() => parseLabelledChapter(bad)).toThrow();
  });
});
