import type { LangNormalizer, CurrencyUnit } from '../types.js';

const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine',
  'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];

function under1000(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
  const h = Math.floor(n / 100), r = n % 100;
  return ONES[h] + ' hundred' + (r ? ' ' + under1000(r) : '');
}

export function cardinal(n: number): string {
  if (n === 0) return 'zero';
  const scales: Array<[number, string]> = [[1_000_000, 'million'], [1000, 'thousand']];
  let out = '', rest = n;
  for (const [value, name] of scales) {
    if (rest >= value) {
      out += (out ? ' ' : '') + under1000(Math.floor(rest / value)) + ' ' + name;
      rest %= value;
    }
  }
  if (rest) out += (out ? ' ' : '') + under1000(rest);
  return out;
}

const ORD_IRREGULAR: Record<string, string> = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth',
  nine: 'ninth', twelve: 'twelfth',
};
function ordWord(w: string): string {
  if (ORD_IRREGULAR[w]) return ORD_IRREGULAR[w];
  if (w.endsWith('y')) return w.slice(0, -1) + 'ieth';
  return w + 'th';
}
export function ordinal(n: number): string {
  const words = cardinal(n).split(/([ -])/); // keep separators
  // Make only the final word ordinal.
  for (let i = words.length - 1; i >= 0; i--) {
    if (/\w/.test(words[i])) { words[i] = ordWord(words[i]); break; }
  }
  return words.join('');
}

export function year(n: number): string {
  if (n % 100 === 0) return n % 1000 === 0 ? cardinal(n) : under1000(n / 100) + ' hundred';
  const hi = Math.floor(n / 100), lo = n % 100;
  if (n >= 2000 && n < 2010) return cardinal(n); // "two thousand seven"
  const loStr = lo < 10 ? 'oh ' + ONES[lo] : under1000(lo);
  return under1000(hi) + ' ' + loStr;
}

export function decade(start: number): string {
  // 1990 -> "nineteen nineties". Boundary decades need care: TENS[0]/TENS[1]
  // are empty, so X00s and X10s are special-cased.
  const hi = Math.floor(start / 100), lo = start % 100;
  if (lo === 0) return start % 1000 === 0 ? cardinal(start) + 's' : under1000(hi) + ' hundreds'; // 2000s/1900s
  if (lo === 10) return under1000(hi) + ' tens'; // 1910s/2010s
  const tens = TENS[Math.floor(lo / 10)]; // "ninety"
  return under1000(hi) + ' ' + tens.slice(0, -1) + 'ies'; // ninety -> nineties
}

const usd: CurrencyUnit = { major: (n) => (n === 1 ? 'dollar' : 'dollars'), minor: (n) => (n === 1 ? 'cent' : 'cents'), connector: 'and' };
const gbp: CurrencyUnit = { major: (n) => (n === 1 ? 'pound' : 'pounds'), minor: (n) => (n === 1 ? 'penny' : 'pence'), connector: 'and' };
const eur: CurrencyUnit = { major: (n) => (n === 1 ? 'euro' : 'euros'), minor: (n) => (n === 1 ? 'cent' : 'cents'), connector: 'and' };

const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function date(day: number, monthIndex: number, yr: number): string {
  const dm = `${MONTHS_EN[monthIndex]} ${ordinal(day)}`;
  return yr ? `${dm}, ${year(yr)}` : dm; // yr === 0 => day+month only
}

export const en: LangNormalizer = {
  cardinal, ordinal, year, decade, date,
  separators: { decimal: '.', thousands: ',' },
  decimalWord: 'point',
  currency: { '$': usd, '£': gbp, '€': eur },
  months: { nominative: MONTHS_EN },
  ordinalPattern: /\b(\d+)(?:st|nd|rd|th)\b/g,
  symbols: { '%': 'percent', '&': 'and', '°': 'degrees', '×': 'times' },
  abbreviations: [
    [/\bMr\./g, 'Mister'], [/\bMrs\./g, 'Missus'], [/\bMs\./g, 'Miss'],
    [/\bDr\./g, 'Doctor'], [/\bProf\./g, 'Professor'], [/\bvs\./g, 'versus'],
    [/\betc\./g, 'etcetera'], [/\be\.g\./g, 'for example'], [/\bi\.e\./g, 'that is'],
    [/\bNo\.\s+(?=\d)/g, 'Number '], // only before a digit
    [/\bSt\.\s+(?=[A-Z])/g, 'Saint '], // only title-cased before a capital
  ],
};
