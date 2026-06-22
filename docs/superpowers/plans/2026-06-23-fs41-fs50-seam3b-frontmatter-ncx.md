# fs-41/fs-50 Seam 3b — Language-aware front-matter + EPUB NCX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make front-matter-title detection (`FRONT_MATTER_RX`) and the EPUB generic-NCX merge (`GENERIC_NCX_RE`) recognise non-English terms, and move the confirm-screen's front-matter pre-tick to a **server-computed per-chapter flag** — retiring the hand-mirrored client regex (a divergence risk flagged in review) — without changing English behaviour.

**Architecture:** Same union approach as seam 3a (language not known at parse time → union over all languages). The registry gains non-English front-matter keywords; `front-matter.ts` builds `FRONT_MATTER_RX` from English-inline + that union; `html-utils.ts` rebuilds `GENERIC_NCX_RE` from the seam-3a heading-lexicon union. The import response carries a per-chapter `isLikelyFrontMatter` boolean (server computes title-regex + word-threshold once); the confirm screen reads it and the client `chapter-heuristics.ts` front-matter logic is removed (`chapterSlug`/`slugify` stay).

**Tech Stack:** TypeScript (ESM, `.js` imports), Node 20+, Vitest (server + frontend).

## Global Constraints

- **English behaviour unchanged.** Existing `front-matter.test.ts`/`html-utils`/`text.test.ts` English assertions stay green (union only ADDS). No English test inverted.
- **Single source of truth for front-matter detection** ends up server-side; the client consumes a flag, it does not re-implement the regex. `chapterSlug`/`slugify` in `chapter-heuristics.ts` are unaffected.
- The non-English front-matter lexicon is added for es/fr/de/ru even though es/fr/de are `supported:false` (parsing/exclusion is independent of synthesis gating).
- Regexes matching non-ASCII use the `iu` flags. ESM `.js` imports. Commit `<type>(<scope>): <subject>`. Husky pre-commit runs the in-scope test legs (green, no `--no-verify`). Work from the worktree `C:/Claude/Audiobook-Generator-wt-fs41`, branch `docs/docs-fs41-fs50-seam3b`.

---

### Task 1: Add non-English front-matter keywords to the registry

**Files:**
- Modify: `server/src/tts/language-registry.ts`
- Test: `server/src/tts/language-registry.test.ts`

**Interfaces:**
- Produces: `LanguageEntry` gains optional `frontMatterKeywords?: string[]`; `nonEnglishFrontMatterKeywords(): string[]` (deduped union over all entries).

- [ ] **Step 1: Write the failing test** — append to `server/src/tts/language-registry.test.ts`:

```typescript
import { nonEnglishFrontMatterKeywords } from './language-registry.js';

describe('nonEnglishFrontMatterKeywords', () => {
  it('unions non-English front-matter terms (deduped), no English', () => {
    const fm = nonEnglishFrontMatterKeywords();
    for (const w of ['dedicatoria', 'dédicace', 'widmung', 'посвящение']) expect(fm).toContain(w);
    expect(fm).not.toContain('dedication'); // English stays inline in front-matter.ts
    expect(new Set(fm).size).toBe(fm.length);
  });
  it('ru/es/fr/de carry frontMatterKeywords; en does not', () => {
    expect(getLanguageEntry('en')?.frontMatterKeywords).toBeUndefined();
    for (const c of ['ru', 'es', 'fr', 'de']) expect(getLanguageEntry(c)?.frontMatterKeywords).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/language-registry.test.ts`
Expected: FAIL — export + field missing.

- [ ] **Step 3: Implement** — add `frontMatterKeywords?: string[]` to the `LanguageEntry` interface, populate ru/es/fr/de, and add the accessor:

```typescript
  /** Non-English front/back-matter title terms (used to build the language-agnostic
      FRONT_MATTER_RX; English stays inline in parsers/front-matter.ts). Absent on en. */
  frontMatterKeywords?: string[];
```

Add to each non-English entry (keep `headingLexicon` etc. as-is):

```typescript
  // ru:
  frontMatterKeywords: ['посвящение', 'авторские права', 'благодарности', 'содержание', 'оглавление',
    'об авторе', 'предисловие', 'послесловие', 'приложение', 'глоссарий', 'библиография', 'указатель',
    'примечания', 'выходные данные', 'эпиграф'],
  // es:
  frontMatterKeywords: ['dedicatoria', 'derechos de autor', 'agradecimientos', 'índice', 'sobre el autor',
    'prefacio', 'apéndice', 'glosario', 'bibliografía', 'epígrafe', 'colofón', 'nota del autor',
    'nota del traductor'],
  // fr:
  frontMatterKeywords: ['dédicace', 'remerciements', 'table des matières', 'sommaire',
    'à propos de l’auteur', 'préface', 'avant-propos', 'postface', 'annexe', 'glossaire', 'bibliographie',
    'note de l’auteur', 'note du traducteur', 'colophon', 'épigraphe'],
  // de:
  frontMatterKeywords: ['widmung', 'urheberrecht', 'danksagung', 'inhaltsverzeichnis', 'über den autor',
    'vorwort', 'nachwort', 'anhang', 'glossar', 'bibliografie', 'register', 'anmerkungen', 'impressum',
    'epigraph'],
```

Add the accessor (mirror `nonEnglishHeadingLexicon`):

```typescript
/** Deduped union of every entry's non-English front-matter keywords. */
export function nonEnglishFrontMatterKeywords(): string[] {
  const out = new Set<string>();
  for (const e of ENTRIES) e.frontMatterKeywords?.forEach((w) => out.add(w));
  return [...out];
}
```

- [ ] **Step 4: Run to verify pass** — `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/tts/language-registry.test.ts` → PASS (all blocks).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/language-registry.ts server/src/tts/language-registry.test.ts
git commit -m "feat(server): add non-English front-matter keywords to the registry"
```

---

### Task 2: Union FRONT_MATTER_RX + rebuild GENERIC_NCX_RE from the language unions

**Files:**
- Modify: `server/src/parsers/front-matter.ts` (FRONT_MATTER_RX)
- Modify: `server/src/parsers/html-utils.ts` (GENERIC_NCX_RE)
- Test: `server/src/parsers/front-matter.test.ts` (create if absent), `server/src/parsers/html-utils.test.ts` (or wherever GENERIC_NCX_RE is tested; the epub merge test)

**Interfaces:**
- Consumes: `nonEnglishFrontMatterKeywords` (Task 1), `nonEnglishHeadingLexicon` (seam 3a).
- Produces: `isLikelyFrontMatterTitle` / `GENERIC_NCX_RE` now match non-English; signatures unchanged.

- [ ] **Step 1: Write failing tests** — add non-English cases (mirror the existing English ones):

```typescript
// front-matter.test.ts
import { isLikelyFrontMatterTitle } from './front-matter.js';
it('flags non-English front-matter titles', () => {
  for (const t of ['Derechos de autor', 'Dédicace', 'Danksagung', 'Об авторе']) {
    expect(isLikelyFrontMatterTitle(t)).toBe(true);
  }
  expect(isLikelyFrontMatterTitle('Capítulo 1')).toBe(false); // a real chapter is not front-matter
});
```

```typescript
// html-utils test (GENERIC_NCX_RE)
import { GENERIC_NCX_RE } from './html-utils.js';
it('matches non-English generic chapter labels', () => {
  for (const s of ['Capítulo 3', 'Kapitel 5', 'Глава 2', 'Chapitre IV']) {
    expect(GENERIC_NCX_RE.test(s)).toBe(true);
  }
});
```

- [ ] **Step 2: Run to verify failure** — `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/parsers/front-matter.test.ts src/parsers/html-utils.test.ts` → FAIL (English-only regexes).

- [ ] **Step 3: Implement**

In `server/src/parsers/front-matter.ts`, build `FRONT_MATTER_RX` from the English alternation (kept inline) + the non-English union, with `iu` flags:

```typescript
import { nonEnglishFrontMatterKeywords } from '../tts/language-registry.js';

const EN_FRONT_MATTER = `dedication|copyright|preface|foreword|acknowledg|about the author|about the publisher|table of contents|contents|epigraph|introduction(?!\\s*\\(|\\s+to\\b)|by the same author|also by|praise for|colophon|afterword|appendix|notes\\b|bibliograph|index\\b|glossary|halftitle|half[- ]title|frontispiece|imprint|publisher's note|publisher’s note|author's note|author’s note|translator's note|translator’s note`;
const FRONT_MATTER_RX = new RegExp(
  `^(?:${EN_FRONT_MATTER}|${nonEnglishFrontMatterKeywords().map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
  'iu',
);
```

(Escape the union terms for regex safety. Keep `isLikelyFrontMatterTitle` as the wrapper.)

In `server/src/parsers/html-utils.ts`, rebuild `GENERIC_NCX_RE` from the seam-3a heading union:

```typescript
import { nonEnglishHeadingLexicon } from '../tts/language-registry.js';

const NE = nonEnglishHeadingLexicon();
const NCX_KEYWORDS = ['chapter', ...NE.keywords].join('|');
const NCX_NUMBERS = ['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve',
  'thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty','thirty','forty',
  'fifty','sixty','seventy','eighty','ninety','hundred', ...NE.numberWords].join('|');
export const GENERIC_NCX_RE = new RegExp(
  `^(?:${NCX_KEYWORDS})\\s+(?:[ivxlcdm\\d]+|(?:${NCX_NUMBERS})(?:[-\\s](?:${NCX_NUMBERS}))?)\\s*$`,
  'iu',
);
```

- [ ] **Step 4: Run to verify pass — non-English AND the full English suites**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/parsers`
Expected: PASS — new non-English cases + all pre-existing English front-matter / NCX / epub-merge / text assertions.

- [ ] **Step 5: Commit**

```bash
git add server/src/parsers/front-matter.ts server/src/parsers/html-utils.ts server/src/parsers/front-matter.test.ts server/src/parsers/html-utils.test.ts
git commit -m "feat(server): language-agnostic front-matter + generic-NCX detection"
```

---

### Task 3: Server-computed per-chapter `isLikelyFrontMatter`; retire the client mirror

**Files:**
- Modify: `server/src/routes/import.ts` (per-chapter flag in the response)
- Modify: `src/lib/types.ts` (chapter shape gains `isLikelyFrontMatter?`) + `openapi.yaml` if the import chapter is openapi-typed (regen `api-types.ts`)
- Modify: `src/views/confirm-metadata.tsx` (consume `ch.isLikelyFrontMatter`)
- Modify: `src/lib/chapter-heuristics.ts` (remove `FRONT_MATTER_RX` + `isLikelyFrontMatter`; keep `chapterSlug`/`slugify`/`FRONT_MATTER_WORD_THRESHOLD` if still referenced)
- Test: `server/src/routes/import.test.ts`, `src/views/confirm-metadata.test.tsx`, `src/lib/chapter-heuristics.test.ts` (if exists)

**Interfaces:**
- Consumes: `isLikelyFrontMatterTitle` (Task 2). Produces: import-response chapters carry `isLikelyFrontMatter: boolean` (title-union OR `wordCount` ≤ 150).

- [ ] **Step 1: Write the failing server test** — in `server/src/routes/import.test.ts`:

```typescript
it('marks a non-English front-matter chapter via the per-chapter flag', async () => {
  const text = 'Derechos de autor\n\n© 2026.\n\nCapítulo 1\n\n' + 'palabra '.repeat(400);
  const res = await request(app).post('/api/import').send({ text }).expect(200);
  const fm = res.body.candidate.chapters.find((c: any) => /Derechos de autor/.test(c.title));
  const ch1 = res.body.candidate.chapters.find((c: any) => /Capítulo 1/.test(c.title));
  expect(fm.isLikelyFrontMatter).toBe(true);
  expect(ch1.isLikelyFrontMatter).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure** — `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/routes/import.test.ts` → FAIL (`isLikelyFrontMatter` undefined).

- [ ] **Step 3: Implement the server flag** — in `server/src/routes/import.ts`, where the response `chapters` are mapped (the `chapters: entry.chapters.map(...)` block), add the flag (reusing `isLikelyFrontMatterTitle` + the word threshold):

```typescript
import { isLikelyFrontMatterTitle } from '../parsers/front-matter.js';
const FRONT_MATTER_WORD_THRESHOLD = 150;
// inside the chapter map:
chapters: entry.chapters.map((c) => {
  const wordCount = countWords(c.body);
  return {
    id: c.id,
    title: c.title,
    wordCount,
    isLikelyFrontMatter:
      isLikelyFrontMatterTitle(c.title) || (wordCount > 0 && wordCount <= FRONT_MATTER_WORD_THRESHOLD),
  };
}),
```

- [ ] **Step 4: Thread the type + retire the client regex**

(a) In `src/lib/types.ts`, add `isLikelyFrontMatter?: boolean;` to the `ImportCandidate` chapter element type. (If the chapter is openapi-typed — `grep -n "ImportCandidate" openapi.yaml` — mirror there + `npm run openapi:types`.)

(b) In `src/views/confirm-metadata.tsx`, replace the `isLikelyFrontMatter(ch.title, ch.wordCount)` call (line ~74) with `ch.isLikelyFrontMatter` and drop the import of `isLikelyFrontMatter` from `../lib/chapter-heuristics` (keep `chapterSlug`).

(c) In `src/lib/chapter-heuristics.ts`, remove `FRONT_MATTER_RX` and the `isLikelyFrontMatter` function (and `FRONT_MATTER_WORD_THRESHOLD` if now unreferenced — grep first). Keep `chapterSlug`/`slugify`. Update the file header comment to note detection moved server-side.

- [ ] **Step 5: Update the frontend tests** — in `src/views/confirm-metadata.test.tsx`, the front-matter pre-tick test must now provide `chapters` with `isLikelyFrontMatter` set (instead of relying on the client regex). If `src/lib/chapter-heuristics.test.ts` tested the removed `isLikelyFrontMatter`, remove those cases (the behaviour moved to `front-matter.test.ts` server-side) and keep the `chapterSlug` tests.

- [ ] **Step 6: Run to verify pass** — server + frontend + typecheck:

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/routes/import.test.ts`
Run: `cd C:/Claude/Audiobook-Generator-wt-fs41 && npx vitest run src/views/confirm-metadata.test.tsx src/lib && npm run typecheck`
Expected: PASS; `grep -rn "chapter-heuristics" src | grep isLikelyFrontMatter` returns nothing (no dangling importer).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/import.ts src/lib/types.ts src/views/confirm-metadata.tsx src/lib/chapter-heuristics.ts server/src/routes/import.test.ts src/views/confirm-metadata.test.tsx src/lib/chapter-heuristics.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): server-computed per-chapter front-matter flag; retire the client mirror"
```

(Only add `openapi.yaml`/`api-types.ts`/`chapter-heuristics.test.ts` if they were actually touched.)

---

## Self-Review

- **Spec coverage (§4.1 title-side / §4.7 front-matter):** FRONT_MATTER_RX is language-aware ✓ (T2); GENERIC_NCX_RE matches non-English generic labels ✓ (T2); front-matter detection is single-source server-side and the client mirror is retired ✓ (T3) — resolving the review's mirror-divergence finding. English behaviour preserved (union only adds).
- **Placeholder scan:** none.
- **Type consistency:** `nonEnglishFrontMatterKeywords` (T1) consumed in T2; `isLikelyFrontMatter` per-chapter flag spelled identically server (T3 Step 3) + type (T3 Step 4a) + confirm (T3 Step 4b); `isLikelyFrontMatterTitle` reused, not re-implemented.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-fs41-fs50-seam3b-frontmatter-ncx.md`. Subagent-Driven recommended (T3 spans server + frontend + the client-mirror retirement). Next analyze-half PRs after 3b: §4.2 quote/dialogue + audio-tags, §4.3 attribution sites, §4.4 minor-cast, §4.5 token divisor, §4.6 prompt skills.
