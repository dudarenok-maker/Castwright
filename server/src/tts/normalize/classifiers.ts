import type { LangNormalizer } from './types.js';

type Sep = { decimal: string; thousands: 'space' | '.' | ',' };
/** One definition of the thousands-whitespace class; re-exported so index.ts
    imports it instead of duplicating. */
export const SPACE_CLASS = '[\\u0020\\u00A0\\u202F\\u2009]';

/** Parse a locale-formatted numeric string to a JS number. A thousands
    separator is only honoured when it groups exactly-3-digit runs; a lone
    separator is treated as the decimal (so de "1.5" stays 1.5, not 1500). */
export function parseLocaleNumber(raw: string, sep: Sep): number {
  const thou = sep.thousands === 'space' ? SPACE_CLASS : '\\' + sep.thousands;
  const grouped = new RegExp(`^\\d{1,3}(${thou}\\d{3})+`).test(raw);
  let s = raw;
  if (grouped) s = s.replace(new RegExp(thou, 'g'), '');
  // Only the locale decimal separator becomes '.'. A lone, non-grouping
  // thousands-char that is NOT the decimal (e.g. de "1.5") is left as-is, so
  // Number() reads it as a plain decimal point rather than being stripped to 15.
  if (sep.decimal !== '.') s = s.replace(new RegExp('\\' + sep.decimal, 'g'), '.');
  return Number(s);
}

/** Spell a RAW locale number string for speech: integer via cardinal, fraction
    read digit-by-digit. Fraction digits come from the raw string (NOT
    String(Number(...))) so float-repr artifacts can't leak in. */
export function speakNumber(raw: string, norm: LangNormalizer): string {
  const v = parseLocaleNumber(raw, norm.separators);
  if (Number.isInteger(v)) return norm.cardinal(v);
  // The fraction digits follow the separator parseLocaleNumber treated as the
  // decimal point: normally the locale decimal char, but a LONE non-grouping
  // punctuation thousands char (es/de "1.5") is also read as a decimal — split
  // on whichever actually appears so we never lose the fraction.
  const fracPart =
    raw.split(norm.separators.decimal)[1] ??
    (norm.separators.thousands !== 'space' ? raw.split(norm.separators.thousands)[1] : undefined) ??
    '';
  const digits = fracPart.split('').map((d) => norm.cardinal(Number(d))).join(' ');
  return `${norm.cardinal(Math.trunc(v))} ${norm.decimalWord} ${digits}`;
}
