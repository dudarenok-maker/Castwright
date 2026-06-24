import type { LangNormalizer, CurrencyUnit } from '../types.js';

// 0–16 are irregular single words; 17–19 are dix-sept/dix-huit/dix-neuf.
const ONES = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf',
  'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
// 20,30,…,60 (indices 2..6; 70/80/90 are built on soixante/quatre-vingt below).
const TENS = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

// 0–99. The 70/80/90 ranges have no native tens word: 70–79 ride on soixante
// (soixante-dix … soixante-dix-neuf), 80–99 ride on quatre-vingt
// (quatre-vingts, quatre-vingt-un … quatre-vingt-dix-neuf). `et` joins ONLY the
// unit "un"/"onze" in 21/31/41/51/61/71 — never in 81/91 (hyphen only).
function under100(n: number): string {
  if (n < 17) return ONES[n];
  if (n < 20) return 'dix-' + ONES[n - 10]; // dix-sept, dix-huit, dix-neuf
  if (n < 70) {
    const t = Math.floor(n / 10), u = n % 10;
    if (u === 0) return TENS[t];
    if (u === 1) return TENS[t] + ' et un'; // vingt et un, …, soixante et un
    return TENS[t] + '-' + ONES[u];
  }
  if (n < 80) {
    // 70–79 = soixante + (10..19). 71 = soixante et onze (the only `et` here).
    const r = n - 60; // 10..19
    if (r === 11) return 'soixante et onze';
    return 'soixante-' + under100(r);
  }
  // 80–99 = quatre-vingt(s) + (0..19). 80 bare → plural "quatre-vingts";
  // any 81–99 → singular "quatre-vingt-…" (no `et`, no trailing s).
  const r = n - 80; // 0..19
  if (r === 0) return 'quatre-vingts';
  return 'quatre-vingt-' + under100(r);
}

function under1000(n: number): string {
  if (n < 100) return under100(n);
  const h = Math.floor(n / 100), r = n % 100;
  // 100/200/… : "cent" with no leading "un" (cent, not un cent). "cent"
  // pluralises to "cents" ONLY when it's a bare multiple (>1 hundred) AND nothing
  // follows it: deux cents, but deux cent un (no s before a trailing number).
  const head = h === 1 ? 'cent' : ONES[h] + ' cent' + (r === 0 ? 's' : '');
  return r ? head + ' ' + under100(r) : head;
}

export function cardinal(n: number): string {
  if (n === 0) return 'zéro';
  let out = '', rest = n;
  if (rest >= 1_000_000) {
    const millions = Math.floor(rest / 1_000_000);
    // "un million", "deux millions" (million IS a noun, pluralises).
    out += (millions === 1 ? 'un million' : under1000(millions) + ' millions');
    rest %= 1_000_000;
  }
  if (rest >= 1000) {
    const thousands = Math.floor(rest / 1000);
    // "mille" is invariant and drops a leading "un": mille, deux mille.
    out += (out ? ' ' : '') + (thousands === 1 ? 'mille' : under1000(thousands) + ' mille');
    rest %= 1000;
  }
  if (rest) out += (out ? ' ' : '') + under1000(rest);
  return out;
}

// Ordinals are only needed for dates here; day 1 reads "premier", the rest read
// as cardinals (idiomatic spoken French: "le deux mai").
export function ordinal(n: number): string {
  if (n === 1) return 'premier';
  return cardinal(n);
}

export function year(n: number): string {
  // French reads years as plain cardinals: 1999 → "mille neuf cent quatre-vingt-dix-neuf".
  return cardinal(n);
}

export function decade(start: number): string {
  // Century is NOT dropped: 1990 → "les années quatre-vingt-dix".
  const lo = start % 100;
  return 'les années ' + under100(lo);
}

const eur: CurrencyUnit = {
  major: (n) => (n === 1 ? 'euro' : 'euros'),
  minor: (n) => (n === 1 ? 'centime' : 'centimes'),
  connector: 'et',
};
const usd: CurrencyUnit = {
  major: (n) => (n === 1 ? 'dollar' : 'dollars'),
  minor: (n) => (n === 1 ? 'centime' : 'centimes'),
  connector: 'et',
};

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function date(day: number, monthIndex: number, yr: number): string {
  // Day 1 is "premier"; other days read as cardinals ("le 2 mai" → "deux mai").
  const dayWord = day === 1 ? 'premier' : cardinal(day);
  const dm = `${dayWord} ${MONTHS_FR[monthIndex]}`;
  return yr ? `${dm} ${cardinal(yr)}` : dm;
}

export const fr: LangNormalizer = {
  cardinal, ordinal, year, decade, date,
  separators: { decimal: ',', thousands: 'space' },
  decimalWord: 'virgule',
  currency: { '€': eur, '$': usd },
  months: { nominative: MONTHS_FR },
  ordinalPattern: /\b(\d+)(?:er|ère|e|ème)\b/g,
  symbols: { '%': 'pour cent', '&': 'et', '°': 'degrés', '×': 'fois' },
  abbreviations: [
    [/\bM\./g, 'Monsieur'],
    [/\bMme\b\.?/g, 'Madame'],
    [/\bDr\b\.?/g, 'Docteur'],
    [/\betc\./g, 'et cetera'],
  ],
};
