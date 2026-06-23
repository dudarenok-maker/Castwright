/* language — the BCP-47 ↔ sidecar language-name bridge (fs-2). Pins the
   normalisation, the en/ru mapping, the fail-loud throw for unsupported codes
   (seam 5a), and the isNonEnglish predicate that gates the never-cross-language
   enforcement. */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LANGUAGE,
  normaliseBookLanguage,
  sidecarLanguageName,
  isNonEnglish,
} from './language.js';

describe('normaliseBookLanguage', () => {
  it('defaults missing/empty/whitespace to en', () => {
    expect(normaliseBookLanguage(undefined)).toBe('en');
    expect(normaliseBookLanguage(null)).toBe('en');
    expect(normaliseBookLanguage('')).toBe('en');
    expect(normaliseBookLanguage('   ')).toBe('en');
    expect(DEFAULT_LANGUAGE).toBe('en');
  });

  it('lower-cases and strips to the primary subtag', () => {
    expect(normaliseBookLanguage('ru')).toBe('ru');
    expect(normaliseBookLanguage('RU')).toBe('ru');
    expect(normaliseBookLanguage('ru-RU')).toBe('ru');
    expect(normaliseBookLanguage('en-US')).toBe('en');
  });
});

describe('sidecarLanguageName', () => {
  it('maps en/ru (and their regional variants) to the sidecar word', () => {
    expect(sidecarLanguageName('en')).toBe('English');
    expect(sidecarLanguageName('en-US')).toBe('English');
    expect(sidecarLanguageName('ru')).toBe('Russian');
    expect(sidecarLanguageName('ru-RU')).toBe('Russian');
  });

  it('treats missing/empty as English (normalises to "en" which resolves)', () => {
    expect(sidecarLanguageName('')).toBe('English');
  });

  /* seam 5a — fail loud: an unsupported language code must THROW, not silently
     return 'English' and ship cross-language garbage through the voice pipeline. */
  it('throws for an unknown BCP-47 code', () => {
    expect(() => sidecarLanguageName('xy')).toThrow(/unsupported language/);
    expect(() => sidecarLanguageName('xy')).toThrow(/xy/);
  });

  it('throws for a language not in the registry (e.g. Japanese)', () => {
    expect(() => sidecarLanguageName('ja')).toThrow(/unsupported language/);
    expect(() => sidecarLanguageName('ja-JP')).toThrow(/unsupported language/);
  });

  it('throw message includes the bcp47 tag and the primary subtag', () => {
    expect(() => sidecarLanguageName('zz-ZZ')).toThrow(/zz-ZZ/);
    expect(() => sidecarLanguageName('zz-ZZ')).toThrow(/"zz"/);
  });

  it('sources the language word from the registry entry', async () => {
    const { getLanguageEntry } = await import('./language-registry.js');
    expect(sidecarLanguageName('ru')).toBe(getLanguageEntry('ru')?.sidecarName);
    expect(sidecarLanguageName('en')).toBe(getLanguageEntry('en')?.sidecarName);
  });
});

describe('isNonEnglish', () => {
  it('is false for English (and absent/empty), true for everything else', () => {
    expect(isNonEnglish('en')).toBe(false);
    expect(isNonEnglish('en-US')).toBe(false);
    expect(isNonEnglish('')).toBe(false);
    expect(isNonEnglish('ru')).toBe(true);
    expect(isNonEnglish('ru-RU')).toBe(true);
    expect(isNonEnglish('de')).toBe(true);
  });
});
