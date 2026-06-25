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

describe('expandForSpeech — fr/de activate once supported (plan 229)', () => {
  // fr/de flipped supported:true (plan 229), so the gate now lets their engines
  // run end-to-end (previously dormant behind supported:false). The exact output
  // is pinned in lang/fr.test.ts + lang/de.test.ts; here we just assert the gate
  // opened — the input no longer passes through unchanged.
  it('fr now expands end-to-end (no longer dormant)', () =>
    expect(expandForSpeech('J’ai 5 €.', 'fr')).not.toBe('J’ai 5 €.'));
  it('de now expands end-to-end (no longer dormant)', () =>
    expect(expandForSpeech('Ich habe 5 €.', 'de')).not.toBe('Ich habe 5 €.'));
});

describe('expandForSpeech activation gate', () => {
  it('unknown language no-ops', () =>
    expect(expandForSpeech('I have $5.', 'xx')).toBe('I have $5.'));
  it('supported language with engine expands', () =>
    expect(expandForSpeech('I have $5.', 'en')).toBe('I have five dollars.'));
});
