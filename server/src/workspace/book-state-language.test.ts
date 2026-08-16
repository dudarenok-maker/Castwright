/* fs-2 — `bookStateLanguage` resolver. Pure helper: returns the normalised
   `language` field from `BookStateJson` when present, else the `'en'` fallback
   that preserves backward compat for state files written before fs-2.

   The default keeps existing books behaving identically post-deploy: an
   English book reads back `'en'` whether or not the field is on disk, so the
   never-cross-language enforcement never mis-fires on a legacy file. */

import { describe, it, expect } from 'vitest';
import {
  BookLanguageUnsetError,
  bookStateLanguage,
  bookStateLanguageOrNull,
  requireBookStateLanguage,
  type BookStateJson,
} from './scan.js';

function makeStateBase(): BookStateJson {
  return {
    bookId: 'demo__sa__test',
    manuscriptId: 'm_demo',
    title: 'Test',
    author: 'Test',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: [],
    coverGradient: ['#000', '#fff'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };
}

describe('bookStateLanguage', () => {
  it("defaults to 'en' when state.language is absent (legacy books)", () => {
    expect(bookStateLanguage(makeStateBase())).toBe('en');
  });

  it('returns the normalised language when present', () => {
    expect(bookStateLanguage({ ...makeStateBase(), language: 'en' })).toBe('en');
    expect(bookStateLanguage({ ...makeStateBase(), language: 'ru' })).toBe('ru');
    expect(bookStateLanguage({ ...makeStateBase(), language: 'ru-RU' })).toBe('ru');
  });

  it("falls back to 'en' when state.language is undefined or empty", () => {
    expect(bookStateLanguage({ ...makeStateBase(), language: undefined })).toBe('en');
    expect(bookStateLanguage({ ...makeStateBase(), language: '' })).toBe('en');
  });
});

describe('bookStateLanguageOrNull / requireBookStateLanguage', () => {
  it('returns null when the key is absent — absence is a fact, not English', () => {
    expect(bookStateLanguageOrNull(makeStateBase())).toBeNull();
  });

  it('returns null for empty and whitespace-only values', () => {
    for (const value of ['', '   ', '\t', ' \n ']) {
      expect(bookStateLanguageOrNull({ ...makeStateBase(), language: value })).toBeNull();
    }
  });

  it('throws BookLanguageUnsetError when unset', () => {
    expect(() => requireBookStateLanguage(makeStateBase())).toThrow(BookLanguageUnsetError);
  });

  it('the message carries no filesystem path — it is client-facing', () => {
    try {
      requireBookStateLanguage(makeStateBase());
    } catch (e) {
      expect((e as Error).message).not.toMatch(/[A-Za-z]:\\|\/(Users|home|AudiobookWorkspace)/);
      expect((e as Error).message).toContain('Book settings');
    }
  });

  it('a stored null behaves as unset for both helpers', () => {
    const state = { ...makeStateBase(), language: null };
    expect(bookStateLanguageOrNull(state)).toBeNull();
    expect(() => requireBookStateLanguage(state)).toThrow(BookLanguageUnsetError);
  });

  it('the control: a book with a language reads it back and never throws', () => {
    const state = { ...makeStateBase(), language: 'ru' };
    expect(bookStateLanguageOrNull(state)).toBe('ru');
    expect(requireBookStateLanguage(state)).toBe('ru');
    expect(() => requireBookStateLanguage(state)).not.toThrow();
    // existing defaulting reader is unchanged for the same state
    expect(bookStateLanguage(state)).toBe('ru');
  });
});
