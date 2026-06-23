/* Server-side manuscript language detection (fs-41/fs-50 seam 2).
   Script pre-pass is authoritative; franc disambiguates Latin; front-matter
   stripped before detecting; es/fr/de detected but not yet `supported`. */
import { describe, it, expect } from 'vitest';
import { detectManuscriptLanguage } from './detect-language.js';

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

  it('detects French (not yet supported)', () => {
    const fr =
      "Le four avait refroidi jusqu'à la couleur d'un coucher de soleil couvert de cendre, et Wren raclait la dernière scorie lorsque l'on frappa à la porte de son atelier.";
    expect(detectManuscriptLanguage(fr)).toEqual({ language: 'fr', supported: false });
  });

  it('detects German (not yet supported)', () => {
    const de =
      'Der Ofen war bis zur Farbe eines aschbedeckten Sonnenuntergangs abgekühlt, und Wren kratzte die letzte Schlacke ab, als es an der Tür ihrer Werkstatt klopfte.';
    expect(detectManuscriptLanguage(de)).toEqual({ language: 'de', supported: false });
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

  it('flags a CJK manuscript as detected-but-unsupported (no zh/ja registry entry yet)', () => {
    const zh = '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
    const r = detectManuscriptLanguage(zh);
    expect(r.supported).toBe(false);
    expect(['zh', 'ja']).toContain(r.language);
  });
});
