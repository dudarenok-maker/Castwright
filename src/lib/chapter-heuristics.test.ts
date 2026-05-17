import { describe, expect, it } from 'vitest';
import {
  isLikelyFrontMatter,
  FRONT_MATTER_WORD_THRESHOLD,
  chapterSlug,
} from './chapter-heuristics';

describe('isLikelyFrontMatter — title patterns', () => {
  it.each([
    'Dedication',
    'DEDICATION',
    '  dedication  ',
    'Copyright',
    'Copyright Page',
    'Preface',
    'Foreword',
    'Acknowledgements',
    'Acknowledgments', // US spelling
    'About the Author',
    'About the Publisher',
    'Table of Contents',
    'Contents',
    'Epigraph',
    'Introduction',
    'By the Same Author',
    'Also by Jane Smith',
    'Praise for Earthsea',
    'Colophon',
    'Afterword',
    'Appendix A',
    'Notes',
    'Bibliography',
    'Index',
    'Glossary',
    "Author's Note",
    'Author’s Note', // smart-quote variant
    "Translator's Note",
    "Publisher's Note",
    'Half-Title',
    'Halftitle',
    'Imprint',
  ])('matches "%s" as front matter regardless of length', (title) => {
    expect(isLikelyFrontMatter(title, 50_000)).toBe(true);
  });

  it('does NOT match bare "Prologue" — it is usually narrative', () => {
    expect(isLikelyFrontMatter('Prologue', 4_000)).toBe(false);
  });

  it('does NOT match bare "Epilogue" — it is usually narrative', () => {
    expect(isLikelyFrontMatter('Epilogue', 4_000)).toBe(false);
  });

  it('does NOT match a normal chapter title', () => {
    expect(isLikelyFrontMatter('Chapter 1', 4_000)).toBe(false);
    expect(isLikelyFrontMatter('The Wizard Arrives', 6_000)).toBe(false);
    expect(isLikelyFrontMatter('1. The Beginning', 5_500)).toBe(false);
  });

  it('does NOT match "Introduction to <name>" mid-novel chapter naming', () => {
    /* The regex is anchored so "Introductions" and "Introduction to ..." that
       indicate a narrative scene rather than a foreword still pass through. */
    expect(isLikelyFrontMatter('Introduction to a Stranger', 3_000)).toBe(false);
  });
});

describe('isLikelyFrontMatter — word-count gate', () => {
  it('flags a very short chapter regardless of title', () => {
    expect(isLikelyFrontMatter('A Strange Page', 80)).toBe(true);
  });

  it('does NOT flag at exactly the threshold boundary', () => {
    /* The gate is <= threshold, so threshold itself triggers. */
    expect(isLikelyFrontMatter('Borderline', FRONT_MATTER_WORD_THRESHOLD)).toBe(true);
    expect(isLikelyFrontMatter('Borderline', FRONT_MATTER_WORD_THRESHOLD + 1)).toBe(false);
  });

  it('ignores zero / missing word count (no signal)', () => {
    expect(isLikelyFrontMatter('Some Title', 0)).toBe(false);
    expect(isLikelyFrontMatter('Some Title', undefined)).toBe(false);
  });

  it('does not flag a long narrative chapter even with TOC-ish nouns inside', () => {
    expect(isLikelyFrontMatter('The Note That Changed Everything', 4_500)).toBe(false);
  });
});

describe('chapterSlug — must match the server (paths.ts) derivation', () => {
  /* Slugs are the wire key between confirm-stage exclusion and the
     server. If these drift apart the server silently fails to mark the
     chapter excluded. */
  it('produces id-padded + slugified title', () => {
    expect(chapterSlug(1, 'Dedication')).toBe('01-dedication');
    expect(chapterSlug(2, 'Chapter One')).toBe('02-chapter-one');
    expect(chapterSlug(10, 'About the Author')).toBe('10-about-the-author');
  });

  it('strips accents and non-alphanumerics', () => {
    expect(chapterSlug(3, 'Café au Lait!')).toBe('03-cafe-au-lait');
  });

  it('falls back to "untitled" for an empty title', () => {
    expect(chapterSlug(4, '')).toBe('04-untitled');
    expect(chapterSlug(5, '   ')).toBe('05-untitled');
  });
});

describe('isLikelyFrontMatter — empty / whitespace input', () => {
  it('returns false for empty title with no word-count signal', () => {
    expect(isLikelyFrontMatter('', 0)).toBe(false);
    expect(isLikelyFrontMatter('   ', 0)).toBe(false);
  });

  it('returns true for empty title if word-count gate fires', () => {
    expect(isLikelyFrontMatter('', 50)).toBe(true);
  });
});
