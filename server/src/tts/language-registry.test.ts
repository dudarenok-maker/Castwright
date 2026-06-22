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
      detect: { script: 'latin', iso6393: 'eng' },
    });
  });

  it('returns the ru entry, supported (grandfathered under fs-2)', () => {
    const ru = getLanguageEntry('ru');
    expect(ru).toEqual<LanguageEntry>({
      code: 'ru',
      sidecarName: 'Russian',
      supported: true,
      detect: { script: 'cyrillic', iso6393: 'rus' },
    });
  });

  it('returns undefined for a code not in the registry', () => {
    expect(getLanguageEntry('xy')).toBeUndefined();
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

import {
  allLanguageEntries,
  supportedLanguages,
} from './language-registry.js';

describe('detect field + Latin entries', () => {
  it('en/ru carry a detect script + iso6393', () => {
    expect(getLanguageEntry('en')?.detect).toEqual({ script: 'latin', iso6393: 'eng' });
    expect(getLanguageEntry('ru')?.detect).toEqual({ script: 'cyrillic', iso6393: 'rus' });
  });

  it('es/fr/de exist, are Latin, and are NOT yet supported', () => {
    for (const [code, iso] of [['es', 'spa'], ['fr', 'fra'], ['de', 'deu']] as const) {
      const e = getLanguageEntry(code);
      expect(e?.detect).toEqual({ script: 'latin', iso6393: iso });
      expect(e?.supported).toBe(false);
    }
  });
});

describe('isSupportedLanguage with a present-but-unsupported entry', () => {
  it('is false for es (present, supported:false) — not just for absent codes', () => {
    expect(getLanguageEntry('es')).toBeDefined();
    expect(isSupportedLanguage('es')).toBe(false);
  });
});

describe('supportedLanguages', () => {
  it('returns only supported entries as {code,label}', () => {
    const list = supportedLanguages();
    expect(list).toEqual([
      { code: 'en', label: 'English' },
      { code: 'ru', label: 'Russian' },
    ]);
  });
});

describe('allLanguageEntries', () => {
  it('includes all five codes', () => {
    expect(allLanguageEntries().map((e) => e.code).sort()).toEqual(['de', 'en', 'es', 'fr', 'ru']);
  });
});
