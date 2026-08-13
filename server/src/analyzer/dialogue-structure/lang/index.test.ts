import { describe, expect, it } from 'vitest';
import { conventionsFor } from './index.js';

describe('conventionsFor', () => {
  it('returns a populated table for each supported language', () => {
    // `ja` is deliberately NOT in this loop: it carries 9 speechVerbStems,
    // under the >10 bar below. (`zh` has 11 and would pass; it is left out
    // alongside its sibling rather than split across the two lists.) The
    // duplicate-pair guard further down DOES cover both — salvaged onto #2288's
    // engine fix (#2300) while this branch was blocked.
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
  it('no language declares a pair in BOTH tiers', () => {
    for (const lang of ['ru', 'en', 'es', 'fr', 'de', 'zh', 'ja']) {
      const c = conventionsFor(lang)!;
      const inPrimary = (o: string, x: string) => c.quotePairs.some(([a, b]) => a === o && b === x);
      for (const [o, x] of c.secondaryQuotePairs) {
        expect(inPrimary(o, x), `${lang} declares ${o}${x} in both tiers`).toBe(false);
      }
    }
  });

  /* The gap tier's straddle test keys on the primary OPENER SET, so a secondary
     pair sharing an opener with a primary pair would decline itself. None of
     #2286's nine additions does — verified per language in the design. Loosen
     this only together with a re-measurement. */
  it('no secondary pair shares an opener glyph with a primary pair', () => {
    for (const lang of ['ru', 'en', 'es', 'fr', 'de', 'zh', 'ja']) {
      const c = conventionsFor(lang)!;
      const primaryOpeners = new Set(c.quotePairs.map(([o]) => o));
      for (const [o] of c.secondaryQuotePairs) {
        expect(primaryOpeners.has(o), `${lang}: secondary opener ${o} is also a primary opener`).toBe(false);
      }
    }
  });
});
