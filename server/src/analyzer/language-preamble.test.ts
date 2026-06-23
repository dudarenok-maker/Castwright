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
});
