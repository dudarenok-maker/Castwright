# Marlow / the Hollow Tide → Coalfall Scrub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove all *The Hollow Tide* (third-party copyright) content — the codebase's de-facto fixture/mock dataset — and replace it with Castwright-owned content (The Coalfall Commission + the Hollow Tide series), committing an owned canonical e2e manuscript (+ a Russian variant for multilingual).

**Architecture:** A single fixed **mapping table** (the Hollow Tide entity → owned entity) applied consistently. Renaming *both* a fixture's input text and its assertions preserves most prose-derived tests; only **char-position** assertions break (different name lengths shift offsets) and need re-derivation. Mechanical bulk via a word-boundary, case-preserving codemod; the position-sensitive analyzer subset by hand.

**Tech Stack:** TypeScript (Vitest server + frontend), Node codemod script, Markdown docs.

**Scope:** `docs/superpowers/specs/2026-06-12-Marlow-scrub-scope.md` (decisions: full scope incl. archived docs; commit owned manuscript; Russian multilingual fixture; historicity = replace-name-keep-point-no-fabricated-numbers).

**Commit scope vocab:** `server` | `frontend` | `mocks` | `docs` | `scripts` | `e2e`. One phase = one PR.

**Conventions for every phase:**
- Work on a branch `chore/Marlow-scrub-phaseN-<slug>` off latest `main`; one PR per phase.
- After edits, the phase's **acceptance gate** is: (1) `git grep -i` for the the Hollow Tide names in that phase's scope returns **zero**, and (2) the relevant test battery passes.
- Run server tests with `npm run test:server` (+ `test:server-slow` for the 6 routed files); frontend with `npm test`; e2e with `npm run test:e2e`.

---

## The mapping table (the linchpin — authored here, finalised in Phase 0)

**Characters** (chosen to preserve token-count/role where a test depends on it; twins/alias/non-human use the Coalfall analogues):

| the Hollow Tide | Owned | Note |
|---|---|---|
| Wren / Wren Sparrow | Wren / Wren Sparrow | protagonist; alias analogue |
| Foster (surname) | Sparrow | Wren's in-story alias |
| Marlow / Marlow Halden | Pell / Pell Hollis | |
| Sir Singe (Marlow's joke alias) | Sir Singe | owned joke alias |
| Oduvan | Oduvan (Master Oduvan) | |
| Brann | Brann (Brann Weir) | twin analogue |
| Maerin | Maerin | |
| Hart | Hart | |
| Garrow | Garrow | owned (bodyguard role) |
| Lessom | Lessom (Father Lessom) | |
| Casper | Casper (Widow Casper) | |
| Linnet / Councillor Linnet / Dame Linnet | Linnet / Dame Linnet | owned |
| Lord Vane | Lord Vane | owned (keeps "Lord X") |
| Lady Wick | Lady Wick | owned (keeps "Lady X") |
| Sela | Sela | |
| Berrin | Berrin (Berrin Weir) | second twin |
| Edda | Edda | owned |
| Corvin | Corvin | owned (father) |
| Hespa | Hespa | owned (mother) |
| Bram | Bram | owned |

**Books / series — UNAMBIGUOUS (safe for the blanket codemod):**

| the Hollow Tide | Owned |
|---|---|
| The Hollow Tide (series) | The Hollow Tide |
| The Drowning Bell | The Drowning Bell |
| The Tidewatcher's Oath | The Tidewatcher's Oath |
| Saltgrave | Saltgrave |

**Books — CONTEXT-ONLY (⚠️ common English / code words — NOT in the codemod):**

| the Hollow Tide | Owned | Why manual |
|---|---|---|
| Exile | The Ebb | "exile" is a common word |
| Unlocked | The Floodmark | UI/state term |
| Legacy | The Lantern Tide | **114 code files** use "legacy" for legacy format/pairing — must NOT blanket-rename |
| Flashback | The Undertow | common word |
| Foster (surname) | Sparrow | "foster" is also a verb — capitalised-standalone only |

> These are renamed **only by the reviewed manual pass** (Phase 4 Step 3b / Phase 5
> Step 1b), where a human confirms each occurrence genuinely refers to the the Hollow Tide
> book/surname. The codemod must **exclude** them.
>
> All owned names above are original (no third-party IP). Coalfall cast names come
> from `brand/test-book/the-coalfall-commission-cast-sheet.md`; the rest are
> fabricated Hollow Tide-universe names.

**Unambiguous CHARACTER tokens** (safe for the codemod): Wren, Marlow, Oduvan,
Garrow, Lessom, Casper, Brann, Maerin, Berrin, Sela, Edda, Hespa,
Singe, Vane, Wick, The Drowning Bell, The Tidewatcher's Oath, Saltgrave. (`Hart`, `Linnet`,
`Corvin`, `Bram` are short/common enough to **spot-check** the diff, but `\b`
+ capitalisation makes them low-risk.)

---

## Phase 0: Foundation — commit the manuscript + mapping doc + codemod

**Files:**
- Create: `server/src/__fixtures__/the-coalfall-commission.md` (owned manuscript)
- Create: `server/src/__fixtures__/the-coalfall-commission.ru.md` (Russian variant — Cat 6)
- Create: `docs/test-book/the Hollow Tide-to-coalfall-mapping.md` (the canon table above + enumeration)
- Create: `scripts/scrub-the Hollow Tide.mjs` (codemod)
- Test: `scripts/tests/scrub-the Hollow Tide.test.mjs` (node --test)

- [ ] **Step 1: Commit the owned manuscript fixture**

Copy the owned manuscript out of git-ignored `brand/test-book/` into a committed fixtures path:
```bash
mkdir -p server/src/__fixtures__
cp "brand/test-book/the-coalfall-commission.md" server/src/__fixtures__/the-coalfall-commission.md
```
Confirm it is original/owned prose (header reads "A Castwright original"). This is the committed canonical e2e manuscript.

- [ ] **Step 2: Create the Russian multilingual fixture**

Produce an owned Russian translation of **Chapter One** of the Coalfall manuscript (the language-detection fixture only needs a non-English passage, not the whole book). Write it to `server/src/__fixtures__/the-coalfall-commission.ru.md`. Keep it clearly owned (translation of the owned text). This replaces the Russian *the Coalfall Commission* used by `e2e/language-detection.spec.ts` + fs-2 multilingual.

> The translation content is authored by the implementer/maintainer; it must be a faithful Russian rendering of Coalfall Ch1, no third-party text.

- [ ] **Step 3: Write the mapping doc**

Create `docs/test-book/the Hollow Tide-to-coalfall-mapping.md` containing the two tables above verbatim, plus a "completeness" note: the canonical enumeration command (below) and the rule "Coalfall cast first, fabricate owned Hollow Tide names for overflow; never a near-homophone of a the Hollow Tide name."

- [ ] **Step 4: Enumerate every the Hollow Tide name in use (catch the long tail)**

Run and append any names not already in the table:
```bash
git grep -ohE "\b(Wren|Marlow|Oduvan|Garrow|Lessom|Casper|Hart|Brann|Maerin|Berrin|Vane|Sela|Singe|Linnet|Wick|Corvin|Bram|Edda|Hespa|Foster|The Hollow Tide|The Drowning Bell|Unlocked|Legacy|Saltgrave|Exile|The Tidewatcher's Oath|Flashback)\b" -- ':!node_modules' ':!docs/superpowers/plans' | sort | uniq -c | sort -rn
```
Expected: the names already in the table. Add any stragglers (e.g. `Councillor X`, `Lord/Lady X`) with an owned mapping before proceeding.

- [ ] **Step 5: Write the codemod (TDD)**

Create `scripts/scrub-the Hollow Tide.mjs` exporting `scrubText(s)`. Requirements:

- **Only the UNAMBIGUOUS map** (the safe character + book lists above). The
  context-only words (`Exile`/`Unlocked`/`Legacy`/`Flashback`/`Foster`) are
  **explicitly excluded** — a guard test asserts `scrubText('legacy pairing')` is
  unchanged.
- **Word boundaries + case preservation**: `Wren`→`Wren`, `Wren`→`wren`,
  `Wren`→`WREN`.
- **Longest-key-first**: `Wren Sparrow`/`Marlow Halden`/`Lord Vane` before the
  single tokens.
- **Kebab/slug forms**: for each mapping, also match the hyphen-joined lowercase
  form — `Wren-foster`→`wren-sparrow`, `Marlow-Halden`→`Pell-hollis`,
  `mock-book-The Drowning Bell`→`mock-book-the-drowning-bell`. Implement by, for each
  `[from,to]`, registering both the spaced form AND `kebab(from)→kebab(to)`
  (`from.toLowerCase().replace(/ /g,'-')`).
- **Manuscript-path** entries: `…\the Coalfall Commission.txt` and
  `~/Downloads/the Coalfall Commission.txt` → `server/src/__fixtures__/the-coalfall-commission.md`.
- A `--write <files...>` CLI that scrubs each file in place (used by every later phase).

Write `scripts/tests/scrub-the Hollow Tide.test.mjs` first:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText } from '../scrub-the Hollow Tide.mjs';

test('multi-word before single-word', () => {
  assert.equal(scrubText('Wren Sparrow and Wren'), 'Wren Sparrow and Wren');
  assert.equal(scrubText('Marlow Halden'), 'Pell Hollis');
});
test('case preservation', () => {
  assert.equal(scrubText('Wren said to Marlow'), 'WREN said to Pell');
});
test('word boundaries — no mid-word hits', () => {
  assert.equal(scrubText('Fosters philosophiel'), 'Fosters philosophiel');
});
test('books', () => {
  assert.equal(scrubText('The Hollow Tide: The Drowning Bell'),
    'The Hollow Tide: The Drowning Bell');
});
test('kebab/slug forms', () => {
  assert.equal(scrubText("id: 'Wren-foster'"), "id: 'wren-sparrow'");
  assert.equal(scrubText('mock-book-The Drowning Bell'), 'mock-book-the-drowning-bell');
});
test('common words are LEFT ALONE (context-only, not codemod)', () => {
  assert.equal(scrubText('the legacy pairing format'), 'the legacy pairing format');
  assert.equal(scrubText('exile the chapter'), 'exile the chapter');
  assert.equal(scrubText('foster a connection'), 'foster a connection');
});
```
Run: `node --test scripts/tests/scrub-the Hollow Tide.test.mjs` → FAIL, then implement `scrubText` until PASS.

- [ ] **Step 6: Commit**
```bash
git add server/src/__fixtures__ docs/test-book scripts/scrub-the Hollow Tide.mjs scripts/tests/scrub-the Hollow Tide.test.mjs
git commit -m "chore(scripts): owned Coalfall fixtures + the Hollow Tide→Coalfall mapping + codemod"
```

---

## Phase 1: Code comments (Cat 2a)

**Files (5):** `server/src/analyzer/roster-coverage.ts`, `server/src/routes/voice-match.ts`, `server/src/util/text-match.ts`, `server/src/workspace/series-cast-scan.ts`, `src/modals/drift-report.tsx`

- [ ] **Step 1: Apply the codemod to comments only**

These files use the Hollow Tide names *only in comments* (verified — no logic depends). Apply:
```bash
node scripts/scrub-the Hollow Tide.mjs --write server/src/analyzer/roster-coverage.ts server/src/routes/voice-match.ts server/src/util/text-match.ts server/src/workspace/series-cast-scan.ts src/modals/drift-report.tsx
```

- [ ] **Step 2: Historicity check**

Review the diff for any comment recording a *real observed value* (e.g. "produced 6 characters: …"). Per the historicity convention: keep the count, replace the names; do not invent new Coalfall-specific values. Hand-fix any that read as a fabricated run.

- [ ] **Step 3: Verify**
```bash
git grep -iE "Wren|Marlow|Oduvan|The Drowning Bell|keeper of the lost" -- server/src/analyzer/roster-coverage.ts server/src/routes/voice-match.ts server/src/util/text-match.ts server/src/workspace/series-cast-scan.ts src/modals/drift-report.tsx
```
Expected: **no matches**. Then `npm run typecheck`. Commit `docs(server,frontend): reword the Hollow Tide examples in code comments` (use `chore` if scope mix rejects).

---

## Phase 2: Analyzer prompt examples + tests (Cat 2b)

**Files:** `server/src/routes/analysis.ts` (the Hollow Tide names inside the LLM prompt template literals, ~L1140–1147 et al.), `server/src/analyzer/gemini.test.ts`, `server/src/analyzer/ollama.test.ts` (+ any analyzer test asserting prompt substrings)

- [ ] **Step 1: Find prompt-substring assertions first**
```bash
git grep -nE "Wren|Marlow|FILED BY|Memory Log" -- 'server/src/analyzer/*.test.ts' 'server/src/routes/analysis.test.ts'
```
List every test that asserts a prompt substring containing a the Hollow Tide name — those assertions must change in lockstep with the prompt.

- [ ] **Step 2: Scrub the prompt + its tests together**
```bash
node scripts/scrub-the Hollow Tide.mjs --write server/src/routes/analysis.ts
node scripts/scrub-the Hollow Tide.mjs --write server/src/analyzer/gemini.test.ts server/src/analyzer/ollama.test.ts
```
Then hand-reconcile any test from Step 1 whose assertion didn't get rewritten by the codemod (e.g. partial-string matches).

- [ ] **Step 3: Verify**

Run: `npm run test:server` (analyzer tests) — expect green. Then `git grep -iE "Wren|Marlow|Oduvan|Lessom|The Drowning Bell" -- server/src/routes/analysis.ts` → no matches.
Commit `refactor(server): replace the Hollow Tide examples in the analyzer prompt + tests`.

---

## Phase 3: Frontend mock data (Cat 3)

**Files (2 + tests):** `src/data/drift.ts`, `src/lib/api.ts` (mock book entries like `mock-book-The Drowning Bell` + comments), plus any frontend `*.test.tsx` asserting those names.

- [ ] **Step 1: Scrub**
```bash
node scripts/scrub-the Hollow Tide.mjs --write src/data/drift.ts src/lib/api.ts
```
Also rename id slugs: `mock-book-The Drowning Bell` → `mock-book-the-drowning-bell` (the codemod should map `The Drowning Bell` in slugs too; verify the slug form `mock-book-<x>` is handled or hand-fix).

- [ ] **Step 2: Update frontend tests**
```bash
git grep -il "Wren\|Marlow\|The Drowning Bell\|mock-book-The Drowning Bell" -- 'src/**/*.test.tsx' 'src/**/*.test.ts'
```
Scrub those files too; reconcile assertions.

- [ ] **Step 3: Verify**

Run: `npm test` (frontend) → green. `git grep -iE "Wren|Marlow|The Drowning Bell|The Tidewatcher's Oath|Saltgrave" -- src/data/drift.ts src/lib/api.ts` → no matches. Sanity-check mock mode still renders (`npm run dev`, spot-check the library). Commit `mocks(frontend): owned books/characters in drift + api mock data`.

---

## Phase 4: Server test fixtures (Cat 4 — the big one, ~62 files)

**Files:** ~62 `server/src/**/*.test.ts` (enumerate: `git grep -il "Wren\|Marlow\|The Drowning Bell\|Oduvan\|Lessom\|Casper\|Hart\|Brann\|Maerin\|Saltgrave\|exile\|The Tidewatcher's Oath\|unlocked\|legacy" -- 'server/src/**/*.test.ts'`).

- [ ] **Step 1: Classify pure-rename vs. re-fixture**

Position/length-sensitive tests break under rename (different name lengths shift char offsets). Find them:
```bash
git grep -lnE "pos(ition)?[: ]+[0-9]{3,}|charIndex|offset[: ]+[0-9]+|substring\(|slice\([0-9]" -- 'server/src/**/*.test.ts' | xargs git grep -lE "Wren|Marlow" 2>/dev/null
```
Mark these for **manual re-derivation** (Step 3). Everything else is pure-rename (Step 2).

- [ ] **Step 2: Codemod the bulk**

Run the codemod across all Cat-4 test files EXCEPT the position-sensitive set:
```bash
node scripts/scrub-the Hollow Tide.mjs --write $(git grep -il "Wren\|Marlow\|The Drowning Bell\|Oduvan\|Lessom\|Casper\|Hart\|Brann\|Maerin\|Saltgrave\|exile\|The Tidewatcher's Oath\|unlocked\|legacy" -- 'server/src/**/*.test.ts')
```
Because the codemod renames inline fixture text AND the assertions consistently, count/occurrence-based expectations stay correct.

- [ ] **Step 3: Re-derive position-sensitive tests**

For each file flagged in Step 1, after renaming, recompute the char offsets against the renamed fixture text (the name-length delta shifts them). Where feasible, prefer asserting on a substring/anchor rather than a hardcoded integer to avoid future fragility.

- [ ] **Step 3b: Manual context-only pass (the ⚠️ common words)**

The codemod left `Exile`/`Unlocked`/`Legacy`/`Flashback`/`Foster` untouched. Grep each in the Cat-4 files and rename **only** the occurrences that genuinely refer to the the Hollow Tide book/surname (almost always adjacent to other the Hollow Tide names):
```bash
git grep -nE "\b(Exile|Unlocked|Flashback)\b" -- 'server/src/**/*.test.ts'   # review each
git grep -nE "\bFoster\b" -- 'server/src/**/*.test.ts'                         # surname → Sparrow
```
Do **not** touch lowercase `legacy`/`exile`/`unlocked` (code terms). `Legacy` the
book is rare in tests; confirm by eye before any edit.

- [ ] **Step 4: Verify**
```bash
npm run test:server && npm run test:server-slow
# Gate greps the UNAMBIGUOUS tokens only (common words excluded by design):
git grep -iE "\b(Wren|Marlow|Oduvan|Garrow|Lessom|Casper|Brann|Maerin|Berrin|Sela|Edda|Hespa|Singe|Vane|Wick|The Drowning Bell|The Tidewatcher's Oath|Saltgrave|keeper of the lost)\b" -- 'server/src/**/*.test.ts'
```
Expected: all server tests green; gate grep returns **no matches**. (Eyeball the
remaining `Exile`/`Legacy`/`Foster` hits are all non-the Hollow Tide.) Commit `test(server): re-fixture the server suite onto owned Coalfall/Hollow Tide content`.

> This phase may warrant splitting into 2–3 PRs by directory (`analyzer`+`routes`, `tts`+`store`, `workspace`+`audio`+`export`+`parsers`+`handoff`) to keep each review tractable. The acceptance gate per PR is the same (scoped grep clean + that subtree's tests green).

---

## Phase 5: Docs — pointer + prose together (Cat 1 + Cat 5)

**Files:** `CLAUDE.md` + ~45 `docs/**/*.md` (`git grep -il "Marlow\|Wren\|bonus Marlow story\|The Drowning Bell\|keeper of the lost" -- 'CLAUDE.md' 'docs/**/*.md'`).

- [ ] **Step 1: Repoint the canonical manuscript**

The manuscript-path replacement is **a mapping entry** (added in Phase 0): both
`C:\Users\dudar\Downloads\the Coalfall Commission.txt` and `~/Downloads/the Coalfall Commission.txt`
→ `server/src/__fixtures__/the-coalfall-commission.md`. So the same `--write`
codemod handles names, books, AND the path:
```bash
node scripts/scrub-the Hollow Tide.mjs --write CLAUDE.md $(git grep -il "Marlow\|Wren\|bonus Marlow\|The Drowning Bell\|keeper of the lost\|Saltgrave\|exile\|The Tidewatcher's Oath\|unlocked" -- 'docs/**/*.md')
```
Then hand-edit CLAUDE.md's "Canonical end-to-end manuscript" block prose (it is now committed + owned; drop the "do not commit — copyrighted" caveat).

- [ ] **Step 2: Historicity sweep**

Per the convention: in archived plans recording real past runs (observed char lists, "Ch44 pos 37588"), the codemod replaces the *name* — review the diff and **do not** invent Coalfall-specific numbers. Where a sentence would read as a fabricated Coalfall run, soften to "(historical run against the prior test manuscript)" rather than asserting it happened against Coalfall.

Also do the **context-only book pass** here (the codemod skipped `Exile`/`Unlocked`/`Legacy`/`Flashback`): in *docs prose* these usually DO mean the the Hollow Tide book (e.g. "Exile ch56", "The Drowning Bell reusing The Tidewatcher's Oath"). Rename those occurrences by hand to the owned titles; still leave lowercase code-term `legacy` alone if any appears in docs.

- [ ] **Step 3: Verify**
```bash
# Unambiguous tokens must be zero; eyeball remaining Exile/Legacy hits are non-the Hollow Tide.
git grep -iE "\b(Marlow|Wren|bonus Marlow story|The Drowning Bell|keeper of the lost|Saltgrave|The Tidewatcher's Oath|Oduvan|Garrow|Lessom|Casper)\b" -- 'CLAUDE.md' 'docs/**/*.md'
```
Expected: **no matches**. (Docs-only PR → CI doc-fast-path applies.) Commit `docs(docs): repoint canonical manuscript + scrub the Hollow Tide from all docs`.

---

## Phase 6: Multilingual fixture wiring (Cat 6)

**Files:** `e2e/language-detection.spec.ts` + any server test / fixture that fed it non-English the Hollow Tide text; references in `docs/features/162-fs2-multilanguage.md`, `docs/features/165-*.md`.

- [ ] **Step 1: Point the language fixtures at the Russian Coalfall excerpt**

Replace the non-English the Hollow Tide fixture content/reference with `server/src/__fixtures__/the-coalfall-commission.ru.md` (or an inline excerpt from it). Update assertions that checked specific the Hollow Tide Russian strings to Coalfall Russian strings.

- [ ] **Step 2: Verify**
```bash
npm run test:e2e -- language-detection
git grep -iE "Marlow|Wren" -- e2e/language-detection.spec.ts docs/features/162-fs2-multilanguage.md
```
Expected: language-detection e2e green; no the Hollow Tide matches. Commit `e2e(e2e): owned Russian Coalfall fixture for language detection`.

---

## Final verification (after all phases)

- [ ] **Repo-wide grep is clean (UNAMBIGUOUS tokens):**
```bash
git grep -iE "\b(Wren|Marlow|Oduvan|Garrow|Lessom|Casper|Brann|Maerin|Berrin|Sela|Edda|Hespa|Singe|Vane|Wick|The Drowning Bell|The Tidewatcher's Oath|Saltgrave|keeper of the lost|bonus Marlow story)\b" -- ':!node_modules' ':!docs/superpowers/plans/2026-06-12-Marlow-scrub.md' ':!docs/test-book/the Hollow Tide-to-coalfall-mapping.md'
```
Expected: **no matches** (except this plan + the mapping doc, which name them deliberately).
- [ ] **Context-only words audited:** the remaining `Exile`/`Unlocked`/`Legacy`/`Flashback`/`Foster` hits are each confirmed non-the Hollow Tide (code terms / the verb), per Phase 4 Step 3b + Phase 5 Step 2.
- [ ] **Full battery:** `npm run verify` green.
- [ ] **Spec status → delivered;** move the scope doc note. Update `CLAUDE.md` testing section already done in Phase 5.

## Self-review notes

- `Hart` (3 letters) and `Brann`, `Hart`, `Pell` are short — ensure the codemod's word-boundary regex doesn't hit substrings (`Dexterity`, `indexed`). The Phase-0 test pins `\b` behaviour; add `Hart`-specific cases.
- `Foster` → `Sparrow` only as a standalone surname; guard against "foster" the verb (lowercase) — check the ~128 `Foster` hits are all the surname before blanket-renaming (a Phase-0/Phase-4 spot check).
- `Pell`/`Hart`/`Sela`/`Wren` are **owned** names already present (Coalfall) — the codemod must not double-map them; the mapping table has no owned-name keys, so this is safe by construction, but verify no the Hollow Tide→owned target collides with a *different* the Hollow Tide source.
