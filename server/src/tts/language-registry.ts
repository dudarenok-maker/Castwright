/* language-registry — the single source of truth for per-language data
   (fs-41/fs-50). Seam 1 (foundation) holds only the fields `language.ts`
   reads today: `code`, `sidecarName`, `supported`. Later seams EXTEND
   LanguageEntry with the detection slice, text-pipeline lexicons, and
   `refText` (see the fs-41/fs-50 spec §2) and add es/fr/de entries — each
   gated `supported:false` until its validation gate passes.

   `en` and `ru` are seeded `supported:true`: ru shipped validated under
   fs-2, so it is grandfathered past the per-language gate.
   `es` flipped `supported:true` 2026-06-23 after canary validation + operator
   acceptance (fs-41/fs-50 Spanish rollout). `fr` and `de` remain gated. */

export interface LanguageEntry {
  /** BCP-47 primary subtag, lower-cased (e.g. 'en', 'ru', 'es'). */
  code: string;
  /** Sidecar/analyzer language word — also the confirm-selector label. */
  sidecarName: string;
  /** True only once the language has passed its validation gate. */
  supported: boolean;
  /** Detection routing: the script class + the franc ISO-639-3 code for this language. */
  detect: { script: 'latin' | 'cyrillic'; iso6393: string };
  /** Non-English chapter-heading lexicon (used to build the language-agnostic
      split regex; English stays inline in parsers/text.ts). Absent on `en`. */
  headingLexicon?: { keywords: string[]; numberWords: string[]; standalone: string[] };
  /** Non-English front/back-matter title terms (used to build the language-agnostic
      FRONT_MATTER_RX; English stays inline in parsers/front-matter.ts). Absent on en. */
  frontMatterKeywords?: string[];
}

const ENTRIES: readonly LanguageEntry[] = [
  { code: 'en', sidecarName: 'English', supported: true,  detect: { script: 'latin',    iso6393: 'eng' } },
  { code: 'ru', sidecarName: 'Russian', supported: true,  detect: { script: 'cyrillic', iso6393: 'rus' },
    headingLexicon: {
      keywords: ['глава', 'часть', 'день', 'книга', 'действие', 'сцена', 'раздел'],
      numberWords: ['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять',
        'одиннадцать', 'двенадцать', 'двадцать', 'тридцать'],
      standalone: ['пролог', 'эпилог', 'предисловие', 'введение', 'интерлюдия', 'послесловие'],
    },
    frontMatterKeywords: ['посвящение', 'авторские права', 'благодарности', 'содержание', 'оглавление',
      'об авторе', 'предисловие', 'послесловие', 'приложение', 'глоссарий', 'библиография', 'указатель',
      'примечания', 'выходные данные', 'эпиграф'],
  },
  // es: canary-validated + operator-accepted (2026-06-23); fr/de remain gated.
  // fr/de: detection identifies them, but they are not claimed until their
  // rollout phase's operator gate flips `supported`.
  { code: 'es', sidecarName: 'Spanish', supported: true,  detect: { script: 'latin',    iso6393: 'spa' },
    headingLexicon: {
      keywords: ['capítulo', 'parte', 'día', 'libro', 'acto', 'escena', 'sección'],
      numberWords: ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
        'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
        'veinte', 'treinta', 'cuarenta', 'cincuenta'],
      standalone: ['prólogo', 'epílogo', 'prefacio', 'introducción', 'interludio', 'epígrafe'],
    },
    frontMatterKeywords: ['dedicatoria', 'derechos de autor', 'agradecimientos', 'índice', 'sobre el autor',
      'prefacio', 'apéndice', 'glosario', 'bibliografía', 'epígrafe', 'colofón', 'nota del autor',
      'nota del traductor'],
  },
  { code: 'fr', sidecarName: 'French',  supported: false, detect: { script: 'latin',    iso6393: 'fra' },
    headingLexicon: {
      keywords: ['chapitre', 'partie', 'jour', 'livre', 'acte', 'scène', 'section'],
      numberWords: ['un', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
        'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'vingt', 'trente', 'quarante', 'cinquante'],
      standalone: ['prologue', 'épilogue', 'préface', 'introduction', 'interlude', 'avant-propos'],
    },
    frontMatterKeywords: ['dédicace', 'remerciements', 'table des matières', 'sommaire',
      'à propos de l\'auteur', 'préface', 'avant-propos', 'postface', 'annexe', 'glossaire', 'bibliographie',
      'note de l\'auteur', 'note du traducteur', 'colophon', 'épigraphe'],
  },
  { code: 'de', sidecarName: 'German',  supported: false, detect: { script: 'latin',    iso6393: 'deu' },
    headingLexicon: {
      keywords: ['kapitel', 'teil', 'tag', 'buch', 'akt', 'szene', 'abschnitt'],
      numberWords: ['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn',
        'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'zwanzig', 'dreißig', 'vierzig'],
      standalone: ['prolog', 'epilog', 'vorwort', 'einleitung', 'zwischenspiel', 'nachwort'],
    },
    frontMatterKeywords: ['widmung', 'urheberrecht', 'danksagung', 'inhaltsverzeichnis', 'über den autor',
      'vorwort', 'nachwort', 'anhang', 'glossar', 'bibliografie', 'register', 'anmerkungen', 'impressum',
      'epigraph'],
  },
];

const BY_CODE: ReadonlyMap<string, LanguageEntry> = new Map(
  ENTRIES.map((e) => [e.code, e]),
);

/** Look up a registry entry by an already-normalised BCP-47 primary subtag. */
export function getLanguageEntry(code: string): LanguageEntry | undefined {
  return BY_CODE.get(code);
}

/** True when the language has passed its validation gate (registry `supported`). */
export function isSupportedLanguage(code: string): boolean {
  return BY_CODE.get(code)?.supported ?? false;
}

/** All registry entries (e.g. to build the franc `only`-set or the supported-list). */
export function allLanguageEntries(): readonly LanguageEntry[] {
  return ENTRIES;
}

/** Supported languages as {code,label} for the confirm-screen selector. */
export function supportedLanguages(): Array<{ code: string; label: string }> {
  return ENTRIES.filter((e) => e.supported).map((e) => ({ code: e.code, label: e.sidecarName }));
}

/** Deduped union of every entry's non-English heading lexicon — used by the
    parser to build a language-agnostic chapter-split regex (English stays
    inline in parsers/text.ts). */
export function nonEnglishHeadingLexicon(): { keywords: string[]; numberWords: string[]; standalone: string[] } {
  const keywords = new Set<string>();
  const numberWords = new Set<string>();
  const standalone = new Set<string>();
  for (const e of ENTRIES) {
    if (!e.headingLexicon) continue;
    e.headingLexicon.keywords.forEach((k) => keywords.add(k));
    e.headingLexicon.numberWords.forEach((n) => numberWords.add(n));
    e.headingLexicon.standalone.forEach((s) => standalone.add(s));
  }
  return { keywords: [...keywords], numberWords: [...numberWords], standalone: [...standalone] };
}

/** Deduped union of every entry's non-English front-matter keywords. */
export function nonEnglishFrontMatterKeywords(): string[] {
  const out = new Set<string>();
  for (const e of ENTRIES) e.frontMatterKeywords?.forEach((w) => out.add(w));
  return [...out];
}

/** Reverse of `sidecarName` — the BCP-47 code for a sidecar/manifest language word. */
export function codeForSidecarName(word: string): string | undefined {
  return ENTRIES.find((e) => e.sidecarName === word)?.code;
}
