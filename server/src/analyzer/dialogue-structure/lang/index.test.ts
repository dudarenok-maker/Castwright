import { describe, expect, it } from 'vitest';
import { conventionsFor } from './index.js';

describe('conventionsFor', () => {
  it('returns a populated table for each supported language', () => {
    // zh/ja are deliberately NOT in this loop: their speechVerbStems are single
    // CJK characters, so the >10 bar below does not apply to them (ja has 9).
    // The duplicate-pair guard further down DOES cover them, since #2279.
    for (const lang of ['ru', 'en', 'es', 'fr', 'de']) {
      const c = conventionsFor(lang);
      expect(c, lang).not.toBeNull();
      expect(c!.speechVerbStems.length, lang).toBeGreaterThan(10);
    }
  });
  it('returns null for unsupported/absent language (engine no-op path)', () => {
    expect(conventionsFor('zz')).toBeNull();
    expect(conventionsFor(undefined)).toBeNull();
  });
  it('registers zh/ja conventions', () => {
    expect(conventionsFor('ja')?.quotePairs).toContainEqual(['「', '」']);
    expect(conventionsFor('zh')?.quotePairs).toContainEqual(['“', '”']);
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
  it('quotePairs has no collapsed duplicate pairs for any supported language', () => {
    // zh/ja joined this loop in #2279 — the release that first gave them pairs
    // beyond their two CJK brackets, i.e. the first time collapsing was possible.
    for (const lang of ['ru', 'en', 'es', 'fr', 'de', 'zh', 'ja']) {
      const c = conventionsFor(lang)!;
      const seen = new Set<string>();
      for (const [open, close] of c.quotePairs) {
        const key = `${open} ${close}`;
        expect(seen.has(key), `${lang}: duplicate quotePair ${JSON.stringify([open, close])}`).toBe(false);
        seen.add(key);
      }
    }
  });
  it('en quotePairs contains the plain-ASCII quote pair', () => {
    expect(conventionsFor('en')!.quotePairs).toContainEqual(['"', '"']);
  });
  it('ru quotePairs distinguishes the curly pair from the low-open pair', () => {
    const ru = conventionsFor('ru')!;
    expect(ru.quotePairs).toContainEqual(['“', '”']); // “ ”
    expect(ru.quotePairs).toContainEqual(['„', '“']); // „ “
  });
});
