import type { LangNormalizer, CurrencyUnit, YearCase } from '../types.js';

/* Russian number engine (the raised floor — see plan Task 5).

   Scope is the floor needed for years/dates/currency in book prose, NOT a full
   Russian declension engine. Documented simplifications:
   - Cardinals are NOMINATIVE, masculine/neuter default. "один/два" gender is
     inferred from the FOLLOWING bare noun's ending (heuristic; mis-genders
     soft-sign nouns like "тень" and irregulars like "папа" — pinned as a
     known-failure fixture).
   - Plain ordinals via ordinalPattern render NOMINATIVE MASCULINE only.
   - "тысяча/миллион" scale words are emitted in their dictionary (singular
     nominative) form; the engine does not decline them by count (e.g. it emits
     "тысяча девятьсот" for 1900, which is the correct read for years and the
     tested values). */

// 0–19.
const ONES = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
  'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
// 20,30,…,90 (index 2..9; 0/1 unused).
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят',
  'восемьдесят', 'девяносто'];
// 100,200,…,900 (index 1..9).
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот',
  'восемьсот', 'девятьсот'];

function under1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (r < 20) {
    if (r) parts.push(ONES[r]);
  } else {
    const t = Math.floor(r / 10);
    const u = r % 10;
    parts.push(TENS[t]);
    if (u) parts.push(ONES[u]);
  }
  return parts.join(' ');
}

export function cardinal(n: number): string {
  if (n === 0) return 'ноль';
  const parts: string[] = [];
  let rest = n;
  if (rest >= 1_000_000) {
    const millions = Math.floor(rest / 1_000_000);
    // Dictionary form for the floor: "миллион" for 1, plain count + "миллион"
    // otherwise (no плюрализация — out of the tested floor).
    parts.push(millions === 1 ? 'миллион' : under1000(millions) + ' миллион');
    rest %= 1_000_000;
  }
  if (rest >= 1000) {
    const thousands = Math.floor(rest / 1000);
    // "тысяча" alone for 1000; otherwise count + "тысяча" (dictionary form;
    // годы like 1900→"тысяча девятьсот" are the canonical read).
    parts.push(thousands === 1 ? 'тысяча' : under1000(thousands) + ' тысяча');
    rest %= 1000;
  }
  if (rest) parts.push(under1000(rest));
  return parts.join(' ');
}

/* Ordinal stems keyed by the cardinal WORD of the final year/decade component.
   Endings are appended per case (nominative masc -ый/-ой, prep -ом, gen -ого,
   dat -ому). Stems intentionally exclude the final vowel so we can append the
   case ending. Where the nominative masculine takes -ой (second, sixth, seventh,
   eighth, fortieth), the stress shifts but the stem is the same for prep/gen/dat
   (-ом/-ого/-ому), so a single stem table works. */
const ORD_STEM: Record<string, string> = {
  // units
  один: 'перв', два: 'втор', три: 'трет', четыре: 'четвёрт', пять: 'пят',
  шесть: 'шест', семь: 'седьм', восемь: 'восьм', девять: 'девят', десять: 'десят',
  одиннадцать: 'одиннадцат', двенадцать: 'двенадцат', тринадцать: 'тринадцат',
  четырнадцать: 'четырнадцат', пятнадцать: 'пятнадцат', шестнадцать: 'шестнадцат',
  семнадцать: 'семнадцат', восемнадцать: 'восемнадцат', девятнадцать: 'девятнадцат',
  // tens
  двадцать: 'двадцат', тридцать: 'тридцат', сорок: 'сороков', пятьдесят: 'пятидесят',
  шестьдесят: 'шестидесят', семьдесят: 'семидесят', восемьдесят: 'восьмидесят',
  девяносто: 'девяност',
  // hundreds (final component of a round-hundred year)
  сто: 'сот', двести: 'двухсот', триста: 'трёхсот', четыреста: 'четырёхсот',
  пятьсот: 'пятисот', шестьсот: 'шестисот', семьсот: 'семисот', восемьсот: 'восьмисот',
  девятьсот: 'девятисот',
};

// Nominative masculine ending: -ой for the stressed-ending ordinals, else -ый.
// Only the units второй/шестой/седьмой/восьмой and сороковой take stressed -ой.
// Hundreds ordinals are -ый (двухсо́тый … девятисо́тый — stress on the -со- syllable,
// ending unstressed), so they are NOT in this set.
const ORD_NOM_OY = new Set([
  'втор', 'шест', 'седьм', 'восьм', 'сороков',
]);

function ordinalEnding(stem: string, c: YearCase): string {
  // "третий" is soft-stem and irregular: третий / третьем / третьего / третьему.
  if (stem === 'трет') {
    return { nominative: 'третий', prepositional: 'третьем', genitive: 'третьего', dative: 'третьему' }[c];
  }
  switch (c) {
    case 'prepositional':
      return stem + 'ом';
    case 'genitive':
      return stem + 'ого';
    case 'dative':
      return stem + 'ому';
    case 'nominative':
    default:
      return stem + (ORD_NOM_OY.has(stem) ? 'ой' : 'ый');
  }
}

export function ordinal(n: number): string {
  // Plain-ordinal pass: nominative masculine only (documented simplification).
  // Spell as a cardinal, then ordinalise the final word.
  const words = cardinal(n).split(' ');
  const last = words[words.length - 1];
  const stem = ORD_STEM[last];
  if (stem) words[words.length - 1] = ordinalEnding(stem, 'nominative');
  return words.join(' ');
}

export function year(n: number, c: YearCase = 'nominative'): string {
  // Spell as a cardinal, then the FINAL component becomes an ordinal in `c`.
  const words = cardinal(n).split(' ');
  const last = words[words.length - 1];
  const stem = ORD_STEM[last];
  if (stem) words[words.length - 1] = ordinalEnding(stem, c);
  return words.join(' ');
}

export function decade(start: number): string {
  // Substantivised plural ordinal of the tens word, century dropped:
  // 1990 → "девяностые" (девяност + plural -ые).
  const lo = start % 100;
  const t = Math.floor(lo / 10);
  const tensWord = TENS[t];
  const stem = ORD_STEM[tensWord];
  // Plural substantivised ending: -ые (and the stressed-ending tens take -ые too;
  // сороков- → сороковые). No -ие soft variant among the tens.
  return (stem ?? tensWord) + 'ые';
}

/* Russian count-agreement: 1, 21, 31… → singular nominative; 2–4, 22–24…
   (paucal) → genitive singular; everything else (0, 5–20, 11–14, …) → genitive
   plural. The 11–14 teens override the last-digit rule. */
function agree(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

const rub: CurrencyUnit = {
  major: (n) => agree(n, 'рубль', 'рубля', 'рублей'),
  minor: (n) => agree(n, 'копейка', 'копейки', 'копеек'),
  connector: '',
};
const usd: CurrencyUnit = {
  major: (n) => agree(n, 'доллар', 'доллара', 'долларов'),
  minor: (n) => agree(n, 'цент', 'цента', 'центов'),
  connector: '',
};

const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// Neuter ordinals 1–31 for the day-of-month (число is neuter → -ое/-ье).
const DAY_ORD = ['', 'первое', 'второе', 'третье', 'четвёртое', 'пятое', 'шестое', 'седьмое',
  'восьмое', 'девятое', 'десятое', 'одиннадцатое', 'двенадцатое', 'тринадцатое', 'четырнадцатое',
  'пятнадцатое', 'шестнадцатое', 'семнадцатое', 'восемнадцатое', 'девятнадцатое', 'двадцатое',
  'двадцать первое', 'двадцать второе', 'двадцать третье', 'двадцать четвёртое', 'двадцать пятое',
  'двадцать шестое', 'двадцать седьмое', 'двадцать восьмое', 'двадцать девятое', 'тридцатое',
  'тридцать первое'];

export function date(day: number, monthIndex: number, yr: number): string {
  const dm = `${DAY_ORD[day]} ${MONTHS_GEN[monthIndex]}`;
  // Years in dates are genitive + "года": "третье января тысяча … девятого года".
  return yr ? `${dm} ${year(yr, 'genitive')} года` : dm;
}

/* 1/2 gender heuristic — infer the FOLLOWING bare noun's gender from its ending
   to pick один/одна/одно and два/две. Clear -а/-я → feminine; -о/-е → neuter;
   else masculine. This is a heuristic floor: it WILL mis-gender soft-sign nouns
   (тень is feminine but ends in -ь → read masculine) and irregulars like папа
   (masculine but ends in -а → read feminine). Documented + pinned as a
   known-failure fixture. Only standalone "1"/"2" tokens are touched; numbers
   inside larger tokens (years, grouped numbers) are left to the generic pass. */
function genderOf(noun: string): 'm' | 'f' | 'n' {
  const last = noun.slice(-1).toLowerCase();
  if (last === 'а' || last === 'я') return 'f';
  if (last === 'о' || last === 'е') return 'n';
  return 'm';
}

export function preNumberPass(text: string): string {
  return text.replace(/\b([12])\s+(\p{L}+)/gu, (_m, digit: string, noun: string) => {
    const g = genderOf(noun);
    let word: string;
    if (digit === '1') word = g === 'f' ? 'одна' : g === 'n' ? 'одно' : 'один';
    else word = g === 'f' ? 'две' : 'два'; // neuter & masculine share "два"
    return `${word} ${noun}`;
  });
}

export const ru: LangNormalizer = {
  cardinal,
  ordinal,
  year,
  decade,
  date,
  preNumberPass,
  separators: { decimal: ',', thousands: 'space' },
  // Digit-by-digit read with "запятая" between integer and fraction (e.g.
  // 3,14 → "три запятая один четыре"). Avoids the целых/десятых declension morass.
  decimalWord: 'запятая',
  currency: { '₽': rub, '$': usd },
  months: { nominative: MONTHS_NOM, genitiveDates: MONTHS_GEN },
  ordinalPattern: /\b(\d+)-(?:й|я|е|го|му|м|х)\b/g,
  symbols: { '%': 'процентов', '&': 'и', '°': 'градусов', '×': 'на' },
  abbreviations: [
    // Only unambiguous expansions. "г." is ambiguous (год / город / господин) → SKIPPED.
    [/\bи т\.\s?д\./g, 'и так далее'],
    [/\bт\.е\./g, 'то есть'],
  ],
  yearCaseFor(precedingWord: string | undefined): YearCase {
    const w = precedingWord?.toLowerCase();
    if (w === 'в' || w === 'во') return 'prepositional';
    if (w === 'с' || w === 'до' || w === 'от' || w === 'после') return 'genitive';
    if (w === 'к') return 'dative';
    return 'nominative';
  },
};
