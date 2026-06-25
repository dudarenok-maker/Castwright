import type { LangNormalizer, CurrencyUnit } from '../types.js';

// 0–12 are irregular single words; 13–19 ride on the unit + 'zehn' (with sech-/
// sieb- contractions). All of German below a million is ONE concatenated word.
const ONES = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun',
  'zehn', 'elf', 'zwölf'];
// 13–19 stems: note sechzehn (drops the 's') and siebzehn (drops the 'en').
const TEENS = ['dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
// 10,20,…,90 (index = tens digit). dreißig uses ß; sechzig/siebzig contract.
const TENS = ['', 'zehn', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

// A unit digit as it appears INSIDE a compound: bare 1 is 'eins', but a 1 that
// precedes a scale word ('hundert'/'tausend') or rides in a 'und' compound is
// 'ein' (einundzwanzig, einhundert) — never 'einsundzwanzig'.
function unitInCompound(u: number): string {
  return u === 1 ? 'ein' : ONES[u];
}

function under100(n: number): string {
  if (n < 13) return ONES[n];
  if (n < 20) return TEENS[n - 13];
  const t = Math.floor(n / 10), u = n % 10;
  if (u === 0) return TENS[t];
  // unit-BEFORE-ten, joined by 'und', all one word: einundzwanzig, vierunddreißig.
  return unitInCompound(u) + 'und' + TENS[t];
}

function under1000(n: number): string {
  if (n < 100) return under100(n);
  const h = Math.floor(n / 100), r = n % 100;
  // 'einhundert' (not 'einshundert'), 'zweihundert'. Everything concatenates.
  return unitInCompound(h) + 'hundert' + (r ? under100(r) : '');
}

// Below a million is one concatenated word; a million and up are separate words
// (and pluralise: 'eine Million', 'zwei Millionen'). 'tausend' takes the bare
// 'ein' prefix (eintausend), like 'hundert'.
function underMillion(n: number): string {
  if (n < 1000) return under1000(n);
  const th = Math.floor(n / 1000), r = n % 1000;
  return unitInCompound(th) + 'tausend' + (r ? under1000(r) : '');
}

export function cardinal(n: number): string {
  if (n === 0) return 'null';
  let out = '', rest = n;
  if (rest >= 1_000_000) {
    const millions = Math.floor(rest / 1_000_000);
    // Million is a feminine noun → 'eine Million', 'zwei Millionen' (capital M,
    // separate word). The count below a million is still one concatenated word.
    out += millions === 1 ? 'eine Million' : underMillion(millions) + ' Millionen';
    rest %= 1_000_000;
  }
  if (rest) out += (out ? ' ' : '') + underMillion(rest);
  return out;
}

// German ordinals: 1–19 add '-te', 20+ add '-ste', on the cardinal stem.
// Irregular stems: erste(1), dritte(3), siebte(7 — drops 'en'), achte(8 — single t).
// Only the date/ordinal path needs these; nominative form is fine (documented
// simplification — German declines ordinals by case/gender, we don't).
const ORD_IRREGULAR: Record<number, string> = {
  1: 'erste', 3: 'dritte', 7: 'siebte', 8: 'achte',
};
export function ordinal(n: number): string {
  if (ORD_IRREGULAR[n]) return ORD_IRREGULAR[n];
  const suffix = n < 20 ? 'te' : 'ste';
  return cardinal(n) + suffix;
}

export function year(n: number): string {
  // German reads years as plain cardinals (eintausendneunhundertneunundneunzig).
  return cardinal(n);
}

export function decade(start: number): string {
  // Century dropped: 1990 → 'die Neunzigerjahre' (tens-stem + 'erjahre',
  // capitalised). 1920 → 'die Zwanzigerjahre'.
  const lo = start % 100;
  const t = Math.floor(lo / 10);
  const stem = TENS[t]; // 'neunzig'
  return 'die ' + stem.charAt(0).toUpperCase() + stem.slice(1) + 'erjahre';
}

// German Euro is invariant in the plural ('ein Euro', 'zwei Euro'); Cent likewise.
const eur: CurrencyUnit = {
  major: () => 'Euro',
  minor: () => 'Cent',
  connector: 'und',
};
const usd: CurrencyUnit = {
  major: () => 'Dollar',
  minor: () => 'Cent',
  connector: 'und',
};

const MONTHS_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export function date(day: number, monthIndex: number, yr: number): string {
  const dm = `${ordinal(day)} ${MONTHS_DE[monthIndex]}`;
  return yr ? `${dm} ${cardinal(yr)}` : dm;
}

export const de: LangNormalizer = {
  cardinal, ordinal, year, decade, date,
  separators: { decimal: ',', thousands: '.' },
  decimalWord: 'Komma',
  currency: { '€': eur, '$': usd },
  months: { nominative: MONTHS_DE },
  // Conservative: a number-period only before a capitalised word (German bare
  // "3." collides with the sentence period). Standalone ordinals mostly go
  // through date(); this catches "3. Januar"-style detached ordinals.
  ordinalPattern: /\b(\d+)\.(?=\s+[A-ZÄÖÜ])/g,
  symbols: { '%': 'Prozent', '&': 'und', '°': 'Grad', '×': 'mal' },
  abbreviations: [
    [/\bHr\./g, 'Herr'],
    [/\bFr\./g, 'Frau'],
    [/\bDr\./g, 'Doktor'],
    [/\busw\./g, 'und so weiter'],
  ],
};
