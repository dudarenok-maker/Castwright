# Keefe / KotLC → Coalfall Scrub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Remove all *Keeper of the Lost Cities* (third-party copyright) content — the codebase's de-facto fixture/mock dataset — and replace it with Castwright-owned content (The Coalfall Commission + the Hollow Tide series), committing an owned canonical e2e manuscript (+ a Russian variant for multilingual).

**Architecture:** A single fixed **mapping table** (KotLC entity → owned entity) applied consistently. Renaming *both* a fixture's input text and its assertions preserves most prose-derived tests; only **char-position** assertions break (different name lengths shift offsets) and need re-derivation. Mechanical bulk via a word-boundary, case-preserving codemod; the position-sensitive analyzer subset by hand.

**Tech Stack:** TypeScript (Vitest server + frontend), Node codemod script, Markdown docs.

**Scope:** `docs/superpowers/specs/2026-06-12-keefe-scrub-scope.md` (decisions: full scope incl. archived docs; commit owned manuscript; Russian multilingual fixture; historicity = replace-name-keep-point-no-fabricated-numbers).

**Commit scope vocab:** `server` | `frontend` | `mocks` | `docs` | `scripts` | `e2e`. One phase = one PR.

**Conventions for every phase:**
- Work on a branch `chore/keefe-scrub-phaseN-<slug>` off latest `main`; one PR per phase.
- After edits, the phase's **acceptance gate** is: (1) `git grep -i` for the KotLC names in that phase's scope returns **zero**, and (2) the relevant test battery passes.
- Run server tests with `npm run test:server` (+ `test:server-slow` for the 6 routed files); frontend with `npm test`; e2e with `npm run test:e2e`.

## Subagent-driven execution notes (controller reads this)

- **One subagent per phase, strictly sequential (0 → 6).** Phases 1–6 all depend on Phase 0's codemod + mapping doc being on disk and correct, so Phase 0 cannot be parallelised or skipped.
- **Scene-setting to paste into every dispatch:** package is `castwright` (frontend at repo root, server under `server/`); the codemod is `scripts/scrub-kotlc.mjs` and the canonical mapping is `docs/test-book/kotlc-to-coalfall-mapping.md` (both created in Phase 0); the phase's **Files** + **acceptance gate** define done; touch only files in the phase's scope.
- **Two CONTROLLER CHECKPOINTS (do NOT delegate the sign-off):**
  - **After Phase 0** — manually verify the mapping table has no target collisions, the codemod's guard tests pass (common words untouched, kebab forms handled), and the Russian fixture is a faithful translation. Everything downstream trusts this.
  - **After Phase 4** — the ~62-file server re-fixture is the highest-risk change; review the diff + full `test:server`/`test:server-slow` before merge.
- **Judgment steps carry explicit decision-RULES** (below) so a context-free subagent is deterministic. Where a step says **[controller]**, the subagent stops and hands back for a decision rather than guessing.
- **Model guidance:** Phase 0 (codemod + translation) and Phase 4 (re-derivation) → most capable model; Phases 1, 3, 6 (mechanical codemod + small reconciliation) → standard; Phase 5 (docs, high volume but mechanical) → standard.
- **Per phase = one branch + one PR**, verified, merged before the next phase starts (the next phase greps the post-merge tree).

---

## The mapping table (the linchpin — authored here, finalised in Phase 0)

**Characters** (chosen to preserve token-count/role where a test depends on it; twins/alias/non-human use the Coalfall analogues):

| KotLC | Owned | Note |
|---|---|---|
| Sophie / Sophie Foster | Wren / Wren Sparrow | protagonist; alias analogue |
| Foster (surname) | Sparrow | Wren's in-story alias |
| Keefe / Keefe Sencen | Tam / Tam Hollis | |
| Lord Hunkyhair (Keefe's joke alias) | Sir Singe | owned joke alias |
| Elwin | Oduvan (Master Oduvan) | |
| Fitz | Brann (Brann Weir) | twin analogue |
| Biana | Maerin | |
| Dex | Hart | |
| Sandor | Garrow | owned (bodyguard role) |
| Prentice | Lessom (Father Lessom) | |
| Forkle | Casper (Widow Casper) | |
| Alina / Councillor Alina / Dame Alina | Linnet / Dame Linnet | owned |
| Lord Cassius | Lord Vane | owned (keeps "Lord X") |
| Lady Galvin | Lady Wick | owned (keeps "Lady X") |
| Grizel | Sela | |
| Maruca | Berrin (Berrin Weir) | second twin |
| Marella | Edda | owned |
| Grady | Corvin | owned (father) |
| Edaline | Hespa | owned (mother) |
| Brant | Bram | owned |

**Books / series — UNAMBIGUOUS (safe for the blanket codemod):**

| KotLC | Owned |
|---|---|
| Keeper of the Lost Cities (series) | The Hollow Tide |
| Stellarlune | The Drowning Bell |
| Everblaze | The Tidewatcher's Oath |
| Neverseen | Saltgrave |

**Books — CONTEXT-ONLY (⚠️ common English / code words — NOT in the codemod):**

| KotLC | Owned | Why manual |
|---|---|---|
| Exile | The Ebb | "exile" is a common word |
| Unlocked | The Floodmark | UI/state term |
| Legacy | The Lantern Tide | **114 code files** use "legacy" for legacy format/pairing — must NOT blanket-rename |
| Flashback | The Undertow | common word |
| Foster (surname) | Sparrow | "foster" is also a verb — capitalised-standalone only |

> These are renamed **only by the reviewed manual pass** (Phase 4 Step 3b / Phase 5
> Step 1b), where a human confirms each occurrence genuinely refers to the KotLC
> book/surname. The codemod must **exclude** them.
>
> All owned names above are original (no third-party IP). Coalfall cast names come
> from `brand/test-book/the-coalfall-commission-cast-sheet.md`; the rest are
> fabricated Hollow Tide-universe names.

**Unambiguous CHARACTER tokens** (safe for the codemod): Sophie, Keefe, Elwin,
Sandor, Prentice, Forkle, Fitz, Biana, Maruca, Grizel, Marella, Edaline,
Hunkyhair, Cassius, Galvin, Stellarlune, Everblaze, Neverseen. (`Dex`, `Alina`,
`Grady`, `Brant` are short/common enough to **spot-check** the diff, but `\b`
+ capitalisation makes them low-risk.)

---

## Phase 0: Foundation — commit the manuscript + mapping doc + codemod

**Files:**
- Create: `server/src/__fixtures__/the-coalfall-commission.md` (owned manuscript)
- Create: `server/src/__fixtures__/the-coalfall-commission.ru.md` (Russian variant — Cat 6)
- Create: `docs/test-book/kotlc-to-coalfall-mapping.md` (the canon table above + enumeration)
- Create: `scripts/scrub-kotlc.mjs` (codemod)
- Test: `scripts/tests/scrub-kotlc.test.mjs` (node --test)

- [ ] **Step 1: Commit the owned manuscript fixture**

Copy the owned manuscript out of git-ignored `brand/test-book/` into a committed fixtures path:
```bash
mkdir -p server/src/__fixtures__
cp "brand/test-book/the-coalfall-commission.md" server/src/__fixtures__/the-coalfall-commission.md
```
Confirm it is original/owned prose (header reads "A Castwright original"). This is the committed canonical e2e manuscript.

- [ ] **Step 2: Create the Russian multilingual fixture**

Produce an owned Russian translation of **Chapter One** of the Coalfall manuscript (the language-detection fixture only needs a non-English passage, not the whole book). Write it to `server/src/__fixtures__/the-coalfall-commission.ru.md`. Keep it clearly owned (translation of the owned text). This replaces the Russian *Bonus Keefe Story* used by `e2e/language-detection.spec.ts` + fs-2 multilingual.

> **Subagent rule:** read the Chapter One text from the committed
> `server/src/__fixtures__/the-coalfall-commission.md`, produce a faithful Russian
> translation of it (proper Cyrillic prose, not transliteration), and write it to
> the `.ru.md` path. **[controller]** signs off on translation faithfulness before
> Phase 6 consumes it.

- [ ] **Step 3: Write the mapping doc**

Create `docs/test-book/kotlc-to-coalfall-mapping.md` containing the two tables above verbatim, plus a "completeness" note: the canonical enumeration command (below) and the rule "Coalfall cast first, fabricate owned Hollow Tide names for overflow; never a near-homophone of a KotLC name."

- [ ] **Step 4: Enumerate every KotLC name in use (catch the long tail)**

Run and append any names not already in the table:
```bash
git grep -ohE "\b(Sophie|Keefe|Elwin|Sandor|Prentice|Forkle|Dex|Fitz|Biana|Maruca|Cassius|Grizel|Hunkyhair|Alina|Galvin|Grady|Brant|Marella|Edaline|Foster|Keeper of the Lost Cities|Stellarlune|Unlocked|Legacy|Neverseen|Exile|Everblaze|Flashback)\b" -- ':!node_modules' ':!docs/superpowers/plans' | sort | uniq -c | sort -rn
```
Expected: the names already in the table. **Rule for any straggler** (a KotLC name
not yet mapped): assign an owned target by — (1) reuse a Coalfall cast member whose
role fits, else (2) fabricate an original Hollow Tide-universe name; keep the
`Lord X`/`Lady X`/`Councillor X` *title* and swap only the surname; never pick a
near-homophone of any KotLC name; never reuse an owned target already in the table.
**[controller]** approves added mappings before Step 5 bakes them into the codemod.

- [ ] **Step 5: Write the codemod (TDD)**

Create `scripts/scrub-kotlc.mjs` exporting `scrubText(s)`. Requirements:

- **Only the UNAMBIGUOUS map** (the safe character + book lists above). The
  context-only words (`Exile`/`Unlocked`/`Legacy`/`Flashback`/`Foster`) are
  **explicitly excluded** — a guard test asserts `scrubText('legacy pairing')` is
  unchanged.
- **Word boundaries + case preservation**: `Sophie`→`Wren`, `sophie`→`wren`,
  `SOPHIE`→`WREN`.
- **Longest-key-first**: `Sophie Foster`/`Keefe Sencen`/`Lord Cassius` before the
  single tokens.
- **Kebab/slug forms**: for each mapping, also match the hyphen-joined lowercase
  form — `sophie-foster`→`wren-sparrow`, `keefe-sencen`→`tam-hollis`,
  `mock-book-stellarlune`→`mock-book-the-drowning-bell`. Implement by, for each
  `[from,to]`, registering both the spaced form AND `kebab(from)→kebab(to)`
  (`from.toLowerCase().replace(/ /g,'-')`).
- **Manuscript-path** entries: `…\Bonus Keefe Story.txt` and
  `~/Downloads/Bonus Keefe Story.txt` → `server/src/__fixtures__/the-coalfall-commission.md`.
- A `--write <files...>` CLI that scrubs each file in place (used by every later phase).

Write `scripts/tests/scrub-kotlc.test.mjs` first:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubText } from '../scrub-kotlc.mjs';

test('multi-word before single-word', () => {
  assert.equal(scrubText('Sophie Foster and Sophie'), 'Wren Sparrow and Wren');
  assert.equal(scrubText('Keefe Sencen'), 'Tam Hollis');
});
test('case preservation', () => {
  assert.equal(scrubText('SOPHIE said to keefe'), 'WREN said to tam');
});
test('word boundaries — no mid-word hits', () => {
  assert.equal(scrubText('Fosters philosophiel'), 'Fosters philosophiel');
});
test('books', () => {
  assert.equal(scrubText('Keeper of the Lost Cities: Stellarlune'),
    'The Hollow Tide: The Drowning Bell');
});
test('kebab/slug forms', () => {
  assert.equal(scrubText("id: 'sophie-foster'"), "id: 'wren-sparrow'");
  assert.equal(scrubText('mock-book-stellarlune'), 'mock-book-the-drowning-bell');
});
test('common words are LEFT ALONE (context-only, not codemod)', () => {
  assert.equal(scrubText('the legacy pairing format'), 'the legacy pairing format');
  assert.equal(scrubText('exile the chapter'), 'exile the chapter');
  assert.equal(scrubText('foster a connection'), 'foster a connection');
});
```
Run: `node --test scripts/tests/scrub-kotlc.test.mjs` → FAIL, then implement `scrubText` until PASS.

- [ ] **Step 6: Commit**
```bash
git add server/src/__fixtures__ docs/test-book scripts/scrub-kotlc.mjs scripts/tests/scrub-kotlc.test.mjs
git commit -m "chore(scripts): owned Coalfall fixtures + KotLC→Coalfall mapping + codemod"
```

---

## Phase 1: Code comments (Cat 2a)

**Files (5):** `server/src/analyzer/roster-coverage.ts`, `server/src/routes/voice-match.ts`, `server/src/util/text-match.ts`, `server/src/workspace/series-cast-scan.ts`, `src/modals/drift-report.tsx`

- [ ] **Step 1: Apply the codemod to comments only**

These files use KotLC names *only in comments* (verified — no logic depends). Apply:
```bash
node scripts/scrub-kotlc.mjs --write server/src/analyzer/roster-coverage.ts server/src/routes/voice-match.ts server/src/util/text-match.ts server/src/workspace/series-cast-scan.ts src/modals/drift-report.tsx
```

- [ ] **Step 2: Historicity check**

Review the diff for any comment recording a *real observed value* (e.g. "produced 6 characters: …"). Per the historicity convention: keep the count, replace the names; do not invent new Coalfall-specific values. Hand-fix any that read as a fabricated run.

- [ ] **Step 3: Verify**
```bash
git grep -iE "sophie|keefe|elwin|stellarlune|keeper of the lost" -- server/src/analyzer/roster-coverage.ts server/src/routes/voice-match.ts server/src/util/text-match.ts server/src/workspace/series-cast-scan.ts src/modals/drift-report.tsx
```
Expected: **no matches**. Then `npm run typecheck`. Commit `docs(server,frontend): reword KotLC examples in code comments` (use `chore` if scope mix rejects).

---

## Phase 2: Analyzer prompt examples + tests (Cat 2b)

**Files:** `server/src/routes/analysis.ts` (KotLC names inside the LLM prompt template literals, ~L1140–1147 et al.), `server/src/analyzer/gemini.test.ts`, `server/src/analyzer/ollama.test.ts` (+ any analyzer test asserting prompt substrings)

- [ ] **Step 1: Find prompt-substring assertions first**
```bash
git grep -nE "Sophie|Keefe|FILED BY|Memory Log" -- 'server/src/analyzer/*.test.ts' 'server/src/routes/analysis.test.ts'
```
List every test that asserts a prompt substring containing a KotLC name — those assertions must change in lockstep with the prompt.

- [ ] **Step 2: Scrub the prompt + its tests together**
```bash
node scripts/scrub-kotlc.mjs --write server/src/routes/analysis.ts
node scripts/scrub-kotlc.mjs --write server/src/analyzer/gemini.test.ts server/src/analyzer/ollama.test.ts
```
Then hand-reconcile any test from Step 1 whose assertion didn't get rewritten by the codemod (e.g. partial-string matches).

- [ ] **Step 3: Verify**

Run: `npm run test:server` (analyzer tests) — expect green. Then `git grep -iE "sophie|keefe|elwin|prentice|stellarlune" -- server/src/routes/analysis.ts` → no matches.
Commit `refactor(server): replace KotLC examples in the analyzer prompt + tests`.

---

## Phase 3: Frontend mock data (Cat 3)

**Files (2 + tests):** `src/data/drift.ts`, `src/lib/api.ts` (mock book entries like `mock-book-stellarlune` + comments), plus any frontend `*.test.tsx` asserting those names.

- [ ] **Step 1: Scrub**
```bash
node scripts/scrub-kotlc.mjs --write src/data/drift.ts src/lib/api.ts
```
Also rename id slugs: `mock-book-stellarlune` → `mock-book-the-drowning-bell` (the codemod should map `stellarlune` in slugs too; verify the slug form `mock-book-<x>` is handled or hand-fix).

- [ ] **Step 2: Update frontend tests**
```bash
git grep -il "sophie\|keefe\|stellarlune\|mock-book-stellarlune" -- 'src/**/*.test.tsx' 'src/**/*.test.ts'
```
Scrub those files too; reconcile assertions.

- [ ] **Step 3: Verify**

Run: `npm test` (frontend) → green. `git grep -iE "sophie|keefe|stellarlune|everblaze|neverseen" -- src/data/drift.ts src/lib/api.ts` → no matches. Sanity-check mock mode still renders (`npm run dev`, spot-check the library). Commit `mocks(frontend): owned books/characters in drift + api mock data`.

---

## Phase 4: Server test fixtures (Cat 4 — the big one, ~62 files)

**Files:** ~62 `server/src/**/*.test.ts` (enumerate with the **boundary-safe, unambiguous** token set — never bare `dex`/`legacy`/`exile`, which match `index`/`legacy-format`/etc.: `git grep -ilE "\b(sophie|keefe|stellarlune|elwin|sandor|prentice|forkle|fitz|biana|maruca|grizel|neverseen|everblaze|keeper of the lost)\b" -- 'server/src/**/*.test.ts'`).

- [ ] **Step 1: Flag the position-sensitive subset (don't skip — just note them)**

These assert a *numeric char offset* against fixture prose, which shifts when a name's length changes. Record the list for Step 3:
```bash
git grep -lnE "pos(ition)?[: ]+[0-9]{3,}|charIndex|offset[: ]+[0-9]+|substring\(|slice\([0-9]" -- 'server/src/**/*.test.ts' | sort -u
```
**Rule:** position-sensitive iff it hardcodes an integer offset/index tied (by the assertion or a comment) to a *position in the manuscript text*. Pure occurrence COUNTS (`toHaveLength(3)`, `toBe(10)` "lines spoken") are **not** position-sensitive — they survive the rename unchanged.

- [ ] **Step 2: Codemod ALL Cat-4 files (names everywhere, incl. the flagged ones)**
```bash
node scripts/scrub-kotlc.mjs --write $(git grep -ilE "\b(sophie|keefe|stellarlune|elwin|sandor|prentice|forkle|fitz|biana|maruca|grizel|neverseen|everblaze|keeper of the lost)\b" -- 'server/src/**/*.test.ts')
```
The codemod renames inline fixture text AND assertions consistently, so count/occurrence expectations stay correct. The flagged files get their *names* fixed here too; only their *numeric offsets* remain for Step 3.

- [ ] **Step 3: Re-derive numeric offsets in the flagged files**

For each file from Step 1: `cd server && npx vitest run src/<path>.test.ts`.
**Rule:** the rename is semantics-neutral, so a failure that is *purely a shifted integer offset/index* is fixed by replacing the hardcoded number with the value the run reports as "received" — but **only** for offset/index assertions and **only** when the diff shows a renamed name is the cause. Prefer an anchor (`text.indexOf('Wren')`) over a magic number where trivial. Any failure that is **not** a shifted offset → **[controller]**, stop and surface it.

- [ ] **Step 3b: Manual context-only pass (the ⚠️ common words)**

The codemod left `Exile`/`Unlocked`/`Legacy`/`Flashback`/`Foster` untouched.
```bash
git grep -nE "\b(Exile|Unlocked|Legacy|Flashback|Foster)\b" -- 'server/src/**/*.test.ts'
```
**Rule:** rename a hit to its owned title (context-only table) **iff** the same
`it(...)`/`describe(...)` block OR the same line contains another KotLC name, OR
the token is in a `bookTitle`/`series`/`bookId` field. Otherwise leave it (code
term). `Foster` capitalised-standalone = surname → `Sparrow`. **Never** touch
lowercase `legacy`/`exile`/`unlocked`. Genuinely unsure on a hit → **[controller]**.

- [ ] **Step 4: Verify**
```bash
npm run test:server && npm run test:server-slow
# Gate greps the UNAMBIGUOUS tokens only (common words excluded by design):
git grep -iE "\b(sophie|keefe|elwin|sandor|prentice|forkle|fitz|biana|maruca|grizel|marella|edaline|hunkyhair|cassius|galvin|stellarlune|everblaze|neverseen|keeper of the lost)\b" -- 'server/src/**/*.test.ts'
```
Expected: all server tests green; gate grep returns **no matches**. (Eyeball the
remaining `Exile`/`Legacy`/`Foster` hits are all non-KotLC.) Commit `test(server): re-fixture the server suite onto owned Coalfall/Hollow Tide content`.

> This phase may warrant splitting into 2–3 PRs by directory (`analyzer`+`routes`, `tts`+`store`, `workspace`+`audio`+`export`+`parsers`+`handoff`) to keep each review tractable. The acceptance gate per PR is the same (scoped grep clean + that subtree's tests green).

---

## Phase 5: Docs — pointer + prose together (Cat 1 + Cat 5)

**Files:** `CLAUDE.md` + ~45 `docs/**/*.md` (`git grep -il "keefe\|sophie\|bonus keefe story\|stellarlune\|keeper of the lost" -- 'CLAUDE.md' 'docs/**/*.md'`).

- [ ] **Step 1: Repoint the canonical manuscript**

The manuscript-path replacement is **a mapping entry** (added in Phase 0): both
`C:\Users\dudar\Downloads\Bonus Keefe Story.txt` and `~/Downloads/Bonus Keefe Story.txt`
→ `server/src/__fixtures__/the-coalfall-commission.md`. So the same `--write`
codemod handles names, books, AND the path:
```bash
node scripts/scrub-kotlc.mjs --write CLAUDE.md $(git grep -ilE "\b(keefe|sophie|bonus keefe|stellarlune|keeper of the lost|neverseen|everblaze|elwin|sandor|prentice|forkle)\b" -- 'docs/**/*.md')
```
Then hand-edit CLAUDE.md's "Canonical end-to-end manuscript" block prose (it is now committed + owned; drop the "do not commit — copyrighted" caveat).

- [ ] **Step 2: Historicity sweep**

Per the convention: in archived plans recording real past runs (observed char lists, "Ch44 pos 37588"), the codemod replaces the *name* — review the diff and **do not** invent Coalfall-specific numbers. Where a sentence would read as a fabricated Coalfall run, soften to "(historical run against the prior test manuscript)" rather than asserting it happened against Coalfall.

Also do the **context-only book pass** here (the codemod skipped `Exile`/`Unlocked`/`Legacy`/`Flashback`): in *docs prose* these usually DO mean the KotLC book (e.g. "Exile ch56", "Stellarlune reusing Everblaze"). Rename those occurrences by hand to the owned titles; still leave lowercase code-term `legacy` alone if any appears in docs.

- [ ] **Step 3: Verify**
```bash
# Unambiguous tokens must be zero; eyeball remaining Exile/Legacy hits are non-KotLC.
git grep -iE "\b(keefe|sophie|bonus keefe story|stellarlune|keeper of the lost|neverseen|everblaze|elwin|sandor|prentice|forkle)\b" -- 'CLAUDE.md' 'docs/**/*.md'
```
Expected: **no matches**. (Docs-only PR → CI doc-fast-path applies.) Commit `docs(docs): repoint canonical manuscript + scrub KotLC from all docs`.

---

## Phase 6: Multilingual fixture wiring (Cat 6)

**Files:** `e2e/language-detection.spec.ts` + any server test / fixture that fed it non-English KotLC text; references in `docs/features/162-fs2-multilanguage.md`, `docs/features/165-*.md`.

- [ ] **Step 1: Point the language fixtures at the Russian Coalfall excerpt**

Replace the non-English KotLC fixture content/reference with `server/src/__fixtures__/the-coalfall-commission.ru.md` (or an inline excerpt from it). Update assertions that checked specific KotLC Russian strings to Coalfall Russian strings.

- [ ] **Step 2: Verify**
```bash
npm run test:e2e -- language-detection
git grep -iE "keefe|sophie" -- e2e/language-detection.spec.ts docs/features/162-fs2-multilanguage.md
```
Expected: language-detection e2e green; no KotLC matches. Commit `e2e(e2e): owned Russian Coalfall fixture for language detection`.

---

## Final verification (after all phases)

- [ ] **Repo-wide grep is clean (UNAMBIGUOUS tokens):**
```bash
git grep -iE "\b(sophie|keefe|elwin|sandor|prentice|forkle|fitz|biana|maruca|grizel|marella|edaline|hunkyhair|cassius|galvin|stellarlune|everblaze|neverseen|keeper of the lost|bonus keefe story)\b" -- ':!node_modules' ':!docs/superpowers/plans/2026-06-12-keefe-scrub.md' ':!docs/test-book/kotlc-to-coalfall-mapping.md'
```
Expected: **no matches** (except this plan + the mapping doc, which name them deliberately).
- [ ] **Context-only words audited:** the remaining `Exile`/`Unlocked`/`Legacy`/`Flashback`/`Foster` hits are each confirmed non-KotLC (code terms / the verb), per Phase 4 Step 3b + Phase 5 Step 2.
- [ ] **Full battery:** `npm run verify` green.
- [ ] **Spec status → delivered;** move the scope doc note. Update `CLAUDE.md` testing section already done in Phase 5.

## Self-review notes

- `Dex` (3 letters) and `Fitz`, `Hart`, `Tam` are short — ensure the codemod's word-boundary regex doesn't hit substrings (`Dexterity`, `indexed`). The Phase-0 test pins `\b` behaviour; add `Dex`-specific cases.
- `Foster` → `Sparrow` only as a standalone surname; guard against "foster" the verb (lowercase) — check the ~128 `Foster` hits are all the surname before blanket-renaming (a Phase-0/Phase-4 spot check).
- `Tam`/`Hart`/`Sela`/`Wren` are **owned** names already present (Coalfall) — the codemod must not double-map them; the mapping table has no owned-name keys, so this is safe by construction, but verify no KotLC→owned target collides with a *different* KotLC source.
