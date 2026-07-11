// server/src/analyzer/non-story-essay-title.test.ts
import { describe, it, expect } from 'vitest';
import { isNonStoryEssayTitle } from './non-story-essay-title.js';
import { isLikelyFrontMatterTitle } from '../parsers/front-matter.js';

describe('isNonStoryEssayTitle', () => {
  it('matches the Russian critical-essay class', () => {
    expect(isNonStoryEssayTitle('Вступительная статья')).toBe(true);
    expect(isNonStoryEssayTitle('вступительная статья')).toBe(true);
    expect(isNonStoryEssayTitle('Критическая статья')).toBe(true);
  });
  it('matches the English critical-essay class', () => {
    expect(isNonStoryEssayTitle('Critical Introduction')).toBe(true);
    expect(isNonStoryEssayTitle('Introductory essay')).toBe(true);
  });
  it('does not match ordinary narrative titles', () => {
    expect(isNonStoryEssayTitle('Chapter 1')).toBe(false);
    expect(isNonStoryEssayTitle('ПРОЛОГ')).toBe(false);
    expect(isNonStoryEssayTitle('Глава вторая')).toBe(false);
    expect(isNonStoryEssayTitle(undefined)).toBe(false);
    expect(isNonStoryEssayTitle('')).toBe(false);
  });
  it('stays decoupled from the exclusion machinery (spec regression)', () => {
    // The essay-class titles this predicate matches must NOT be front-matter
    // titles that isLikelyFrontMatterTitle would exclude — that predicate has
    // no essay-article class, so the two never overlap on the target case.
    // (Import kept local to avoid coupling the module graph.)
    expect(isLikelyFrontMatterTitle('Вступительная статья')).toBe(false);
    expect(isNonStoryEssayTitle('Вступительная статья')).toBe(true);
  });
});
