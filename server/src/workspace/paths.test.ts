/* `slug` / `makeBookId` — plan 219 non-Latin support.

   Pre-219 `slug` normalised with `[^a-z0-9]`, so a Cyrillic title/author
   collapsed to `untitled`/`standalones` → `makeBookId` mapped EVERY Russian
   book to the same id (`untitled__standalones__untitled`), colliding their
   identifiers. These pin the fix: ASCII output is byte-identical to the legacy
   slug, non-Latin titles are preserved, and two distinct Cyrillic books get two
   distinct ids. (The on-disk book DIRECTORY already uses display strings
   verbatim — `bookDirByDisplay` — so this only changes the slug-based id key.) */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { slug, makeBookId, parseBookId, bookDirByDisplay, BOOKS_ROOT } from './paths.js';

/* The exact legacy slug (pre-219) — the oracle for ASCII parity. */
function legacySlug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

describe('slug', () => {
  it('is byte-identical to the legacy slug for ASCII titles', () => {
    for (const s of ['The Coalfall Commission', 'A Tale: Of Two Cities!', 'Mr. Brown']) {
      expect(slug(s)).toBe(legacySlug(s));
    }
  });

  it('deburrs accented Latin like the legacy slug', () => {
    expect(slug('Les Misérables')).toBe('les-miserables');
  });

  it('preserves a Cyrillic title instead of collapsing to "untitled"', () => {
    expect(slug('Война и мир')).toBe('война-и-мир');
    expect(slug('Анна Каренина')).toBe('анна-каренина');
  });

  it('still returns "untitled" for a title with no usable characters', () => {
    expect(slug('!!!')).toBe('untitled');
    expect(slug('')).toBe('untitled');
  });
});

describe('makeBookId', () => {
  it('gives two distinct Cyrillic books distinct ids (was all → untitled)', () => {
    const a = makeBookId('Толстой', 'Standalones', 'Война и мир');
    const b = makeBookId('Толстой', 'Standalones', 'Анна Каренина');
    expect(a).not.toBe(b);
    expect(a).not.toContain('untitled');
  });

  it('round-trips through parseBookId for a Cyrillic id', () => {
    const id = makeBookId('Толстой', 'Standalones', 'Война и мир');
    const parsed = parseBookId(id);
    expect(parsed).not.toBeNull();
    expect(parsed?.titleSlug).toBe('война-и-мир');
  });
});

describe('bookDirByDisplay containment', () => {
  it('sanitizes traversal to a contained folder', () => {
    const dir = bookDirByDisplay('..\\..\\evil', 'Series', 'Title');
    expect(path.relative(BOOKS_ROOT, dir).startsWith('..')).toBe(false);
  });
  it('preserves spaces and hyphens in normal display names', () => {
    const dir = bookDirByDisplay('Jane Doe', 'Sci-Fi', 'The Fall');
    const parts = path.relative(BOOKS_ROOT, dir).split(path.sep);
    expect(parts).toEqual(['Jane Doe', 'Sci-Fi', 'The Fall']);
  });
  it('never collapses a level when a field sanitizes to empty', () => {
    const dir = bookDirByDisplay('...', 'Series', 'Title');
    expect(path.relative(BOOKS_ROOT, dir).split(path.sep).length).toBe(3);
  });
});
