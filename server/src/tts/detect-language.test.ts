/* Server-side manuscript language detection (fs-41/fs-50 seam 2).
   Script pre-pass is authoritative; franc disambiguates Latin; front-matter
   stripped before detecting; es/fr/de detected but not yet `supported`. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectManuscriptLanguage, detectManuscriptLanguageFromChapters } from './detect-language.js';
import { getLanguageEntry } from './language-registry.js';

describe('detectManuscriptLanguage', () => {
  it('detects Russian via the Cyrillic pre-pass (supported)', () => {
    const ru =
      'Горн остыл до цвета подёрнутого пеплом заката, и Рен выскребала последнюю окалину, когда раздался стук в дверь её мастерской.';
    expect(detectManuscriptLanguage(ru)).toEqual({ language: 'ru', supported: true, fallback: false });
  });

  it('detects Spanish (present in the registry, supported — canary-validated)', () => {
    const es =
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller.';
    expect(detectManuscriptLanguage(es)).toEqual({ language: 'es', supported: true, fallback: false });
  });

  it('detects French (supported, plan 229)', () => {
    const fr =
      "Le four avait refroidi jusqu'à la couleur d'un coucher de soleil couvert de cendre, et Wren raclait la dernière scorie lorsque l'on frappa à la porte de son atelier.";
    expect(detectManuscriptLanguage(fr)).toEqual({ language: 'fr', supported: true, fallback: false });
  });

  it('detects German (supported, plan 229)', () => {
    const de =
      'Der Ofen war bis zur Farbe eines aschbedeckten Sonnenuntergangs abgekühlt, und Wren kratzte die letzte Schlacke ab, als es an der Tür ihrer Werkstatt klopfte.';
    expect(detectManuscriptLanguage(de)).toEqual({ language: 'de', supported: true, fallback: false });
  });

  it('keeps an English manuscript English even when dense with French proper nouns', () => {
    const en =
      'Marcel Beaumont and Geneviève Dubois walked along the Champs-Élysées toward the Café de Flore, where Henri Toussaint waited beneath the awning with the morning papers.';
    // A real franc match on 'en' is a decision, not a surrender: fallback must be false
    // even though the language happens to be the same value the surrender paths guess.
    expect(detectManuscriptLanguage(en)).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('returns English for empty / letter-less input, flagged as a fallback guess', () => {
    // Surrender branch 1 (detect-language.ts): letters === 0. `language`/`supported`
    // are identical to a genuine English decision — only `fallback` distinguishes them.
    expect(detectManuscriptLanguage('')).toEqual({ language: 'en', supported: true, fallback: true });
    expect(detectManuscriptLanguage('1234 — ... !!!')).toEqual({
      language: 'en',
      supported: true,
      fallback: true,
    });
  });

  it('flags English as a fallback guess when franc finds no Latin match', () => {
    // Surrender branch 2 (detect-language.ts): the terminal `match ? … : result('en')`
    // when franc returns 'und' or a code outside the registry's Latin set. Short,
    // ambiguous, punctuation-heavy text starves franc below its confidence floor.
    const r = detectManuscriptLanguage('. . . ? ! -- ok yes no');
    expect(r).toEqual({ language: 'en', supported: true, fallback: true });
  });

  it('strips an English front-matter page before detecting the Spanish body', () => {
    const text =
      'Copyright © 2026 Some Publisher. All rights reserved.\nFirst published as an ebook.\nhttps://example.com/book\n\n' +
      'El horno se había enfriado hasta el color de un atardecer cubierto de ceniza, y Wren raspaba la última escoria cuando alguien llamó a la puerta de su taller, una y otra vez, hasta que abrió.';
    // stripFrontMatterBoilerplate drops the bare-URL + copyright lines; the Spanish
    // body dominates the sample, so franc must return Spanish, not English.
    expect(detectManuscriptLanguage(text)).toEqual({ language: 'es', supported: true, fallback: false });
  });

  it('flags a CJK manuscript with `supported` read THROUGH the registry (fs-59 W2 mechanism; W5 flips zh to supported:true) rather than hardcoded', () => {
    const zh = '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
    const r = detectManuscriptLanguage(zh);
    // read-through, not a literal: mirrors whatever the registry says
    // (true since fs-59 W5 flipped zh.supported = true).
    expect(r.supported).toBe(getLanguageEntry('zh')?.supported ?? false);
    expect(['zh', 'ja']).toContain(r.language);
    expect(r.fallback).toBe(false); // script pre-pass match — a decision, not a guess
  });

  it('detects Japanese via the CJK pre-pass, supported reads through the registry (true since fs-59 W5)', () => {
    const ja = '彼は歩いた。彼女は走った。'.repeat(50);
    const r = detectManuscriptLanguage(ja);
    expect(r.language).toBe('ja');
    expect(r.supported).toBe(getLanguageEntry('ja')?.supported ?? false);
    expect(r.fallback).toBe(false); // script pre-pass match — a decision, not a guess
  });
});

describe('detectManuscriptLanguage — CJK read-through proof (fs-59 W2, independent-review CRITICAL finding)', () => {
  /* Each test must: vi.resetModules() → vi.doMock() → dynamic import, so the
     dynamic `import('./detect-language.js')` inside the test picks up the
     stubbed registry rather than the module cache (see ensure-sidecar-loaded.test.ts
     for the same pattern). This is the load-bearing test: it does NOT rely on
     the real registry's current zh.supported value (true since fs-59 W5) — it
     stubs the registry to zh.supported=true independently and proves detection
     propagates that stub, which only happens if the CJK branch calls the
     `result()` helper instead of returning a hardcoded `{ supported: false }`
     literal (the original independent-review CRITICAL finding). */
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
    expect(r.fallback).toBe(false); // script pre-pass match — a decision, not a guess
  });
});

/* #2263 — chapter-aware entry point (POST /api/import calls this instead of
   detectManuscriptLanguage). Fixtures repeat a single real sentence enough
   times to clear BOTH thresholds a body chapter needs to enter the vote:
   FRONT_MATTER_WORD_THRESHOLD (150 words) and, for the single-chapter path,
   PROSE_UNIT_FLOOR (20 sentence-terminal units) — each repeat is one unit. */
describe('detectManuscriptLanguageFromChapters (#2263)', () => {
  const EN_SENTENCE =
    'Marcel Beaumont and Geneviève Dubois walked along the Champs-Élysées toward the Café de Flore, where Henri Toussaint waited beneath the awning with the morning papers.';
  const RU_SENTENCE =
    'Горн остыл до цвета подёрнутого пеплом заката, и Рен выскребала последнюю окалину, когда раздался стук в дверь её мастерской.';
  const ZH_SENTENCE =
    '熔炉已经冷却到被灰烬覆盖的落日的颜色，当有人敲响她作坊的门时，雷恩正在刮掉最后的炉渣。';
  const repeat = (sentence: string, times = 25) => Array(times).fill(sentence).join(' ');

  it('votes over multiple body chapters and returns the unanimous language', () => {
    const r = detectManuscriptLanguageFromChapters([
      { title: 'Chapter One', body: repeat(EN_SENTENCE) },
      { title: 'Chapter Two', body: repeat(EN_SENTENCE) },
    ]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('drops a front-matter-titled chapter from the vote, not just outvotes it', () => {
    // Without the title filter this would be a 1-en/1-ru split (no strict
    // majority) and surrender. With it, "Copyright" never enters the vote,
    // leaving a single English candidate that clears the floor on its own.
    const r = detectManuscriptLanguageFromChapters([
      { title: 'Copyright', body: repeat(RU_SENTENCE) },
      { title: 'Chapter One', body: repeat(EN_SENTENCE) },
    ]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('drops a short, non-front-matter-titled chapter by WORD COUNT alone — a 1-vs-1 head-to-head that only resolves once it is dropped', () => {
    // Isolates the word-count half of selectBodyChapters from the title
    // half and from vote-majority robustness: with only ONE other chapter,
    // an unfiltered short chapter is a 1-vs-1 split (no majority) — dropping
    // it by word count alone is the only way this resolves to a decision.
    const r = detectManuscriptLanguageFromChapters([
      { title: 'Chapter 1', body: '[emphatic] Castwright 原创作品。\n\n---' }, // not front-matter-titled, but far under FRONT_MATTER_WORD_THRESHOLD
      { title: '第一章', body: repeat(ZH_SENTENCE) },
    ]);
    expect(r).toEqual({ language: 'zh', supported: true, fallback: false });
  });

  it('drops a short, non-front-matter-titled first chapter by WORD COUNT alone — resolves to the body language (the 煤落的委托 shape)', () => {
    // Real repro against the live corpus book: this exact chapter body,
    // detected alone, is a confident (fallback:false) WRONG 'en' vote —
    // proof the selection filter, not the vote, is what excludes it.
    const lookalike = detectManuscriptLanguage('[emphatic] Castwright 原创作品。\n\n---');
    expect(lookalike).toEqual({ language: 'en', supported: true, fallback: false });

    const r = detectManuscriptLanguageFromChapters([
      { title: 'Chapter 1', body: '[emphatic] Castwright 原创作品。\n\n---' }, // not a front-matter TITLE, but far under FRONT_MATTER_WORD_THRESHOLD
      { title: '第一章', body: repeat(ZH_SENTENCE) },
      { title: '第二章', body: repeat(ZH_SENTENCE) },
    ]);
    expect(r.language).toBe('zh');
    expect(r.fallback).toBe(false);
  });

  it('2-vs-2 split (en/ru), no strict majority → surrenders', () => {
    const r = detectManuscriptLanguageFromChapters([
      { title: 'Chapter One', body: repeat(EN_SENTENCE) },
      { title: 'Chapter Two', body: repeat(EN_SENTENCE) },
      { title: 'Глава первая', body: repeat(RU_SENTENCE) },
      { title: 'Глава вторая', body: repeat(RU_SENTENCE) },
    ]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: true });
  });

  it('a single body chapter ABOVE the prose-unit floor backfills (the floor is not a blanket single-chapter refusal)', () => {
    const r = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: repeat(EN_SENTENCE) }]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('a single body chapter BELOW the prose-unit floor surrenders — it cannot corroborate itself', () => {
    // Genuine, confidently-detected English prose on its own (fallback would
    // be false via detectManuscriptLanguage directly) — but only one
    // sentence, far under PROSE_UNIT_FLOOR.
    const solo = detectManuscriptLanguage(EN_SENTENCE);
    expect(solo.fallback).toBe(false);

    const r = detectManuscriptLanguageFromChapters([{ title: 'Chapter One', body: EN_SENTENCE }]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: true });
  });

  it('falls back to considering ALL chapters when every one is front-matter-titled, rather than refusing outright', () => {
    const r = detectManuscriptLanguageFromChapters([
      { title: 'Dedication', body: repeat(EN_SENTENCE) },
      { title: 'Copyright', body: repeat(EN_SENTENCE) },
    ]);
    expect(r).toEqual({ language: 'en', supported: true, fallback: false });
  });

  it('an empty chapter list surrenders rather than throwing', () => {
    expect(detectManuscriptLanguageFromChapters([])).toEqual({ language: 'en', supported: true, fallback: true });
  });
});
