import { describe, it, expect } from 'vitest';
import { evidenceFamily } from './buckets.js';

describe('evidenceFamily', () => {
  it.each([
    ['tag-confirm:alice', 'tag'],
    ['tag-correct:bob', 'tag'],
    ['tag-span-narrator', 'tag'],
    ['pronoun-confirm:x', 'pronoun'],
    ['pronoun-keep-flag:a-vs-b', 'pronoun'],
    ['alt-confirm:x', 'alternation'],
    ['alt-keep-flag:a-vs-b', 'alternation'],
    ['unanchored-named:m', 'unanchored'],
    ['unanchored-narrator', 'unanchored'],
    ['narration-confirm', 'narration'],
    ['narration-demote:first', 'narration'],
    ['lumped', 'lumped'],
    ['unaligned', 'unaligned'],
    ['flag-only-floor', 'other'],
  ])('%s → %s', (reason, family) => {
    expect(evidenceFamily(reason)).toBe(family);
  });
});
