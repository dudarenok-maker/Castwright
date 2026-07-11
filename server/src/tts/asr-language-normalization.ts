/* Per-language ASR word-error-rate normalization data (#1084). Declarative
   data only — frozen arrays built once at module load, never per-call
   closures — so this stays a plain lookup from segment-asr-qa.ts's
   perspective. Deliberately NOT part of language-registry.ts's LanguageEntry:
   that interface holds heading/front-matter parsing data with unrelated
   consumers; ASR-QA is its own concern with its own consumer
   (segment-asr-qa.ts), so it gets its own module. See the design spec
   (docs/superpowers/specs/2026-07-10-srv-asr-qa-non-english-normalization-design.md)
   for the full per-language composition-rule rationale.

   WER_INTEGERS[lang][n] = the token array for integer n (0..99). Numbers
   >= 100 aren't covered here — normalizeForWer in segment-asr-qa.ts leaves
   the digit as-is for those, mirroring English's spellInteger, which also
   declines 3+ digit numbers. */

type IntegerTable = ReadonlyArray<readonly string[]>;

const ES_ONES = [
  'cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete',
  'dieciocho', 'diecinueve',
];
const ES_TWENTIES = [
  'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco',
  'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve',
];
const ES_DECADES: Record<number, string> = {
  3: 'treinta', 4: 'cuarenta', 5: 'cincuenta', 6: 'sesenta',
  7: 'setenta', 8: 'ochenta', 9: 'noventa',
};

/** Spanish is regular past 29 (unlike French): every decade 30-90 composes
    as [decade, 'y', ones]. Only 0-29 need literal/fused enumeration. */
function buildSpanish(): IntegerTable {
  const out: string[][] = [];
  for (let n = 0; n < 20; n += 1) out.push([ES_ONES[n]]);
  for (let n = 20; n < 30; n += 1) out.push([ES_TWENTIES[n - 20]]);
  for (let decade = 3; decade <= 9; decade += 1) {
    out.push([ES_DECADES[decade]]);
    for (let ones = 1; ones <= 9; ones += 1) out.push([ES_DECADES[decade], 'y', ES_ONES[ones]]);
  }
  return out;
}

const FR_ONES = [
  'zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
  'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
];
/** FR_TEEN_WORDS[i] = the word for (10+i), i in 0..9 — used standalone (17-19)
    and as the second half of the 70s/90s base-20 compounds (e.g. 72 =
    "soixante" + FR_TEEN_WORDS[2] = "douze"). */
const FR_TEEN_WORDS = [
  'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
  'dix-sept', 'dix-huit', 'dix-neuf',
];
const FR_REGULAR_DECADES: Record<number, string> = {
  2: 'vingt', 3: 'trente', 4: 'quarante', 5: 'cinquante', 6: 'soixante',
};

/** Tokens for the teen word (10+i), i in 0..9. dix..seize are one token;
    dix-sept/huit/neuf split on their hyphen into two. */
function teenTokens(i: number): string[] {
  if (i <= 6) return [FR_TEEN_WORDS[i]];
  const [a, b] = FR_TEEN_WORDS[i].split('-');
  return [a, b];
}

/** French: regular decade+ones (with et/no-et) through 69, then base-20
    counting for 70-99 (soixante+teen for 70s, quatre-vingt+ones/teen for
    80s/90s) — enumerated per the composition rules in the design spec, not
    derived by one generic formula, since this range is genuinely irregular. */
function buildFrench(): IntegerTable {
  const out: string[][] = [];
  for (let n = 0; n <= 16; n += 1) out.push([FR_ONES[n]]);
  for (let n = 17; n <= 19; n += 1) out.push(teenTokens(n - 10));
  for (let d = 2; d <= 6; d += 1) {
    const decade = FR_REGULAR_DECADES[d];
    out.push([decade]);
    out.push([decade, 'et', 'un']);
    for (let ones = 2; ones <= 9; ones += 1) out.push([decade, FR_ONES[ones]]);
  }
  out.push(['soixante', 'dix']); // 70
  out.push(['soixante', 'et', 'onze']); // 71 — irregular: keeps "et"
  for (let i = 2; i <= 9; i += 1) out.push(['soixante', ...teenTokens(i)]); // 72-79
  out.push(['quatre', 'vingts']); // 80 — plural -s, bare decade only
  for (let ones = 1; ones <= 9; ones += 1) out.push(['quatre', 'vingt', FR_ONES[ones]]); // 81-89, no et
  out.push(['quatre', 'vingt', 'dix']); // 90
  out.push(['quatre', 'vingt', 'onze']); // 91 — no et
  for (let i = 2; i <= 9; i += 1) out.push(['quatre', 'vingt', ...teenTokens(i)]); // 92-99
  return out;
}

const DE_ONES = [
  'null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun',
  'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn',
  'achtzehn', 'neunzehn',
];
const DE_DECADES: Record<number, string> = {
  2: 'zwanzig', 3: 'dreißig', 4: 'vierzig', 5: 'fünfzig',
  6: 'sechzig', 7: 'siebzig', 8: 'achtzig', 9: 'neunzig',
};
/** The composing form of 1-9 — 'eins' drops its final 's' to 'ein' when
    fused into a compound ('einundzwanzig'); 2-9 are unchanged. Index 0 unused. */
const DE_COMPOSING_ONES = ['', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'];

/** German: 0-19 literal (with the sechzehn/siebzehn root truncation), then
    21-99 fuse into ONE token, reversed order, joined by "und". */
function buildGerman(): IntegerTable {
  const out: string[][] = [];
  for (let n = 0; n <= 19; n += 1) out.push([DE_ONES[n]]);
  for (let d = 2; d <= 9; d += 1) {
    out.push([DE_DECADES[d]]);
    for (let ones = 1; ones <= 9; ones += 1) {
      out.push([`${DE_COMPOSING_ONES[ones]}und${DE_DECADES[d]}`]);
    }
  }
  return out;
}

const RU_ONES = [
  'ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
  'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
];
const RU_DECADES: Record<number, string> = {
  2: 'двадцать', 3: 'тридцать', 4: 'сорок', 5: 'пятьдесят',
  6: 'шестьдесят', 7: 'семьдесят', 8: 'восемьдесят', 9: 'девяносто',
};

/** Russian: decade + ones as two separate tokens, no conjunction —
    the simplest of the four languages' composition shapes. */
function buildRussian(): IntegerTable {
  const out: string[][] = [];
  for (let n = 0; n <= 19; n += 1) out.push([RU_ONES[n]]);
  for (let d = 2; d <= 9; d += 1) {
    out.push([RU_DECADES[d]]);
    for (let ones = 1; ones <= 9; ones += 1) out.push([RU_DECADES[d], RU_ONES[ones]]);
  }
  return out;
}

export const WER_INTEGERS: Readonly<Record<string, IntegerTable>> = Object.freeze({
  es: Object.freeze(buildSpanish()),
  fr: Object.freeze(buildFrench()),
  de: Object.freeze(buildGerman()),
  ru: Object.freeze(buildRussian()),
});

export const WER_CONTRACTIONS: Readonly<Record<string, Record<string, string>>> = Object.freeze({
  de: Object.freeze({
    im: 'in dem', zum: 'zu dem', beim: 'bei dem', am: 'an dem',
    ins: 'in das', ans: 'an das', vom: 'von dem',
  }),
});
