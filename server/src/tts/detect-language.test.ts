/* Server-side manuscript language detection (fs-41/fs-50 seam 2).
   Script pre-pass is authoritative; franc disambiguates Latin; front-matter
   stripped before detecting; es/fr/de detected but not yet `supported`. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectManuscriptLanguage } from './detect-language.js';
import { getLanguageEntry } from './language-registry.js';

describe('detectManuscriptLanguage', () => {
  it('detects Russian via the Cyrillic pre-pass (supported)', () => {
    const ru =
      'Горн остыл до цвета подёрнутого пеплом заката, и Рен выскребала последнюю окалину, когда раздался стук в дверь её мастерской.';
    expect(detectManuscriptLanguage(ru)).toEqual({ language: 'ru', supported: true });
  });

  it('detects Spanish (present in the registry, supported — canary-validated)', () => {
    const es =
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller.';
    expect(detectManuscriptLanguage(es)).toEqual({ language: 'es', supported: true });
  });

  it('detects French (supported, plan 229)', () => {
    const fr =
      "Le four avait refroidi jusqu'à la couleur d'un coucher de soleil couvert de cendre, et Wren raclait la dernière scorie lorsque l'on frappa à la porte de son atelier.";
    expect(detectManuscriptLanguage(fr)).toEqual({ language: 'fr', supported: true });
  });

  it('detects German (supported, plan 229)', () => {
    const de =
      'Der Ofen war bis zur Farbe eines aschbedeckten Sonnenuntergangs abgekühlt, und Wren kratzte die letzte Schlacke ab, als es an der Tür ihrer Werkstatt klopfte.';
    expect(detectManuscriptLanguage(de)).toEqual({ language: 'de', supported: true });
  });

  it('keeps an English manuscript English even when dense with French proper nouns', () => {
    const en =
      'Marcel Beaumont and Geneviève Dubois walked along the Champs-Élysées toward the Café de Flore, where Henri Toussaint waited beneath the awning with the morning papers.';
    expect(detectManuscriptLanguage(en)).toEqual({ language: 'en', supported: true });
  });

  it('returns English for empty / letter-less input', () => {
    expect(detectManuscriptLanguage('')).toEqual({ language: 'en', supported: true });
    expect(detectManuscriptLanguage('1234 — ... !!!')).toEqual({ language: 'en', supported: true });
  });

  it('strips an English front-matter page before detecting the Spanish body', () => {
    const text =
      'Copyright © 2026 Some Publisher. All rights reserved.\nFirst published as an ebook.\nhttps://example.com/book\n\n' +
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller, una y otra vez, hasta que abrió.';
    // stripFrontMatterBoilerplate drops the bare-URL + copyright lines; the Spanish
    // body dominates the sample, so franc must return Spanish, not English.
    expect(detectManuscriptLanguage(text)).toEqual({ language: 'es', supported: true });
  });

  it('flags a CJK manuscript as detected-but-unsupported, reading `supported` THROUGH the registry (fs-59 W2) rather than hardcoding it', () => {
    const zh = '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
    const r = detectManuscriptLanguage(zh);
    // read-through, not a literal: mirrors whatever the registry says today
    // (false today; flips automatically once fs-59 W5 sets zh.supported = true).
    expect(r.supported).toBe(getLanguageEntry('zh')?.supported ?? false);
    expect(['zh', 'ja']).toContain(r.language);
  });

  it('detects Japanese via the CJK pre-pass, supported reads through the registry (false today)', () => {
    const ja = '彼は歩いた。彼女は走った。'.repeat(50);
    const r = detectManuscriptLanguage(ja);
    expect(r.language).toBe('ja');
    expect(r.supported).toBe(getLanguageEntry('ja')?.supported ?? false);
  });
});

describe('detectManuscriptLanguage — CJK read-through proof (fs-59 W2, independent-review CRITICAL finding)', () => {
  /* Each test must: vi.resetModules() → vi.doMock() → dynamic import, so the
     dynamic `import('./detect-language.js')` inside the test picks up the
     stubbed registry rather than the module cache (see ensure-sidecar-loaded.test.ts
     for the same pattern). This is the load-bearing test: it does NOT rely on
     the false==false coincidence (today's real zh.supported is false) — it
     stubs the registry to zh.supported=true and proves detection propagates
     that, which only happens if the CJK branch calls the `result()` helper
     instead of returning a hardcoded `{ supported: false }` literal. */
  afterEach(() => {
    vi.doUnmock('./language-registry.js');
    vi.resetModules();
  });

  it('propagates a stubbed zh.supported=true through to the detection result', async () => {
    vi.resetModules();
    vi.doMock('./language-registry.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./language-registry.js')>();
      return {
        ...actual,
        allLanguageEntries: () =>
          actual.allLanguageEntries().map((e) => (e.code === 'zh' ? { ...e, supported: true } : e)),
      };
    });
    const { detectManuscriptLanguage: detectWithStub } = await import('./detect-language.js');
    const zh = '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
    const r = detectWithStub(zh);
    expect(r.language).toBe('zh');
    expect(r.supported).toBe(true); // only true if the CJK branch reads THROUGH the registry
  });
});
