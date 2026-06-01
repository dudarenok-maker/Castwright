/* fs-2 — detectLanguage heuristic. Pins the Cyrillic-ratio classification that
   seeds the confirm-view language selector. */

import { describe, it, expect } from 'vitest';
import { detectLanguage, CYRILLIC_THRESHOLD } from './detect-language.js';

describe('detectLanguage', () => {
  it('classifies an all-English text as en', () => {
    expect(detectLanguage('The quick brown fox jumps over the lazy dog.')).toBe('en');
  });

  it('classifies an all-Russian text as ru', () => {
    expect(detectLanguage('Съешь же ещё этих мягких французских булок да выпей чаю.')).toBe('ru');
  });

  it('defaults empty / letter-less input to en', () => {
    expect(detectLanguage('')).toBe('en');
    expect(detectLanguage('   1234 — !@#$ ')).toBe('en');
  });

  it('a majority-Russian passage with English names/quotes still reads as ru', () => {
    const text =
      '— Привет, — сказала Соня. «Hello», ответил John, но дальше говорили только по-русски: ' +
      'это была длинная глава о приключениях в далёкой стране, полная диалогов и описаний.';
    expect(detectLanguage(text)).toBe('ru');
  });

  it('a majority-English passage with a stray Russian word stays en (below threshold)', () => {
    const text =
      'The meeting ran long. Everyone agreed the plan was sound, though Boris muttered "да" ' +
      'under his breath before the vote carried and the room emptied for the evening.';
    expect(detectLanguage(text)).toBe('en');
  });

  it('uses a ~30% threshold on the letter count', () => {
    expect(CYRILLIC_THRESHOLD).toBe(0.3);
    /* 1 Cyrillic letter among 9 letters total = ~11% → en. */
    expect(detectLanguage('abcdefgh я')).toBe('en');
    /* 4 Cyrillic among 8 = 50% → ru. */
    expect(detectLanguage('abcd ядро')).toBe('ru');
  });
});
