/* seam 3e — languagePreamble es/fr/de naming + conventions (Task 1) */
import { describe, expect, it } from 'vitest';
import { languagePreamble } from './gemini.js';

describe('languagePreamble — es/fr/de naming + conventions (seam 3e)', () => {
  it('names Spanish/French/German (not the raw code) and adds quote conventions', () => {
    expect(languagePreamble('es')).toMatch(/Spanish/);
    expect(languagePreamble('es')).not.toMatch(/\bes \(a non-English language\)/);
    expect(languagePreamble('fr')).toMatch(/French/);
    expect(languagePreamble('de')).toMatch(/German/);
    // German caution: capitalisation does not indicate a name
    expect(languagePreamble('de')).toMatch(/capitali[sz]ed/i);
  });

  it('is empty for English and unchanged for Russian (still names Russian + Cyrillic)', () => {
    expect(languagePreamble('en')).toBe('');
    expect(languagePreamble(undefined)).toBe('');
    expect(languagePreamble('ru')).toMatch(/Russian \(Cyrillic script\)/);
  });

  it('languagePreamble carries CJK conventions + in-language examples', () => {
    // NOTE (independent-review): do NOT assert on the language NAME — after Task 2.1
    // registers the rows, `where` already contains "Japanese"/"Chinese" (gemini.ts:233),
    // so /Japanese/ passes before any W3 change. Assert on the CJK-specific convention
    // text + the in-language few-shot marker instead.
    const ja = languagePreamble('ja');
    expect(ja).toContain('「');                 // corner-bracket convention hint (new in W3)
    expect(ja).toMatch(/tag[^]*narrator|話者ではない/); // interrupted-quote/tag-is-narrator few-shot
    expect(languagePreamble('zh')).toContain('“'); // zh fullwidth-quote hint
  });
});
