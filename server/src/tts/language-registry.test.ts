/* language-registry — single source of truth for per-language data.
   Seam 1: pins the en/ru entries + the accessor contract. */

import { describe, it, expect } from 'vitest';
import {
  getLanguageEntry,
  isSupportedLanguage,
  type LanguageEntry,
  allLanguageEntries,
  supportedLanguages,
  nonEnglishHeadingLexicon,
  nonEnglishFrontMatterKeywords,
  codeForSidecarName,
  isDefaultNarratorName,
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
      headingLexicon: {
        keywords: ['глава', 'часть', 'день', 'книга', 'действие', 'сцена', 'раздел'],
        numberWords: ['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять',
          'одиннадцать', 'двенадцать', 'двадцать', 'тридцать'],
        standalone: ['пролог', 'эпилог', 'предисловие', 'введение', 'интерлюдия', 'послесловие'],
      },
      frontMatterKeywords: ['посвящение', 'авторские права', 'благодарности', 'содержание', 'оглавление',
        'об авторе', 'предисловие', 'послесловие', 'приложение', 'глоссарий', 'библиография', 'указатель',
        'примечания', 'выходные данные', 'эпиграф'],
      narratorName: 'Рассказчик',
    });
  });

  it('returns undefined for a code not in the registry', () => {
    expect(getLanguageEntry('xy')).toBeUndefined();
    expect(getLanguageEntry('')).toBeUndefined();
  });

  it('returns the zh entry, not yet supported (fs-59 W2; promptExamples added W3)', () => {
    const zh = getLanguageEntry('zh');
    expect(zh).toEqual<LanguageEntry>({
      code: 'zh',
      sidecarName: 'Chinese',
      supported: false,
      detect: { script: 'cjk', iso6393: 'cmn' },
      headingLexicon: {
        keywords: ['章', '部', '巻', '節', '幕'],
        numberWords: [],
        standalone: ['序章', '終章', '序', '跋', 'プロローグ', 'エピローグ'],
      },
      frontMatterKeywords: ['目录', '版权', '致谢', '序言', '后记', '附录', '关于作者'],
      narratorName: '旁白',
      promptExamples: {
        roster: '例如："林芳"（女主角，二十多岁，语气温柔）、"陈警官"（旁白之外的配角，说话直接）。',
        attribution: '例："“我们该走了，”她说，“天要黑了。”" — 引号内的两段话都是这个角色说的；"她说"是旁白的叙述标签，不是说话人，"天要黑了"这后半句仍然属于说话的角色，不是旁白。',
      },
    });
  });

  it('returns the ja entry, not yet supported (fs-59 W2; promptExamples added W3)', () => {
    const ja = getLanguageEntry('ja');
    expect(ja).toEqual<LanguageEntry>({
      code: 'ja',
      sidecarName: 'Japanese',
      supported: false,
      detect: { script: 'cjk', iso6393: 'jpn' },
      headingLexicon: {
        keywords: ['章', '部', '巻', '節', '話', '幕'],
        numberWords: [],
        standalone: ['序章', '終章', 'プロローグ', 'エピローグ', 'あとがき', '前書き'],
      },
      frontMatterKeywords: ['目次', '著作権', '献辞', '謝辞', 'まえがき', 'あとがき', '付録', '著者について'],
      narratorName: '語り手',
      promptExamples: {
        roster: '例：「美咲」（主人公、二十代、口調は穏やか）、「田中刑事」（脇役、話し方は率直）。',
        attribution: '例：「もう行かないと」彼女は言った。「日が暮れる前に」 — 「」内の二つの発言はどちらもこの人物のセリフである。「彼女は言った」は語り手のタグであり話者ではない。後半の「日が暮れる前に」もタグの後に続く同じ話者のセリフであり、語り手のものではない。',
      },
    });
  });
});

describe('isSupportedLanguage', () => {
  it('is true for en/ru/es/fr/de (canary-validated), false otherwise', () => {
    expect(isSupportedLanguage('en')).toBe(true);
    expect(isSupportedLanguage('ru')).toBe(true);
    expect(isSupportedLanguage('es')).toBe(true);
    expect(isSupportedLanguage('fr')).toBe(true);
    expect(isSupportedLanguage('de')).toBe(true);
    expect(isSupportedLanguage('zh')).toBe(false); // registered but not yet validated (fs-59 W2)
    expect(isSupportedLanguage('ja')).toBe(false); // registered but not yet validated (fs-59 W2)
    expect(isSupportedLanguage('')).toBe(false);
  });
});

describe('detect field + Latin entries', () => {
  it('en/ru carry a detect script + iso6393', () => {
    expect(getLanguageEntry('en')?.detect).toEqual({ script: 'latin', iso6393: 'eng' });
    expect(getLanguageEntry('ru')?.detect).toEqual({ script: 'cyrillic', iso6393: 'rus' });
  });

  it('es exists, is Latin, and IS supported (canary-validated)', () => {
    const e = getLanguageEntry('es');
    expect(e?.detect).toEqual({ script: 'latin', iso6393: 'spa' });
    expect(e?.supported).toBe(true);
  });

  it('fr/de exist, are Latin, and ARE supported (canary-validated, plan 229)', () => {
    for (const [code, iso] of [['fr', 'fra'], ['de', 'deu']] as const) {
      const e = getLanguageEntry(code);
      expect(e?.detect).toEqual({ script: 'latin', iso6393: iso });
      expect(e?.supported).toBe(true);
    }
  });
});

describe('isSupportedLanguage distinguishes absent from present', () => {
  // zh/ja (fs-59 W2) are the present-but-`false` case; a code truly absent
  // from the registry (e.g. 'ko') exercises the `?? false` fallback path.
  it('is false-but-present for zh/ja (registered, not yet validated)', () => {
    expect(getLanguageEntry('zh')).toBeDefined();
    expect(getLanguageEntry('ja')).toBeDefined();
    expect(isSupportedLanguage('zh')).toBe(false);
    expect(isSupportedLanguage('ja')).toBe(false);
  });

  it('is false for a genuinely absent code (ko not in the registry)', () => {
    expect(getLanguageEntry('ko')).toBeUndefined();
    expect(isSupportedLanguage('ko')).toBe(false);
  });
});

describe('supportedLanguages', () => {
  it('returns only supported entries as {code,label}', () => {
    const list = supportedLanguages();
    expect(list).toEqual([
      { code: 'en', label: 'English' },
      { code: 'ru', label: 'Russian' },
      { code: 'es', label: 'Spanish' },
      { code: 'fr', label: 'French' },
      { code: 'de', label: 'German' },
    ]);
  });
});

describe('allLanguageEntries', () => {
  it('includes all seven codes (fs-59 W2 adds zh/ja)', () => {
    expect(allLanguageEntries().map((e) => e.code).sort()).toEqual([
      'de', 'en', 'es', 'fr', 'ja', 'ru', 'zh',
    ]);
  });
});

describe('nonEnglishHeadingLexicon', () => {
  it('unions the non-English heading keywords (es/fr/de/ru), deduped', () => {
    const lex = nonEnglishHeadingLexicon();
    for (const kw of ['capítulo', 'chapitre', 'kapitel', 'глава']) {
      expect(lex.keywords).toContain(kw);
    }
    // English keywords are NOT in here (English stays inline in text.ts)
    expect(lex.keywords).not.toContain('chapter');
    // deduped
    expect(new Set(lex.keywords).size).toBe(lex.keywords.length);
  });

  it('includes non-English number words and standalone markers', () => {
    const lex = nonEnglishHeadingLexicon();
    expect(lex.numberWords).toContain('uno');   // es
    expect(lex.numberWords).toContain('drei');  // de
    expect(lex.standalone).toContain('пролог'); // ru prologue
    expect(lex.standalone).toContain('prólogo');// es prologue
  });

  it('en has no headingLexicon; ru/es/fr/de do', () => {
    expect(getLanguageEntry('en')?.headingLexicon).toBeUndefined();
    for (const c of ['ru', 'es', 'fr', 'de']) {
      expect(getLanguageEntry(c)?.headingLexicon).toBeDefined();
    }
  });
});

describe('nonEnglishFrontMatterKeywords', () => {
  it('unions non-English front-matter terms (deduped), no English', () => {
    const fm = nonEnglishFrontMatterKeywords();
    for (const w of ['dedicatoria', 'dédicace', 'widmung', 'посвящение']) expect(fm).toContain(w);
    expect(fm).not.toContain('dedication'); // English stays inline in front-matter.ts
    expect(new Set(fm).size).toBe(fm.length);
  });
  it('ru/es/fr/de carry frontMatterKeywords; en does not', () => {
    expect(getLanguageEntry('en')?.frontMatterKeywords).toBeUndefined();
    for (const c of ['ru', 'es', 'fr', 'de']) expect(getLanguageEntry(c)?.frontMatterKeywords).toBeDefined();
  });
});

describe('codeForSidecarName', () => {
  it('maps sidecar words back to BCP-47 codes', () => {
    expect(codeForSidecarName('Russian')).toBe('ru');
    expect(codeForSidecarName('Spanish')).toBe('es');
    expect(codeForSidecarName('German')).toBe('de');
    expect(codeForSidecarName('English')).toBe('en');
    expect(codeForSidecarName('Klingon')).toBeUndefined();
  });
});

describe('narratorName', () => {
  it('exposes localized narrator names for the four non-English supported languages', () => {
    expect(getLanguageEntry('de')?.narratorName).toBe('Erzähler');
    expect(getLanguageEntry('ru')?.narratorName).toBe('Рассказчик');
    expect(getLanguageEntry('es')?.narratorName).toBe('Narrador');
    expect(getLanguageEntry('fr')?.narratorName).toBe('Narrateur');
  });

  it('omits narratorName on en (defaults to "Narrator" at the call site)', () => {
    expect(getLanguageEntry('en')?.narratorName).toBeUndefined();
  });

  it('exposes localized narrator names for zh/ja (fs-59, still supported:false)', () => {
    // Seeded now so a CJK book's narrator localizes the moment zh/ja flip to
    // supported at W5 — the seed reads getLanguageEntry(lang)?.narratorName.
    expect(getLanguageEntry('zh')?.narratorName).toBe('旁白');
    expect(getLanguageEntry('ja')?.narratorName).toBe('語り手');
  });
});

describe('isDefaultNarratorName', () => {
  it('is true for the English default and every localized default, case-insensitively', () => {
    for (const n of ['Narrator', 'narrator', ' NARRATOR ', 'Erzähler', 'Рассказчик', 'Narrador', 'Narrateur', '旁白', '語り手']) {
      expect(isDefaultNarratorName(n)).toBe(true);
    }
  });
  it('is false for a user rename and for empty/nullish', () => {
    expect(isDefaultNarratorName('The Bard')).toBe(false);
    expect(isDefaultNarratorName('')).toBe(false);
    expect(isDefaultNarratorName(undefined)).toBe(false);
    expect(isDefaultNarratorName(null)).toBe(false);
  });
});
