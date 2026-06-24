import { describe, it, expect } from 'vitest';
import { ru, preNumberPass } from './ru.js';

describe('ru cardinal', () => {
  it.each([
    [0, 'ноль'],
    [7, 'семь'],
    [13, 'тринадцать'],
    [21, 'двадцать один'],
    [100, 'сто'],
    [101, 'сто один'],
    [999, 'девятьсот девяносто девять'],
    [1000, 'тысяча'],
    [1200, 'тысяча двести'],
    [1999, 'тысяча девятьсот девяносто девять'],
    [1_000_000, 'миллион'],
  ])('cardinal(%i) = %s', (n, expected) => expect(ru.cardinal(n)).toBe(expected));
});

describe('ru year (final component becomes an ordinal in the requested case)', () => {
  it('nominative', () => expect(ru.year(1999, 'nominative')).toBe('тысяча девятьсот девяносто девятый'));
  it('prepositional', () => expect(ru.year(1999, 'prepositional')).toBe('тысяча девятьсот девяносто девятом'));
  it('genitive', () => expect(ru.year(1999, 'genitive')).toBe('тысяча девятьсот девяносто девятого'));
  it('dative', () => expect(ru.year(1999, 'dative')).toBe('тысяча девятьсот девяносто девятому'));
  // Round-century year: the final component is a hundreds word, which takes -ый
  // (NOT the stressed -ой). Locks the ORD_NOM_OY hundreds-exclusion fix.
  it('round-century nominative', () => expect(ru.year(1800, 'nominative')).toBe('тысяча восьмисотый'));
  it('round-century prepositional', () => expect(ru.year(1800, 'prepositional')).toBe('тысяча восьмисотом'));
});

describe('ru ordinal hundreds take -ый not -ой', () => {
  it('200th', () => expect(ru.ordinal(200)).toBe('двухсотый'));
  it('900th', () => expect(ru.ordinal(900)).toBe('девятисотый'));
});

describe('ru yearCaseFor', () => {
  it('в => prepositional', () => expect(ru.yearCaseFor!('в')).toBe('prepositional'));
  it('во => prepositional', () => expect(ru.yearCaseFor!('во')).toBe('prepositional'));
  it('с => genitive', () => expect(ru.yearCaseFor!('с')).toBe('genitive'));
  it('до => genitive', () => expect(ru.yearCaseFor!('до')).toBe('genitive'));
  it('к => dative', () => expect(ru.yearCaseFor!('к')).toBe('dative'));
  it('uppercase В => prepositional (lowercased first)', () => expect(ru.yearCaseFor!('В')).toBe('prepositional'));
  it('other => nominative', () => expect(ru.yearCaseFor!('году')).toBe('nominative'));
  it('undefined => nominative', () => expect(ru.yearCaseFor!(undefined)).toBe('nominative'));
});

describe('ru decade', () => {
  it('decade(1990) => substantivised plural ordinal, century dropped', () =>
    expect(ru.decade(1990)).toBe('девяностые'));
});

describe('ru currency agreement', () => {
  it.each([
    [1, 'рубль'],
    [2, 'рубля'],
    [3, 'рубля'],
    [4, 'рубля'],
    [5, 'рублей'],
    [11, 'рублей'],
    [12, 'рублей'],
    [14, 'рублей'],
    [21, 'рубль'],
    [22, 'рубля'],
    [25, 'рублей'],
  ])('major(%i) = %s', (n, expected) => expect(ru.currency['₽'].major(n)).toBe(expected));
});

describe('ru 1/2 gender heuristic (preNumberPass)', () => {
  // Singular-noun successes: ending unambiguously signals gender.
  it('feminine -а: 1 книга => одна книга', () => expect(preNumberPass('1 книга')).toBe('одна книга'));
  it('feminine -я: 1 неделя => одна неделя', () => expect(preNumberPass('1 неделя')).toBe('одна неделя'));
  it('neuter -о: 1 окно => одно окно', () => expect(preNumberPass('1 окно')).toBe('одно окно'));
  it('masculine consonant: 1 дом => один дом', () => expect(preNumberPass('1 дом')).toBe('один дом'));
  // два/две picks by the SAME ending rule (feminine -а/-я → "две"; neuter &
  // masculine share "два"). The heuristic reads the noun's ENDING only, so a
  // paucal genitive-singular ("два дома") whose form ends in -а is read fem —
  // a documented limit. These pin the ending→form mapping, not real agreement.
  it('ending -а → две (form rule): 2 страна => две страна', () =>
    expect(preNumberPass('2 страна')).toBe('две страна'));
  it('ending consonant → два: 2 дом => два дом', () => expect(preNumberPass('2 дом')).toBe('два дом'));
  it('ending -о → два (neuter shares два): 2 окно => два окно', () =>
    expect(preNumberPass('2 окно')).toBe('два окно'));
  // known-failure: soft-sign feminine noun mis-gendered masculine (тень is fem).
  it('mis-gender soft-sign: 1 тень => один тень (WRONG, documented)', () =>
    expect(preNumberPass('1 тень')).toBe('один тень'));
  // known-failure: -а masculine irregular mis-gendered feminine (папа is masc).
  it('mis-gender папа: 1 папа => одна папа (WRONG, documented)', () =>
    expect(preNumberPass('1 папа')).toBe('одна папа'));
});

describe('ru date', () => {
  it('day + genitive month + no year', () => expect(ru.date(3, 0, 0)).toBe('третье января'));
  it('day + genitive month + genitive year + года', () =>
    expect(ru.date(3, 0, 1999)).toBe('третье января тысяча девятьсот девяносто девятого года'));
});
