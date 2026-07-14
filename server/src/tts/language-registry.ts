/* language-registry — the single source of truth for per-language data
   (fs-41/fs-50). Seam 1 (foundation) holds only the fields `language.ts`
   reads today: `code`, `sidecarName`, `supported`. Later seams EXTEND
   LanguageEntry with the detection slice, text-pipeline lexicons, and
   `refText` (see the fs-41/fs-50 spec §2) and add es/fr/de entries — each
   gated `supported:false` until its validation gate passes.

   `en` and `ru` are seeded `supported:true`: ru shipped validated under
   fs-2, so it is grandfathered past the per-language gate.
   `es` flipped `supported:true` 2026-06-23 after canary validation + operator
   acceptance (fs-41/fs-50 Spanish rollout). `fr` and `de` flipped `supported:true`
   2026-06-25 after operator audio acceptance of designed FR/DE Coalfall samples
   (plan 229). zh/ja were added `supported:false` in fs-59 W2 — registered but
   not yet validated — and flipped `supported:true` in fs-59 W5 after on-box
   validation: Coqui XTTS (zh-cn/ja) and Qwen both render CJK, and CJK chapter
   splitting via the heading lexicon shipped in #1576. CJK attribution quality
   is analyzer-model-dependent — see the fs-59 regression plan for the
   recommended local Qwen analyzer model and the demotion-gate caveat on the
   general lite default. */

export interface LanguageEntry {
  /** BCP-47 primary subtag, lower-cased (e.g. 'en', 'ru', 'es'). */
  code: string;
  /** Sidecar/analyzer language word — also the confirm-selector label. */
  sidecarName: string;
  /** True only once the language has passed its validation gate. */
  supported: boolean;
  /** Detection routing: the script class + the franc ISO-639-3 code for this language. */
  detect: { script: 'latin' | 'cyrillic' | 'cjk'; iso6393: string };
  /** Non-English chapter-heading lexicon (used to build the language-agnostic
      split regex; English stays inline in parsers/text.ts). Absent on `en`. */
  headingLexicon?: { keywords: string[]; numberWords: string[]; standalone: string[] };
  /** Non-English front/back-matter title terms (used to build the language-agnostic
      FRONT_MATTER_RX; English stays inline in parsers/front-matter.ts). Absent on en. */
  frontMatterKeywords?: string[];
  /** Localized narrator display name for this language. Absent on `en`
      (call sites default to "Narrator"). */
  narratorName?: string;
  /** Language-specific few-shot examples for the analyzer roster/attribution
      prompts (fs-59 W3). Unset until a wave populates it. */
  promptExamples?: { roster: string; attribution: string };
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
    narratorName: 'Рассказчик',
  },
  // es/fr/de: canary-validated + operator-accepted (es 2026-06-23; fr/de 2026-06-25,
  // audio acceptance of designed Coalfall samples, plan 229). All three are Latin Qwen.
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
    narratorName: 'Narrador',
  },
  { code: 'fr', sidecarName: 'French',  supported: true,  detect: { script: 'latin',    iso6393: 'fra' },
    headingLexicon: {
      keywords: ['chapitre', 'partie', 'jour', 'livre', 'acte', 'scène', 'section'],
      numberWords: ['un', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
        'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'vingt', 'trente', 'quarante', 'cinquante'],
      standalone: ['prologue', 'épilogue', 'préface', 'introduction', 'interlude', 'avant-propos'],
    },
    frontMatterKeywords: ['dédicace', 'remerciements', 'table des matières', 'sommaire',
      'à propos de l\'auteur', 'préface', 'avant-propos', 'postface', 'annexe', 'glossaire', 'bibliographie',
      'note de l\'auteur', 'note du traducteur', 'colophon', 'épigraphe'],
    narratorName: 'Narrateur',
  },
  { code: 'de', sidecarName: 'German',  supported: true,  detect: { script: 'latin',    iso6393: 'deu' },
    headingLexicon: {
      keywords: ['kapitel', 'teil', 'tag', 'buch', 'akt', 'szene', 'abschnitt'],
      numberWords: ['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn',
        'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'zwanzig', 'dreißig', 'vierzig'],
      standalone: ['prolog', 'epilog', 'vorwort', 'einleitung', 'zwischenspiel', 'nachwort'],
    },
    frontMatterKeywords: ['widmung', 'urheberrecht', 'danksagung', 'inhaltsverzeichnis', 'über den autor',
      'vorwort', 'nachwort', 'anhang', 'glossar', 'bibliografie', 'register', 'anmerkungen', 'impressum',
      'epigraph'],
    narratorName: 'Erzähler',
  },
  // zh/ja: registered fs-59 W2 (supported:false), on-box validated + flipped
  // supported:true in fs-59 W5. Coqui XTTS (zh-cn/ja) and Qwen both render
  // CJK; headingLexicon.keywords feed the circumfix CJK chapter-split path
  // (parsers/text.ts CJK_HEADING_ALT, landed #1576) in addition to
  // frontMatterKeywords feeding FRONT_MATTER_RX as substrings. CJK attribution
  // quality is analyzer-model-dependent (~62% recall / 72% coverage / 100%
  // precision on a local Qwen analyzer model; weaker/unstable on the general
  // lite default) — see the fs-59 W5 regression plan for the operator
  // recommendation and the known demotion-gate interaction.
  { code: 'zh', sidecarName: 'Chinese',  supported: true,  detect: { script: 'cjk', iso6393: 'cmn' },
    headingLexicon: { keywords: ['章', '部', '巻', '節', '幕'], numberWords: [],
      standalone: ['序章', '終章', '序', '跋', 'プロローグ', 'エピローグ'] },
    frontMatterKeywords: ['目录', '版权', '致谢', '序言', '后记', '附录', '关于作者'],
    narratorName: '旁白',
    // In-language few-shot for the analyzer preamble (fs-59 W3, Task 3.3). The
    // attribution example demonstrates the interrupted-quote rule: a spoken turn
    // split by a narrator tag ("她说") — the SECOND spoken half belongs to the
    // speaker, not the narrator.
    promptExamples: {
      roster: '例如："林芳"（女主角，二十多岁，语气温柔）、"陈警官"（旁白之外的配角，说话直接）。',
      attribution: '例："“我们该走了，”她说，“天要黑了。”" — 引号内的两段话都是这个角色说的；"她说"是旁白的叙述标签，不是说话人，"天要黑了"这后半句仍然属于说话的角色，不是旁白。',
    } },
  { code: 'ja', sidecarName: 'Japanese', supported: true,  detect: { script: 'cjk', iso6393: 'jpn' },
    headingLexicon: { keywords: ['章', '部', '巻', '節', '話', '幕'], numberWords: [],
      standalone: ['序章', '終章', 'プロローグ', 'エピローグ', 'あとがき', '前書き'] },
    frontMatterKeywords: ['目次', '著作権', '献辞', '謝辞', 'まえがき', 'あとがき', '付録', '著者について'],
    narratorName: '語り手',
    // In-language few-shot (fs-59 W3, Task 3.3). The attribution example
    // demonstrates the interrupted-quote rule: a spoken turn split by a
    // narrator tag ("彼女は言った") — the SECOND spoken half belongs to the
    // speaker, not the narrator (the tag is narrator, not speaker).
    promptExamples: {
      roster: '例：「美咲」（主人公、二十代、口調は穏やか）、「田中刑事」（脇役、話し方は率直）。',
      attribution: '例：「もう行かないと」彼女は言った。「日が暮れる前に」 — 「」内の二つの発言はどちらもこの人物のセリフである。「彼女は言った」は語り手のタグであり話者ではない。後半の「日が暮れる前に」もタグの後に続く同じ話者のセリフであり、語り手のものではない。',
    } },
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

/** True when `name` is a built-in narrator default — the English "Narrator" or
    any language's localized narrator name. Distinguishes a replaceable default
    from a user rename (which must survive reparse). Case-insensitive; trims. */
export function isDefaultNarratorName(name: string | undefined | null): boolean {
  if (typeof name !== 'string') return false;
  const key = name.trim().toLowerCase();
  if (!key) return false;
  if (key === 'narrator') return true;
  return ENTRIES.some((e) => e.narratorName?.toLowerCase() === key);
}
