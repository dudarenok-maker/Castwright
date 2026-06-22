/* language-registry — single source of truth for per-language data.
   Seam 1: pins the en/ru entries + the accessor contract. */

import { describe, it, expect } from 'vitest';
import {
  getLanguageEntry,
  isSupportedLanguage,
  type LanguageEntry,
} from './language-registry.js';

describe('getLanguageEntry', () => {
  it('returns the en entry, supported', () => {
    const en = getLanguageEntry('en');
    expect(en).toEqual<LanguageEntry>({
      code: 'en',
      sidecarName: 'English',
      supported: true,
    });
  });

  it('returns the ru entry, supported (grandfathered under fs-2)', () => {
    const ru = getLanguageEntry('ru');
    expect(ru).toEqual<LanguageEntry>({
      code: 'ru',
      sidecarName: 'Russian',
      supported: true,
    });
  });

  it('returns undefined for a code not in the registry', () => {
    expect(getLanguageEntry('de')).toBeUndefined();
    expect(getLanguageEntry('')).toBeUndefined();
  });
});

describe('isSupportedLanguage', () => {
  it('is true for seeded en/ru, false otherwise', () => {
    expect(isSupportedLanguage('en')).toBe(true);
    expect(isSupportedLanguage('ru')).toBe(true);
    expect(isSupportedLanguage('de')).toBe(false);
    expect(isSupportedLanguage('')).toBe(false);
  });
});
