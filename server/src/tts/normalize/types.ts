/* The contract every per-language engine implements. The shared classifier
   layer (classifiers.ts) detects spans language-agnostically and dispatches
   rendering here. Fields a language doesn't need (e.g. yearCaseFor for non-RU)
   are optional. */
export type YearCase = 'nominative' | 'prepositional' | 'genitive' | 'dative';

/** Major/minor currency unit words, agreeing with the amount (Russian needs the
    count for рубль/рубля/рублей; others ignore n). */
export interface CurrencyUnit {
  major(n: number): string;
  minor(n: number): string;
  /** Word joining major+minor units. '' for Russian (juxtaposition). */
  connector: string;
}

export interface LangNormalizer {
  cardinal(n: number): string;
  ordinal(n: number): string;
  /** Spoken year; `c` selects the inflection (Russian); others ignore it. */
  year(n: number, c?: YearCase): string;
  /** `start` is the decade's first year (1990 for "1990s"). */
  decade(start: number): string;
  /** Decimal char + thousands grouping kind for this locale. */
  separators: { decimal: string; thousands: 'space' | '.' | ',' };
  /** Spoken word for the decimal point: en 'point', es 'coma', fr 'virgule',
      de 'Komma', ru pinned form. */
  decimalWord: string;
  /** Keyed by symbol: '$','€','£','₽'. */
  currency: Record<string, CurrencyUnit>;
  /** 12 nominative month names (index 0 = January); genitiveDates is the
      genitive form used in dates where the language inflects (Russian). Both
      tables feed date DETECTION (a date may be written in either form). */
  months: { nominative: string[]; genitiveDates?: string[] };
  /** Render a detected date. `monthIndex` is 0-based; `year === 0` means no
      year was present → render day+month only. Each engine owns its idiomatic
      form + day-ordinal gender (en "January third, twenty twenty-six";
      ru neuter-ordinal day + genitive month). */
  date(day: number, monthIndex: number, year: number): string;
  /** Symbol → spoken word: '%','&','°','#','@','×'. */
  symbols: Record<string, string>;
  /** Ordered [pattern, replacement] abbreviation rules. */
  abbreviations: Array<[RegExp, string]>;
  /** Global regex matching a written ordinal, capture group 1 = the digits.
      en `/\b(\d+)(?:st|nd|rd|th)\b/g`; es `/\b(\d+)\.?[ºª]/g`; fr
      `/\b(\d+)(?:er|ère|e|ème)\b/g`; ru `/\b(\d+)-(?:й|я|е|го|му|м|х)\b/g`.
      de: conservative `/\b(\d+)\.(?=\s+[A-ZÄÖÜ])/g` (number-period before a
      capitalised word) — German bare "3." collides with the sentence period, so
      standalone German ordinals are mostly left to date() (documented). */
  ordinalPattern: RegExp;
  /** Russian implements (returns case from the governing preposition); others
      omit → caller defaults to 'nominative'. */
  yearCaseFor?(precedingWord: string | undefined): YearCase;
}
