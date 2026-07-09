import { describe, expect, it } from 'vitest';
import { conventionsFor } from './index.js';

describe('conventionsFor', () => {
  it('returns a populated table for each supported language', () => {
    for (const lang of ['ru', 'en', 'es', 'fr', 'de']) {
      const c = conventionsFor(lang);
      expect(c, lang).not.toBeNull();
      expect(c!.speechVerbStems.length, lang).toBeGreaterThan(10);
    }
  });
  it('returns null for unsupported/absent language (engine no-op path)', () => {
    expect(conventionsFor('ja')).toBeNull();
    expect(conventionsFor(undefined)).toBeNull();
  });
  it('ru stemmer strips case endings so Антона/Антону/Антоном share a stem', () => {
    const ru = conventionsFor('ru')!;
    const stems = new Set(['Антона', 'Антону', 'Антоном', 'Антоне', 'Антон'].map((t) => ru.nameStemmer(t.toLowerCase())));
    expect(stems.size).toBe(1);
  });
  it('en stemmer strips possessive only', () => {
    const en = conventionsFor('en')!;
    expect(en.nameStemmer("halloran's")).toBe('halloran');
    expect(en.nameStemmer('halloran')).toBe('halloran');
  });
});
