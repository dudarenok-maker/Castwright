# Russian Attribution — Narrator-Default Heuristic + Dash-Tag Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make non-English (Russian-first) stage-2 attribution correct by deterministically forcing non-spoken sentences to `narrator` after the model returns, plus a Russian dash-dialogue tag guard in the language preamble.

**Architecture:** A new pure module (`narrator-default.ts`) classifies each attributed sentence as spoken vs. narration and rewrites non-spoken sentences' `characterId` to `narrator`. It is applied inside the shared `attributeChapterStage2` runner, gated on `isNonEnglish(language)`, so both the main and subset analysis routes get it with zero English-path change. Coverage is unaffected (the coverage guard keys on sentence *text*, never `characterId`). A short Russian guard string is appended to the existing `languagePreamble` to nudge the model on dash-dialogue *tags* (the one class the heuristic deliberately leaves to the model).

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Vitest (server, node env), Zod schema types (`SentenceOutput`).

**Why this scope:** This is Wave A of plan [221](../../features/221-multilingual-attribution-gemma-and-cast-merge.md). It is self-contained and deterministically unit-testable (no model calls). The model-selection (gemma-e4b), roster de-duplication, and localized buckets are separate later waves and are NOT in this plan.

**Empirical basis (server/repro-heuristic.mts, 3/3 runs on the real failing section):** the model's narration-block correctness was 0–1/6; the heuristic deterministically produced **6/6 every run** while leaving every dialogue line untouched (`spoken-lines-kept-named` unchanged 15→15, 14→14, 13→13).

---

## File Structure

- **Create** `server/src/analyzer/narrator-default.ts` — pure classification + rewrite helpers. One responsibility: deciding spoken-vs-narration and applying the narrator default.
- **Create** `server/src/analyzer/narrator-default.test.ts` — unit tests (pure, no model/network).
- **Modify** `server/src/routes/analysis.ts` — call the helper inside `attributeChapterStage2` (one gated line + two imports).
- **Modify** `server/src/analyzer/gemini.ts` — extend the Russian branch of `languagePreamble`.
- **Modify** `server/src/analyzer/gemini.test.ts` (or the file that tests `languagePreamble`) — assert the new guard text appears for `ru` and not for `en`.
- **Modify** `docs/features/162-fs2-multilanguage.md` — note the narrator-default heuristic under multilanguage attribution.
- **Modify** `docs/features/INDEX.md` — only if a new plan entry is needed (221 already tracked).

---

### Task 1: Pure narrator-default module

**Files:**
- Create: `server/src/analyzer/narrator-default.ts`
- Test: `server/src/analyzer/narrator-default.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/analyzer/narrator-default.test.ts
import { describe, it, expect } from 'vitest';
import type { SentenceOutput } from '../handoff/schemas.js';
import {
  isSpokenLine,
  forceNarratorOnNonSpokenLines,
  applyNonEnglishNarratorDefault,
} from './narrator-default.js';

const s = (id: number, characterId: string, text: string): SentenceOutput =>
  ({ id, chapterId: 1, characterId, text, confidence: 0.9 }) as SentenceOutput;

describe('isSpokenLine', () => {
  it('treats leading em-dash / en-dash / hyphen as spoken', () => {
    expect(isSpokenLine('— Иди сюда')).toBe(true);
    expect(isSpokenLine('– Иди сюда')).toBe(true);
    expect(isSpokenLine('- Иди сюда')).toBe(true);
    expect(isSpokenLine('   — с ведущими пробелами')).toBe(true);
  });
  it('treats leading or embedded quote spans as spoken', () => {
    expect(isSpokenLine('«Привет»')).toBe(true);
    expect(isSpokenLine('Он сказал «привет» громко')).toBe(true);
    expect(isSpokenLine('"Hard to starboard"')).toBe(true);
    expect(isSpokenLine('“smart quotes”')).toBe(true);
  });
  it('treats plain third-person narration as NOT spoken', () => {
    expect(isSpokenLine('Егор засунул руки в карманы, покосился назад.')).toBe(false);
    expect(isSpokenLine('Мальчик шёл по переходу.')).toBe(false);
    expect(isSpokenLine('')).toBe(false);
    // mid-sentence dash is punctuation, not a dialogue marker (anchored ^)
    expect(isSpokenLine('Ветер толкнул Егора последний раз и стих - будто смирился.')).toBe(false);
  });
  it('matches named HTML dash entities at the start (stripHtml may leave them)', () => {
    expect(isSpokenLine('&mdash; Иди сюда')).toBe(true);
    expect(isSpokenLine('&ndash; Стой')).toBe(true);
  });
  it('a bare dash line is spoken (no text after the marker)', () => {
    expect(isSpokenLine('—')).toBe(true);
    expect(isSpokenLine('- ')).toBe(true);
  });
  it('KNOWN false-positive: narration quoting a sign/title reads as spoken (documented limitation)', () => {
    // The embedded-quoted-span branch can't tell a spoken line from narration
    // that quotes an inscription. Acceptable: it only means such a line is LEFT
    // to the model rather than forced to narrator — never the reverse.
    expect(isSpokenLine('На двери висела табличка «Закрыто».')).toBe(true);
  });
});

describe('forceNarratorOnNonSpokenLines', () => {
  it('rewrites non-spoken sentences to narrator, leaves spoken lines untouched', () => {
    const input = [
      s(1, 'egor', 'Егор засунул руки в карманы, покосился назад.'),
      s(2, 'woman', '— Иди сюда.., иди ко мне...'),
      s(3, 'egor', 'Мальчик шёл по переходу.'),
    ];
    const out = forceNarratorOnNonSpokenLines(input);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'woman', 'narrator']);
  });
  it('does not mutate the input array or its elements', () => {
    const input = [s(1, 'egor', 'Егор побежал.')];
    const out = forceNarratorOnNonSpokenLines(input);
    expect(input[0].characterId).toBe('egor');
    expect(out[0]).not.toBe(input[0]);
  });
  it('preserves all other fields', () => {
    const input = [{ id: 7, chapterId: 2, characterId: 'egor', text: 'Он обернулся.', confidence: 0.55, emotion: 'sad' } as SentenceOutput];
    const out = forceNarratorOnNonSpokenLines(input);
    expect(out[0]).toMatchObject({ id: 7, chapterId: 2, characterId: 'narrator', text: 'Он обернулся.', confidence: 0.55, emotion: 'sad' });
  });
});

describe('applyNonEnglishNarratorDefault', () => {
  const input = [s(1, 'egor', 'Егор побежал.'), s(2, 'woman', '— Стой!')];
  it('applies the heuristic for non-English languages', () => {
    expect(applyNonEnglishNarratorDefault(input, 'ru').map((x) => x.characterId)).toEqual(['narrator', 'woman']);
    expect(applyNonEnglishNarratorDefault(input, 'ru-RU').map((x) => x.characterId)).toEqual(['narrator', 'woman']);
  });
  it('is a no-op for English and for missing language (returns the same array reference)', () => {
    expect(applyNonEnglishNarratorDefault(input, 'en')).toBe(input);
    expect(applyNonEnglishNarratorDefault(input, undefined)).toBe(input);
  });
  it('leaves English characterIds unchanged in VALUE, not just reference (guards a gate regression)', () => {
    const en = [s(1, 'halloran', 'The wind had turned.'), s(2, 'halloran', '"Hard to starboard,"')];
    const out = applyNonEnglishNarratorDefault(en, 'en');
    expect(out.map((x) => x.characterId)).toEqual(['halloran', 'halloran']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/narrator-default.test.ts`
Expected: FAIL — `Cannot find module './narrator-default.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/analyzer/narrator-default.ts
/* Deterministic narrator-default heuristic (plan 221, Wave A).

   The per-sentence attribution model — especially on non-Latin scripts —
   mislabels third-person NARRATION as the named character (e.g. "Егор засунул
   руки в карманы" → `egor`), which would read narration in that character's
   voice. The spoken-vs-narration distinction is mechanical, so we decide it in
   code instead of trusting the model: any sentence that is NOT a spoken line is
   forced to `narrator`.

   A "spoken line" = begins with a dialogue dash (—/–/-) or an opening quote
   («/"/“), OR contains a quoted span. Everything else is narration. This
   deliberately LEAVES dashed narrative tags ("— сказал юноша") to the model +
   language preamble (they look spoken), and never touches dialogue lines, so it
   cannot break speaker attribution — it only ever changes a non-spoken line to
   `narrator`. Coverage is unaffected (the coverage guard keys on sentence text,
   not characterId). Empirically (server/repro-heuristic.mts) this took the
   model's narration-block correctness from 0–1/6 to 6/6 on every run with zero
   dialogue damage. Pure: no I/O, no model calls. */

import type { SentenceOutput } from '../handoff/schemas.js';
import { isNonEnglish } from '../tts/language.js';

const NARRATOR_ID = 'narrator';

/** True when the sentence text reads as spoken dialogue: a leading dialogue
    dash / opening quote, or an embedded quoted span. Also matches the named
    HTML dash entities `&mdash;`/`&ndash;` — some EPUB toolchains emit these and
    `stripHtml` (parsers/html-utils.ts) only decodes a small named-entity set, so
    the dash can survive literally in the body the model echoes. Without this,
    real dialogue prefixed by `&mdash;` would be wrongly forced to narrator. */
export function isSpokenLine(text: string): boolean {
  const t = (text ?? '').trimStart();
  if (!t) return false;
  if (/^(&mdash;|&ndash;|[-–—])/i.test(t)) return true; // dash entities + literal dashes
  if (/^[«"“]/.test(t)) return true; // opening guillemet / straight / smart quote
  if (/«[^»]+»/.test(t) || /"[^"]+"/.test(t) || /“[^”]+”/.test(t)) return true; // embedded quoted span
  return false;
}

/** Return a new sentence list where every non-spoken sentence's characterId is
    `narrator`. Spoken lines are returned unchanged. Pure — never mutates input. */
export function forceNarratorOnNonSpokenLines(sentences: SentenceOutput[]): SentenceOutput[] {
  return sentences.map((s) =>
    isSpokenLine(s.text) ? s : { ...s, characterId: NARRATOR_ID },
  );
}

/** Apply the narrator-default heuristic only for non-English books. For English
    (and missing language) returns the SAME array reference (no-op) so the
    English path is byte-identical. */
export function applyNonEnglishNarratorDefault(
  sentences: SentenceOutput[],
  language: string | undefined,
): SentenceOutput[] {
  if (!isNonEnglish(language ?? '')) return sentences;
  return forceNarratorOnNonSpokenLines(sentences);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/analyzer/narrator-default.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/narrator-default.ts server/src/analyzer/narrator-default.test.ts
git commit -m "feat(server): narrator-default heuristic for non-English attribution"
```

---

### Task 2: Wire the heuristic into the shared stage-2 runner

**Files:**
- Modify: `server/src/routes/analysis.ts` (imports near the other analyzer imports; body of `attributeChapterStage2` ~`1473-1514`)

- [ ] **Step 1: Add the import**

Add to the analyzer-side imports in `server/src/routes/analysis.ts` (near `import { runStage1ChapterChunked, ... } from '../analyzer/stage1-chunk.js';`):

```typescript
import { applyNonEnglishNarratorDefault } from '../analyzer/narrator-default.js';
```

- [ ] **Step 2: Make the function `async` and apply the heuristic on the stitched result**

FIRST: the function is declared `function attributeChapterStage2(opts: {` (analysis.ts:1473) — it is NOT async and currently returns the promise directly. Adding `await` requires changing the declaration to:

```typescript
async function attributeChapterStage2(opts: {
```

(The return type annotation `Promise<Stage2ChunkRunResult>` is unchanged and still correct.)

THEN, in the body, replace the trailing `return runStage2ChapterChunked({ ... });` with an awaited capture + gated rewrite. The function body's final statement currently is:

```typescript
  return runStage2ChapterChunked({
    body: opts.chapter.body,
    charBudget: resolveStage2ChunkCharBudget(opts.engine),
    coverageRetries: resolveStage2CoverageRetries(),
    callForBody,
    onRetry: opts.onCoverageRetry,
    onChunk: opts.onChunk,
  });
```

Change it to:

```typescript
  const result = await runStage2ChapterChunked({
    body: opts.chapter.body,
    charBudget: resolveStage2ChunkCharBudget(opts.engine),
    coverageRetries: resolveStage2CoverageRetries(),
    callForBody,
    onRetry: opts.onCoverageRetry,
    onChunk: opts.onChunk,
  });
  /* plan 221 Wave A — non-English narrator-default heuristic. The model
     mislabels third-person narration as a character on non-Latin scripts;
     force non-spoken sentences to `narrator`. No-op for English. Runs AFTER
     coverage (coverage keys on text, not characterId), so the verdict is
     unchanged. */
  result.sentences = applyNonEnglishNarratorDefault(result.sentences, opts.stageCall.language);
  return result;
```

- [ ] **Step 3: Typecheck**

Run: `cd server && npx tsc --noEmit`
Expected: no errors. (`attributeChapterStage2` already returns `Promise<Stage2ChunkRunResult>`; `result.sentences` is `SentenceOutput[]`, matching the helper.)

- [ ] **Step 4: Run the server attribution tests to confirm no regression**

Run: `cd server && npx vitest run src/routes/analysis.test.ts`
Expected: PASS (English-path attribution unchanged — the helper is a no-op for `en`/absent language).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/analysis.ts
git commit -m "feat(server): apply narrator-default in attributeChapterStage2 (non-English)"
```

---

### Task 3: Fold-interaction safety test (narration-default vs minor-cast fold)

**Why:** the heuristic moves model-mislabeled narration off characters onto `narrator`, which lowers those characters' line counts. `foldMinorCast` (`server/src/analyzer/fold-minor-cast.ts`) folds/drops characters with `< minLines` (default 3) attributed lines. We must prove a real speaker (≥3 genuine dialogue lines) is NOT folded after the heuristic, and consciously accept that a genuinely-minor speaker (<3 dialogue lines) folding is the *intended* behavior (the heuristic makes the count accurate — narration was never their dialogue). KNOWN GAP (Wave C): the protection that rescues low-line speakers via prose tags (`taggedSpeakerIds` → `DIALOGUE_VERBS` in `recover-tagged-lines.ts`/`dialogue-verbs.ts`) is **English-verb-only**, so a Russian speaker whose quotes were stranded on narrator isn't protected — extending those verbs to Russian is Wave C, not this plan.

**Files:**
- Test: `server/src/analyzer/narrator-default.test.ts` (add a describe block; import `foldMinorCast`)

- [ ] **Step 1: Write the test**

```typescript
import { foldMinorCast } from './fold-minor-cast.js';

describe('narrator-default + foldMinorCast interaction', () => {
  it('a speaker with >= minLines real (dashed) dialogue lines survives the fold', () => {
    // egor: 4 narration lines (model mislabeled as egor) + 3 real dashed lines
    const sentences = [
      s(1, 'egor', 'Егор засунул руки в карманы.'),
      s(2, 'egor', 'Мальчик посмотрел вверх.'),
      s(3, 'egor', 'Егор побежал.'),
      s(4, 'egor', 'Он обернулся.'),
      s(5, 'egor', '— Хорошо.'),
      s(6, 'egor', '— Иду.'),
      s(7, 'egor', '— Сейчас.'),
    ];
    const chars = [
      { id: 'narrator', name: 'Narrator', role: 'narrator', gender: 'neutral' },
      { id: 'egor', name: 'Егор', role: 'Boy', gender: 'male' },
    ] as any;
    const fixed = forceNarratorOnNonSpokenLines(sentences); // 4 narration -> narrator, 3 dashed stay egor
    const folded = foldMinorCast(chars, fixed, { minLines: 3 });
    expect(folded.characters.some((c) => c.id === 'egor')).toBe(true); // survived (3 dialogue lines)
    expect(folded.rewrites['egor']).toBeUndefined(); // not folded into a bucket
  });

  it('a speaker with < minLines real dialogue lines folds — intended (count is now accurate)', () => {
    const sentences = [
      s(1, 'extra', 'Прохожий шёл мимо.'),
      s(2, 'extra', 'Он остановился.'),
      s(3, 'extra', '— Что?'),
    ];
    const chars = [
      { id: 'narrator', name: 'Narrator', role: 'narrator', gender: 'neutral' },
      { id: 'extra', name: 'Прохожий', role: 'Passerby', gender: 'male' },
    ] as any;
    const fixed = forceNarratorOnNonSpokenLines(sentences); // 2 narration -> narrator, 1 dashed stays
    const folded = foldMinorCast(chars, fixed, { minLines: 3 });
    expect(folded.rewrites['extra']).toBe('unknown-male'); // 1 dialogue line < 3 -> folded (correct)
  });
});
```

- [ ] **Step 2: Run the test**

Run: `cd server && npx vitest run src/analyzer/narrator-default.test.ts`
Expected: PASS. (If the first test FAILS — a real speaker gets folded — STOP and escalate: the heuristic is removing protection that Russian needs, and Wave C's Russian `DIALOGUE_VERBS` extension must move into this plan.)

- [ ] **Step 3: Commit**

```bash
git add server/src/analyzer/narrator-default.test.ts
git commit -m "test(server): narrator-default x foldMinorCast interaction (Russian speaker survival)"
```

---

### Task 4: Russian dash-dialogue tag guard in languagePreamble

**Files:**
- Modify: `server/src/analyzer/gemini.ts` (`languagePreamble`, ~`161-169`)
- Test: `server/src/analyzer/gemini.test.ts` (or wherever `languagePreamble` is unit-tested — search for `languagePreamble`)

- [ ] **Step 1: Write the failing test**

Add to the language-preamble test file (search: `grep -rn "languagePreamble" server/src --include=*.test.ts`). If none exists, add to `server/src/analyzer/gemini.test.ts`:

```typescript
import { languagePreamble } from './gemini.js';

describe('languagePreamble — Russian dash-dialogue tag guard', () => {
  it('tells the model that dashed narrative tags are narrator, for ru', () => {
    const p = languagePreamble('ru');
    expect(p).toMatch(/тег|narrative tag|сказал/i);
    expect(p).toMatch(/narrator/);
  });
  it('adds nothing for English', () => {
    expect(languagePreamble('en')).toBe('');
    expect(languagePreamble(undefined)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

NOTE: `gemini.test.ts` is in the SLOW vitest tier (`server/vitest.config.ts` `SLOW_FILES_TO_EXCLUDE` excludes it from the default config). It runs ONLY via the slow config — the plain `npx vitest run src/analyzer/gemini.test.ts` reports "No test files found". Always pass `--config vitest.config.slow.ts` for this file.

Run: `cd server && npx vitest run --config vitest.config.slow.ts src/analyzer/gemini.test.ts -t "dash-dialogue tag guard"`
Expected: FAIL — current Russian preamble has no tag guidance.

- [ ] **Step 3: Extend the Russian conventions string**

In `server/src/analyzer/gemini.ts`, the Russian branch of `languagePreamble` currently is:

```typescript
  const conventions = ru
    ? ' Dialogue is often marked with guillemets «…» or an em-dash —, not English "quotes". Characters may be named by first name, patronymic, surname, or diminutive (e.g. "Соня" for "Софья") — treat these as the same person.'
    : '';
```

Replace the `ru` string with (append the tag-splitting guidance):

```typescript
  const conventions = ru
    ? ' Dialogue is often marked with guillemets «…» or an em-dash —, not English "quotes". Characters may be named by first name, patronymic, surname, or diminutive (e.g. "Соня" for "Софья") — treat these as the same person. IMPORTANT: a dashed line that is a narrative TAG describing who spoke or what they did — e.g. «— сказал юноша.», «— тихо произнесла девушка.», «— Девушка улыбнулась.» (verbs like сказал/произнёс(ла)/воскликнул(а)/спросил(а)/засмеялся/улыбнулась/нахмурился) — is the narrator, NOT the speaker. Only the actually-spoken words belong to the speaker.'
    : '';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run --config vitest.config.slow.ts src/analyzer/gemini.test.ts -t "dash-dialogue tag guard"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/gemini.ts server/src/analyzer/gemini.test.ts
git commit -m "feat(server): Russian dash-dialogue tag guard in languagePreamble"
```

---

### Task 5: Regression plan + docs

**Files:**
- Modify: `docs/features/162-fs2-multilanguage.md`
- Modify: `docs/features/221-multilingual-attribution-gemma-and-cast-merge.md` (mark Wave A status)

- [ ] **Step 1: Note the heuristic in the multilanguage plan**

Add a short subsection to `docs/features/162-fs2-multilanguage.md` under attribution, documenting: non-English stage-2 applies a deterministic narrator-default (`server/src/analyzer/narrator-default.ts`) + the dash-tag preamble guard; cite `server/repro-heuristic.mts` evidence (0–1/6 → 6/6, dialogue untouched); note the known limitation (a genuine spoken line lacking a leading dash/quote would be forced to narrator — rare in Russian dash-dialogue).

- [ ] **Step 2: Update plan 221 Wave A status**

In `docs/features/221-multilingual-attribution-gemma-and-cast-merge.md`, mark Wave A (heuristic + dash-tag guard) as implemented/shipping, leaving Waves B/C/D as follow-ups.

- [ ] **Step 3: Commit**

```bash
git add docs/features/162-fs2-multilanguage.md docs/features/221-multilingual-attribution-gemma-and-cast-merge.md
git commit -m "docs(server): record narrator-default heuristic under multilanguage (plan 221 Wave A)"
```

---

### Task 6: Full verification

- [ ] **Step 1: Run the server test battery**

Run: `cd server && npm run test` (or from root: `npm run test:server`)
Expected: PASS, including the new `narrator-default.test.ts` and unchanged `analysis.test.ts`. NOTE: `gemini.test.ts` is in the SLOW tier — it runs via `npm run test:server-slow` (root), NOT the default `npm run test`. Run that too: `npm run test:server-slow` → PASS (incl. the new dash-tag guard test).

- [ ] **Step 2: Typecheck the whole project**

Run (root): `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full pre-push battery**

Run (root): `npm run verify`
Expected: PASS (lint + all tests + e2e + build). This is the gate before opening the PR.

---

## Self-Review

**Spec coverage:**
- Narration mislabeled as character → Task 1 (`forceNarratorOnNonSpokenLines`) + Task 2 (wired, non-English). ✓
- Dash-dialogue tags → Task 3 (preamble guard — the class the heuristic leaves to the model). ✓
- English path unchanged → `applyNonEnglishNarratorDefault` no-ops for `en`/absent (Task 1 test asserts same-reference return; Task 2 only changes non-English). ✓
- Coverage unaffected → heuristic runs after `runStage2ChapterChunked` returns; coverage verdict already computed on text. ✓
- Both main + subset routes covered → applied inside shared `attributeChapterStage2`. ✓

**Placeholder scan:** none — all steps have concrete code, exact paths, and commands.

**Type consistency:** `SentenceOutput` used throughout; `isNonEnglish(language: string)` is the real signature in `server/src/tts/language.ts` (call with `language ?? ''`); `attributeChapterStage2` returns `Promise<Stage2ChunkRunResult>` whose `.sentences` is `SentenceOutput[]`; helper names (`isSpokenLine`, `forceNarratorOnNonSpokenLines`, `applyNonEnglishNarratorDefault`) are consistent across Tasks 1–2.

**Known limitation (documented in Task 4):** a genuine spoken line that lacks a leading dialogue marker AND has no quoted span would be wrongly forced to `narrator`. Rare in Russian dash-dialogue (the failing section showed zero such damage across 3 runs); acceptable for v1, revisit if a counter-example appears.

**Evidence provenance:** the "6/6 every run" numbers come from `server/repro-heuristic.mts` against a LOCAL, non-committed EPUB (Ночной дозор, em-dash dialogue). They are not reproducible from a clean checkout. The committed Russian fixture `server/src/__fixtures__/the-coalfall-commission.ru.md` uses guillemet «…» dialogue (no leading dashes) — `isSpokenLine` handles both marker styles (the embedded-quoted-span branch covers guillemets), and the Task 1 unit tests exercise both. The `isSpokenLine` logic in the plan is byte-identical to the validated probe.

**Scope (cached analyses):** this corrects NEW or re-run analyses only. A Russian book analysed/cached before this ships keeps the model's bad narration labels until re-analysed — `attributeChapterStage2` is the single stage-2 chokepoint (both main route analysis.ts:3535 and subset route :4649 go through it, and BOTH set `stageCall.language` — verified analysis.ts:3472 and :4658; the emotion pass only reads `characterId`, never re-attributes), so a re-run applies the fix everywhere.

**Round-2 review notes folded in:**
- **Fold interaction (was flagged BLOCKER):** Task 3 pins it with tests — a ≥3-dialogue-line speaker survives; a <3-line speaker folds (intended, the count is now accurate). The model-trust risk is real only if `isSpokenLine` MISSES genuine dialogue (see next), which would under-count a real speaker.
- **Dialogue-detection robustness (model-dependent):** the heuristic only force-narrators a line with no leading dash/quote and no quoted span. If the analyzer emits dialogue WITHOUT a leading marker (drops the dash when echoing, or a quote continues across a segmentation boundary), that line is wrongly narrator-ized. Empirically gemma-e4b preserved the dash on every dialogue line (`repro-heuristic.mts`, `spoken-lines-kept-named` unchanged 3/3 runs), and `&mdash;`/`&ndash;` are now handled — but this is a **model-preservation dependency**, not a guarantee. Honest claim: "depends on the model preserving the dialogue marker," not "rare."
- **Shared preamble:** `languagePreamble` feeds `buildSystemInstruction` for ALL stages (stage-1 detection, stage-2, emotion), not just stage-2. The dashed-tag guard reaching stage-1 is harmless (stage-1 builds the roster, doesn't attribute lines) — considered, accepted.
- **No deterministic backstop for dashed TAGS:** `— сказал юноша` looks spoken to `isSpokenLine`, so the heuristic leaves it to the model+guard. If the model disobeys the guard, that tag stays mis-attributed. Known gap, not a solved case.
- **Follow-ups (NOT this plan):** decode `&mdash;`/`&ndash;` in `stripHtml` (parsers/html-utils.ts) at the source so the literal entity never reaches synthesis (broader parser change); extend `DIALOGUE_VERBS` (dialogue-verbs.ts) to Russian so `recover-tagged-lines`/`taggedSpeakerIds` protects Russian low-line speakers — **Wave C** (roster).
