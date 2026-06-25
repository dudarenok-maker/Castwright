import { describe, it, expect } from 'vitest';
import { de } from './de.js';

describe('de cardinal', () => {
  it.each([
    [21, 'einundzwanzig'],
    [34, 'vierunddreißig'],
    [100, 'einhundert'],
    [1000, 'eintausend'],
    [1234, 'eintausendzweihundertvierunddreißig'],
    [1_000_000, 'eine Million'],
  ])('cardinal(%i) = %s', (n, expected) => expect(de.cardinal(n)).toBe(expected));
});

describe('de decade', () => {
  it('decade(1990) drops century', () => expect(de.decade(1990)).toBe('die Neunzigerjahre'));
});
