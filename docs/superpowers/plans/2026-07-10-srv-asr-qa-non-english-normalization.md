# srv ASR-QA Non-English Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the ASR content-QA word-error-rate gate (`server/src/tts/segment-asr-qa.ts`, srv-31) real non-English normalization — per-language integer-spelling and contraction-expansion for es/fr/de/ru — instead of the English-only helpers it silently falls back to today.

**Architecture:** A new, purely-declarative module (`server/src/tts/asr-language-normalization.ts`) holds one frozen 0–99 token-array table per language plus a German contraction map; `normalizeForWer` in `segment-asr-qa.ts` consults it for any non-English language instead of the current English-gated `spellInteger`/`CONTRACTIONS`. Two new `registry.ts` knobs (`qa.asr.maxWer.fr`/`.de`) complete the existing `.es`/`.ru` per-language-override scaffold.

**Tech Stack:** TypeScript (Node/Vitest), no new dependencies.

**Source spec:** [`docs/superpowers/specs/2026-07-10-srv-asr-qa-non-english-normalization-design.md`](../specs/2026-07-10-srv-asr-qa-non-english-normalization-design.md) — read it first; this plan implements it task-by-task and does not restate its rationale.

## Global Constraints

- English behavior in `segment-asr-qa.ts` (`ONES`, `TENS`, `CONTRACTIONS`, `spellInteger`, the `if (english)` branch) must stay byte-for-byte unchanged. No regression to the already-shipped, calibrated English path.
- `qa.asr.enabled` (env `SEG_ASR_ENABLED`) stays default-off — nothing here touches that gate.
- New `qa.asr.maxWer.fr` / `qa.asr.maxWer.de` knobs default to the existing global `0.4`, unvalidated — same footing as the existing `.es`/`.ru` scaffold. Never set them to anything else in this plan.
- All new per-language linguistic data lives in `server/src/tts/asr-language-normalization.ts` as literal frozen arrays built once at module load — never as per-call closures, never on `LanguageEntry` in `language-registry.ts`.
- Integer tables cover indices 0..99 only. Numbers ≥100 fall through to the existing digit-stays-a-digit behavior, matching English's `spellInteger`.
- On-box calibration, real-audio validation, and any change to `AsrThresholds.maxWer`'s default value are explicitly out of scope — do not add them "while you're in there."
- Every task lands with its file's Vitest suite green before commit — no behavior ships without a paired test (CLAUDE.md testing discipline).

---

## File Structure

- **Create** `server/src/tts/asr-language-normalization.ts` — the new module: `WER_INTEGERS` (`Record<string, ReadonlyArray<readonly string[]>>`, keyed `es`/`fr`/`de`/`ru`) and `WER_CONTRACTIONS` (`Record<string, Record<string,string>>`, only `de` populated). Built across Tasks 1–4, one language per task.
- **Modify** `server/src/tts/segment-asr-qa.ts` — `normalizeForWer` (currently lines 247–279) gains a non-English branch that consults the new module. Task 5.
- **Modify** `server/src/tts/segment-asr-qa.test.ts` — new `describe` blocks for per-language integer/contraction normalization (Task 5) and `classifyTranscript` faithful/drift coverage (Task 6).
- **Modify** `server/src/config/registry.ts` — two new knob entries, `qa.asr.maxWer.fr` / `qa.asr.maxWer.de`, inserted after the existing `qa.asr.maxWer.ru` entry (current lines 259–268). Task 7.
- **Modify** (docs, no tests) `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/features/248-srv-asr-qa-non-english-normalization.md` (Ship notes), plus filing the calibration follow-up issue. Task 8.

---

### Task 1: Spanish integer table

**Files:**
- Create: `server/src/tts/asr-language-normalization.ts`
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Produces: `export const WER_INTEGERS: Readonly<Record<string, ReadonlyArray<readonly string[]>>>` — this task populates only the `es` key; later tasks add `fr`/`de`/`ru` to the same object. `export const WER_CONTRACTIONS: Readonly<Record<string, Record<string,string>>>` — declared empty (`{}`) this task, populated by Task 3.

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/segment-asr-qa.test.ts` (new `describe` block, anywhere after the existing imports; add `import { WER_INTEGERS } from './asr-language-normalization.js';` alongside the file's existing imports):

```ts
describe('WER_INTEGERS.es (#1084)', () => {
  it('spells 0-19 literally, including accented dieciséis', () => {
    expect(WER_INTEGERS.es[0]).toEqual(['cero']);
    expect(WER_INTEGERS.es[16]).toEqual(['dieciséis']);
    expect(WER_INTEGERS.es[19]).toEqual(['diecinueve']);
  });
  it('fuses 21-29 into one accented token', () => {
    expect(WER_INTEGERS.es[21]).toEqual(['veintiuno']);
    expect(WER_INTEGERS.es[22]).toEqual(['veintidós']);
    expect(WER_INTEGERS.es[26]).toEqual(['veintiséis']);
  });
  it('splits 30-99 into [decade, y, ones] with no irregularity past 29', () => {
    expect(WER_INTEGERS.es[31]).toEqual(['treinta', 'y', 'uno']);
    expect(WER_INTEGERS.es[71]).toEqual(['setenta', 'y', 'uno']);
    expect(WER_INTEGERS.es[95]).toEqual(['noventa', 'y', 'cinco']);
  });
  it('covers exactly indices 0..99', () => {
    expect(WER_INTEGERS.es).toHaveLength(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "WER_INTEGERS.es"`
Expected: FAIL — `Cannot find module './asr-language-normalization.js'` (the module doesn't exist yet).

- [ ] **Step 3: Write the module**

Create `server/src/tts/asr-language-normalization.ts`:

```ts
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

export const WER_INTEGERS: Readonly<Record<string, IntegerTable>> = Object.freeze({
  es: Object.freeze(buildSpanish()),
});

export const WER_CONTRACTIONS: Readonly<Record<string, Record<string, string>>> = Object.freeze({});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "WER_INTEGERS.es"`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/asr-language-normalization.ts server/src/tts/segment-asr-qa.test.ts
git commit -m "feat(server): add Spanish WER integer table (#1084)"
```

---

### Task 2: French integer table (base-20 counting)

**Files:**
- Modify: `server/src/tts/asr-language-normalization.ts`
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Produces: adds the `fr` key to the same `WER_INTEGERS` object from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/segment-asr-qa.test.ts`:

```ts
describe('WER_INTEGERS.fr (#1084)', () => {
  it('spells 0-16 literally, 17-19 as two tokens', () => {
    expect(WER_INTEGERS.fr[0]).toEqual(['zéro']);
    expect(WER_INTEGERS.fr[16]).toEqual(['seize']);
    expect(WER_INTEGERS.fr[17]).toEqual(['dix', 'sept']);
    expect(WER_INTEGERS.fr[19]).toEqual(['dix', 'neuf']);
  });
  it('composes 20-69 regularly with the et/no-et split', () => {
    expect(WER_INTEGERS.fr[21]).toEqual(['vingt', 'et', 'un']);
    expect(WER_INTEGERS.fr[22]).toEqual(['vingt', 'deux']);
    expect(WER_INTEGERS.fr[61]).toEqual(['soixante', 'et', 'un']);
  });
  it('switches to base-20 counting for 70-79, keeping et only at 71', () => {
    expect(WER_INTEGERS.fr[70]).toEqual(['soixante', 'dix']);
    expect(WER_INTEGERS.fr[71]).toEqual(['soixante', 'et', 'onze']);
    expect(WER_INTEGERS.fr[72]).toEqual(['soixante', 'douze']);
    expect(WER_INTEGERS.fr[77]).toEqual(['soixante', 'dix', 'sept']);
    expect(WER_INTEGERS.fr[79]).toEqual(['soixante', 'dix', 'neuf']);
  });
  it('drops the plural -s off vingt(s) and the et at 80-89', () => {
    expect(WER_INTEGERS.fr[80]).toEqual(['quatre', 'vingts']);
    expect(WER_INTEGERS.fr[81]).toEqual(['quatre', 'vingt', 'un']);
    expect(WER_INTEGERS.fr[89]).toEqual(['quatre', 'vingt', 'neuf']);
  });
  it('continues base-20 for 90-99, no et at 91', () => {
    expect(WER_INTEGERS.fr[90]).toEqual(['quatre', 'vingt', 'dix']);
    expect(WER_INTEGERS.fr[91]).toEqual(['quatre', 'vingt', 'onze']);
    expect(WER_INTEGERS.fr[97]).toEqual(['quatre', 'vingt', 'dix', 'sept']);
    expect(WER_INTEGERS.fr[99]).toEqual(['quatre', 'vingt', 'dix', 'neuf']);
  });
  it('covers exactly indices 0..99', () => {
    expect(WER_INTEGERS.fr).toHaveLength(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "WER_INTEGERS.fr"`
Expected: FAIL — `WER_INTEGERS.fr` is `undefined`.

- [ ] **Step 3: Write the implementation**

Add to `server/src/tts/asr-language-normalization.ts` (above the `WER_INTEGERS` export, then add `fr:` to it):

```ts
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
```

Update the `WER_INTEGERS` export to add the new key:

```ts
export const WER_INTEGERS: Readonly<Record<string, IntegerTable>> = Object.freeze({
  es: Object.freeze(buildSpanish()),
  fr: Object.freeze(buildFrench()),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "WER_INTEGERS.fr"`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/asr-language-normalization.ts server/src/tts/segment-asr-qa.test.ts
git commit -m "feat(server): add French WER integer table with base-20 counting (#1084)"
```

---

### Task 3: German integer table + contractions

**Files:**
- Modify: `server/src/tts/asr-language-normalization.ts`
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Produces: adds the `de` key to `WER_INTEGERS`; populates `WER_CONTRACTIONS.de`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/segment-asr-qa.test.ts`:

```ts
import { WER_CONTRACTIONS } from './asr-language-normalization.js'; // add to the existing import line from Task 1

describe('WER_INTEGERS.de (#1084)', () => {
  it('spells 0-12 literally', () => {
    expect(WER_INTEGERS.de[0]).toEqual(['null']);
    expect(WER_INTEGERS.de[12]).toEqual(['zwölf']);
  });
  it('truncates the ones-root for 16/17 (sechzehn/siebzehn, not sechszehn/siebenzehn)', () => {
    expect(WER_INTEGERS.de[16]).toEqual(['sechzehn']);
    expect(WER_INTEGERS.de[17]).toEqual(['siebzehn']);
    expect(WER_INTEGERS.de[13]).toEqual(['dreizehn']); // regular teens unaffected
  });
  it('fuses 21-99 into one reversed-order token with eins->ein', () => {
    expect(WER_INTEGERS.de[21]).toEqual(['einundzwanzig']);
    expect(WER_INTEGERS.de[22]).toEqual(['zweiundzwanzig']);
  });
  it('covers exactly indices 0..99', () => {
    expect(WER_INTEGERS.de).toHaveLength(100);
  });
});

describe('WER_CONTRACTIONS.de (#1084)', () => {
  it('expands the seven documented prepositional contractions', () => {
    expect(WER_CONTRACTIONS.de).toEqual({
      im: 'in dem', zum: 'zu dem', beim: 'bei dem', am: 'an dem',
      ins: 'in das', ans: 'an das', vom: 'von dem',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "WER_INTEGERS.de"`
Expected: FAIL — `WER_INTEGERS.de` is `undefined`.

- [ ] **Step 3: Write the implementation**

Add to `server/src/tts/asr-language-normalization.ts`:

```ts
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
```

Update `WER_INTEGERS` and `WER_CONTRACTIONS`:

```ts
export const WER_INTEGERS: Readonly<Record<string, IntegerTable>> = Object.freeze({
  es: Object.freeze(buildSpanish()),
  fr: Object.freeze(buildFrench()),
  de: Object.freeze(buildGerman()),
});

export const WER_CONTRACTIONS: Readonly<Record<string, Record<string, string>>> = Object.freeze({
  de: Object.freeze({
    im: 'in dem', zum: 'zu dem', beim: 'bei dem', am: 'an dem',
    ins: 'in das', ans: 'an das', vom: 'von dem',
  }),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "WER_INTEGERS.de|WER_CONTRACTIONS.de"`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/asr-language-normalization.ts server/src/tts/segment-asr-qa.test.ts
git commit -m "feat(server): add German WER integer table + prepositional contractions (#1084)"
```

---

### Task 4: Russian integer table

**Files:**
- Modify: `server/src/tts/asr-language-normalization.ts`
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Produces: adds the final `ru` key to `WER_INTEGERS`, completing the table for all four languages.

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/segment-asr-qa.test.ts`:

```ts
describe('WER_INTEGERS.ru (#1084)', () => {
  it('spells 0-19 literally', () => {
    expect(WER_INTEGERS.ru[0]).toEqual(['ноль']);
    expect(WER_INTEGERS.ru[19]).toEqual(['девятнадцать']);
  });
  it('composes 21-99 as two separate tokens, no conjunction', () => {
    expect(WER_INTEGERS.ru[21]).toEqual(['двадцать', 'один']);
    expect(WER_INTEGERS.ru[99]).toEqual(['девяносто', 'девять']);
  });
  it('covers exactly indices 0..99', () => {
    expect(WER_INTEGERS.ru).toHaveLength(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "WER_INTEGERS.ru"`
Expected: FAIL — `WER_INTEGERS.ru` is `undefined`.

- [ ] **Step 3: Write the implementation**

Add to `server/src/tts/asr-language-normalization.ts`:

```ts
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
```

Update `WER_INTEGERS`:

```ts
export const WER_INTEGERS: Readonly<Record<string, IntegerTable>> = Object.freeze({
  es: Object.freeze(buildSpanish()),
  fr: Object.freeze(buildFrench()),
  de: Object.freeze(buildGerman()),
  ru: Object.freeze(buildRussian()),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "WER_INTEGERS.ru"`
Expected: PASS (3 tests). Then run the full new-test set from Tasks 1-4 together: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "WER_INTEGERS|WER_CONTRACTIONS"` — expect all 18 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/asr-language-normalization.ts server/src/tts/segment-asr-qa.test.ts
git commit -m "feat(server): add Russian WER integer table, completing #1084 language tables"
```

---

### Task 5: Wire `normalizeForWer` to the new module

**Files:**
- Modify: `server/src/tts/segment-asr-qa.ts:28-30` (imports), `:247-279` (`normalizeForWer`)
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Consumes: `WER_INTEGERS`, `WER_CONTRACTIONS` from `./asr-language-normalization.js` (Tasks 1-4).
- Produces: `normalizeForWer(text: string, language?: string | null): string[]` — same signature as today; English behavior unchanged, non-English languages now spell integers and expand German contractions instead of no-op'ing.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/tts/segment-asr-qa.test.ts`, inside (or alongside) the existing `describe('normalizeForWer', ...)` block (add `WER_CONTRACTIONS` to the `./asr-language-normalization.js` import added in Task 3):

```ts
describe('normalizeForWer non-English integer spelling (#1084)', () => {
  it('spells a Spanish number inline with the surrounding words', () => {
    expect(normalizeForWer('Tenía 31 años.', 'es')).toEqual(['tenía', 'treinta', 'y', 'uno', 'años']);
  });
  it('spells a French base-20 number (72) correctly inline', () => {
    expect(normalizeForWer('Il avait 72 ans.', 'fr')).toEqual(['il', 'avait', 'soixante', 'douze', 'ans']);
  });
  it('spells a German fused compound (21) as one token', () => {
    expect(normalizeForWer('Sie hatte 21 Katzen.', 'de')).toEqual(['sie', 'hatte', 'einundzwanzig', 'katzen']);
  });
  it('spells a Russian number (21) as two tokens', () => {
    expect(normalizeForWer('Ей было 21 год.', 'ru')).toEqual(['ей', 'было', 'двадцать', 'один', 'год']);
  });
  it('leaves a 3+ digit number as a digit for every non-English language, matching English', () => {
    expect(normalizeForWer('En 1999.', 'es')).toEqual(['en', '1999']);
  });
});

describe('normalizeForWer German contraction expansion (#1084)', () => {
  it('expands "im" to "in dem" so it matches the uncontracted form', () => {
    expect(normalizeForWer('im Garten', 'de')).toEqual(normalizeForWer('in dem Garten', 'de'));
  });
});

describe('normalizeForWer no-op proof for es/fr/ru contractions (#1084)', () => {
  it('has no WER_CONTRACTIONS entry for es/fr/ru — mandatory contractions need no table', () => {
    expect(WER_CONTRACTIONS.es).toBeUndefined();
    expect(WER_CONTRACTIONS.fr).toBeUndefined();
    expect(WER_CONTRACTIONS.ru).toBeUndefined();
  });
  it('French elision (qu\\'il) already normalizes consistently via the generic apostrophe strip', () => {
    expect(normalizeForWer("qu'il", 'fr')).toEqual(normalizeForWer('quil', 'fr'));
  });
  it('Spanish mandatory contraction (del) passes through unchanged — nothing to reconcile', () => {
    expect(normalizeForWer('Vengo del mercado.', 'es')).toEqual(['vengo', 'del', 'mercado']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "non-English integer spelling|contraction"`
Expected: FAIL — e.g. `expected ['tenía', '31', 'años'] to equal ['tenía', 'treinta', 'y', 'uno', 'años']` (today's code leaves the digit as-is for non-English).

- [ ] **Step 3: Write the implementation**

In `server/src/tts/segment-asr-qa.ts`, add the import near the top (alongside the existing imports at lines 28-30):

```ts
import { WER_INTEGERS, WER_CONTRACTIONS } from './asr-language-normalization.js';
```

Replace the existing `normalizeForWer` function (current lines 247-279) with:

```ts
export function normalizeForWer(text: string, language?: string | null): string[] {
  const lang = baseSubtag(language);
  const english = lang === 'en' || !language;
  let s = (text ?? '').normalize('NFKC').toLowerCase();
  s = s.replace(SMART_QUOTES, "'").replace(SMART_DQUOTES, '"').replace(DASHES, '-');
  if (english) {
    for (const [from, to] of Object.entries(CONTRACTIONS)) {
      s = s.replace(new RegExp(`\\b${from.replace(/'/g, "['’]")}\\b`, 'g'), to);
    }
  } else {
    const contractions = WER_CONTRACTIONS[lang];
    if (contractions) {
      for (const [from, to] of Object.entries(contractions)) {
        s = s.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
      }
    }
  }
  // Drop possessive 's and any remaining apostrophes inside words.
  s = s.replace(/'s\b/g, '').replace(/'/g, '');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
  const tokens = s.split(/\s+/).filter(Boolean);
  if (english) {
    const out: string[] = [];
    for (const tok of tokens) {
      if (/^\d+$/.test(tok)) {
        const spelled = spellInteger(Number(tok));
        if (spelled) {
          out.push(...spelled.split(' '));
          continue;
        }
      }
      out.push(tok);
    }
    return out;
  }
  const table = WER_INTEGERS[lang];
  if (!table) return tokens; // unknown/unsupported language -> unchanged no-op
  const out: string[] = [];
  for (const tok of tokens) {
    if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      const spelled = n <= 99 ? table[n] : undefined;
      if (spelled) {
        out.push(...spelled);
        continue;
      }
    }
    out.push(tok);
  }
  return out;
}
```

Note what did NOT change: the `english` branch's body (contraction expansion via `CONTRACTIONS`, then `spellInteger`) is byte-identical to before. Only the `else` branches are new.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts`
Expected: PASS — the whole file, including every pre-existing test (English/Cyrillic paths untouched) plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/segment-asr-qa.ts server/src/tts/segment-asr-qa.test.ts
git commit -m "feat(server): wire normalizeForWer to per-language integer/contraction tables (#1084)"
```

---

### Task 6: `classifyTranscript` faithful/drift coverage for es/fr/de

**Files:**
- Test: `server/src/tts/segment-asr-qa.test.ts`

**Interfaces:**
- Consumes: `classifyTranscript(expectedText, transcript, signals, opts)` — existing signature, unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/tts/segment-asr-qa.test.ts`, mirroring the existing Cyrillic pair (`'scores a faithful non-Latin (Cyrillic) transcript'` / `'still flags wrong words in a Cyrillic transcript'`):

```ts
describe('classifyTranscript es/fr/de faithful vs. drift (#1084)', () => {
  const signals = { avgLogprob: -0.2, noSpeechProb: 0.05, compressionRatio: 1.2 };

  it('scores a faithful Spanish transcript -> ok', () => {
    const r = classifyTranscript('Tenía treinta y un años en aquel verano.',
      'Tenía treinta y un años en aquel verano.', signals, { language: 'es' });
    expect(r.verdict).toBe('ok');
    expect(r.wer).toBe(0);
  });
  it('flags wrong words in a Spanish transcript -> drift', () => {
    const r = classifyTranscript('Tenía treinta y un años en aquel verano.',
      'Compró un barco azul en el puerto lejano.', signals, { language: 'es' });
    expect(r.verdict).toBe('drift');
  });

  it('scores a faithful French transcript -> ok', () => {
    const r = classifyTranscript('Il avait soixante-douze ans cet été-là.',
      'Il avait soixante-douze ans cet été-là.', signals, { language: 'fr' });
    expect(r.verdict).toBe('ok');
    expect(r.wer).toBe(0);
  });
  it('flags wrong words in a French transcript -> drift', () => {
    const r = classifyTranscript('Il avait soixante-douze ans cet été-là.',
      'Elle portait une robe rouge ce matin-là.', signals, { language: 'fr' });
    expect(r.verdict).toBe('drift');
  });

  it('scores a faithful German transcript -> ok', () => {
    const r = classifyTranscript('Sie hatte einundzwanzig Katzen im Garten.',
      'Sie hatte einundzwanzig Katzen im Garten.', signals, { language: 'de' });
    expect(r.verdict).toBe('ok');
    expect(r.wer).toBe(0);
  });
  it('flags wrong words in a German transcript -> drift', () => {
    const r = classifyTranscript('Sie hatte einundzwanzig Katzen im Garten.',
      'Er kaufte einen roten Wagen am Montag.', signals, { language: 'de' });
    expect(r.verdict).toBe('drift');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "classifyTranscript es/fr/de"`
Expected: FAIL initially only if any sentence-length/reference-word-count accidentally trips the `minChars`/`minRefWords` backstops — inspect the failure message; if it's a genuine assertion mismatch rather than a missing-feature failure, this step's "expected FAIL reason" is that the feature isn't implemented — but since Task 5 already implemented normalization, these should PASS immediately. Run this step anyway to confirm the sentences are well-formed (each expected/transcript pair should be unambiguous, no accidental homophone/compound collisions).

- [ ] **Step 3: No implementation needed**

This task only adds integration-level regression coverage over the Task 5 implementation — skip to running the tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts`
Expected: PASS — full file green.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/segment-asr-qa.test.ts
git commit -m "test(server): classifyTranscript faithful/drift coverage for es/fr/de (#1084)"
```

---

### Task 7: `qa.asr.maxWer.fr` / `.de` registry knobs

**Files:**
- Modify: `server/src/config/registry.ts` (insert after the existing `qa.asr.maxWer.ru` entry, current lines 259-268)
- Test: `server/src/tts/segment-asr-qa.test.ts` (existing `describe('resolveAsrThresholds per-language maxWer (#1084 scaffold)', ...)` block)

**Interfaces:**
- Consumes: `resolveAsrThresholds(override, language)` — existing function in `segment-asr-qa.ts`, unchanged; it already generically resolves `qa.asr.maxWer.<lang>` via its internal `perLanguageMaxWer()` helper for whatever language is passed, so adding the `fr`/`de` registry entries is sufficient — no `segment-asr-qa.ts` code change needed for this task.

- [ ] **Step 1: Write the failing test**

The existing `describe('resolveAsrThresholds per-language maxWer (#1084 scaffold)', ...)` block in `server/src/tts/segment-asr-qa.test.ts` tests the `.es`/`.ru` knobs via `resolveAsrThresholds` + env var overrides (not by inspecting the registry directly) — mirror that exact pattern for `fr`/`de`. Extend the block's `afterEach` to also clean up the two new env vars, and add a new test:

```ts
describe('resolveAsrThresholds per-language maxWer (#1084 scaffold)', () => {
  afterEach(() => {
    delete process.env.SEG_ASR_MAX_WER_ES;
    delete process.env.SEG_ASR_MAX_WER_FR;
    delete process.env.SEG_ASR_MAX_WER_DE;
  });

  // ...existing tests unchanged...

  it('honours fr/de per-language overrides the same way as es/ru', () => {
    process.env.SEG_ASR_MAX_WER_FR = '0.5';
    expect(resolveAsrThresholds(undefined, 'fr').maxWer).toBeCloseTo(0.5);
    expect(resolveAsrThresholds(undefined, 'de').maxWer).toBe(0.4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts -t "fr/de per-language overrides"`
Expected: FAIL — `resolveAsrThresholds(undefined, 'fr').maxWer` is `0.4` (the override isn't recognized yet — the `qa.asr.maxWer.fr` knob doesn't exist in the registry, so `perLanguageMaxWer('fr')` finds no matching knob and falls through to global).

- [ ] **Step 3: Write the implementation**

In `server/src/config/registry.ts`, insert immediately after the existing `qa.asr.maxWer.ru` entry (before `qa.speaker.enabled`):

```ts
  {
    key: 'qa.asr.maxWer.fr',
    env: 'SEG_ASR_MAX_WER_FR',
    group: 'qa-gates',
    label: 'ASR max WER (French)',
    help: 'French-specific WER drift cap; defaults to the global ASR max WER until tuned on-box (#1084).',
    type: 'number', min: 0, max: 1, step: 0.05,
    default: 0.4,
    apply: 'live', risk: 'low',
  },
  {
    key: 'qa.asr.maxWer.de',
    env: 'SEG_ASR_MAX_WER_DE',
    group: 'qa-gates',
    label: 'ASR max WER (German)',
    help: 'German-specific WER drift cap; defaults to the global ASR max WER until tuned on-box (#1084).',
    type: 'number', min: 0, max: 1, step: 0.05,
    default: 0.4,
    apply: 'live', risk: 'low',
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/segment-asr-qa.test.ts`
Expected: PASS — full file green. Also run the full server suite once here since `registry.ts` is a shared file: `cd server && npm run test`
Expected: PASS, no regressions elsewhere in the registry/config test suites.

- [ ] **Step 5: Commit**

```bash
git add server/src/config/registry.ts server/src/tts/segment-asr-qa.test.ts
git commit -m "feat(server): add qa.asr.maxWer.fr/.de knobs, completing the #1084 scaffold"
```

---

### Task 8: Docs, follow-up issue, and PR wrap-up

**Files:**
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/features/248-srv-asr-qa-non-english-normalization.md`

This task has no automated test (docs-only) — follow the steps exactly, they are the deliverable.

- [ ] **Step 1: Append to `docs/release-notes-next.md`**

Add a new entry under the in-progress version's technical register (match the file's existing entry format/tone — terse, PR-refed):

```
- ASR content-QA gate: non-English integer-spelling and contraction normalization for es/fr/de/ru (#1084). Real per-language `maxWer` calibration against rendered audio remains a tracked follow-up.
```

- [ ] **Step 2: Append to `RELEASE_NOTES.md`**

Add a matching user-facing, brand-voice line to the in-progress version section at the top (match the file's existing voice — see other entries in that section for tone):

```
- Sharper quality-checking for non-English books: Castwright now understands numbers and common contractions when it double-checks Spanish, French, German, and Russian narration.
```

- [ ] **Step 3: File the calibration follow-up issue**

Run (adjust title/body to match the repo's issue-template conventions if `gh issue create` prompts for a template):

```bash
gh issue create --title "srv: on-box maxWer calibration for es/fr/de/ru (#1084 follow-up)" --label bug --body "Follow-up to #1084. The non-English normalization tables (integer-spelling, German contractions) shipped in #1084, but per-language maxWer thresholds are still unvalidated defaults (0.4, the English-tuned value). This issue tracks: (1) rendering real audio in es/ru (once the fs-61 Coalfall demo books are voice-designed), then fr/de, (2) running the ASR gate against it and inspecting the WER distribution per language, (3) setting qa.asr.maxWer.{es,fr,de,ru} from that data, (4) validating the two residual risks named in the #1084 design spec: gendered-number mismatch rate (es/fr/ru 'one', ru 'two') and Russian oblique-case declension mismatch rate, plus confirming whether Whisper's German output actually matches the single-fused-token assumption for compound numbers."
```

Note the returned issue number (referred to as `<FOLLOWUP-NN>` below).

- [ ] **Step 4: Comment on #1084**

```bash
gh issue comment 1084 --body "Shipped in this round: per-language integer-spelling + contraction-expansion normalization for es/fr/de/ru (server/src/tts/asr-language-normalization.ts), fixture-test coverage, and the qa.asr.maxWer.fr/.de knobs completing the per-language-override scaffold. Design: docs/superpowers/specs/2026-07-10-srv-asr-qa-non-english-normalization-design.md. Plan: docs/superpowers/plans/2026-07-10-srv-asr-qa-non-english-normalization.md. Still owed: real on-box maxWer calibration against rendered audio — tracked in #<FOLLOWUP-NN>. Leaving this issue open until that lands."
```

- [ ] **Step 5: Fill in `docs/features/248-srv-asr-qa-non-english-normalization.md` Ship notes**

Once the PR merges, edit that file's `## Ship notes` section (currently empty per `TEMPLATE.md`'s convention) to read:

```markdown
## Ship notes

Shipped <fill in merge date>, commit <fill in merge SHA>. Behaviour delta vs. spec: none —
implemented exactly as designed. Calibration remainder tracked in #<FOLLOWUP-NN>; this plan's
own status stays `active` (not `stable`) until that follow-up closes, since #1084 itself stays
open to represent it.
```

Do NOT flip the frontmatter `status:` to `stable` or move the file to `docs/features/archive/` — the calibration remainder means this plan is not fully done, per the spec's own `Refs #1084`-not-`Closes` decision.

- [ ] **Step 6: Final commit**

```bash
git add docs/release-notes-next.md RELEASE_NOTES.md docs/features/248-srv-asr-qa-non-english-normalization.md
git commit -m "docs: release notes + ship-notes wrap-up for #1084 normalization work"
```
