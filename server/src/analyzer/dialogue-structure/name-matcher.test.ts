import { describe, expect, it } from 'vitest';
import { conventionsFor } from './lang/index.js';
import { buildNameIndex, findRosterName } from './name-matcher.js';

const ru = conventionsFor('ru')!;
const roster = [
  { id: 'anton', name: 'Антон', aliases: ['я'] },
  { id: 'boris-ignatyevich', name: 'Борис Игнатьевич', aliases: ['шеф'] },
  { id: 'olga', name: 'Ольга' },
];

describe('name-matcher (ru)', () => {
  const idx = buildNameIndex(roster, ru);
  it('matches inflected case forms', () => {
    expect(findRosterName('— сказал Антону вслед', idx)).toBe('anton');
    expect(findRosterName('ответила Ольге', idx)).toBe('olga');
  });
  it('matches multi-token names and aliases by any token', () => {
    expect(findRosterName('проворчал Борис Игнатьевич', idx)).toBe('boris-ignatyevich');
    expect(findRosterName('заметил шеф', idx)).toBe('boris-ignatyevich');
  });
  it('does NOT match substrings inside unrelated words', () => {
    // "Антенна" must not hit the "Ант..." stem — token-boundary + full-stem equality only
    expect(findRosterName('антенна на крыше дрожала', idx)).toBeNull();
  });
  it('ignores stems shorter than minStemLength (the "я" alias never text-matches)', () => {
    expect(findRosterName('я не знаю', idx)).toBeNull();
  });

  it('drops a stem shared by two distinct roster ids (ambiguous match)', () => {
    const ambiguousRoster = [
      { id: 'ivan-a', name: 'Иван' },
      { id: 'ivan-b', name: 'Иван' },
    ];
    const ambIdx = buildNameIndex(ambiguousRoster, ru);
    expect(findRosterName('позвал Ивана вслед', ambIdx)).toBeNull();
  });

  it('uses tokenized full-stem equality, not whole-text substring matching', () => {
    const marsRoster = [{ id: 'mars', name: 'Марс' }];
    const marsIdx = buildNameIndex(marsRoster, ru);
    // "марсианина" contains the roster stem "марс" as a literal substring,
    // but its own stem ("марсианин") is not equal to "марс" -- a naive
    // text.includes(stem) regression would wrongly match here.
    expect(findRosterName('он смотрел на марсианина', marsIdx)).toBeNull();
    // Confirm the negative isn't "nothing ever matches": a genuine inflected
    // form of the same name still resolves correctly.
    expect(findRosterName('он позвал Марса', marsIdx)).toBe('mars');
  });
});
