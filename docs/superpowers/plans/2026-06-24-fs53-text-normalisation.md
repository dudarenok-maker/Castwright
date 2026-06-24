# fs-53 Text Normalisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand numbers, dates, currency, symbols, and a curated abbreviation set to spoken form at the TTS boundary, language-aware for en/es/ru/fr/de, without desyncing the ASR content-QA gate.

**Architecture:** A new `server/src/tts/normalize/` module exposes `expandForSpeech(text, langCode)`, composed of a shared locale-aware classifier layer plus five per-language engines (`cardinal`/`ordinal`/`year`/`decade` + data tables). It is invoked from the existing `normaliseForTts(text, langCode?)` TTS-boundary normaliser; the synth path threads `bookLanguage` into every audio-producing call **and** the ASR-QA expected-text so the WER comparison stays aligned.

**Tech Stack:** TypeScript (Node ESM), Vitest (server, node env). No new runtime dependencies — hand-rolled regex transforms in the existing `text-normalize.ts` style.

**Spec:** `docs/superpowers/specs/2026-06-24-fs53-text-normalisation-design.md` (read it before starting — the per-language morphology rules and known-limitations are the authority).

## Global Constraints

- **No new runtime dependencies.** Hand-rolled regex/string transforms only.
- **TTS-boundary-only.** Never mutate the underlying `SentenceOutput`/`sentence.text`. All expansion happens on a copy at the synth boundary.
- **Zero regression on the no-`langCode` path.** `normaliseForTts(text)` (one arg) must remain byte-identical to today's output.
- **`expandForSpeech` self-gates.** No-op unless `isSupportedLanguage(langCode)` is true **and** a `lang/<code>.ts` engine is registered. This keeps `fr`/`de` dormant until their `supported` flag flips.
- **Non-ASCII regex/string literals as `\u` escapes where they carry combining marks or invisible chars**, and verify fixtures at byte level (Write/Edit can silently flatten curly quotes/glyphs). Cyrillic letters in plain string literals are fine; the caution is for char-classes and stress marks.
- **Apply exactly once.** `expandForSpeech` is not idempotent; never compose it twice.
- **Idempotent stress marks:** the spec uses combining acute (´) only to show stress in prose — **do not** emit stress marks in actual output. Plain Cyrillic/Latin only.
- Tests live next to the unit (`*.test.ts`). Run server tests with `cd server && npm run test`.
- Commit convention: `<type>(<scope>): <subject>` — use `feat(server): …` for these.

---

## File Structure

```
server/src/tts/normalize/
  types.ts            LangNormalizer interface + YearCase + CurrencyUnit (Task 1)
  number-to-words.ts  engine registry: getNormalizer(langCode) (Task 1, extended per language)
  lang/en.ts          English engine + data (Task 1)
  classifiers.ts      shared locale-aware passes: separator canon + currency/percent/date/ordinal/decade/year/number/symbol/abbrev (Task 2)
  index.ts            expandForSpeech(text, langCode) — gate + compose passes (Task 2)
  lang/es.ts          Spanish engine (Task 4)
  lang/ru.ts          Russian engine (Task 5)
  lang/fr.ts          French engine (Task 6)
  lang/de.ts          German engine (Task 7)
  __fixtures__/en.txt es.txt ru.txt fr.txt de.txt   (one per language)
  fixtures.test.ts    table-driven fixture runner (Task 2, extended per language)

server/src/tts/text-normalize.ts        normaliseForTts gains optional langCode (Task 3)
server/src/tts/synthesise-chapter.ts    thread langCode into audio sites + length key + ASR-QA (Task 3)
docs/features/230-fs53-text-normalisation.md   regression plan (Task 8)
docs/features/INDEX.md                   add entry (Task 8)
```

---

## Task 1: English engine + the `LangNormalizer` interface

**Files:**
- Create: `server/src/tts/normalize/types.ts`
- Create: `server/src/tts/normalize/lang/en.ts`
- Create: `server/src/tts/normalize/number-to-words.ts`
- Test: `server/src/tts/normalize/lang/en.test.ts`

**Interfaces:**
- Produces: `LangNormalizer` interface; `getNormalizer(langCode: string): LangNormalizer | undefined`; the English engine object.

- [ ] **Step 1: Write the interface (`types.ts`)**

```ts
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
```

- [ ] **Step 2: Write failing tests for the English engine (`lang/en.test.ts`)**

```ts
import { describe, it, expect } from 'vitest';
import { en } from './en.js';

describe('en cardinal', () => {
  it.each([
    [0, 'zero'], [7, 'seven'], [13, 'thirteen'], [21, 'twenty-one'],
    [100, 'one hundred'], [101, 'one hundred one'], [999, 'nine hundred ninety-nine'],
    [1000, 'one thousand'], [1200, 'one thousand two hundred'],
    [1_000_000, 'one million'], [999_999_999, 'nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine'],
  ])('cardinal(%i) = %s', (n, expected) => expect(en.cardinal(n)).toBe(expected));
});

describe('en ordinal', () => {
  it.each([[1, 'first'], [2, 'second'], [3, 'third'], [21, 'twenty-first'], [100, 'one hundredth']])(
    'ordinal(%i) = %s', (n, e) => expect(en.ordinal(n)).toBe(e));
});

describe('en year', () => {
  it.each([[1999, 'nineteen ninety-nine'], [2026, 'twenty twenty-six'], [2000, 'two thousand'], [2007, 'two thousand seven'], [1900, 'nineteen hundred']])(
    'year(%i) = %s', (n, e) => expect(en.year(n)).toBe(e));
});

describe('en decade', () => {
  it.each([[1990, 'nineteen nineties'], [1920, 'nineteen twenties'], [2010, 'twenty tens'], [1900, 'nineteen hundreds'], [2000, 'two thousands']])(
    'decade(%i) = %s', (n, e) => expect(en.decade(n)).toBe(e));
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cd server && npx vitest run src/tts/normalize/lang/en.test.ts`
Expected: FAIL (`en` not exported / undefined).

- [ ] **Step 4: Implement the English engine (`lang/en.ts`)**

```ts
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
```

- [ ] **Step 5: Write the engine registry (`number-to-words.ts`)**

```ts
import type { LangNormalizer } from './types.js';
import { en } from './lang/en.js';

const REGISTRY: Record<string, LangNormalizer> = { en };

export function getNormalizer(langCode: string): LangNormalizer | undefined {
  return REGISTRY[langCode];
}
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `cd server && npx vitest run src/tts/normalize/lang/en.test.ts`
Expected: PASS (all rows).

- [ ] **Step 7: Commit**

```bash
git add server/src/tts/normalize/types.ts server/src/tts/normalize/lang/en.ts server/src/tts/normalize/lang/en.test.ts server/src/tts/normalize/number-to-words.ts
git commit -m "feat(server): fs-53 English number engine + LangNormalizer interface"
```

---

## Task 2: Shared classifiers + `expandForSpeech` orchestrator (English end-to-end)

**Files:**
- Create: `server/src/tts/normalize/classifiers.ts`
- Create: `server/src/tts/normalize/index.ts`
- Create: `server/src/tts/normalize/__fixtures__/en.txt`
- Create: `server/src/tts/normalize/fixtures.test.ts`
- Test: `server/src/tts/normalize/index.test.ts`

**Interfaces:**
- Consumes: `getNormalizer` (Task 1), `isSupportedLanguage` (`../language-registry.js`).
- Produces: `expandForSpeech(text: string, langCode: string): string`; `parseLocaleNumber(raw, sep): number` (exported for tests).

- [ ] **Step 1: Write the locale number parser + its tests (`classifiers.ts` skeleton + `index.test.ts`)**

In `index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLocaleNumber } from './classifiers.js';

describe('parseLocaleNumber (3-digit-group guard)', () => {
  it('en 1,200.50 -> 1200.5', () => expect(parseLocaleNumber('1,200.50', { decimal: '.', thousands: ',' })).toBe(1200.5));
  it('de 1.200,50 -> 1200.5', () => expect(parseLocaleNumber('1.200,50', { decimal: ',', thousands: '.' })).toBe(1200.5));
  it('de 1.5 is NOT thousands -> 1.5', () => expect(parseLocaleNumber('1.5', { decimal: ',', thousands: '.' })).toBe(1.5));
  it('de 3,14 -> 3.14', () => expect(parseLocaleNumber('3,14', { decimal: ',', thousands: '.' })).toBe(3.14));
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server && npx vitest run src/tts/normalize/index.test.ts`
Expected: FAIL (`parseLocaleNumber` undefined).

- [ ] **Step 3: Implement `classifiers.ts`**

```ts
import type { LangNormalizer, YearCase } from './types.js';

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
  const fracPart = raw.split(norm.separators.decimal)[1] ?? '';
  const digits = fracPart.split('').map((d) => norm.cardinal(Number(d))).join(' ');
  return `${norm.cardinal(Math.trunc(v))} ${norm.decimalWord} ${digits}`;
}
```

(`speakNumber` reads `norm.decimalWord`, so every language gets its own decimal
word — no later refactor needed.)

- [ ] **Step 4: Implement the ordered passes + `expandForSpeech` (`index.ts`)**

```ts
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
  s = expandOrdinals(s, norm);
  s = expandDecades(s, norm);
  s = expandYears(s, norm);
  s = expandNumbers(s, norm);
  s = expandAbbreviations(s, norm);
  return s;
}
```

Then implement each `expand*` helper in `index.ts` (or `classifiers.ts`). English-targeted first; the per-language data drives them so later languages need no new pass code. Reference implementations:

```ts
// SPACE_CLASS imported from classifiers.js (single definition).
function numberToken(norm: LangNormalizer): string {
  // A locale number: digits with optional grouping + optional decimal.
  const thou = norm.separators.thousands === 'space' ? SPACE_CLASS : '\\' + norm.separators.thousands;
  const dec = '\\' + norm.separators.decimal;
  return `\\d{1,3}(?:${thou}\\d{3})+|\\d+(?:${dec}\\d+)?`;
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
    const dmNoYear = new RegExp(`\\b(\\d{1,2})\\s+(${names})\\b`, 'g');
    s = s.replace(dmNoYear, (_m, day, mon) => norm.date(Number(day), idx.get(mon)!, 0));
  }
  return s;
}
```

Export `speakNumber` and the helpers as needed for unit tests.

- [ ] **Step 5: Create the English fixture file (`__fixtures__/en.txt`)**

Format: one `input ⇒ expected` per line, `#` comments allowed, blank lines ignored.

```
# fs-53 English normalisation fixtures (input ⇒ expected)
He paid $1,200.50 for it. ⇒ He paid one thousand two hundred dollars and fifty cents for it.
It rose 50% in 1999. ⇒ It rose fifty percent in nineteen ninety-nine.
See No. 5 on January 3rd, 2026. ⇒ See Number five on January third, twenty twenty-six.
The 1990s were loud. ⇒ The nineteen nineties were loud.
Dr. Vance met Mr. Poe. ⇒ Doctor Vance met Mister Poe.
# known-failure: Room number reads as a year (limitation #1)
Go to Room 1999. ⇒ Go to Room nineteen ninety-nine.
# St. only expands before a capital
Main St. was quiet. ⇒ Main St. was quiet.
St. James waited. ⇒ Saint James waited.
# No. negation untouched
No. I refuse. ⇒ No. I refuse.
```

- [ ] **Step 6: Write the fixture runner (`fixtures.test.ts`)**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expandForSpeech } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));

function load(lang: string): Array<[string, string]> {
  const raw = readFileSync(join(here, '__fixtures__', `${lang}.txt`), 'utf8');
  return raw.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [input, expected] = l.split(' ⇒ ');
      return [input, expected] as [string, string];
    });
}

for (const lang of ['en']) { // extended per language in later tasks
  describe(`fixtures: ${lang}`, () => {
    it.each(load(lang))('%s', (input, expected) => {
      expect(expandForSpeech(input, lang)).toBe(expected);
    });
  });
}
```

- [ ] **Step 7: Run all Task-2 tests**

Run: `cd server && npx vitest run src/tts/normalize/`
Expected: PASS (parser tests + en fixtures). Fix any ordering bugs (e.g. a number inside currency expanded twice) by confirming currency runs before plain numbers.

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/normalize/classifiers.ts server/src/tts/normalize/index.ts server/src/tts/normalize/index.test.ts server/src/tts/normalize/fixtures.test.ts server/src/tts/normalize/__fixtures__/en.txt
git commit -m "feat(server): fs-53 classifier passes + expandForSpeech (English)"
```

---

## Task 3: Integrate into `normaliseForTts` + synth call-sites + ASR-QA alignment

**Files:**
- Modify: `server/src/tts/text-normalize.ts`
- Modify: `server/src/tts/synthesise-chapter.ts`
- Test: `server/src/tts/text-normalize.test.ts` (extend), `server/src/tts/synthesise-chapter.test.ts` (extend)

**Interfaces:**
- Consumes: `expandForSpeech` (Task 2).
- Produces: `normaliseForTts(text: string, langCode?: string): string`.

- [ ] **Step 1: Write failing tests for the new `normaliseForTts` arg (`text-normalize.test.ts`)**

```ts
import { normaliseForTts } from './text-normalize.js';

it('no langCode => byte-identical to today (no expansion)', () => {
  expect(normaliseForTts('I have $5.')).toBe('I have $5.');
});
it('with langCode => expands', () => {
  expect(normaliseForTts('I have $5.', 'en')).toBe('I have five dollars.');
});
it('no-op on plain prose with langCode', () => {
  const plain = 'The quiet road wound north.';
  expect(normaliseForTts(plain, 'en')).toBe(normaliseForTts(plain));
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd server && npx vitest run src/tts/text-normalize.test.ts`
Expected: FAIL (second/third assertions — langCode arg ignored).

- [ ] **Step 3: Wire `expandForSpeech` into `normaliseForTts`**

In `text-normalize.ts`, add the import and the optional arg:

```ts
import { expandForSpeech } from './normalize/index.js';

export function normaliseForTts(text: string, langCode?: string): string {
  const base = stripAudioTags(softenDashes(denormaliseAllCaps(stripUnsafeForTts(text))));
  return langCode ? expandForSpeech(base, langCode) : base;
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cd server && npx vitest run src/tts/text-normalize.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread `langCode` through `synthesiseChapter`**

In `synthesise-chapter.ts`, resolve the code once near the top of the synth function (where `bookLanguage` is in scope):

```ts
import { normaliseBookLanguage } from './language.js';
// ...
// ALWAYS resolve to a concrete code — normaliseBookLanguage defaults undefined/
// empty to 'en', so an English book (which often has no explicit bookLanguage)
// still gets normalisation. Do NOT gate this on `bookLanguage` being truthy.
const langCode = normaliseBookLanguage(bookLanguage);
```

Then pass `langCode` as the second arg at every audio-producing / audio-compared site:
- `:917`  `text: normaliseForTts(titleText, langCode)`
- `:1090` `text: normaliseForTts(group.text, langCode)`
- `:1139` `return { text: normaliseForTts(g.text, langCode), voiceName }`
- `:1281` `[g, normaliseForTts(g.text, langCode).length]`
- The ASR-QA `verify` closure (`:1460`) — change its calls so `expectedText` is the **normalised** text:

```ts
const verify = (pcm: Buffer, rate: number, text: string): Promise<AsrClassification> =>
  verifySegmentTranscript(pcm, rate, normaliseForTts(text, langCode), { /* unchanged opts */ });
```

(Both `verify(...)` call sites at `:1489` and `:1513` pass `group.text`; the closure now normalises it, so the QA expected text matches the synthesised audio.)

Leave `:682` (empty-filter) and `voice-mapping.ts:183` (ICL picker) as the no-`langCode` form — neutral is correct there (spec known-limit #9).

- [ ] **Step 6: Write the ASR-QA alignment regression test (`synthesise-chapter.test.ts`)**

Add a focused test that the QA expected text equals the synth-input text. If the existing test harness stubs `transcribeFn`, assert the `expectedText` it receives:

```ts
it('ASR-QA expected text is the fs-53-normalised synth input', async () => {
  const seen: string[] = [];
  const transcribeFn = async (_pcm, _rate, _o) => { /* capture expectedText via classify */ return { text: 'one thousand two hundred dollars', avgLogprob: -0.1, noSpeechProb: 0.01, compressionRatio: 1.5 }; };
  // Drive synthesiseChapter with asr enabled on a sentence "$1,200" and bookLanguage 'en';
  // assert the verdict is NOT 'drift' (transcript matches normalised expected).
  // (Use the existing test's chapter/voice scaffolding.)
});
```

Implement against the existing test scaffolding in that file (reuse its fake synth + fixtures). The assertion that matters: with `$1,200` synthesised and a matching transcript, the verdict is `ok`, not `drift`.

- [ ] **Step 7: Run the server suite for this file + a typecheck**

Run: `cd server && npx vitest run src/tts/text-normalize.test.ts src/tts/synthesise-chapter.test.ts && cd .. && npm run typecheck`
Expected: PASS / no type errors.

**If existing `synthesise-chapter` tests assert exact synthesised text containing numbers/currency/abbreviations, they will now see the EXPANDED form** (the feature working). Update those expectations to the normalised text — do NOT revert the threading. A diff like `"$5"` → `"five dollars"` in a fixture assertion is correct. Grep the test file for `$`, digits, and `Dr.`/`Mr.` before running to anticipate which assertions move.

- [ ] **Step 8: Commit**

```bash
git add server/src/tts/text-normalize.ts server/src/tts/text-normalize.test.ts server/src/tts/synthesise-chapter.ts server/src/tts/synthesise-chapter.test.ts
git commit -m "feat(server): fs-53 wire expandForSpeech into normaliseForTts + ASR-QA alignment"
```

---

## Task 4: Spanish engine

**Files:**
- Create: `server/src/tts/normalize/lang/es.ts`
- Create: `server/src/tts/normalize/__fixtures__/es.txt`
- Test: `server/src/tts/normalize/lang/es.test.ts`

**Interfaces:**
- Consumes: `LangNormalizer` (Task 1). Registered into `REGISTRY` in `number-to-words.ts`.
- Produces: `es: LangNormalizer`.

**Rules (from spec):** `dieciséis…veintinueve` contractions; `quinientos/setecientos/novecientos`; `cien` vs `ciento`; `y` joins tens–units only (`treinta y uno`, NOT `ciento y uno`, NOT inside 21–29); gender floor masculine; separators `.`=thousands `,`=decimal; `decimalWord` `coma`; decade drops the century (`los noventa`); currency connector `con`, minor `céntimos`; year reads as cardinal (`1999`→`mil novecientos noventa y nueve`). `date(day, mi, yr)`: cardinal day (day 1 → `primero`) + ` de ` + `months.nominative[mi]` + (`yr` ? ` de ` + cardinal(yr) : ''). Spanish dates carry no genitive table — leave `months.genitiveDates` undefined.

- [ ] **Step 1: Write the engine unit tests (`es.test.ts`)** — exact expected cardinals:

```ts
import { es } from './es.js';
it.each([
  [16, 'dieciséis'], [21, 'veintiuno'], [22, 'veintidós'], [31, 'treinta y uno'],
  [100, 'cien'], [101, 'ciento uno'], [200, 'doscientos'], [500, 'quinientos'],
  [700, 'setecientos'], [900, 'novecientos'], [1000, 'mil'], [1200, 'mil doscientos'],
])('cardinal(%i)=%s', (n, e) => expect(es.cardinal(n)).toBe(e));
it('decade(1990) drops century', () => expect(es.decade(1990)).toBe('los noventa'));
```

- [ ] **Step 2: Run, verify fail.** `cd server && npx vitest run src/tts/normalize/lang/es.test.ts` → FAIL.

- [ ] **Step 3: Implement `es.ts`** against those expectations and the spec rules (cardinal with the `y`-rule and hundreds table; `year` reads as cardinal in Spanish — `1999` → `mil novecientos noventa y nueve`; `ordinal` for dates; `decade(start)` → `'los ' + tensWord(start%100)`).

- [ ] **Step 4: Register es** — in `number-to-words.ts`: `import { es } from './lang/es.js';` and add `es` to `REGISTRY`.

- [ ] **Step 5: Run, verify pass.** Same command → PASS.

- [ ] **Step 6: Add `es` to the fixture loop** in `fixtures.test.ts` (`for (const lang of ['en','es'])`) and create `__fixtures__/es.txt`:

```
# fs-53 Spanish fixtures (€ → euros; % → "por ciento"; es decimal word = coma)
Costó 1.200,50 €. ⇒ Costó mil doscientos euros con cincuenta céntimos.
Subió un 50% en 1999. ⇒ Subió un cincuenta por ciento en mil novecientos noventa y nueve.
# separator guard: 1.5 is NOT 1500
Versión 1.5 lista. ⇒ Versión uno coma cinco lista.
# decade drops the century
Los 1990s fueron ruidosos. ⇒ Los los noventa fueron ruidosos.
```

(The `Los 1990s` line is deliberately awkward to isolate the decade token; if the
implementer prefers a cleaner sentence, keep the `1990s` token and the
century-dropped `los noventa` expected output — the assertion under test is the
century-drop, confirmed against `es.test.ts` `decade(1990)`.)

- [ ] **Step 7: Run `cd server && npx vitest run src/tts/normalize/` → PASS.**

- [ ] **Step 8: Commit** `feat(server): fs-53 Spanish number engine + fixtures`.

---

## Task 5: Russian engine (the raised floor)

**Files:**
- Create: `server/src/tts/normalize/lang/ru.ts`
- Create: `server/src/tts/normalize/__fixtures__/ru.txt`
- Test: `server/src/tts/normalize/lang/ru.test.ts`

**Interfaces:** Produces `ru: LangNormalizer` (implements `yearCaseFor`). Registered in `REGISTRY`.

**Rules (from spec — this is the hardest engine; follow the spec's Russian floor exactly):**
- `cardinal` compounding, nominative, masculine/neuter default.
- `year(n, case)`: spell as cardinal except the **final component becomes an ordinal** in the requested case. `nominative`→`-ый/-ой`, `prepositional`→`-ом`, `genitive`→`-ого`, `dative`→`-ому`.
- `yearCaseFor(prev)`: `в|во`→`prepositional`; `с|до|от|после`→`genitive`; `к`→`dative`; else `nominative`.
- `decade(start)` → substantivised plural ordinal of the tens word, century dropped (`1990`→`девяностые`).
- Dates: implement `date(day, mi, yr)` = neuter-ordinal(day) + ' ' + `months.genitiveDates[mi]` + (`yr` ? ' ' + `year(yr, 'genitive')` + ' года' : ''). Provide `months.genitiveDates` (12 genitive forms: января, февраля, …) AND `months.nominative` (январь, …) so detection matches either.
- Currency: 1→`рубль`/`доллар`, 2–4→`рубля`/`доллара`, 5+ & 11–14→`рублей`/`долларов`; connector `''`.
- 1/2 gender heuristic: infer following-noun gender from ending to pick `один/одна/одно`, `два/две`.
- Separators: space=thousands, `,`=decimal; decimal word `целых`/`и` (use `запятая`? — spec says digit-by-digit "point"; for RU use `целых … десятых`? **Keep it simple: decimal word `точка` is wrong; use `запятая`-free digit read `… целых …`** — confirm against a fixture; if uncertain, restrict RU decimals to integer+`запятая`+digits read individually and pin the chosen form in the fixture).

- [ ] **Step 1: Write `ru.test.ts`** with exact expectations for the deterministic pieces:

```ts
import { ru } from './ru.js';
it('year nominative', () => expect(ru.year(1999, 'nominative')).toBe('тысяча девятьсот девяносто девятый'));
it('year prepositional', () => expect(ru.year(1999, 'prepositional')).toBe('тысяча девятьсот девяносто девятом'));
it('year genitive', () => expect(ru.year(1999, 'genitive')).toBe('тысяча девятьсот девяносто девятого'));
it('year dative', () => expect(ru.year(1999, 'dative')).toBe('тысяча девятьсот девяносто девятому'));
it('yearCaseFor', () => { expect(ru.yearCaseFor!('в')).toBe('prepositional'); expect(ru.yearCaseFor!('с')).toBe('genitive'); expect(ru.yearCaseFor!('к')).toBe('dative'); });
it('decade', () => expect(ru.decade(1990)).toBe('девяностые'));
it('currency agreement', () => { expect(ru.currency['₽'].major(1)).toBe('рубль'); expect(ru.currency['₽'].major(3)).toBe('рубля'); expect(ru.currency['₽'].major(5)).toBe('рублей'); });
```

- [ ] **Step 2: Run, verify fail.** → FAIL.

- [ ] **Step 3: Implement `ru.ts`** against the above + spec rules. Write Cyrillic as plain string literals (NOT `\u` — they carry no combining marks), but DO write the genitive-month array and ordinal tables explicitly. Implement `currency.major` via the 1 / 2–4 / 5+ (with 11–14 exception) rule.

- [ ] **Step 4: Register ru** in `number-to-words.ts`.

- [ ] **Step 5: Run, verify pass.** → PASS.

- [ ] **Step 6: Create `__fixtures__/ru.txt`** and add `ru` to the fixture loop. Include: each preposition frame, a date, currency agreement, a 1/2-gender success + a documented mis-gender known-failure, separator inversion, decade:

```
# fs-53 Russian fixtures
Это случилось в 1999 году. ⇒ Это случилось в тысяча девятьсот девяносто девятом году.
С 1999 года прошло время. ⇒ С тысяча девятьсот девяносто девятого года прошло время.
К 1999 году всё изменилось. ⇒ К тысяча девятьсот девяносто девятому году всё изменилось.
Цена 5 ₽. ⇒ Цена пять рублей.
Цена 3 ₽. ⇒ Цена три рубля.
3 января пришёл ответ. ⇒ третье января пришёл ответ.
# known-failure: soft-sign noun mis-gendered (limitation #4)
Одна тень. ⇒ Одна тень.
```

(Confirm each expected line on a Russian read-through before committing; pin the chosen decimal-read form here.)

- [ ] **Step 7: Run `cd server && npx vitest run src/tts/normalize/` → PASS.**

- [ ] **Step 8: Commit** `feat(server): fs-53 Russian number engine (years/dates/currency/gender) + fixtures`.

---

## Task 6: French engine (dormant)

**Files:** Create `lang/fr.ts`, `__fixtures__/fr.txt`, Test `lang/fr.test.ts`. Register in `REGISTRY`.

**Rules:** `soixante-dix`/`quatre-vingts`/`quatre-vingt-dix`; `vingt`/`cent` pluralisation common-case; separators space=thousands `,`=decimal; `decimalWord` `virgule`; decade `les années quatre-vingt-dix` (no century-drop); currency connector `et`, minor `centimes`; year reads as cardinal; `date(day, mi, yr)` = cardinal day (day 1 → `premier`) + ' ' + `months.nominative[mi]` + (`yr` ? ' ' + cardinal(yr) : ''); leave `genitiveDates` undefined. `supported:false` ⇒ dormant end-to-end.

- [ ] **Step 1: `fr.test.ts`** — `[70,'soixante-dix'],[80,'quatre-vingts'],[90,'quatre-vingt-dix'],[71,'soixante et onze'],[81,'quatre-vingt-un'],[100,'cent'],[200,'deux cents'],[201,'deux cent un']`; `decade(1990)='les années quatre-vingt-dix'`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `fr.ts`.**
- [ ] **Step 4: Register fr; add a dormancy test** (in `index.test.ts`): `expect(expandForSpeech('J’ai 5 €.', 'fr')).toBe('J’ai 5 €.')` — proves `supported:false` no-ops end-to-end while the engine unit tests still pass directly.
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: `__fixtures__/fr.txt` + dormant-fixture runner.** Add `fr` to a SEPARATE fixture block that drives `applyPasses(input, fr)` (the ungated composer from Task 2) instead of `expandForSpeech` — because `fr` is `supported:false`, the gated path would no-op. In `fixtures.test.ts`:

```ts
import { applyPasses } from './index.js';
import { fr } from './lang/fr.js';
// supported languages go through the gate; dormant ones through applyPasses.
const DORMANT: Record<string, typeof fr> = { fr };
for (const [lang, norm] of Object.entries(DORMANT)) {
  describe(`fixtures (dormant): ${lang}`, () => {
    it.each(load(lang))('%s', (input, expected) => expect(applyPasses(input, norm)).toBe(expected));
  });
}
```

Create `fr.txt` with the engine-level expectations (numbers/currency/decade).
- [ ] **Step 7: Run server normalize suite → PASS.**
- [ ] **Step 8: Commit** `feat(server): fs-53 French number engine (dormant) + tests`.

---

## Task 7: German engine (dormant)

**Files:** Create `lang/de.ts`, `__fixtures__/de.txt`, Test `lang/de.test.ts`. Register in `REGISTRY`.

**Rules:** unit-before-ten one-word compounding (`einundzwanzig`); `eins`→`ein` before a scale word (`einhundert`, `eintausend`); separators `.`=thousands `,`=decimal; `decimalWord` `Komma`; decade `die Neunzigerjahre` (century dropped); currency connector `und`, minor `Cent`; year reads as cardinal; `date(day, mi, yr)` = ordinal day + ' ' + `months.nominative[mi]` + (`yr` ? ' ' + cardinal(yr) : ''); leave `genitiveDates` undefined. Dormant (`supported:false`).

- [ ] **Step 1: `de.test.ts`** — `[21,'einundzwanzig'],[100,'einhundert'],[1000,'eintausend'],[1234,'eintausendzweihundertvierunddreißig'],[1_000_000,'eine Million']` (confirm the `eine Million` form); `decade(1990)='die Neunzigerjahre'`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `de.ts`.**
- [ ] **Step 4: Register de; add a dormancy test** mirroring Task 6 Step 4.
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: `__fixtures__/de.txt`** with the **separator-guard** case pinned: `Version 1.5 ist da. ⇒ Version eins Komma fünf ist da.` and `Es kostet 1.200,50 €. ⇒ Es kostet eintausendzweihundert Euro und fünfzig Cent.` Add `de` to the `DORMANT` map in `fixtures.test.ts` (driven via `applyPasses`, as Task 6 Step 6) — NOT the gated loop.
- [ ] **Step 7: Run server normalize suite → PASS.**
- [ ] **Step 8: Commit** `feat(server): fs-53 German number engine (dormant) + tests`.

---

## Task 8: Activation-gate test, regression plan, INDEX, full verify

**Files:**
- Test: `server/src/tts/normalize/index.test.ts` (extend)
- Create: `docs/features/230-fs53-text-normalisation.md`
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1: Write the activation-gate tests** in `index.test.ts`:

```ts
it('dormant: fr (supported:false) no-ops even with an engine', () =>
  expect(expandForSpeech('J’ai 5 €.', 'fr')).toBe('J’ai 5 €.'));
it('unknown language no-ops', () =>
  expect(expandForSpeech('I have $5.', 'xx')).toBe('I have $5.'));
it('supported language with engine expands', () =>
  expect(expandForSpeech('I have $5.', 'en')).toBe('I have five dollars.'));
```

- [ ] **Step 2: Run → PASS** (these assert behaviour already built; if `fr` fails because it expanded, the gate is wrong — fix `expandForSpeech` to check `isSupportedLanguage` first).

Run: `cd server && npx vitest run src/tts/normalize/index.test.ts`

- [ ] **Step 3: Write the regression plan** `docs/features/230-fs53-text-normalisation.md` from `docs/features/TEMPLATE.md`. Fill: frontmatter `status: active`, issue `#976`, the invariants (TTS-boundary-only, zero-regression no-langCode path, ASR-QA alignment, per-language separator handling, fr/de dormancy), the manual acceptance walkthrough (render a Coalfall chapter with a seeded `$1,200 / 1999 / Dr.` line and confirm the audio + no false `asrSuspect`), and the known-limitations list copied from the spec.

- [ ] **Step 4: Add the INDEX entry** under the fs area in `docs/features/INDEX.md` (one line linking the new plan).

- [ ] **Step 5: Run the full fast gate**

Run: `cd .. && npm run typecheck && cd server && npm run test`
Expected: PASS. (The slow server lane isn't touched by this change.)

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/normalize/index.test.ts docs/features/230-fs53-text-normalisation.md docs/features/INDEX.md
git commit -m "feat(server): fs-53 activation-gate tests + regression plan"
```

- [ ] **Step 7: Run `npm run verify` before opening the PR** (typecheck + all tests + e2e + build). Open the PR with `Closes #976`, noting the intentional drop of the Full-stack label's frontend half.

---

## Self-Review notes

- **Spec coverage:** currency/dates/percent/symbols/ordinals/decades/years/numbers/abbreviations → Task 2 passes + per-language Tasks 4–7; ASR-QA alignment → Task 3; separator locale + 3-digit guard → Task 2 (`parseLocaleNumber`) + Task 7 de fixture; activation gate → Task 2 (`expandForSpeech`) + Task 8; RU floor (years/prepositions/dates/currency/gender/decade) → Task 5; fr/de dormant-but-tested → Tasks 6–7.
- **Symbol pass is bounded** (review #1): `°` only after a number, `&` only as ` & `, `×` standalone; `#`/`@` are NOT replaced (out of the v1 closed set) so `C#`/`user@host` survive.
- **Dates live in the engine** (review #1): the classifier detects spans across nominative ∪ genitive month tables and delegates rendering to `norm.date(day, monthIndex, year)`; `year === 0` ⇒ day+month only. Each engine owns day-ordinal gender (RU neuter) and month case (RU genitive).
- **Dormant languages** (review #1): fr/de are fixture-tested via the ungated `applyPasses(text, norm)`; `expandForSpeech` (gated) is asserted to no-op for them separately.
- **Decade boundary cases** (review #2): `en.decade` handles X00s ("nineteen hundreds" / "two thousands") and X10s ("twenty tens"), not just -ties; tested for 1900/2000/2010.
- **Ordinal detection is per-engine** (review #2): `ordinalPattern` on `LangNormalizer` (en `st|nd|rd|th`, es `º/ª`, fr `er/e`, ru `-й…`, de conservative). `expandOrdinals` uses it, not a hardcoded English suffix.
- **No-year date pass gated** (review #2): `dmNoYear` fires only when `genitiveDates` exists (Russian), so English "5 May" doesn't mis-fire.
- **Signed numbers dropped** (review #2): no minus handling in v1 (spec + plan agree); documented limitation.
- **Decimal-word generality:** handled — `decimalWord` is on `LangNormalizer`
  from Task 1 and `speakNumber` reads it. Each per-language engine (Tasks 4–7)
  must set it: es `coma`, ru pinned form, fr `virgule`, de `Komma`.
