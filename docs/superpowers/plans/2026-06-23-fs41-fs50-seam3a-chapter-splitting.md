# fs-41/fs-50 Seam 3a — Language-aware chapter splitting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make plaintext chapter splitting + heading normalisation recognise non-English chapter headings (Spanish/French/German/Russian "Capítulo/Chapitre/Kapitel/Глава 1"), so a non-English manuscript no longer collapses into one chapter — without changing any English behaviour.

**Architecture:** The book language is **not known at parse time** (parsing produces the `sourceText` that detection later runs on — verified). So splitting is **language-agnostic**: the heading regex is built from the **union** of English (kept inline in `text.ts`) + the registry's non-English heading lexicons (es/fr/de/ru). A monolingual manuscript only contains its own language's keywords, so the union never causes cross-language false positives. The ASCII char-classes in `normaliseHeading`/`looksLikeTitle` widen to Unicode so accented/Cyrillic headings survive.

**Tech Stack:** TypeScript (ESM, `.js` imports), Node 20+ (server), Vitest.

## Global Constraints

- **English behaviour is unchanged.** All existing `server/src/parsers/text.test.ts` chapter-split + subtitle-merge assertions stay green. The union only ADDS non-English alternatives; ASCII⊂Unicode so the widened char-classes are supersets. Do not invert an English test.
- **Splitting is language-agnostic** (no language parameter threaded into `parseText` — it isn't available there). The registry supplies non-English lexicons; English stays inline in `text.ts`.
- es/fr/de heading lexicons are added even though those languages are `supported:false` — **detection (synthesis gating) and parsing (chapter splitting) are independent**; a Spanish book must split into chapters regardless of whether Spanish synthesis is claimed yet.
- This seam covers chapter SPLITTING + heading normalisation only. Front-matter-title detection (`front-matter.ts` `FRONT_MATTER_RX`), the EPUB `GENERIC_NCX_RE` merge (`html-utils.ts`), and the client mirror (`chapter-heuristics.ts`) are a SEPARATE later PR (seam 3b).
- Regexes that match non-ASCII keywords use the `u` flag (so the `i` flag case-folds Cyrillic) — verify English tests still pass after adding `u`.
- ESM `.js` imports. Commit `<type>(<scope>): <subject>`. Husky pre-commit runs the server test leg (must be green, no `--no-verify`). Work from the worktree `C:/Claude/Audiobook-Generator-wt-fs41`, branch `docs/docs-fs41-fs50-language`.

---

### Task 1: Add non-English heading lexicons to the registry

**Files:**
- Modify: `server/src/tts/language-registry.ts`
- Test: `server/src/tts/language-registry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `LanguageEntry` gains optional `headingLexicon?: { keywords: string[]; numberWords: string[]; standalone: string[] }`.
  - `nonEnglishHeadingLexicon(): { keywords: string[]; numberWords: string[]; standalone: string[] }` — the deduped union of every entry's `headingLexicon` (en has none; ru/es/fr/de do).

- [ ] **Step 1: Write the failing test** — append to `server/src/tts/language-registry.test.ts`:

```typescript
import { nonEnglishHeadingLexicon } from './language-registry.js';

describe('nonEnglishHeadingLexicon', () => {
  it('unions the non-English heading keywords (es/fr/de/ru), deduped', () => {
    const lex = nonEnglishHeadingLexicon();
    for (const kw of ['capítulo', 'chapitre', 'kapitel', 'глава']) {
      expect(lex.keywords).toContain(kw);
    }
    // English keywords are NOT in here (English stays inline in text.ts)
    expect(lex.keywords).not.toContain('chapter');
    // deduped
    expect(new Set(lex.keywords).size).toBe(lex.keywords.length);
  });

  it('includes non-English number words and standalone markers', () => {
    const lex = nonEnglishHeadingLexicon();
    expect(lex.numberWords).toContain('uno');   // es
    expect(lex.numberWords).toContain('drei');  // de
    expect(lex.standalone).toContain('пролог'); // ru prologue
    expect(lex.standalone).toContain('prólogo');// es prologue
  });

  it('en has no headingLexicon; ru/es/fr/de do', () => {
    expect(getLanguageEntry('en')?.headingLexicon).toBeUndefined();
    for (const c of ['ru', 'es', 'fr', 'de']) {
      expect(getLanguageEntry(c)?.headingLexicon).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/language-registry.test.ts`
Expected: FAIL — `nonEnglishHeadingLexicon` not exported, `headingLexicon` undefined.

- [ ] **Step 3: Implement** — in `server/src/tts/language-registry.ts`, add to the `LanguageEntry` interface:

```typescript
  /** Non-English chapter-heading lexicon (used to build the language-agnostic
      split regex; English stays inline in parsers/text.ts). Absent on `en`. */
  headingLexicon?: { keywords: string[]; numberWords: string[]; standalone: string[] };
```

Add `headingLexicon` to the ru/es/fr/de entries (leave en/`detect`/`supported` as-is):

```typescript
  { code: 'ru', sidecarName: 'Russian', supported: true, detect: { script: 'cyrillic', iso6393: 'rus' },
    headingLexicon: {
      keywords: ['глава', 'часть', 'день', 'книга', 'действие', 'сцена', 'раздел'],
      numberWords: ['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять',
        'одиннадцать', 'двенадцать', 'двадцать', 'тридцать'],
      standalone: ['пролог', 'эпилог', 'предисловие', 'введение', 'интерлюдия', 'послесловие'],
    } },
  { code: 'es', sidecarName: 'Spanish', supported: false, detect: { script: 'latin', iso6393: 'spa' },
    headingLexicon: {
      keywords: ['capítulo', 'parte', 'día', 'libro', 'acto', 'escena', 'sección'],
      numberWords: ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
        'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve',
        'veinte', 'treinta', 'cuarenta', 'cincuenta'],
      standalone: ['prólogo', 'epílogo', 'prefacio', 'introducción', 'interludio', 'epígrafe'],
    } },
  { code: 'fr', sidecarName: 'French', supported: false, detect: { script: 'latin', iso6393: 'fra' },
    headingLexicon: {
      keywords: ['chapitre', 'partie', 'jour', 'livre', 'acte', 'scène', 'section'],
      numberWords: ['un', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix',
        'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'vingt', 'trente', 'quarante', 'cinquante'],
      standalone: ['prologue', 'épilogue', 'préface', 'introduction', 'interlude', 'avant-propos'],
    } },
  { code: 'de', sidecarName: 'German', supported: false, detect: { script: 'latin', iso6393: 'deu' },
    headingLexicon: {
      keywords: ['kapitel', 'teil', 'tag', 'buch', 'akt', 'szene', 'abschnitt'],
      numberWords: ['eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn',
        'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'zwanzig', 'dreißig', 'vierzig'],
      standalone: ['prolog', 'epilog', 'vorwort', 'einleitung', 'zwischenspiel', 'nachwort'],
    } },
```

Add the union accessor:

```typescript
/** Deduped union of every entry's non-English heading lexicon — used by the
    parser to build a language-agnostic chapter-split regex (English stays
    inline in parsers/text.ts). */
export function nonEnglishHeadingLexicon(): { keywords: string[]; numberWords: string[]; standalone: string[] } {
  const keywords = new Set<string>();
  const numberWords = new Set<string>();
  const standalone = new Set<string>();
  for (const e of ENTRIES) {
    if (!e.headingLexicon) continue;
    e.headingLexicon.keywords.forEach((k) => keywords.add(k));
    e.headingLexicon.numberWords.forEach((n) => numberWords.add(n));
    e.headingLexicon.standalone.forEach((s) => standalone.add(s));
  }
  return { keywords: [...keywords], numberWords: [...numberWords], standalone: [...standalone] };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/language-registry.test.ts`
Expected: PASS (all blocks, incl. the prior seam-1/2 ones).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/language-registry.ts server/src/tts/language-registry.test.ts
git commit -m "feat(server): add non-English chapter-heading lexicons to the registry"
```

---

### Task 2: Union the chapter-split regexes + widen heading normalisation to Unicode

**Files:**
- Modify: `server/src/parsers/text.ts` (the heading constants + `normaliseHeading` + `looksLikeTitle`)
- Test: `server/src/parsers/text.test.ts` (existing English tests stay green; add non-English cases)

**Interfaces:**
- Consumes: `nonEnglishHeadingLexicon` (Task 1).
- Produces: no exported-signature change; `parseText` now splits non-English plaintext headings. `normaliseHeading`/`looksLikeTitle` keep their signatures.

- [ ] **Step 1: Write the failing tests** — append to `server/src/parsers/text.test.ts` (inside the existing chapter-splitting describe, or a new one):

```typescript
describe('parseText — non-English chapter splitting (seam 3a)', () => {
  it('splits a Spanish plaintext manuscript on "Capítulo N"', () => {
    const md = 'Capítulo 1\n\nEra una noche oscura.\n\nCapítulo 2\n\nA la mañana siguiente.\n';
    const { chapters } = parseText(md, { format: 'plaintext' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toMatch(/Capítulo 1/);
  });

  it('splits a German plaintext manuscript on "Kapitel N"', () => {
    const md = 'Kapitel 1\n\nEs war eine dunkle Nacht.\n\nKapitel 2\n\nAm nächsten Morgen.\n';
    const { chapters } = parseText(md, { format: 'plaintext' });
    expect(chapters).toHaveLength(2);
  });

  it('splits a Russian plaintext manuscript on "Глава N" and preserves the Cyrillic title', () => {
    const md = 'Глава 1\n\nБыла тёмная ночь.\n\nГлава 2\n\nНа следующее утро.\n';
    const { chapters } = parseText(md, { format: 'plaintext' });
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toMatch(/Глава 1/); // not stripped to empty by normaliseHeading
  });

  it('splits Spanish word-numbered + standalone headings (Capítulo Uno / Prólogo)', () => {
    const md = 'Prólogo\n\nUnas palabras.\n\nCapítulo Uno\n\nComienza la historia.\n';
    const { chapters } = parseText(md, { format: 'plaintext' });
    expect(chapters).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/parsers/text.test.ts`
Expected: FAIL — the non-English manuscripts collapse to 1 chapter (English-only keywords), and the Russian title is stripped by `normaliseHeading`'s ASCII class.

- [ ] **Step 3: Implement** — in `server/src/parsers/text.ts`:

(a) Import the union near the top:

```typescript
import { nonEnglishHeadingLexicon } from '../tts/language-registry.js';
```

(b) Build the union alternatives once (place after the existing English constants `HEADING_KEYWORDS`, `NUMBER_WORDS`, `STANDALONE_HEADINGS`):

```typescript
const NE_LEX = nonEnglishHeadingLexicon();
const ALL_HEADING_KEYWORDS = [...['chapter', 'day', 'part', 'book', 'act', 'section', 'scene'], ...NE_LEX.keywords].join('|');
const ALL_NUMBER_WORDS = [
  'one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen',
  'fifteen','sixteen','seventeen','eighteen','nineteen','twenty','thirty','forty','fifty','sixty','seventy',
  'eighty','ninety','hundred',
  ...NE_LEX.numberWords,
].join('|');
const ALL_STANDALONE = [...['prologue','epilogue','interlude','preface','introduction','afterword','foreword'], ...NE_LEX.standalone].join('|');
```

(Use these `ALL_*` unions to build `CHAPTER_HEADING_RE`, `NUMBER_PART`, `BARE_NUMBERED_HEADING_RE`, `BARE_STANDALONE_HEADING_RE` instead of the English-only `HEADING_KEYWORDS`/`NUMBER_WORDS`/`STANDALONE_HEADINGS`. Keep the existing English constants in place if other code references them; the regex builders switch to the `ALL_*` versions.) Add the **`u` flag** alongside `i` on these regexes so the `i` flag case-folds Cyrillic, e.g.:

```typescript
const NUMBER_PART = `(?:[ivxlcdm\\d]+|(?:${ALL_NUMBER_WORDS})(?:[-\\s](?:${ALL_NUMBER_WORDS}))?)`;
const CHAPTER_HEADING_RE = new RegExp(
  `^(?:#{1,2}\\s+\\S|${ALL_HEADING_KEYWORDS}\\s+${NUMBER_PART}\\b|${ALL_STANDALONE}\\b)`,
  'iu',
);
const BARE_NUMBERED_HEADING_RE = new RegExp(`^(?:${ALL_HEADING_KEYWORDS})\\s+${NUMBER_PART}\\s*$`, 'iu');
const BARE_STANDALONE_HEADING_RE = new RegExp(`^(?:${ALL_STANDALONE})\\s*$`, 'iu');
```

(c) Widen `normaliseHeading` to Unicode (preserve `#`):

```typescript
function normaliseHeading(line: string): string {
  return line.replace(/^[^\p{L}\p{N}#]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}
```

(d) Widen the first-character checks in `looksLikeTitle` to Unicode (uppercase letter or digit), and the word-trim char-class:

```typescript
export function looksLikeTitle(s: string): boolean {
  const words = s.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
    if (word.length === 0) continue;
    const first = word[0];
    if (/\p{Lu}/u.test(first)) continue; // uppercase letter (any script)
    if (/\p{Nd}/u.test(first)) continue; // decimal digit
    if (i === 0) return false;
    if (TITLE_STOPWORDS.has(word.toLowerCase())) continue;
    return false;
  }
  return true;
}
```

- [ ] **Step 4: Run to verify pass — non-English AND the full English suite**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/parsers/text.test.ts`
Expected: PASS — the 4 new non-English cases AND every pre-existing English chapter-split + subtitle-merge assertion (the union only added alternatives; ASCII⊂Unicode; the `u` flag is ASCII-safe).

- [ ] **Step 5: Run the broader parser suite (no regression in epub/pdf/index that share text.ts)**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/parsers`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/parsers/text.ts server/src/parsers/text.test.ts
git commit -m "feat(server): language-agnostic chapter splitting + Unicode heading normalisation"
```

---

## Self-Review

- **Spec coverage (§4.1 chapter split + title normalisation):** the chapter regex now matches non-English headings (via the union) ✓ (T2); `normaliseHeading` no longer strips accented/Cyrillic heading text ✓ (T2c); `looksLikeTitle` accepts non-ASCII title-case ✓ (T2d); registry carries the non-English lexicons ✓ (T1). The parse-time-language constraint is honoured (no language threaded; union is language-agnostic). Front-matter-title / GENERIC_NCX / client mirror are explicitly deferred to seam 3b.
- **Placeholder scan:** none — code + commands + expected output throughout.
- **Type consistency:** `nonEnglishHeadingLexicon` / `headingLexicon` spelled identically in T1 (def) and T2 (consumer); the `ALL_*` union constants are the regex inputs; `normaliseHeading`/`looksLikeTitle` keep their signatures.
- **English-unchanged check:** T2 Step 4 explicitly re-runs the full English `text.test.ts`; the union only appends alternatives and widens char-classes (supersets), so English behaviour is provably preserved.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-fs41-fs50-seam3a-chapter-splitting.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review gate between the two (T2's regex/Unicode changes warrant the gate against the English suite).
2. **Inline Execution** — execute both tasks here with a checkpoint after each.

This is the first of several seam-3 (analyze-half) PRs; the next (seam 3b) covers front-matter-title detection + the EPUB NCX merge + the client mirror.
