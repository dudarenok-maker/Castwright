import { describe, it, expect } from 'vitest';
import { charsPerTokenForText, cloudBodyCharBudget, resolveMaxInputTokensPerRequest } from './token-budget.js';

describe('charsPerTokenForText', () => {
  it('returns ~4 for all-Latin text', () => {
    expect(charsPerTokenForText('The quick brown fox jumps')).toBeCloseTo(4, 5);
  });
  it('returns ~2.5 for all-Cyrillic text', () => {
    expect(charsPerTokenForText('Антон Городецкий шёл домой')).toBeLessThan(2.7);
    expect(charsPerTokenForText('Антон Городецкий шёл домой')).toBeGreaterThan(2.3);
  });
  it('defaults to Latin for empty text', () => {
    expect(charsPerTokenForText('')).toBe(4);
  });
});

describe('cloudBodyCharBudget', () => {
  it('sizes a Cyrillic body to fewer chars than an equal token cap of Latin', () => {
    const ru = 'а'.repeat(1000);
    const en = 'a'.repeat(1000);
    expect(cloudBodyCharBudget(ru)).toBeLessThan(cloudBodyCharBudget(en));
  });
  it('subtracts reserved chars (roster overhead)', () => {
    const body = 'a'.repeat(1000);
    expect(cloudBodyCharBudget(body, 5000)).toBe(cloudBodyCharBudget(body, 0) - 5000);
  });
  it('reserves tokens in token-space (script-correct: expands at the body rate)', () => {
    // Latin body: 4 chars/token → each reserved token removes 4 body chars.
    const latin = 'a'.repeat(1000);
    expect(cloudBodyCharBudget(latin, 0, 1000)).toBe(cloudBodyCharBudget(latin, 0) - 1000 * 4);
    // Cyrillic body: 2.5 chars/token → each reserved token removes only 2.5 chars,
    // so the SAME token reservation removes fewer chars than for Latin. A fixed
    // char reservation could not track this — that's why stage-1 reserves tokens.
    const cyr = 'а'.repeat(1000);
    expect(cloudBodyCharBudget(cyr, 0, 1000)).toBe(cloudBodyCharBudget(cyr, 0) - 1000 * 2.5);
  });
  it('never drops below the 2000 floor', () => {
    expect(cloudBodyCharBudget('a'.repeat(10), 10_000_000)).toBe(2000);
    expect(cloudBodyCharBudget('a'.repeat(10), 0, 10_000_000)).toBe(2000);
  });
});

describe('resolveMaxInputTokensPerRequest', () => {
  it('defaults to 12000', () => {
    expect(resolveMaxInputTokensPerRequest()).toBe(12000);
  });
});
