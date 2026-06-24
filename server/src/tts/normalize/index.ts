import { isSupportedLanguage } from '../language-registry.js';
import { getNormalizer } from './number-to-words.js';
import { parseLocaleNumber, speakNumber, SPACE_CLASS } from './classifiers.js';
import type { LangNormalizer } from './types.js';

/** Language-aware expansion of numbers/dates/currency/symbols/abbreviations.
    No-op unless the language is supported AND has a registered engine. Applied
    exactly once at the TTS boundary, AFTER the language-neutral transforms. */
export function expandForSpeech(text: string, langCode: string): string {
  if (!isSupportedLanguage(langCode)) return text;
  const norm = getNormalizer(langCode);
  if (!norm) return text;
  return applyPasses(text, norm);
}

/** The ordered passes WITHOUT the support/registry gate. Exported so dormant
    engines (fr/de, supported:false) are still fixture-tested directly. */
export function applyPasses(text: string, norm: LangNormalizer): string {
  let s = text;
  s = expandCurrency(s, norm);
  s = expandDates(s, norm);
  s = expandPercentAndSymbols(s, norm);
  // Abbreviations run BEFORE the digit-consuming passes: the "No." guard
  // (\bNo\.\s+(?=\d)) needs the trailing digit still present, which the plain-
  // number pass would otherwise have already spelled out.
  s = expandAbbreviations(s, norm);
  s = expandOrdinals(s, norm);
  s = expandDecades(s, norm);
  s = expandYears(s, norm);
  // Engine-owned pre-pass (Russian 1/2 gender heuristic): consume "1 книга" /
  // "2 двери" before the generic number pass spells them masculine. No-op for
  // engines that don't implement it.
  if (norm.preNumberPass) s = norm.preNumberPass(s);
  s = expandNumbers(s, norm);
  return s;
}

// SPACE_CLASS imported from classifiers.js (single definition).
function numberToken(norm: LangNormalizer): string {
  // A locale number: digits with optional grouping + optional decimal. The
  // grouped alternative carries its OWN optional decimal tail so "$1,200.50"
  // captures the whole "1,200.50" (without it, the alternation would stop at
  // "1,200" and leak ".50" into the plain-number pass).
  const thou = norm.separators.thousands === 'space' ? SPACE_CLASS : '\\' + norm.separators.thousands;
  const dec = '\\' + norm.separators.decimal;
  // A lone, non-grouping punctuation thousands char (es/de "1.5") is a decimal,
  // not a 1500 grouping (parseLocaleNumber already reads it that way). Capture
  // it so the plain-number pass sees one token instead of splitting "1"·"."·"5".
  // It MUST precede the bare `\d+` alternative — otherwise the engine matches
  // just "1" and leaves ".5" behind.
  const loneThou =
    norm.separators.thousands !== 'space'
      ? `\\d+${thou}\\d{1,2}(?!\\d)|`
      : '';
  return `\\d{1,3}(?:${thou}\\d{3})+(?:${dec}\\d+)?|${loneThou}\\d+(?:${dec}\\d+)?`;
}

function expandCurrency(s: string, norm: LangNormalizer): string {
  const num = numberToken(norm);
  for (const [sym, unit] of Object.entries(norm.currency)) {
    const esym = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // symbol-before: $1,200.50   and number-after: 5 €
    const before = new RegExp(`${esym}\\s?(${num})`, 'g');
    const after = new RegExp(`(${num})\\s?${esym}`, 'g');
    const render = (raw: string) => {
      const v = parseLocaleNumber(raw, norm.separators);
      const major = Math.trunc(v);
      const minor = Math.round((v - major) * 100);
      let out = `${norm.cardinal(major)} ${unit.major(major)}`;
      if (minor) out += ` ${unit.connector ? unit.connector + ' ' : ''}${norm.cardinal(minor)} ${unit.minor(minor)}`;
      return out;
    };
    s = s.replace(before, (_m, raw) => render(raw)).replace(after, (_m, raw) => render(raw));
  }
  return s;
}

function expandPercentAndSymbols(s: string, norm: LangNormalizer): string {
  const num = numberToken(norm);
  if (norm.symbols['%']) s = s.replace(new RegExp(`(${num})\\s?%`, 'g'), (_m, raw) =>
    `${speakNumber(raw, norm)} ${norm.symbols['%']}`);
  // Degrees only directly after a number ("20°"); '&' only as a standalone token
  // (surrounded by spaces) so "AT&T"/"R&D" are left intact. '#'/'@' are NOT
  // blanket-replaced (would eat "C#", "user@host") — out of the v1 closed set.
  if (norm.symbols['°']) s = s.replace(new RegExp(`(${num})\\s?°`, 'g'), (_m, raw) =>
    `${speakNumber(raw, norm)} ${norm.symbols['°']}`);
  if (norm.symbols['&']) s = s.replace(/ & /g, ` ${norm.symbols['&']} `);
  if (norm.symbols['×']) s = s.replace(/\s?×\s?/g, ` ${norm.symbols['×']} `);
  return s.replace(/\s{2,}/g, ' ').trim();
}

function expandDecades(s: string, norm: LangNormalizer): string {
  return s.replace(/\b(\d{3}0)['’]?s\b/g, (_m, y) => norm.decade(Number(y)));
}

function expandYears(s: string, norm: LangNormalizer): string {
  return s.replace(/\b(\d{4})\b/g, (m, y, offset: number, full: string) => {
    const n = Number(y);
    if (n < 1100 || n > 2099) return m;
    // The preceding WORD's letters only (ignore "(", quotes, etc.) so the RU
    // preposition is still recognised in `(в 1999`.
    const prev = full.slice(0, offset).match(/(\p{L}+)\s*$/u)?.[1];
    const c = norm.yearCaseFor?.(prev);
    return norm.year(n, c);
  });
}

function expandOrdinals(s: string, norm: LangNormalizer): string {
  return s.replace(norm.ordinalPattern, (_m, n) => norm.ordinal(Number(n)));
}

function expandNumbers(s: string, norm: LangNormalizer): string {
  return s.replace(new RegExp(numberToken(norm), 'g'), (raw) => speakNumber(raw, norm));
}

function expandAbbreviations(s: string, norm: LangNormalizer): string {
  for (const [re, repl] of norm.abbreviations) s = s.replace(re, repl);
  return s;
}

function expandDates(s: string, norm: LangNormalizer): string {
  // Build a month-name -> 0-based-index map across BOTH the nominative and the
  // (optional) genitive table, so a date written in either form is detected.
  // Rendering is delegated to norm.date() which owns the idiomatic form +
  // day-ordinal gender. Longest names first so "March" can't shadow nothing.
  const idx = new Map<string, number>();
  norm.months.nominative.forEach((m, i) => idx.set(m, i));
  norm.months.genitiveDates?.forEach((m, i) => idx.set(m, i));
  const names = [...idx.keys()].sort((a, b) => b.length - a.length).join('|');
  // "January 3, 2026" / "January 3rd 2026"
  const md = new RegExp(`\\b(${names})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'g');
  s = s.replace(md, (_m, mon, day, yr) => norm.date(Number(day), idx.get(mon)!, Number(yr)));
  // "3 January 2026" / "3 января 2026"
  const dm = new RegExp(`\\b(\\d{1,2})\\s+(${names})\\s+(\\d{4})\\b`, 'g');
  s = s.replace(dm, (_m, day, mon, yr) => norm.date(Number(day), idx.get(mon)!, Number(yr)));
  // "3 января" (no year — common in Russian). Gated on genitiveDates so this
  // fires ONLY for languages with a genitive month table (Russian), whose forms
  // (января…) are unambiguous. Skipped for en/es/fr/de to avoid mis-firing on
  // month-words ("5 May", "3 March"). year 0 sentinel => norm.date renders
  // day+month only.
  if (norm.months.genitiveDates) {
    // Trailing boundary is a Unicode-aware negative lookahead, NOT `\b`: JS `\b`
    // uses [A-Za-z0-9_], so it never fires at a Cyrillic-letter→space boundary
    // ("января " would not match `\b`). `(?![\p{L}\d])` + the `u` flag closes the
    // name on any non-letter/non-digit (space, punctuation, end of string).
    const dmNoYear = new RegExp(`\\b(\\d{1,2})\\s+(${names})(?![\\p{L}\\d])`, 'gu');
    s = s.replace(dmNoYear, (_m, day, mon) => norm.date(Number(day), idx.get(mon)!, 0));
  }
  return s;
}
