import { describe, it, expect } from 'vitest';
import { es } from './es.js';

describe('es cardinal', () => {
  it.each([
    [16, 'dieciséis'], [21, 'veintiuno'], [22, 'veintidós'], [31, 'treinta y uno'],
    [100, 'cien'], [101, 'ciento uno'], [200, 'doscientos'], [500, 'quinientos'],
    [700, 'setecientos'], [900, 'novecientos'], [1000, 'mil'], [1200, 'mil doscientos'],
    // y-placement: between tens and units, none after hundreds.
    [234, 'doscientos treinta y cuatro'],
  ])('cardinal(%i)=%s', (n, e) => expect(es.cardinal(n)).toBe(e));
});

describe('es decade', () => {
  it('decade(1990) drops century', () => expect(es.decade(1990)).toBe('los noventa'));
});

describe('es year', () => {
  it('year reads as cardinal', () => expect(es.year(1999)).toBe('mil novecientos noventa y nueve'));
});
