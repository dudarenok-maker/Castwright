import { describe, it, expect } from 'vitest';
import { parseLocaleNumber } from './classifiers.js';

describe('parseLocaleNumber (3-digit-group guard)', () => {
  it('en 1,200.50 -> 1200.5', () => expect(parseLocaleNumber('1,200.50', { decimal: '.', thousands: ',' })).toBe(1200.5));
  it('de 1.200,50 -> 1200.5', () => expect(parseLocaleNumber('1.200,50', { decimal: ',', thousands: '.' })).toBe(1200.5));
  it('de 1.5 is NOT thousands -> 1.5', () => expect(parseLocaleNumber('1.5', { decimal: ',', thousands: '.' })).toBe(1.5));
  it('de 3,14 -> 3.14', () => expect(parseLocaleNumber('3,14', { decimal: ',', thousands: '.' })).toBe(3.14));
});
