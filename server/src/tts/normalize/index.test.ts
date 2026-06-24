import { describe, it, expect } from 'vitest';
import { parseLocaleNumber, speakNumber } from './classifiers.js';
import { en } from './lang/en.js';
import { expandForSpeech } from './index.js';

describe('parseLocaleNumber (3-digit-group guard)', () => {
  it('en 1,200.50 -> 1200.5', () => expect(parseLocaleNumber('1,200.50', { decimal: '.', thousands: ',' })).toBe(1200.5));
  it('de 1.200,50 -> 1200.5', () => expect(parseLocaleNumber('1.200,50', { decimal: ',', thousands: '.' })).toBe(1200.5));
  it('de 1.5 is NOT thousands -> 1.5', () => expect(parseLocaleNumber('1.5', { decimal: ',', thousands: '.' })).toBe(1.5));
  it('de 3,14 -> 3.14', () => expect(parseLocaleNumber('3,14', { decimal: ',', thousands: '.' })).toBe(3.14));
});

describe('speakNumber NaN guard', () => {
  // A malformed "1,50" in an English book parses to NaN — leave it untouched.
  it('returns raw on non-finite parse', () => expect(speakNumber('1,50', en)).toBe('1,50'));
});

describe('expandForSpeech dormancy gate', () => {
  // fr is registered but supported:false — the gate must no-op end-to-end even
  // though the fr engine itself works (exercised directly via applyPasses).
  it('fr (supported:false) no-ops end-to-end', () =>
    expect(expandForSpeech('J’ai 5 €.', 'fr')).toBe('J’ai 5 €.'));
  it('de (supported:false) no-ops end-to-end', () =>
    expect(expandForSpeech('Ich habe 5 €.', 'de')).toBe('Ich habe 5 €.'));
});
