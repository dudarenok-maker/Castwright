# es/ru/fr/de Analyzer-Heuristic Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Localize two English-only analyzer heuristics — the minor-cast descriptor fold (`isDescriptorName`, #1050) and the roster-coverage guard (#1051) — for es/ru/fr/de, reusing the `tag-grammar.ts` substrate from #1028/#1049.

**Architecture:** A new sibling module `descriptor-grammar.ts` holds per-language descriptor data (Unit A); `tag-grammar.ts` gains a per-order regex **array** model plus fr/de rows, German titles, and wider quote glyphs (Unit B). The roster guard drops its `isNonEnglish` gate for a `grammarFor()` null-guard and scans body text with the grammar's regexes. English behavior is byte-identical throughout; es/ru/fr/de behavior intentionally changes.

**Tech Stack:** TypeScript (Node 20.x, ESM, `.js` import specifiers), Vitest (node env), the existing `server/src/analyzer/` modules.

**Spec:** `docs/superpowers/specs/2026-06-24-es-ru-fr-de-analyzer-heuristic-localization-design.md` (carries two folded-in adversarial-review rounds; every guard below traces to a finding there).

## Global Constraints

- **Node 20.x runtime** — NO ES2025-only regex features. Duplicate named capture groups (`(?<name>…|…)`) are a SyntaxError; never use them (finding A).
- **English byte-identical** — the `en` code paths and existing English test assertions must not change. Passing no `language` defaults to `'en'`. `EN_NAME` keeps the curly apostrophe `'` (U+2019).
- **Unmapped languages stay gated** — any language without a grammar row resolves `grammarFor()` / `descriptorGrammarFor()` → `null` → no-op (the gate moves, it doesn't vanish).
- **No `--no-verify`** — every commit goes through the husky gate. Docs/scoped commits skip the test legs automatically.
- **Inclusion-biased word lists** — a missing verb/noun silently drops a real speaker; an over-broad one is filtered downstream. Bias toward adding.
- **`.js` import specifiers** in all TypeScript imports (ESM/NodeNext).
- **Function-word fold rule is ru-only** (finding B) — es/fr/de carry empty `functionWords`; never add Romance/German nobiliary particles (`de`, `del`, `du`, `des`, `von`) to a fold list.
- **Both-orders detection is an ARRAY of regexes, never a single alternation** (finding A); the name stays capture group 1 in each.

## Plan review (round 1) — findings folded in

| # | Severity | Finding | Resolved in |
|---|---|---|---|
| P-1 | 🔴 | Widening `QUOTE_CHARS` in place breaks English byte-identity (the guard's adjacency window runs for `en` too; em-dashes are common in English prose). | Task 6 §4 — narrow `QUOTE_CHARS` (en) + `QUOTE_CHARS_WIDE` (es/ru/fr/de), selected by `normaliseBookLanguage(language)`. |
| P-2 | 🟠 | `validateAttributionCoverage` changes were described, not shown (different id-keyed map). | Task 6 §3.4 — explicit full code. |
| P-3 | 🟡 | `tagScanRegexesFor` flag handling could duplicate a flag. | Task 3 — `replace(/[gm]/g, '')`. |
| P-4 | 🟡 | en `verbBeatRegexFor` gains a `u` flag; a flags/source assertion could trip. | Task 3 §5 note. |
| P-5 | 🟡 | Task 2 re-export could throw TS2484. | Task 2 §2 — `import … ; export { … };` clean form. |
| P-6 | 🟡 | FR `s’exclama` curly apostrophe; DE `fuhr` weak verb. | Task 5 §3 note. |

## Plan review (round 2) — findings folded in

| # | Severity | Finding | Resolved in |
|---|---|---|---|
| R-1 | 🟠 | `validateAttributionCoverage` is modified (P-2) but its `de` gate test is deleted with no localized replacement — modified code with zero localized tests. | Task 6 §1.2 — es/ru half-state tests added. |
| R-2 | 🟡 | Test snippets re-`import` overlapping symbols → duplicate-import compile error if pasted literally. | "Test-snippet imports" note + inline reminders. |
| R-3 | 🟡 | Task 2 note could lead to wrongly deleting `normaliseBookLanguage` (still used by `bucketName`). | Task 2 §4 — explicit "keep it". |
| R-4 | 🟡 | `tagScanRegexesFor` (incl. P-3 flag manip) shipped untested in Task 3. | Task 3 §5 — direct assertion. |

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `server/src/analyzer/descriptor-grammar.ts` | **NEW.** Per-language descriptor data (es/ru/fr/de extras) + `isDescriptorName` matcher (English baseline universal). | 1 |
| `server/src/analyzer/descriptor-grammar.test.ts` | **NEW.** Matcher + per-language unit tests. | 1 |
| `server/src/analyzer/fold-minor-cast.ts` | Re-export `isDescriptorName` from the new module; delete the inline `GENERIC_ROLE_TAIL`/`GENERIC_ROLE_RU`/`RU_FUNCTION_WORDS` + matcher. | 2 |
| `server/src/analyzer/tag-grammar.ts` | `orders[]`, `tagRegexesFor`/`tagScanRegexesFor` array model, remove `tagRegexFor`, multi-order `verbBeatRegexFor` w/ Unicode boundaries, fr/de rows, German `titles` + title-skip, `QUOTE_GLYPHS` += U+201E. | 3,4,5 |
| `server/src/analyzer/recover-tagged-lines.ts` | Consumers loop over the regex array (3 `m[1]` sites). | 3,7 |
| `server/src/analyzer/roster-coverage.ts` | Gate swap, grammar-driven array body-scan w/ per-position dedupe, widened `QUOTE_CHARS`, stopword union, remove `isNonEnglish` import. | 6 |
| `server/src/routes/analysis.ts` | **Verify-only** — language threading to the guard + both `foldMinorCast` passes. | 8 |
| Test files | `fold-minor-cast.test.ts`, `tag-grammar.test.ts`, `roster-coverage.test.ts`, `recover-tagged-lines.test.ts`. | 2,4,5,6,7 |

**Implementation order:** Unit A (Tasks 1–2) lands before Unit B (Tasks 3–8) — the fold is Unit B's fr/de safety net (finding B / full-parity). Within Unit B, Task 3 (array refactor, behavior-preserving) precedes the behavior changes (4–5) and the guard (6).

**How to run the tests:** the server suite runs from the repo root: `npm run test:server -- <path>` (Vitest single-run). For one file: `npm run test:server -- server/src/analyzer/descriptor-grammar.test.ts`. For one test by name add `-t "<name>"`.

**Test-snippet imports (R-2):** the `import { … } from './tag-grammar.js'` lines shown inside test snippets below are illustrative of the symbols each block needs. When adding a block to an **existing** test file (`tag-grammar.test.ts`, `recover-tagged-lines.test.ts`, etc.), **merge the missing symbols into the file's existing top-level import** — do NOT paste a second `import` statement for a symbol already imported, or TypeScript/ESLint will reject the duplicate. The `capturesName` helper introduced in Task 4 likewise lives once at the top of `tag-grammar.test.ts` and is reused by Task 5.

---

## Task 1: `descriptor-grammar.ts` — data + matcher (Unit A core, #1050)

**Files:**
- Create: `server/src/analyzer/descriptor-grammar.ts`
- Test: `server/src/analyzer/descriptor-grammar.test.ts`

**Interfaces:**
- Consumes: `normaliseBookLanguage` from `../tts/language.js`.
- Produces:
  - `interface DescriptorGrammar { articles: ReadonlySet<string>; genericNouns: ReadonlySet<string>; nounMatch: 'bare' | 'trailing' | 'both'; functionWords: ReadonlySet<string> }`
  - `descriptorGrammarFor(language?: string): DescriptorGrammar | null` — returns **extras** for es/ru/fr/de; `null` for en + unmapped.
  - `isDescriptorName(name: string, language?: string): boolean`

**Key design note (byte-identity):** the historical `isDescriptorName` applied the English rules (`^unknown`, `^the …`, English trailing-noun) to **every** language, then added Russian rules for ru. We preserve that exactly: the English rules are a **universal baseline** in the matcher; the per-language grammar holds only the **extras** (so `descriptorGrammarFor('en')` is `null` and English = baseline alone, identical to today). es/ru/fr/de get baseline + their row.

- [ ] **Step 1: Write the failing test**

Create `server/src/analyzer/descriptor-grammar.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isDescriptorName, descriptorGrammarFor } from './descriptor-grammar.js';

describe('isDescriptorName — English baseline (byte-identical, universal)', () => {
  it('folds the Unknown contract in any language', () => {
    expect(isDescriptorName('Unknown Jogger')).toBe(true);
    expect(isDescriptorName('Unknown Jogger', 'ru')).toBe(true);
    expect(isDescriptorName('Unknown Hombre', 'es')).toBe(true);
  });
  it('folds "The <1-2 words>" and trailing English role nouns (all langs)', () => {
    expect(isDescriptorName('The Jogger')).toBe(true);
    expect(isDescriptorName('The Council of Twelve')).toBe(false); // >2 words
    expect(isDescriptorName('Drooly Boy')).toBe(true);
    expect(isDescriptorName('The Jogger', 'de')).toBe(true); // English slip on a de book
  });
  it('does not fold a real proper name', () => {
    expect(isDescriptorName('Wren Sparrow')).toBe(false);
    expect(isDescriptorName('Theodore')).toBe(false);
  });
});

describe('isDescriptorName — ru extras (byte-identical to historical ru)', () => {
  it('folds a lone Russian generic noun', () => {
    expect(isDescriptorName('девушка', 'ru')).toBe(true);
    expect(isDescriptorName('оператор', 'ru')).toBe(true);
  });
  it('folds a Russian phrase carrying a function word', () => {
    expect(isDescriptorName('женщина с двумя овчарками', 'ru')).toBe(true);
  });
  it('does NOT fold a real Russian name or a 2-word noun phrase', () => {
    expect(isDescriptorName('Одуван', 'ru')).toBe(false);
    expect(isDescriptorName('Молодой парень', 'ru')).toBe(false); // bare rule needs 1 token
  });
});

describe('isDescriptorName — es/fr/de (new)', () => {
  it('folds article-led descriptors', () => {
    expect(isDescriptorName('El Hombre', 'es')).toBe(true);
    expect(isDescriptorName('Una Voz', 'es')).toBe(true);
    expect(isDescriptorName('Le Garçon', 'fr')).toBe(true);
    expect(isDescriptorName("L'Homme", 'fr')).toBe(true); // elision, single token
    expect(isDescriptorName('Der Mann', 'de')).toBe(true);
  });
  it('folds bare generic nouns', () => {
    expect(isDescriptorName('Desconocido', 'es')).toBe(true);
    expect(isDescriptorName('Mann', 'de')).toBe(true);
  });
  it('does NOT fold real names carrying nobiliary/patronymic particles (finding B)', () => {
    expect(isDescriptorName('María de la Cruz', 'es')).toBe(false);
    expect(isDescriptorName('Charles de Gaulle', 'fr')).toBe(false);
    expect(isDescriptorName('Otto von Bismarck', 'de')).toBe(false);
  });
});

describe('descriptorGrammarFor', () => {
  it('returns null for en and unmapped (baseline-only)', () => {
    expect(descriptorGrammarFor('en')).toBeNull();
    expect(descriptorGrammarFor('pt')).toBeNull();
    expect(descriptorGrammarFor(undefined)).toBeNull();
  });
  it('returns a row for es/ru/fr/de', () => {
    expect(descriptorGrammarFor('es')).not.toBeNull();
    expect(descriptorGrammarFor('ru-RU')).not.toBeNull(); // subtag-normalised
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:server -- server/src/analyzer/descriptor-grammar.test.ts`
Expected: FAIL — `Cannot find module './descriptor-grammar.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/analyzer/descriptor-grammar.ts`:

```ts
/* Per-language "is this character name a throwaway descriptor?" data, sibling to
   tag-grammar.ts and consumed by foldMinorCast's isDescriptorName (#1050).

   The English rules (Unknown / "The <1-2 words>" / trailing role noun) are a
   UNIVERSAL baseline applied to every language — the model emits English
   descriptors even on non-English books (same rationale as the Unknown contract),
   and the historical isDescriptorName applied them unconditionally. Each non-English
   language adds EXTRAS via a grammar row; en + unmapped languages get the baseline
   alone (byte-identical to the historical behaviour).

   Function-word rule is RUSSIAN-ONLY: a proper Russian name never contains a
   preposition as a standalone token, but Romance/German names carry nobiliary
   particles (de Gaulle, von Bismarck), so es/fr/de leave functionWords empty
   (#938 lesson — never fold a real character). */

import { normaliseBookLanguage } from '../tts/language.js';

export interface DescriptorGrammar {
  /** Leading article tokens for the article-led rule (lowercased). Empty = off. */
  articles: ReadonlySet<string>;
  /** Generic role nouns (lowercased). */
  genericNouns: ReadonlySet<string>;
  /** bare = lone token; trailing = last token of a >=2-word name; both = either. */
  nounMatch: 'bare' | 'trailing' | 'both';
  /** Standalone prep/conj tokens marking a multi-word name as a description
      (lowercased). RU-ONLY; empty for es/fr/de. Empty = rule off. */
  functionWords: ReadonlySet<string>;
}

/* Universal English baseline (applied for EVERY language). Moved verbatim from
   fold-minor-cast.ts so the historical behaviour is byte-identical. */
const ENGLISH_GENERIC_TAIL: ReadonlySet<string> = new Set([
  'boy', 'girl', 'man', 'woman', 'guy', 'lady', 'kid', 'person', 'figure',
  'stranger', 'voice',
]);

const RU: DescriptorGrammar = {
  articles: new Set(),
  genericNouns: new Set([
    'девушка', 'парень', 'юноша', 'мужчина', 'женщина', 'незнакомец',
    'незнакомка', 'человек', 'голос', 'старик', 'старуха', 'парнишка',
    'оператор', 'водитель',
  ]),
  nounMatch: 'bare',
  functionWords: new Set([
    'с', 'со', 'в', 'во', 'на', 'по', 'под', 'из', 'у', 'за', 'к', 'ко',
    'о', 'об', 'обо', 'при', 'про', 'для', 'без', 'до', 'от', 'над',
    'и', 'или', 'а', 'но',
  ]),
};

const ES: DescriptorGrammar = {
  articles: new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas']),
  genericNouns: new Set([
    'hombre', 'mujer', 'chico', 'chica', 'desconocido', 'desconocida',
    'anciano', 'anciana', 'niño', 'niña', 'señor', 'señora', 'voz', 'conductor',
  ]),
  nounMatch: 'both',
  functionWords: new Set(), // ru-only rule (finding B)
};

const FR: DescriptorGrammar = {
  articles: new Set(['le', 'la', "l'", 'les', 'un', 'une', 'des']),
  genericNouns: new Set([
    'homme', 'femme', 'garçon', 'fille', 'inconnu', 'inconnue', 'vieil',
    'vieille', 'voix', 'conducteur', 'enfant',
  ]),
  nounMatch: 'both',
  functionWords: new Set(),
};

const DE: DescriptorGrammar = {
  articles: new Set(['der', 'die', 'das', 'ein', 'eine']), // nominative only (R2-7)
  genericNouns: new Set([
    'mann', 'frau', 'junge', 'mädchen', 'fremder', 'fremde', 'stimme',
    'fahrer', 'alte', 'alter', 'kind',
  ]),
  nounMatch: 'both',
  functionWords: new Set(),
};

/* Extras only — en is the universal baseline (null), unmapped stays gated (null). */
const GRAMMARS: Record<string, DescriptorGrammar> = { ru: RU, es: ES, fr: FR, de: DE };

export function descriptorGrammarFor(language?: string): DescriptorGrammar | null {
  return GRAMMARS[normaliseBookLanguage(language)] ?? null;
}

/* Decides whether a character name reads as a descriptor rather than a proper
   name. English baseline first (universal), then language-specific extras. */
export function isDescriptorName(name: string, language?: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;

  // (1) Stage-1 contract — language-independent.
  if (/^unknown\b/i.test(trimmed)) return true;
  // (2) English baseline — every language.
  if (/^the\s+\S+(\s+\S+)?$/i.test(trimmed)) return true;
  const parts = trimmed.split(/\s+/);
  const lower = parts.map((p) => p.toLowerCase());
  if (parts.length >= 2 && ENGLISH_GENERIC_TAIL.has(lower[lower.length - 1])) return true;

  // (3) Language-specific extras (en + unmapped → baseline only).
  const g = descriptorGrammarFor(language);
  if (!g) return false;

  // article-led: <article> + 1–2 words.
  if (g.articles.size) {
    if ((parts.length === 2 || parts.length === 3) && g.articles.has(lower[0])) return true;
    // FR elision: "L'Homme" tokenises as ONE part "l'homme".
    if (parts.length <= 2) {
      for (const art of g.articles) {
        if (art.endsWith("'") && lower[0].startsWith(art) && lower[0].length > art.length) {
          return true;
        }
      }
    }
  }
  // generic noun.
  if ((g.nounMatch === 'bare' || g.nounMatch === 'both') &&
      parts.length === 1 && g.genericNouns.has(lower[0])) {
    return true;
  }
  if ((g.nounMatch === 'trailing' || g.nounMatch === 'both') &&
      parts.length >= 2 && g.genericNouns.has(lower[lower.length - 1])) {
    return true;
  }
  // function-word phrase (ru-only; empty set → never fires for es/fr/de).
  if (g.functionWords.size && parts.length >= 2) {
    const hit = lower.some((p) => g.functionWords.has(p.replace(/^[—–-]+|[—–-]+$/g, '')));
    if (hit) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:server -- server/src/analyzer/descriptor-grammar.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/descriptor-grammar.ts server/src/analyzer/descriptor-grammar.test.ts
git commit -m "feat(server): descriptor-grammar module for es/ru/fr/de minor-cast fold (#1050)"
```

---

## Task 2: Wire `fold-minor-cast.ts` to the new grammar (Unit A integration, #1050)

**Files:**
- Modify: `server/src/analyzer/fold-minor-cast.ts` (remove inline `GENERIC_ROLE_TAIL`, `GENERIC_ROLE_RU`, `RU_FUNCTION_WORDS`, and the inline `isDescriptorName` body; import + re-export from `descriptor-grammar.js`).
- Test: `server/src/analyzer/fold-minor-cast.test.ts` (existing — must stay green unedited).

**Interfaces:**
- Consumes: `isDescriptorName` from `./descriptor-grammar.js`.
- Produces: `fold-minor-cast.ts` continues to export `isDescriptorName` (re-export) so existing importers (`fold-minor-cast.test.ts`) are unaffected.

- [ ] **Step 1: Confirm the baseline is green before touching it**

Run: `npm run test:server -- server/src/analyzer/fold-minor-cast.test.ts`
Expected: PASS (this is the byte-identity baseline you must preserve).

- [ ] **Step 2: Replace the inline matcher with an import + re-export**

In `server/src/analyzer/fold-minor-cast.ts`:

1. **Delete** the inline constants `GENERIC_ROLE_TAIL`, `GENERIC_ROLE_RU`, `RU_FUNCTION_WORDS` and the **entire** `export function isDescriptorName(name, language) { … }` body (the block that currently lives around lines 144–256).

2. Add this single import + re-export near the top (P-5 — import the local binding once, then re-export *that binding*; this is the clean form that avoids the TS2484 "export declaration conflicts" you'd hit from combining `import { X }` with `export { X } from './m'`):

```ts
/* isDescriptorName moved to descriptor-grammar.ts (#1050). Import for the fold's
   internal use at the `isDescriptorName(c.name, language)` call site, and re-export
   the same binding for back-compat with existing importers (fold-minor-cast.test.ts). */
import { isDescriptorName } from './descriptor-grammar.js';
export { isDescriptorName };
```

Leave the internal call site `const isDescriptor = isDescriptorName(c.name, language);` unchanged.

- [ ] **Step 3: Run the full fold + descriptor suites to verify byte-identity**

Run: `npm run test:server -- server/src/analyzer/fold-minor-cast.test.ts server/src/analyzer/descriptor-grammar.test.ts`
Expected: PASS, with **no edits** to `fold-minor-cast.test.ts`. If any ru/en case regresses, the constant migration diverged — diff the moved sets against the originals.

- [ ] **Step 4: Typecheck (the deletion may orphan imports)**

Run: `npm run typecheck`
Expected: clean. **R-3: keep the `normaliseBookLanguage` import — it is still used by `bucketName` (`fold-minor-cast.ts:121`); only the descriptor constants and the inline matcher leave.** Do not remove it just because `isDescriptorName` no longer references it.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/fold-minor-cast.ts
git commit -m "refactor(server): fold-minor-cast consumes descriptor-grammar; drop inline constants (#1050)"
```

---

## Task 3: `tag-grammar.ts` — per-order regex ARRAY model (Unit B foundation, behavior-preserving)

This is a **pure refactor**: convert `order` → `orders[]` and the single regex builders → array builders, update consumers, but keep every language's **current single order** so behavior (and all existing tests) are unchanged. Finding A (no alternation) + R2-2 (remove `tagRegexFor`).

**Files:**
- Modify: `server/src/analyzer/tag-grammar.ts`
- Modify: `server/src/analyzer/recover-tagged-lines.ts` (3 consumer sites)
- Test: `server/src/analyzer/tag-grammar.test.ts`, `server/src/analyzer/recover-tagged-lines.test.ts` (existing — stay green)

**Interfaces:**
- Produces:
  - `TagGrammar.orders: readonly ('name-verb' | 'verb-name')[]` (replaces `order`)
  - `tagRegexesFor(g: TagGrammar): RegExp[]` (one regex per order; name = capture group 1 in each; NO `g` flag — per-sentence use)
  - `tagScanRegexesFor(g: TagGrammar): RegExp[]` (same, but each is fresh + global + multiline; body-scan ONLY)
  - `verbBeatRegexFor(g: TagGrammar): RegExp` (now OR of every order's verb-beat; Unicode-safe)
  - **REMOVED:** `tagRegexFor` (R2-2 — no singular form; callers must use the array)

- [ ] **Step 1: Confirm existing tag-grammar + recover suites are green**

Run: `npm run test:server -- server/src/analyzer/tag-grammar.test.ts server/src/analyzer/recover-tagged-lines.test.ts`
Expected: PASS (the behavior you must preserve in this task).

- [ ] **Step 2: Convert the interface + rows to `orders[]` (single order each, unchanged)**

In `server/src/analyzer/tag-grammar.ts`, change the interface field and every row. Replace `order: 'name-verb' | 'verb-name'` with:

```ts
  /** Word orders the language uses, in priority. Each yields its own regex
      (NEVER a single alternation — finding A: that would move the name out of
      capture group 1). en is name-verb only; es/ru/fr/de gain a second order
      in a later task. */
  orders: readonly ('name-verb' | 'verb-name')[];
```

Update the rows (keep the SAME single order each for now):

```ts
const TAG_GRAMMARS: Record<string, TagGrammar> = {
  en: { verbs: DIALOGUE_VERBS, orders: ['name-verb'], nameCapture: EN_NAME, flipStrategy: 'preceding' },
  es: { verbs: ES_VERBS, orders: ['verb-name'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: ES_STOPWORDS },
  ru: { verbs: RU_VERBS, orders: ['verb-name'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: RU_STOPWORDS },
};
```

- [ ] **Step 3: Replace the regex builders with array forms (a single-order helper does the per-order work)**

In `tag-grammar.ts`, replace `tagRegexFor` and `verbBeatRegexFor` with:

```ts
/* Build ONE regex for a single order. Name is capture group 1. No flags. */
function buildOrderRegex(g: TagGrammar, order: 'name-verb' | 'verb-name'): RegExp {
  const verbs = g.verbs.join('|');
  if (order === 'name-verb') {
    if (g.nameCapture === EN_NAME) {
      // English: byte-identical to the historical makeTagRegex (ASCII \b, no u).
      return new RegExp(`\\b(${g.nameCapture})\\s+(?:${verbs})\\b`);
    }
    // Unicode languages: \b is ASCII-only and fails next to non-ASCII letters on
    // BOTH ends (e.g. trailing \b after Cyrillic "сказал") — use lookarounds (R2-8).
    return new RegExp(`(?<!\\p{L})(${g.nameCapture})\\s+(?:${verbs})(?!\\p{L})`, 'u');
  }
  // verb-name: beat + verb + up to two lowercase role tokens + the name.
  return new RegExp(
    `${VERB_BEAT}(?:${verbs})\\s+(?:\\p{Ll}[\\p{L}’'-]*\\s+){0,2}(${g.nameCapture})`,
    'u',
  );
}

/** One regex PER order (finding A: array, not alternation). Name = group 1 each.
    No `g` flag — for the per-sentence `.exec` model (recover-tagged-lines.ts). */
export function tagRegexesFor(g: TagGrammar): RegExp[] {
  return g.orders.map((order) => buildOrderRegex(g, order));
}

/** Body-scan variants: one FRESH regex PER order, each global (+ multiline so
    VERB_BEAT's ^ matches each line start). Body-scan ONLY — never use in the
    per-sentence model (its lastIndex would leak across sentences). */
export function tagScanRegexesFor(g: TagGrammar): RegExp[] {
  return g.orders.map((order) => {
    const re = buildOrderRegex(g, order);
    // Strip BOTH g and m before re-adding so a future builder that adds either
    // can't produce a duplicate-flag SyntaxError (P-3). Preserves u when present.
    return new RegExp(re.source, re.flags.replace(/[gm]/g, '') + 'gm');
  });
}

/** "This text carries a dialogue verb on a beat" — name NOT required; used to
    disqualify a flip neighbour that is itself a tag. OR of every order's beat;
    Unicode-safe (JS \b never fires on Cyrillic). */
export function verbBeatRegexFor(g: TagGrammar): RegExp {
  const verbs = g.verbs.join('|');
  const alts: string[] = [];
  for (const order of g.orders) {
    if (order === 'name-verb') {
      // ASCII for en (byte-identical), Unicode-safe lookarounds otherwise.
      alts.push(g.nameCapture === EN_NAME ? `\\b(?:${verbs})\\b` : `(?<!\\p{L})(?:${verbs})(?!\\p{L})`);
    } else {
      alts.push(`${VERB_BEAT}(?:${verbs})(?!\\p{L})`);
    }
  }
  // `u` is required by \p{…}; harmless for the en-only ASCII alternative.
  return new RegExp(alts.join('|'), 'u');
}
```

> Note: `new RegExp('\\b…', 'u')` is legal — the ASCII-`\b` alternative compiles fine under the `u` flag. The en path of `buildOrderRegex` deliberately stays **non-`u`** to remain byte-identical; only `verbBeatRegexFor` unifies under `u`, which does not change `\b`/verb matching for ASCII English verbs.

- [ ] **Step 4: Update the 3 consumer sites in `recover-tagged-lines.ts` to loop**

In `server/src/analyzer/recover-tagged-lines.ts`:

1. Change the import from `tagRegexFor` to `tagRegexesFor`:

```ts
import { grammarFor, tagRegexesFor, verbBeatRegexFor, isQuoteBearing } from './tag-grammar.js';
```

2. In `taggedSpeakerIds`, replace `const tagRe = tagRegexFor(g);` and the single `.exec` with a loop over the array:

```ts
  const tagRes = tagRegexesFor(g);
  const ids = new Set<string>();
  for (const s of sentences) {
    for (const tagRe of tagRes) {
      const m = tagRe.exec(s.text);
      if (!m) continue;
      const id = resolveNameToId(m[1], nameToId, stop);
      if (id) ids.add(id);
    }
  }
  return ids;
```

3. In `recoverTaggedNarratorLines`, both flip branches use `tagRe.exec(out[i].text)`. Replace the single `const tagRe = tagRegexFor(g);` with `const tagRes = tagRegexesFor(g);`, and in each branch try each regex until one matches:

```ts
  // helper local to recoverTaggedNarratorLines:
  const firstTagMatch = (text: string): RegExpExecArray | null => {
    for (const tagRe of tagRes) {
      const m = tagRe.exec(text);
      if (m) return m;
    }
    return null;
  };
```

Then replace `const m = tagRe.exec(out[i].text);` with `const m = firstTagMatch(out[i].text);` in **both** the `'preceding'` loop and the `'adjacent'` loop.

- [ ] **Step 5: Add a direct `tagScanRegexesFor` assertion (R-4)**

`tagScanRegexesFor` (and its P-3 flag manipulation) is otherwise only exercised
indirectly in Task 6 — pin it here, where it's written. Add to `tag-grammar.test.ts`
(merge `grammarFor`/`tagScanRegexesFor` into the file's existing import block — do
**not** add a duplicate `import` line, R-2):

```ts
import { grammarFor, tagScanRegexesFor } from './tag-grammar.js';

describe('tagScanRegexesFor — body-scan flags (R-4)', () => {
  it('returns global+multiline regexes that still capture the name in group 1', () => {
    const res = tagScanRegexesFor(grammarFor('en')!);
    expect(res.length).toBe(1);
    for (const re of res) {
      expect(re.global).toBe(true);
      expect(re.multiline).toBe(true);
    }
    const m = res[0].exec('Wren said hello.');
    expect(m?.[1]).toBe('Wren');
  });
});
```

- [ ] **Step 6: Run the suites — behavior must be unchanged**

Run: `npm run test:server -- server/src/analyzer/tag-grammar.test.ts server/src/analyzer/recover-tagged-lines.test.ts`
Expected: PASS, unedited. Allowed mechanical test edits only (same assertions): if `tag-grammar.test.ts` references `tagRegexFor` or `g.order`, update those call sites to `tagRegexesFor(g)[0]` / `g.orders[0]`. **P-4:** `verbBeatRegexFor` now always carries the `u` flag; if a test asserts its exact `.flags`/`.source`, update that assertion (matching behavior is unchanged for ASCII English verbs — and en uses the `'preceding'` flip, which never calls `verbBeatRegexFor`).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean (no remaining `tagRegexFor` / `g.order` references anywhere).

- [ ] **Step 8: Commit**

```bash
git add server/src/analyzer/tag-grammar.ts server/src/analyzer/recover-tagged-lines.ts server/src/analyzer/tag-grammar.test.ts
git commit -m "refactor(server): tag-grammar per-order regex array; remove tagRegexFor (#1051 prep)"
```

---

## Task 4: es/ru second word order + Unicode boundaries + stopword expansion (#1051)

Adds `name-verb` to es/ru (so `María dijo` / `Иван сказал` are detected), and expands their stopwords so sentence-openers don't manufacture junk candidates (finding J). Behavior change for es/ru (re-acceptance owed — see spec "Owed validation").

**Files:**
- Modify: `server/src/analyzer/tag-grammar.ts` (es/ru `orders`, expanded `ES_STOPWORDS`/`RU_STOPWORDS`)
- Test: `server/src/analyzer/tag-grammar.test.ts`

**Interfaces:**
- Consumes: `tagRegexesFor`, `grammarFor` (Task 3).
- Produces: es/ru rows now `orders: ['verb-name', 'name-verb']`.

- [ ] **Step 1: Write the failing test**

Add to `server/src/analyzer/tag-grammar.test.ts`:

```ts
import { grammarFor, tagRegexesFor } from './tag-grammar.js';

/** Helper: does ANY of the language's order-regexes capture `expectedName`? */
function capturesName(language: string, text: string): string | null {
  const g = grammarFor(language)!;
  for (const re of tagRegexesFor(g)) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

describe('both-orders detection (es/ru) — finding A array, R2-8 boundaries', () => {
  it('detects verb-name AND name-verb in Spanish', () => {
    expect(capturesName('es', '—Está bien —dijo Berrin.')).toBe('Berrin');
    expect(capturesName('es', 'María dijo algo en voz baja.')).toBe('María');
  });
  it('detects name-verb in Russian (trailing boundary after a Cyrillic verb)', () => {
    expect(capturesName('ru', 'Иван сказал, что согласен.')).toBe('Иван');
    expect(capturesName('ru', '«…», — сказал Одуван.')).toBe('Одуван');
  });
  it('es/ru rows expose two orders, NOT a single alternation regex', () => {
    expect(tagRegexesFor(grammarFor('es')!).length).toBe(2);
    expect(tagRegexesFor(grammarFor('ru')!).length).toBe(2);
  });
});

describe('stopword suppression for name-verb (finding J)', () => {
  it('does not capture a Spanish sentence-opener as a name', () => {
    // "Entonces dijo" — name-verb would capture "Entonces"; the stopword must veto it.
    // (the guard resolves only rostered/non-stopword candidates; here we assert the
    //  grammar stopword set contains the opener so roster-coverage can filter it.)
    expect(grammarFor('es')!.stopwords).toContain('entonces');
    expect(grammarFor('ru')!.stopwords).toContain('тогда');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:server -- server/src/analyzer/tag-grammar.test.ts -t "both-orders"`
Expected: FAIL — Russian name-verb returns `null` (only verb-name present), and `length` is 1.

- [ ] **Step 3: Add the second order and expand stopwords**

In `tag-grammar.ts`, change the es/ru rows to two orders:

```ts
  es: { verbs: ES_VERBS, orders: ['verb-name', 'name-verb'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: ES_STOPWORDS },
  ru: { verbs: RU_VERBS, orders: ['verb-name', 'name-verb'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: RU_STOPWORDS },
```

Expand the stopword constants (sentence-opener adverbs/pronouns that look like a name in name-verb order):

```ts
const ES_STOPWORDS = [
  'él', 'ella', 'ellos', 'ellas', 'este', 'esta', 'eso', 'que', 'quien', 'aquí', 'allí',
  // name-verb openers (finding J)
  'entonces', 'luego', 'después', 'así', 'pero', 'aunque', 'mientras', 'cuando',
  'también', 'además', 'sin', 'por', 'finalmente', 'de', 'pronto',
] as const;
const RU_STOPWORDS = [
  'он', 'она', 'оно', 'они', 'это', 'тот', 'та', 'кто', 'что', 'там', 'тут', 'так', 'вот',
  // name-verb openers (finding J)
  'тогда', 'потом', 'затем', 'однако', 'хотя', 'наконец', 'вдруг', 'теперь', 'здесь',
] as const;
```

- [ ] **Step 4: Run the new + existing tests**

Run: `npm run test:server -- server/src/analyzer/tag-grammar.test.ts`
Expected: PASS (both-orders + stopword cases green; existing es/ru verb-name cases still green).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/tag-grammar.ts server/src/analyzer/tag-grammar.test.ts
git commit -m "feat(server): es/ru both-orders tag detection + name-verb stopwords (#1051)"
```

---

## Task 5: fr/de grammar rows + German title-skip + `QUOTE_GLYPHS` U+201E (#1051)

Adds `fr` and `de` rows (both orders), German honorific titles (so `Frau Schmidt` → `Schmidt`), and the German low-opening quote to `QUOTE_GLYPHS`. Activating fr/de rows also turns on #1028's flip + keep-protection for those languages (intended).

**Files:**
- Modify: `server/src/analyzer/tag-grammar.ts`
- Test: `server/src/analyzer/tag-grammar.test.ts`

**Interfaces:**
- Produces: `TagGrammar.titles?: readonly string[]`; rows `fr`, `de`; `QUOTE_GLYPHS` includes `„` (U+201E).

- [ ] **Step 1: Write the failing test**

Add to `server/src/analyzer/tag-grammar.test.ts`:

```ts
import { grammarFor, tagRegexesFor, isQuoteBearing } from './tag-grammar.js';

describe('fr/de grammar rows (#1051)', () => {
  it('detects French inversion and name-verb', () => {
    expect(capturesName('fr', '— Bonjour, dit Marie.')).toBe('Marie');
    expect(capturesName('fr', 'Marie dit bonjour.')).toBe('Marie');
  });
  it('detects German inversion and name-verb', () => {
    expect(capturesName('de', '„Hallo“, sagte Anna.')).toBe('Anna');
    expect(capturesName('de', 'Anna sagte leise etwas.')).toBe('Anna');
  });
  it('skips a German capitalized title and captures the surname', () => {
    expect(capturesName('de', '„Guten Tag“, sagte Frau Schmidt.')).toBe('Schmidt');
    expect(capturesName('de', 'sagte Herr Berger')).toBe('Berger');
  });
  it('captures a lone German title-noun (no surname) for the fold to bucket', () => {
    expect(capturesName('de', 'sagte Frau')).toBe('Frau');
  });
  it('unmapped languages stay gated', () => {
    expect(grammarFor('pt')).toBeNull();
  });
});

describe('QUOTE_GLYPHS recognises German low-opening quote (R2-3)', () => {
  it('treats „… as quote-bearing', () => {
    expect(isQuoteBearing('„Hallo, wie geht es dir?')).toBe(true); // opening only
    expect(isQuoteBearing('«Hola»')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:server -- server/src/analyzer/tag-grammar.test.ts -t "fr/de"`
Expected: FAIL — `grammarFor('fr')`/`('de')` are `null` → `capturesName` throws / returns null.

- [ ] **Step 3: Add fr/de verbs, stopwords, titles, rows; widen `QUOTE_GLYPHS`**

> **Word-list notes (P-6, conscious choices, inclusion-biased):** `FR_VERBS` lists
> `s’exclama` with a **curly** apostrophe (U+2019) — a manuscript using a straight
> `s'exclama` won't match; add the straight form too if a fr fixture shows it.
> `DE_VERBS` includes `fuhr` (really "fuhr fort" = continued); as a bare verb it can
> over-match "fuhr" (drove), but the roster-resolution + fold backstop absorbs a
> stray candidate. Both are acceptable for v1; a missing verb silently drops a real
> speaker, an extra one is filtered downstream.

In `tag-grammar.ts` add the verb + stopword + title constants:

```ts
const FR_VERBS = [
  'dit', 'demanda', 'répondit', 'répliqua', 'ajouta', 'cria', 'murmura',
  'chuchota', 's’exclama', 'reprit', 'répéta', 'insista', 'continua', 'soupira',
  'lança', 'ordonna',
] as const;
const DE_VERBS = [
  'sagte', 'fragte', 'antwortete', 'erwiderte', 'rief', 'flüsterte', 'murmelte',
  'entgegnete', 'fuhr', 'meinte', 'erklärte', 'wiederholte', 'fügte', 'seufzte',
  'brüllte', 'stammelte',
] as const;
const FR_STOPWORDS = [
  'il', 'elle', 'ils', 'elles', 'je', 'tu', 'nous', 'vous', 'ce', 'cela', 'qui', 'que',
  'alors', 'puis', 'ensuite', 'mais', 'donc', 'quand', 'enfin', 'ici', 'là',
] as const;
const DE_STOPWORDS = [
  'er', 'sie', 'es', 'ich', 'du', 'wir', 'ihr', 'das', 'dies', 'wer', 'was',
  'dann', 'da', 'als', 'doch', 'aber', 'also', 'hier', 'dort', 'schließlich', 'plötzlich',
] as const;
/* German honorifics: capitalized, so the lowercase role-token skip in the verb-name
   regex won't skip them — list them explicitly to capture the following surname. */
const DE_TITLES = [
  'Herr', 'Frau', 'Fräulein', 'Dr', 'Doktor', 'Professor', 'Prof', 'Graf',
  'Gräfin', 'Baron', 'Baronin', 'König', 'Königin', 'Prinz', 'Prinzessin',
  'Meister', 'Hauptmann',
] as const;
```

Add the optional `titles` field to the `TagGrammar` interface:

```ts
  /** Capitalized honorifics to skip before the name in verb-name order (de). */
  titles?: readonly string[];
```

Add the rows:

```ts
  fr: { verbs: FR_VERBS, orders: ['verb-name', 'name-verb'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: FR_STOPWORDS },
  de: { verbs: DE_VERBS, orders: ['verb-name', 'name-verb'], nameCapture: UNI_NAME, flipStrategy: 'adjacent', stopwords: DE_STOPWORDS, titles: DE_TITLES },
```

Widen `QUOTE_GLYPHS` to include the German low-opening quote `„` (U+201E):

```ts
const QUOTE_GLYPHS = /[«»„“”"]|^\s*[—–]/u;
```

- [ ] **Step 4: Add the title-skip to the verb-name builder**

In `buildOrderRegex`'s verb-name branch, insert an optional title-skip when the grammar carries `titles`:

```ts
  // verb-name: beat + verb + up to two lowercase role tokens + optional
  // capitalized title (de) + the name.
  const titleSkip = g.titles?.length
    ? `(?:(?:${g.titles.join('|')})\\.?\\s+)?`
    : '';
  return new RegExp(
    `${VERB_BEAT}(?:${verbs})\\s+(?:\\p{Ll}[\\p{L}’'-]*\\s+){0,2}${titleSkip}(${g.nameCapture})`,
    'u',
  );
```

(Regex backtracking makes the optional group correct: `sagte Frau Schmidt` → eats `Frau `, captures `Schmidt`; lone `sagte Frau` → backtracks, captures `Frau`.)

- [ ] **Step 5: Run the tests**

Run: `npm run test:server -- server/src/analyzer/tag-grammar.test.ts`
Expected: PASS (fr/de detection, German title-skip, lone-title, `isQuoteBearing` German open, plus all earlier cases).

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/tag-grammar.ts server/src/analyzer/tag-grammar.test.ts
git commit -m "feat(server): fr/de tag-grammar rows + German title-skip + U+201E quote (#1051)"
```

---

## Task 6: Roster-coverage guard — un-gate + grammar-driven array scan (#1051 core)

Replaces the `isNonEnglish` gate with the grammar null-guard, builds the body scan from `tagScanRegexesFor` with per-position dedupe (R2-1), widens `QUOTE_CHARS` (R2-3), unions stopwords, removes the orphaned import (E), inverts the de gate tests (F), and adds the ADD-path tests (the trap #1028 fell into).

**Files:**
- Modify: `server/src/analyzer/roster-coverage.ts` (both `validateRosterCoverage` and `validateAttributionCoverage`)
- Test: `server/src/analyzer/roster-coverage.test.ts`

**Interfaces:**
- Consumes: `grammarFor`, `tagScanRegexesFor` from `./tag-grammar.js`.
- Produces: no signature changes — `validateRosterCoverage(bodyText, rosterNames, thresholds?, language?)` and `validateAttributionCoverage(...)` keep their shapes; behavior un-gates for es/ru/fr/de.

- [ ] **Step 1: Write the failing ADD-path test + invert the de gate test**

In `server/src/analyzer/roster-coverage.test.ts`:

1. **Replace** the `describe('roster guard — non-English gate (seam 3d)', …)` block (the one asserting `de` no-ops at ~`:280–304`) with detection assertions:

```ts
describe('roster guard — localized detection (es/ru/fr/de) #1051', () => {
  it('flags a Spanish prose-tagged speaker missing from the roster (Berrin)', () => {
    const body = '—Está bien —dijo Berrin, mirando la campana.';
    const res = validateRosterCoverage(body, new Set<string>(['Mara']), DEFAULT_ROSTER_COVERAGE_THRESHOLDS, 'es');
    expect(res.ok).toBe(false);
    expect(res.missingSpeakers.map((s) => s.name)).toContain('Berrin');
  });
  it('flags a Russian prose-tagged speaker missing from the roster (Одуван)', () => {
    const body = '«Одну минуту», — сказал Одуван и улыбнулся.';
    const res = validateRosterCoverage(body, new Set<string>(['Мара']), DEFAULT_ROSTER_COVERAGE_THRESHOLDS, 'ru');
    expect(res.ok).toBe(false);
    expect(res.missingSpeakers.map((s) => s.name)).toContain('Одуван');
  });
  it('recovers the German SURNAME, not the title (Frau Schmidt → Schmidt)', () => {
    const body = '„Guten Tag“, sagte Frau Schmidt zu ihrem Nachbarn.';
    const res = validateRosterCoverage(body, new Set<string>(['Mara']), DEFAULT_ROSTER_COVERAGE_THRESHOLDS, 'de');
    expect(res.missingSpeakers.map((s) => s.name)).toContain('Schmidt');
    expect(res.missingSpeakers.map((s) => s.name)).not.toContain('Frau');
  });
  it('does NOT flag a Spanish sentence-opener (stopword, finding J)', () => {
    const body = 'Entonces dijo que la noche sería larga. Entonces dijo otra cosa.';
    const res = validateRosterCoverage(body, new Set<string>(['Mara']), DEFAULT_ROSTER_COVERAGE_THRESHOLDS, 'es');
    expect(res.missingSpeakers.map((s) => s.name)).not.toContain('Entonces');
  });
  it('still gates an unmapped language (pt → no-op)', () => {
    const body = 'qualquer coisa';
    const res = validateRosterCoverage(body, new Set<string>(), DEFAULT_ROSTER_COVERAGE_THRESHOLDS, 'pt');
    expect(res.ok).toBe(true);
    expect(res.missingSpeakers).toEqual([]);
  });
});
```

2. **Also add a localized `validateAttributionCoverage` test (R-1)** — the old seam-3d block had a `de` gate test for this function too; un-gating it must be paired with a localized half-state test (a rostered, prose-tagged speaker with 0 attributed lines in the chapter), not silently dropped:

```ts
describe('validateAttributionCoverage — localized half-state (es/ru) #1051', () => {
  it('flags a rostered Spanish speaker prose-tagged but with 0 attributed lines', () => {
    const body = '—Está bien —dijo Berrin, mirando la campana.';
    const roster = [{ id: 'berrin', name: 'Berrin' }];
    const chapterSentences = [{ characterId: 'narrator' }]; // Berrin's quote stranded on narrator
    const res = validateAttributionCoverage(body, roster, chapterSentences, DEFAULT_ROSTER_COVERAGE_THRESHOLDS, 'es');
    expect(res.ok).toBe(false);
    expect(res.halfStateSpeakers.map((s) => s.id)).toContain('berrin');
  });
  it('does not flag a rostered Spanish speaker who already has lines', () => {
    const body = '—Está bien —dijo Berrin.';
    const roster = [{ id: 'berrin', name: 'Berrin' }];
    const chapterSentences = [{ characterId: 'berrin' }]; // has a line → not a half-state
    const res = validateAttributionCoverage(body, roster, chapterSentences, DEFAULT_ROSTER_COVERAGE_THRESHOLDS, 'es');
    expect(res.halfStateSpeakers.map((s) => s.id)).not.toContain('berrin');
  });
  it('still gates an unmapped language (pt → no-op)', () => {
    const res = validateAttributionCoverage('qualquer', [{ id: 'x', name: 'X' }], [], DEFAULT_ROSTER_COVERAGE_THRESHOLDS, 'pt');
    expect(res.ok).toBe(true);
  });
});
```

(`validateAttributionCoverage` is already imported at the top of the file from the original seam-3d test — reuse that import, R-2.)

3. Confirm the English describe blocks above remain **untouched**.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:server -- server/src/analyzer/roster-coverage.test.ts -t "localized"`
Expected: FAIL (both new blocks) — es/ru/fr currently no-op (`isNonEnglish` gate), so `ok` is `true` and `missingSpeakers`/`halfStateSpeakers` empty.

- [ ] **Step 3: Swap the gate + build the grammar-driven array scan with dedupe**

In `server/src/analyzer/roster-coverage.ts`:

1. Imports: drop `isNonEnglish`, add the grammar + `normaliseBookLanguage` (needed
   to keep English on the narrow quote set — P-1):

```ts
import { grammarFor, tagScanRegexesFor } from './tag-grammar.js';
import { normaliseBookLanguage } from '../tts/language.js';
```

2. In `validateRosterCoverage`, replace the `if (isNonEnglish(language)) return {…}` early-return and the hardcoded `tagRe` construction:

```ts
export function validateRosterCoverage(
  bodyText: string,
  rosterNames: Iterable<string>,
  thresholds?: RosterCoverageThresholds,
  language: string = 'en',
): RosterCoverageVerdict {
  const g = grammarFor(language);
  if (!g) return { ok: true, missingSpeakers: [], issues: [] }; // unmapped → gated
  const t = resolveThresholds(thresholds);
  const roster = rosterTokenSet(rosterNames);
  const ignore = ignoredNames();
  const langStops = langStopwords(g); // language sentence-opener stopwords (es/ru/fr/de)
  const tagRes = tagScanRegexesFor(g);
  // P-1: English keeps the historical NARROW quote set (byte-identity); es/ru/fr/de
  // use the wide set their dialogue marks require.
  const quoteChars = normaliseBookLanguage(language) === 'en' ? QUOTE_CHARS : QUOTE_CHARS_WIDE;

  const body = bodyText || '';
  interface Acc { name: string; tagCount: number; sampleTag: string; quoteAdjacent: boolean }
  const candidates = new Map<string, Acc>();
  const seenSpans = new Set<number>(); // R2-1: count each source span once

  for (const tagRe of tagRes) {
    for (let m = tagRe.exec(body); m; m = tagRe.exec(body)) {
      const nameIdx = m.index + m[0].indexOf(m[1]);
      if (seenSpans.has(nameIdx)) continue; // matched by another order already
      seenSpans.add(nameIdx);
      const rawName = stripPossessive(m[1]);
      const key = rawName.toLowerCase();
      if (key.includes('-as-')) continue;
      const root = key.split(/['’]/)[0];
      // English de-pluralization via isStopword (byte-identical); language
      // sentence-openers via langStops (finding J). en → langStops empty.
      if (isStopword(key) || isStopword(root) || langStops.has(key) || ignore.has(key)) continue;
      if (roster.has(key)) continue;
      const start = Math.max(0, m.index - t.quoteProximityChars);
      const end = Math.min(body.length, m.index + m[0].length + t.quoteProximityChars);
      const adjacent = quoteChars.test(body.slice(start, end));
      const prev = candidates.get(key);
      if (prev) {
        prev.tagCount += 1;
        prev.quoteAdjacent = prev.quoteAdjacent || adjacent;
      } else {
        candidates.set(key, { name: rawName, tagCount: 1, sampleTag: m[0].trim(), quoteAdjacent: adjacent });
      }
    }
  }
  // …unchanged from here: build missingSpeakers from candidates with the
  // tagCount/quote-adjacency bound, sort, map to issues, return.
```

> Byte-identity note: the existing English `isStopword(key)` predicate (with its `-s`/`-es` de-pluralization) is **kept and still checked first** — that's what preserves the English path exactly. `langStops` only *adds* the language sentence-openers. For English, `g.stopwords` is undefined → `langStops` is empty → behavior is identical to today.

3. Add the language-stopword helper near `isStopword` (do NOT remove or fold `isStopword` — it carries English de-pluralization the new languages don't need):

```ts
/** A grammar's language sentence-opener stopwords as a Set (es/ru/fr/de). Empty
    for en (no g.stopwords) so the English path stays byte-identical — the loop
    still applies the existing isStopword() de-pluralization predicate first. */
function langStopwords(g: { stopwords?: readonly string[] }): Set<string> {
  return new Set<string>(g.stopwords ?? []);
}
```

4. Make the **same** edits to `validateAttributionCoverage` — shown explicitly (P-2)
   because its candidate map is keyed by **character id** (resolved via `tokenToId`),
   not name. Replace its `isNonEnglish` gate + `tagRe` build + `m[1]` loop with:

```ts
export function validateAttributionCoverage(
  bodyText: string,
  roster: Iterable<{ id: string; name: string; aliases?: string[] }>,
  chapterSentences: Iterable<{ characterId: string }>,
  thresholds?: RosterCoverageThresholds,
  language: string = 'en',
): AttributionCoverageVerdict {
  const g = grammarFor(language);
  if (!g) return { ok: true, halfStateSpeakers: [], issues: [] }; // unmapped → gated
  const t = resolveThresholds(thresholds);
  const tokenToId = rosterTokenToId(roster);
  const ignore = ignoredNames();
  const langStops = langStopwords(g);
  const tagRes = tagScanRegexesFor(g);
  const quoteChars = normaliseBookLanguage(language) === 'en' ? QUOTE_CHARS : QUOTE_CHARS_WIDE;
  const body = bodyText || '';

  // Attributed-line counts per character id for THIS chapter (unchanged).
  const linesById = new Map<string, number>();
  for (const s of chapterSentences) {
    linesById.set(s.characterId, (linesById.get(s.characterId) ?? 0) + 1);
  }
  const narratorLines = linesById.get('narrator') ?? 0;

  interface Acc { id: string; name: string; tagCount: number; sampleTag: string; quoteAdjacent: boolean }
  const candidates = new Map<string, Acc>(); // keyed by character id
  const seenSpans = new Set<number>(); // R2-1

  for (const tagRe of tagRes) {
    for (let m = tagRe.exec(body); m; m = tagRe.exec(body)) {
      const nameIdx = m.index + m[0].indexOf(m[1]);
      if (seenSpans.has(nameIdx)) continue;
      seenSpans.add(nameIdx);
      const rawName = stripPossessive(m[1]);
      const key = rawName.toLowerCase();
      if (key.includes('-as-')) continue;
      const root = key.split(/['’]/)[0];
      if (isStopword(key) || isStopword(root) || langStops.has(key) || ignore.has(key)) continue;
      const id = tokenToId.get(key);
      if (!id) continue; // not rostered — that's validateRosterCoverage's job
      if (id === 'narrator' || id.startsWith('unknown-')) continue; // buckets never flag
      const start = Math.max(0, m.index - t.quoteProximityChars);
      const end = Math.min(body.length, m.index + m[0].length + t.quoteProximityChars);
      const adjacent = quoteChars.test(body.slice(start, end));
      const prev = candidates.get(id);
      if (prev) {
        prev.tagCount += 1;
        prev.quoteAdjacent = prev.quoteAdjacent || adjacent;
      } else {
        candidates.set(id, { id, name: rawName, tagCount: 1, sampleTag: m[0].trim(), quoteAdjacent: adjacent });
      }
    }
  }
  // …unchanged from here: for each candidate, apply the tagCount/quote-adjacency
  // bound, skip if attributedLines > 0, push the half-state, sort, map issues, return.
```

- [ ] **Step 4: Add a WIDE quote-char set for non-English; keep `QUOTE_CHARS` narrow (R2-3 + P-1)**

Do **NOT** widen `QUOTE_CHARS` in place — `validateRosterCoverage` runs for `en`
too, and adding em-dash/guillemets to the English adjacency window changes which
English single-hit candidates get flagged (em-dashes are common in English prose),
breaking the byte-identity invariant. Instead keep the narrow set for English and
add a sibling wide set, selected by language (the `quoteChars` line in Step 3):

```ts
const QUOTE_CHARS = /["“”]/;              // en — UNCHANGED (byte-identity)
const QUOTE_CHARS_WIDE = /["“”„«»—–]/;    // es/ru/fr/de — guillemets + German „ + dashes
```

(The `quoteChars = normaliseBookLanguage(language) === 'en' ? QUOTE_CHARS : QUOTE_CHARS_WIDE`
selection in both `validateRosterCoverage` and `validateAttributionCoverage` does the rest.)

- [ ] **Step 5: Run the roster suite + typecheck**

Run: `npm run test:server -- server/src/analyzer/roster-coverage.test.ts`
Expected: PASS — localized-detection cases green, English cases unedited & green.

Run: `npm run typecheck`
Expected: clean (no `isNonEnglish` import left in `roster-coverage.ts`).

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/roster-coverage.ts server/src/analyzer/roster-coverage.test.ts
git commit -m "feat(server): localize roster-coverage guard for es/ru/fr/de (#1051)"
```

---

## Task 7: Activated #1028 paths — fr/de coverage + es/ru both-orders review

Because Task 5 turned on the flip + keep-protection for fr/de and Task 4 changed es/ru detection, add fr/de coverage and re-verify es/ru in the `recover-tagged-lines` + fold keep-protection suites.

**Files:**
- Test: `server/src/analyzer/recover-tagged-lines.test.ts`, `server/src/analyzer/fold-minor-cast.test.ts`

**Interfaces:** consumes the shipped grammar; no production code changes expected (tests only — unless a real defect surfaces, which then gets fixed under finding-driven TDD).

- [ ] **Step 1: Add fr/de flip + keep-protection tests**

Add to `server/src/analyzer/recover-tagged-lines.test.ts` a describe block exercising both languages, e.g. German inversion flipping a narrator-stranded quote onto the rostered speaker:

```ts
describe('recoverTaggedNarratorLines — fr/de (activated by #1051 rows)', () => {
  it('flips a German narrator quote onto the inversion-tagged speaker', () => {
    const roster = [{ id: 'anna', name: 'Anna' }];
    const sentences = [
      { id: 1, chapterId: 1, characterId: 'narrator', text: '„Ich komme mit.“' },
      { id: 2, chapterId: 1, characterId: 'narrator', text: 'sagte Anna entschlossen.' },
    ];
    const { sentences: out, flipped } = recoverTaggedNarratorLines(sentences, roster, 'de');
    expect(flipped).toBe(1);
    expect(out[0].characterId).toBe('anna');
  });
  it('keeps a 0-line French tagged speaker via taggedSpeakerIds', () => {
    const roster = [{ id: 'marie', name: 'Marie' }];
    const ids = taggedSpeakerIds(
      [{ id: 1, chapterId: 1, characterId: 'narrator', text: '— Bonjour, dit Marie.' }],
      roster,
      'fr',
    );
    expect(ids.has('marie')).toBe(true);
  });
});
```

- [ ] **Step 2: Re-verify es/ru — adjust any assertion the both-orders change shifted**

Run: `npm run test:server -- server/src/analyzer/recover-tagged-lines.test.ts`
Expected: PASS. If an existing es/ru assertion shifted because name-verb detection now fires (a legitimately-changed expectation, not a regression), update it to the new expected attribution and add a one-line comment citing the both-orders change. Do **not** weaken a real invariant; if a flip now misfires, treat it as a bug and fix the grammar/flip.

- [ ] **Step 3: Add an es/fr/de fold keep-protection case**

Add to `server/src/analyzer/fold-minor-cast.test.ts` a case proving a prose-tagged es/fr/de speaker with 0 lines is kept (not dropped), mirroring the existing ru/en keep-protection test:

```ts
it('keeps a prose-tagged Spanish 0-line speaker (es keep-protection)', () => {
  const characters = [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', gender: 'neutral', description: '', aliases: [] },
    { id: 'berrin', name: 'Berrin', role: 'minor', color: 'narrator', gender: 'male', description: '', aliases: [] },
  ];
  const sentences = [
    { id: 1, chapterId: 1, characterId: 'narrator', text: '—Está bien —dijo Berrin.' },
  ];
  const result = foldMinorCast(characters as any, sentences as any, { language: 'es' });
  expect(result.characters.map((c) => c.id)).toContain('berrin');
});
```

- [ ] **Step 4: Run both suites**

Run: `npm run test:server -- server/src/analyzer/recover-tagged-lines.test.ts server/src/analyzer/fold-minor-cast.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/recover-tagged-lines.test.ts server/src/analyzer/fold-minor-cast.test.ts
git commit -m "test(server): fr/de flip+keep coverage; es/ru both-orders review (#1051)"
```

---

## Task 8: Verify call-site language threading (#1050 + #1051)

Verify-only: confirm `language` reaches the roster guard and **both** `foldMinorCast` passes. Thread it into the interim pass if it isn't already (R2-4).

**Files:**
- Inspect/Modify (only if a gap is found): `server/src/routes/analysis.ts`
- Test: an integration assertion if a thread is added; otherwise none.

- [ ] **Step 1: Trace the roster-guard call sites**

Read `server/src/routes/analysis.ts` around the `runStage1Guarded` wrapper (~`:529`) and its callers (~`:2783`, ~`:4608`). Confirm each passes the resolved `bookLanguage` (via `resolveBookLanguageForManuscript`, ~`:2178`/`:4451`) through `opts.language` to `runStage1WithRosterGuard`. Document the line numbers in the commit message.

Run (sanity grep): `npm run test:server -- server/src/routes/analysis.test.ts`
Expected: existing route tests PASS.

- [ ] **Step 2: Trace both `foldMinorCast` call sites**

Find every `foldMinorCast(` call in `server/src/routes/analysis.ts`. Confirm:
- the **final** (post-stage-2) pass passes `{ language: … }` (it already must, since #1028's keep-protection needs `taggedSpeakerIds(…, language)`),
- the **interim** (`nameOnly: true`) pass also passes `{ language: …, nameOnly: true }`.

If the interim pass omits `language`, add it (one-line change). This makes es/fr/de descriptors fold at the interim cast write, not only at the final pass.

- [ ] **Step 3: If a thread was added, pin it with a test; else record the trace**

If you modified a call site, add/extend a route test asserting an es manuscript's interim cast folds a descriptor (or buckets it). If no change was needed, no test — record the verified line numbers in the commit body instead.

- [ ] **Step 4: Full server suite + typecheck**

Run: `npm run test:server && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts
git commit -m "fix(server): thread bookLanguage to interim foldMinorCast pass (#1050)"
```

(If nothing changed, skip the commit and note the verification in the PR body instead.)

---

## Final verification (before opening the PR)

- [ ] **Run the whole server battery:** `npm run test:server && npm run test:server-slow`
- [ ] **Typecheck + lint + build:** `npm run typecheck && npm run lint && npm run build`
- [ ] **Full local gate (matches pre-push):** `npm run verify`
- [ ] Confirm **no English assertion was edited** in `fold-minor-cast.test.ts` / `roster-coverage.test.ts` (byte-identity invariant).
- [ ] Confirm `grep -rn "tagRegexFor\b\|isNonEnglish" server/src/analyzer/` returns nothing (R2-2 / E).

## Owed validation (post-merge, on-box — out of this plan's CI)

Per the spec's "Owed validation": **es re-acceptance** (both-orders changes the accepted render — re-run the Gemini e2e via `scratchpad/gateA.mjs`; pass = Berrin and Ivo are their own cast members and `«Está bien»` → `berrin`), **ru** equivalent when its background pass lands, **fr/de** smoke pass on the translated Coalfall fixtures. These belong in the PR's "owed gates" note, not as blockers on the unit-test landing.

## Suggested follow-ups (not in scope)

- **#1046** helper dedup between `roster-coverage.ts` and `recover-tagged-lines.ts` (`rosterTokenSet`/`buildNameToId`, the two `stripPossessive`s).
- A stemmer for inflected descriptor nouns / verbs (listed surface forms only today).
- Localizing `scripts/recover-missing-character.mjs` (manual hotfix, stays English).
