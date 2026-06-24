import { describe, it, expect } from 'vitest';
import { fr } from './fr.js';

describe('fr cardinal', () => {
  it.each([
    // 70/80/90 family: French has no native words; built on soixante/quatre-vingt.
    [70, 'soixante-dix'], [80, 'quatre-vingts'], [90, 'quatre-vingt-dix'],
    // `et` joins the unit in 71 (soixante et onze) but NOT in 81/91 (hyphen only).
    [71, 'soixante et onze'], [81, 'quatre-vingt-un'], [91, 'quatre-vingt-onze'],
    // `et` in the -1 of 21/31/41/51/61 (vingt et un …) but not 81/91.
    [21, 'vingt et un'], [31, 'trente et un'], [61, 'soixante et un'],
    // cent pluralises only when a bare multiple (deux cents) and NOT followed by
    // another number (deux cent un).
    [100, 'cent'], [200, 'deux cents'], [201, 'deux cent un'],
    // mille is invariant.
    [1000, 'mille'], [2000, 'deux mille'],
  ])('cardinal(%i)=%s', (n, e) => expect(fr.cardinal(n)).toBe(e));
});

describe('fr decade', () => {
  it('decade(1990) keeps the century, no drop', () =>
    expect(fr.decade(1990)).toBe('les années quatre-vingt-dix'));
});

describe('fr year', () => {
  it('year reads as cardinal', () =>
    expect(fr.year(1999)).toBe('mille neuf cent quatre-vingt-dix-neuf'));
});
