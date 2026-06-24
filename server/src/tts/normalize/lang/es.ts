import type { LangNormalizer, CurrencyUnit } from '../types.js';

// 0–15 are irregular single words; 16–19 and 21–29 are one-word contractions
// (dieciséis, veintiuno) handled below.
const ONES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince'];
const TEENS = ['dieciséis', 'diecisiete', 'dieciocho', 'diecinueve'];
const TWENTIES = ['veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco',
  'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
// 30,40,…,90 (indices 3..9; 0/1/2 unused, the lower ranges are special-cased).
const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
// 100,200,…,900 (index 1..9). 100 alone is "cien"; 101+ is "ciento …".
const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos',
  'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

function tensWord(n: number): string {
  // 0–99.
  if (n < 16) return ONES[n];
  if (n < 20) return TEENS[n - 16];
  if (n < 30) return TWENTIES[n - 20];
  const t = Math.floor(n / 10), u = n % 10;
  // The `y` joins tens and units — and ONLY here (never after hundreds, never
  // inside 21–29 which are one word).
  return u ? TENS[t] + ' y ' + ONES[u] : TENS[t];
}

function under1000(n: number): string {
  if (n < 100) return tensWord(n);
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100), r = n % 100;
  // No `y` after hundreds: "ciento uno", "doscientos treinta y cuatro".
  return HUNDREDS[h] + (r ? ' ' + tensWord(r) : '');
}

export function cardinal(n: number): string {
  if (n === 0) return 'cero';
  let out = '', rest = n;
  if (rest >= 1_000_000) {
    const millions = Math.floor(rest / 1_000_000);
    out += millions === 1 ? 'un millón' : under1000(millions) + ' millones';
    rest %= 1_000_000;
  }
  if (rest >= 1000) {
    const thousands = Math.floor(rest / 1000);
    // "mil", "dos mil", "doscientos mil" — the leading "un" is dropped before mil.
    out += (out ? ' ' : '') + (thousands === 1 ? 'mil' : under1000(thousands) + ' mil');
    rest %= 1000;
  }
  if (rest) out += (out ? ' ' : '') + under1000(rest);
  return out;
}

// Ordinals are only needed for dates here; day 1 reads "primero", the rest read
// as cardinals (idiomatic spoken Spanish: "el dos de mayo").
export function ordinal(n: number): string {
  if (n === 1) return 'primero';
  return cardinal(n);
}

export function year(n: number): string {
  // Spanish reads years as plain cardinals: 1999 → "mil novecientos noventa y nueve".
  return cardinal(n);
}

export function decade(start: number): string {
  // Century dropped: 1990 → "los noventa".
  const lo = start % 100;
  const t = Math.floor(lo / 10);
  return 'los ' + TENS[t];
}

const eur: CurrencyUnit = {
  major: (n) => (n === 1 ? 'euro' : 'euros'),
  minor: (n) => (n === 1 ? 'céntimo' : 'céntimos'),
  connector: 'con',
};
const usd: CurrencyUnit = {
  major: (n) => (n === 1 ? 'dólar' : 'dólares'),
  minor: (n) => (n === 1 ? 'céntimo' : 'céntimos'),
  connector: 'con',
};

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function date(day: number, monthIndex: number, yr: number): string {
  const dayWord = day === 1 ? 'primero' : cardinal(day);
  const dm = `${dayWord} de ${MONTHS_ES[monthIndex]}`;
  return yr ? `${dm} de ${cardinal(yr)}` : dm;
}

export const es: LangNormalizer = {
  cardinal, ordinal, year, decade, date,
  separators: { decimal: ',', thousands: '.' },
  decimalWord: 'coma',
  currency: { '€': eur, '$': usd },
  months: { nominative: MONTHS_ES },
  ordinalPattern: /\b(\d+)\.?[ºª]/g,
  symbols: { '%': 'por ciento', '&': 'y', '°': 'grados', '×': 'por' },
  abbreviations: [
    [/\bSr\./g, 'Señor'], [/\bSra\./g, 'Señora'],
    [/\bDr\./g, 'Doctor'], [/\bDra\./g, 'Doctora'],
    [/\bProf\./g, 'Profesor'],
    [/\bnúm\.\s+(?=\d)/g, 'número '], // only before a digit
  ],
};
