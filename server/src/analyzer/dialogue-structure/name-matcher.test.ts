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
});
