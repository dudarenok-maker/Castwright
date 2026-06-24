import { describe, it, expect } from 'vitest';
import { en } from './en.js';

describe('en cardinal', () => {
  it.each([
    [0, 'zero'], [7, 'seven'], [13, 'thirteen'], [21, 'twenty-one'],
    [100, 'one hundred'], [101, 'one hundred one'], [999, 'nine hundred ninety-nine'],
    [1000, 'one thousand'], [1200, 'one thousand two hundred'],
    [1_000_000, 'one million'], [999_999_999, 'nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine'],
  ])('cardinal(%i) = %s', (n, expected) => expect(en.cardinal(n)).toBe(expected));
});

describe('en ordinal', () => {
  it.each([[1, 'first'], [2, 'second'], [3, 'third'], [21, 'twenty-first'], [100, 'one hundredth']])(
    'ordinal(%i) = %s', (n, e) => expect(en.ordinal(n)).toBe(e));
});

describe('en year', () => {
  it.each([[1999, 'nineteen ninety-nine'], [2026, 'twenty twenty-six'], [2000, 'two thousand'], [2007, 'two thousand seven'], [1900, 'nineteen hundred']])(
    'year(%i) = %s', (n, e) => expect(en.year(n)).toBe(e));
});

describe('en decade', () => {
  it.each([[1990, 'nineteen nineties'], [1920, 'nineteen twenties'], [2010, 'twenty tens'], [1900, 'nineteen hundreds'], [2000, 'two thousands']])(
    'decade(%i) = %s', (n, e) => expect(en.decade(n)).toBe(e));
});
