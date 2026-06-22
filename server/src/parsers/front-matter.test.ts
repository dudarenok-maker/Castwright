/* Unit tests for isLikelyFrontMatterTitle — English baseline + non-English
   extension via the language-registry union (fs-41/fs-50 seam 3b). */

import { describe, it, expect } from 'vitest';
import { isLikelyFrontMatterTitle } from './front-matter.js';

describe('isLikelyFrontMatterTitle — English (existing behaviour)', () => {
  it('matches English front-matter keywords', () => {
    for (const t of [
      'Dedication',
      'Copyright',
      'Preface',
      'Foreword',
      'Acknowledgements',
      'About the Author',
      'About the Publisher',
      'Table of Contents',
      'Contents',
      'Epigraph',
      'Introduction',
      'By the Same Author',
      'Also By',
      'Praise for',
      'Colophon',
      'Afterword',
      'Appendix',
      'Notes',
      'Bibliography',
      'Index',
      'Glossary',
    ]) {
      expect(isLikelyFrontMatterTitle(t)).toBe(true);
    }
  });

  it('does not flag a real chapter title as front matter', () => {
    expect(isLikelyFrontMatterTitle('Chapter 1')).toBe(false);
    expect(isLikelyFrontMatterTitle('The Berth at Liverpool')).toBe(false);
    expect(isLikelyFrontMatterTitle('Introduction to the World')).toBe(false); // "Introduction to" is excluded
  });

  it('returns false for an empty string', () => {
    expect(isLikelyFrontMatterTitle('')).toBe(false);
  });
});

describe('isLikelyFrontMatterTitle — non-English (seam 3b)', () => {
  it('flags non-English front-matter titles', () => {
    for (const t of [
      'Derechos de autor',   // Spanish: copyright
      'Dédicace',            // French: dedication
      'Danksagung',          // German: acknowledgements
      'Об авторе',           // Russian: about the author
    ]) {
      expect(isLikelyFrontMatterTitle(t)).toBe(true);
    }
  });

  it('does not flag a real Spanish chapter title as front matter', () => {
    expect(isLikelyFrontMatterTitle('Capítulo 1')).toBe(false);
  });

  it('matches Russian front-matter terms (case-insensitive via /iu/ flag)', () => {
    expect(isLikelyFrontMatterTitle('ПОСВЯЩЕНИЕ')).toBe(true);
    expect(isLikelyFrontMatterTitle('посвящение')).toBe(true);
  });

  it('matches German front-matter terms', () => {
    expect(isLikelyFrontMatterTitle('Inhaltsverzeichnis')).toBe(true);
    expect(isLikelyFrontMatterTitle('Über den Autor')).toBe(true);
  });
});

describe('isLikelyFrontMatterTitle — apostrophe tolerance (seam 3b)', () => {
  it('matches a curly-apostrophe French title (U+2019)', () => {
    // Registry has "à propos de l'auteur" (straight apostrophe);
    // real EPUB/typeset titles often use the curly form (U+2019 = ’).
    expect(isLikelyFrontMatterTitle('À propos de l’auteur')).toBe(true);
  });

  it('matches the straight-apostrophe form too', () => {
    expect(isLikelyFrontMatterTitle("À propos de l'auteur")).toBe(true);
  });

  it('matches note de l’auteur (French author note, curly)', () => {
    expect(isLikelyFrontMatterTitle('Note de l’auteur')).toBe(true);
  });
});
