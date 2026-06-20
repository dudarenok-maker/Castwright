# English narrator-default attribution guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop English close-third-person narration ("She was lost.") from being voiced in a character's voice by generalizing the existing deterministic narrator-default guard to English, and flag each demoted block as low-confidence for review.

**Architecture:** The guard already exists for non-English (`server/src/analyzer/narrator-default.ts`). We (1) extend its `isSpokenLine` predicate to recognize smart single-quote dialogue, (2) replace the non-English-gated `applyNonEnglishNarratorDefault` with a language-agnostic `applyNarratorDefault` that demotes non-spoken character lines to `narrator` and clamps the *first* sentence of each demoted run to confidence `0.5` (so the Confirm-view low-confidence navigator gets one review stop per block, not one per sentence), and update the single call site in the same commit. Pure functions, no I/O, no model calls.

**Tech Stack:** TypeScript, Vitest (node env), server-side analyzer.

**Spec:** `docs/superpowers/specs/2026-06-20-english-narrator-default-attribution-design.md`

## Global Constraints

- **Commit convention:** `<type>(<scope>): <subject>` — use scope `server` (e.g. `feat(server): …`). Enforced by `.husky/commit-msg`.
- **No commit may leave the tree non-compiling.** The export rename touches both `narrator-default.ts` and its importer `analysis.ts`; they are changed together in one commit (Task 2), with a `typecheck` gate before committing. Pre-commit does NOT run typecheck (it is pre-push only), so run it explicitly.
- **Demote-only at the sentence level:** the guard sets a non-spoken sentence's `characterId` to `narrator`; it NEVER reassigns a quoted line to a different speaker and NEVER promotes `narrator` → character. (It DOES lower line counts, which can fold/drop a character — intended; see Task 3.)
- **`'narrator'` is the always-present fallback id** and must stay a valid roster id (it is — `analysis.ts:1044-1045`, `:4940`). Guard output is therefore invisible to the `attribution_drift` counter.
- **All common quote conventions (defense in depth).** Recognize double, smart-single `'…'`, straight-single `'…'` (leading + word-boundary-anchored embedded), guillemet, and dash. The boundary anchor is what keeps straight `'` from colliding with apostrophes (`don't`, `dogs'`).
- **One review stop per demoted block:** clamp only the FIRST override in each contiguous demoted run to `0.5`; later overrides in the run are demoted but keep their model confidence.
- **`Math.min`, not overwrite:** `confidence = Math.min(existing ?? 1, 0.5)` so a line the model already rated below 0.5 keeps its lower value.
- **Run server tests** for a single file: `cd server && npx vitest run src/analyzer/narrator-default.test.ts`. Full server suite from repo root: `npm run test:server` (note: the root scripts `test:server`/`test:server-slow` map to the server package's `test`/`test:slow`).
- Branch: `feat/server-english-narrator-default` (already cut).

---

## Preflight — informational (not a blocker)

Quote convention is no longer a gate: Task 1 hardens `isSpokenLine` to cover
double, smart-single, **straight-single**, guillemet, and dash conventions
(defense in depth — books arrive from arbitrary `.env` locations in every style).
A glance at a real _Scepter_ dialogue line is still useful to sanity-check the
live result, but no convention blocks the build.

- [ ] (Optional) Noted _Scepter_'s quote style for the manual-acceptance check.

---

## Task 1: Harden `isSpokenLine` to all common quote conventions (defense in depth)

**Files:**
- Modify: `server/src/analyzer/narrator-default.ts:31-38` (the `isSpokenLine` predicate)
- Test: `server/src/analyzer/narrator-default.test.ts` (add to the existing `describe('isSpokenLine')` block, after line 46)

**Interfaces:**
- Produces: `isSpokenLine(text: string): boolean` — unchanged signature; now also returns `true` for leading smart single `'` (U+2018) and straight single `'`, embedded smart-single `'…'` (U+2018…U+2019), and word-boundary-anchored embedded straight-single `'…'` spans. Apostrophes (`don't`, `O'Brien`, `dogs'`) do NOT trigger it.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('isSpokenLine', () => { … })` in `server/src/analyzer/narrator-default.test.ts`:

```ts
it('treats smart single-quote dialogue as spoken (UK/Irish typeset convention)', () => {
  expect(isSpokenLine('‘I’m lost,’ she said.')).toBe(true); // leading U+2018
  expect(isSpokenLine('She said ‘this way’ firmly.')).toBe(true); // embedded U+2018…U+2019
});
it('treats straight single-quote dialogue as spoken (leading + boundary-anchored embedded)', () => {
  expect(isSpokenLine("'I'm lost,' she said.")).toBe(true); // leading straight '
  expect(isSpokenLine("She said 'go away' angrily.")).toBe(true); // embedded, boundary-anchored
  expect(isSpokenLine("'Aye, Captain,'")).toBe(true); // leading-only spoken split
});
it('a single quote used as an apostrophe does NOT make narration spoken', () => {
  expect(isSpokenLine('She didn’t know where she was.')).toBe(false); // smart apostrophe (lone U+2019)
  expect(isSpokenLine("She didn't know where she'd been.")).toBe(false); // straight apostrophes, word-internal
  expect(isSpokenLine("The dogs' bones lay by the cats' bowls.")).toBe(false); // possessive apostrophes
  expect(isSpokenLine("O'Brien walked past the corner.")).toBe(false); // name apostrophe
});
it('narration quoting a sign with straight double quotes still reads as spoken (documented false-negative)', () => {
  expect(isSpokenLine('She read the sign that said "Exit".')).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/analyzer/narrator-default.test.ts -t "single-quote"`
Expected: FAIL — `'I'm lost,' she said.` (smart and straight) currently returns `false`.

- [ ] **Step 3: Implement the predicate extension**

In `server/src/analyzer/narrator-default.ts`, update the quote checks in `isSpokenLine` (currently lines 35-36) to:

```ts
  if (/^[«"“‘']/.test(t)) return true; // any opening quote: guillemet / straight+smart double / smart+straight single
  if (/«[^»]+»/.test(t) || /"[^"]+"/.test(t) || /“[^”]+”/.test(t) || /‘[^’]+’/.test(t)) return true; // embedded span: guillemet / straight+smart double / smart single
  // embedded STRAIGHT single, word-boundary-anchored: opens after start/space/bracket/dash, closes before space/punct.
  // Avoids apostrophes (don't, O'Brien, dogs') whose ' is never at a word boundary.
  if (/(?:^|[\s([{<«—–-])'(?=\S)[^']*?\S'(?=[\s.,!?;:)\]}>»]|$)/.test(t)) return true;
```

Leave the leading-dash and HTML-entity checks (lines 32-34) unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run src/analyzer/narrator-default.test.ts`
Expected: PASS — all `isSpokenLine` tests green (the new convention/apostrophe cases plus the existing dash/quote/false-positive cases at lines 13-46).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/narrator-default.ts server/src/analyzer/narrator-default.test.ts
git commit -m "feat(server): harden isSpokenLine to all common quote conventions (single/double/guillemet/dash)"
```

---

## Task 2: Add `applyNarratorDefault` and wire it into the route (single commit)

**Files:**
- Modify: `server/src/analyzer/narrator-default.ts` — update the module header comment (lines 1-18); remove the `isNonEnglish` import (line 21); remove `applyNonEnglishNarratorDefault` (lines 48-57); add `applyNarratorDefault`.
- Modify: `server/src/routes/analysis.ts:13` (import) and `:1558-1563` (comment + single call site).
- Test: `server/src/analyzer/narrator-default.test.ts` (replace the `describe('applyNonEnglishNarratorDefault')` block, lines 72-87).

**Interfaces:**
- Consumes: `isSpokenLine` (Task 1); the module const `NARRATOR_ID = 'narrator'` (line 23).
- Produces: `applyNarratorDefault(sentences: SentenceOutput[]): SentenceOutput[]` — runs for ALL languages; demotes each non-spoken **override** (model-assigned real character) to `narrator`; clamps the first override of each contiguous demoted run to `Math.min(existing ?? 1, 0.5)`; leaves spoken lines and pre-existing-narrator lines untouched (same reference). `forceNarratorOnNonSpokenLines` is kept, unchanged and field-preserving.

> **Why one commit:** removing `applyNonEnglishNarratorDefault` while `analysis.ts` still imports it leaves the tree non-compiling. The function and its only importer are changed together so every commit builds.

- [ ] **Step 1: Write the failing tests**

In `server/src/analyzer/narrator-default.test.ts`, change the import (lines 3-7) from `applyNonEnglishNarratorDefault` to `applyNarratorDefault`, and **replace** the entire `describe('applyNonEnglishNarratorDefault', …)` block (lines 72-87) with:

```ts
describe('applyNarratorDefault', () => {
  it('runs for English: demotes non-spoken character lines to narrator, leaves spoken lines', () => {
    const en = [s(1, 'stephanie', 'She was lost.'), s(2, 'stephanie', '"Hard to starboard,"')];
    expect(applyNarratorDefault(en).map((x) => x.characterId)).toEqual(['narrator', 'stephanie']);
  });

  it('clamps only the FIRST override in a contiguous demoted run to 0.5', () => {
    const run = [
      s(1, 'stephanie', 'She was lost.'),
      s(2, 'stephanie', 'She turned away from the dead end.'),
      s(3, 'stephanie', 'She tried to remember the way.'),
    ];
    const out = applyNarratorDefault(run);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'narrator', 'narrator']);
    expect(out.map((x) => x.confidence)).toEqual([0.5, 0.9, 0.9]);
  });

  it('a spoken line resets the run so each demoted block gets its own single flag', () => {
    const seq = [
      s(1, 'stephanie', 'She was lost.'),       // override -> clamp 0.5
      s(2, 'stephanie', 'She turned away.'),     // override -> 0.9
      s(3, 'stephanie', '"This way,"'),          // spoken -> reset
      s(4, 'stephanie', 'She walked on.'),       // override -> clamp 0.5 (new run)
    ];
    const out = applyNarratorDefault(seq);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'narrator', 'stephanie', 'narrator']);
    expect(out.map((x) => x.confidence)).toEqual([0.5, 0.9, 0.9, 0.5]);
  });

  it('leaves pre-existing narrator lines untouched and they do not consume the clamp slot', () => {
    const seq = [
      s(1, 'narrator', 'The hall was dark.'),  // already narrator
      s(2, 'stephanie', 'She was lost.'),       // first override of the run -> 0.5
    ];
    const out = applyNarratorDefault(seq);
    expect(out[0]).toBe(seq[0]); // unchanged reference
    expect(out[1].characterId).toBe('narrator');
    expect(out[1].confidence).toBe(0.5);
  });

  it('clamp is min, not overwrite: a model confidence already below 0.5 stays', () => {
    const low = [
      { id: 1, chapterId: 1, characterId: 'stephanie', text: 'She was lost.', confidence: 0.3 } as SentenceOutput,
    ];
    expect(applyNarratorDefault(low)[0].confidence).toBe(0.3);
  });

  it('demotes non-English narration too AND now flags it (both-language flag)', () => {
    const ru = [s(1, 'egor', 'Егор побежал.'), s(2, 'woman', '— Стой!')];
    const out = applyNarratorDefault(ru);
    expect(out.map((x) => x.characterId)).toEqual(['narrator', 'woman']);
    expect(out[0].confidence).toBe(0.5); // previously silent, now flagged
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run src/analyzer/narrator-default.test.ts -t "applyNarratorDefault"`
Expected: FAIL — `applyNarratorDefault` is not exported / not defined.

- [ ] **Step 3: Update the module header comment and the appliers in `narrator-default.ts`**

1. Replace the module header comment (lines 1-18) so it no longer claims non-English-only gating. Use:

```ts
/* Deterministic narrator-default heuristic (plan 221 Wave A; generalized to all
   languages 2026-06-20).

   The per-sentence attribution model mislabels third-person NARRATION as the
   named character (e.g. "She was lost." -> stephanie), which would read
   narration in that character's voice. The spoken-vs-narration distinction is
   mechanical, so we decide it in code: any sentence that is NOT a spoken line is
   forced to narrator. Runs for English too (the model ignores the same rule in
   the skill prompt).

   A spoken line begins with a dialogue dash or any opening quote, OR contains a
   quoted span (double / guillemet / smart-single / boundary-anchored
   straight-single). Everything else is narration. Demote-only at the sentence
   level: it never reassigns a quoted line and never promotes narrator->character
   (it does lower line counts, which fold/reconcile consume downstream). Coverage
   is unaffected (the coverage guard keys on sentence text, not characterId).
   Pure: no I/O, no model calls. */
```

**ASCII-only by design** — write this comment exactly as shown (no smart quotes, no
Cyrillic, no arrows). The only non-ASCII in this file lives in the `isSpokenLine`
regex, which Task 2 does NOT touch.

2. Delete the `import { isNonEnglish } from '../tts/language.js';` line (line 21).
3. Delete the JSDoc + `applyNonEnglishNarratorDefault` function (lines 48-57 — the doc is 48-50, the function 51-57).
4. Add (keep `forceNarratorOnNonSpokenLines` exactly as-is). Note: after this commit `forceNarratorOnNonSpokenLines` is no longer called by production code — it is retained intentionally as the field-preserving primitive exercised by the `:65-69` and `:89-124` tests. Do NOT delete it as "dead code."

```ts
/** Apply the narrator-default heuristic for ALL languages. Each non-spoken
    sentence whose model-assigned characterId is a real character is demoted to
    `narrator`; the FIRST such override in each contiguous demoted run has its
    confidence clamped to <= 0.5 so the Confirm-view low-confidence navigator
    gets one review stop per block (not one per sentence). Spoken lines and
    pre-existing-narrator lines are returned by reference, untouched. Pure. */
export function applyNarratorDefault(sentences: SentenceOutput[]): SentenceOutput[] {
  let clampedThisRun = false;
  return sentences.map((s) => {
    if (isSpokenLine(s.text)) {
      clampedThisRun = false;
      return s;
    }
    if (s.characterId === NARRATOR_ID) return s; // already narrator — not an override
    if (!clampedThisRun) {
      clampedThisRun = true;
      return { ...s, characterId: NARRATOR_ID, confidence: Math.min(s.confidence ?? 1, 0.5) };
    }
    return { ...s, characterId: NARRATOR_ID };
  });
}
```

- [ ] **Step 4: Update the call site in `analysis.ts`**

1. Change the import at `server/src/routes/analysis.ts:13` from:

```ts
import { applyNonEnglishNarratorDefault } from '../analyzer/narrator-default.js';
```

to:

```ts
import { applyNarratorDefault } from '../analyzer/narrator-default.js';
```

2. Replace the comment + call site at `server/src/routes/analysis.ts:1558-1563` (the comment ending "No-op for English. Runs AFTER coverage…" and the `result.sentences = applyNonEnglishNarratorDefault(...)` line) with:

```ts
  /* Deterministic narrator-default: force non-spoken sentences to `narrator`
     and flag the first of each demoted block low-confidence. Runs for ALL
     languages, AFTER coverage (coverage keys on text, not characterId, so the
     verdict is unchanged) and UPSTREAM of fold/reconcile. */
  result.sentences = applyNarratorDefault(result.sentences);
  return result;
```

- [ ] **Step 5: Type-check (catches the cross-file rename)**

Run: `npm run typecheck`
Expected: PASS — no remaining reference to `applyNonEnglishNarratorDefault` in compiled code. If it reports the old name, run `git grep -n "applyNonEnglishNarratorDefault" -- 'server/src/**'` and fix each hit.

- [ ] **Step 6: Run the analyzer tests**

Run: `cd server && npx vitest run src/analyzer/narrator-default.test.ts`
Expected: PASS — the new `applyNarratorDefault` block plus the unchanged `isSpokenLine`, `forceNarratorOnNonSpokenLines`, and fold-interaction blocks (the latter still call `forceNarratorOnNonSpokenLines`, which is unchanged).

- [ ] **Step 7: Commit**

```bash
git add server/src/analyzer/narrator-default.ts server/src/analyzer/narrator-default.test.ts server/src/routes/analysis.ts
git commit -m "feat(server): run language-agnostic narrator-default guard with per-block low-confidence flag"
```

---

## Task 3: Pin the cast-roster effect (corrected invariant) for English

**Files:**
- Test: `server/src/analyzer/narrator-default.test.ts` (add to the existing `describe('narrator-default + foldMinorCast interaction')` block, after line 124)

**Interfaces:**
- Consumes: `applyNarratorDefault` (Task 2), `foldMinorCast` (already imported at test line 8).

This task locks the spec's corrected invariant: demoting a mostly-narrated character's lines lowers their count and can fold/drop them — the *intended* outcome — while a separately-quoted character keeps her slot. It uses the real `applyNarratorDefault` path (the existing Russian fold tests use the lower-level `forceNarratorOnNonSpokenLines`).

- [ ] **Step 1: Write the tests**

Add inside `describe('narrator-default + foldMinorCast interaction', () => { … })`:

```ts
it('English: a character whose only lines are demoted narration folds out (intended)', () => {
  const sentences = [
    s(1, 'extra', 'A passer-by walked past.'),
    s(2, 'extra', 'He paused at the corner.'),
    s(3, 'extra', '"What?"'), // one real quoted line
  ];
  const chars = [
    { id: 'narrator', name: 'Narrator', role: 'narrator', gender: 'neutral' },
    { id: 'extra', name: 'Passer-by', role: 'Passerby', gender: 'male' },
  ] as any;
  const fixed = applyNarratorDefault(sentences); // 2 narration -> narrator, 1 quoted stays
  const folded = foldMinorCast(chars, fixed, { minLines: 3 });
  expect(folded.rewrites['extra']).toBe('unknown-male'); // 1 dialogue line < 3 -> folded (correct)
});

it('English: a character with >= minLines real quoted lines survives the fold', () => {
  const sentences = [
    s(1, 'stephanie', 'She was lost.'),
    s(2, 'stephanie', 'She turned away.'),
    s(3, 'stephanie', '"This way,"'),
    s(4, 'stephanie', '"No, wait,"'),
    s(5, 'stephanie', '"Here."'),
  ];
  const chars = [
    { id: 'narrator', name: 'Narrator', role: 'narrator', gender: 'neutral' },
    { id: 'stephanie', name: 'Stephanie', role: 'Protagonist', gender: 'female' },
  ] as any;
  const fixed = applyNarratorDefault(sentences); // 2 narration -> narrator, 3 quoted stay
  const folded = foldMinorCast(chars, fixed, { minLines: 3 });
  expect(folded.characters.some((c) => c.id === 'stephanie')).toBe(true); // survived (3 quoted lines)
  expect(folded.rewrites['stephanie']).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests**

Run: `cd server && npx vitest run src/analyzer/narrator-default.test.ts` (run the whole file — do NOT use `-t "English"`; that substring also matches Task 2's "both-language" test and a zero-match typo would exit 0 and false-pass).
Expected: PASS — these assert behavior already produced by Tasks 1-2 + `foldMinorCast` (a bare quoted line does not earn `proseTagged` protection, so `extra` with 1 line < `minLines` folds to `unknown-male`; `stephanie` with 3 quoted lines survives). If either FAILS, the fold interaction differs from the spec — STOP and reconcile against `fold-minor-cast.ts:303,356,362` before forcing the assertion.

- [ ] **Step 3: Run the full analyzer test file**

Run: `cd server && npx vitest run src/analyzer/narrator-default.test.ts`
Expected: PASS — all blocks green.

- [ ] **Step 4: Commit**

```bash
git add server/src/analyzer/narrator-default.test.ts
git commit -m "test(server): pin English cast-roster fold/drop effect of the narrator-default guard"
```

---

## Task 4: Full verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-06-20-english-narrator-default-attribution-design.md` (frontmatter `status:` → `active`)

- [ ] **Step 1: Run the full server suite**

Run: `npm run test:server`
Expected: PASS — no regressions across the analyzer/routes tests. (`narrator-default.test.ts` is in the main config, not the slow split — only `gemini.test.ts` is routed to `test:server-slow`.)

- [ ] **Step 2: Confirm no stale CODE references remain**

Run: `git grep -n "applyNonEnglishNarratorDefault" -- 'server/src/**'`
Expected: **no output.** (The old name still appears intentionally in historical `docs/**` plans/feature notes — do NOT rewrite those.)

- [ ] **Step 3: Run the full pre-push battery**

Run: `npm run verify`
Expected: PASS — typecheck + all tests + e2e + build green.

- [ ] **Step 4: Mark the spec active**

In `docs/superpowers/specs/2026-06-20-english-narrator-default-attribution-design.md`, change `- **Status:** draft` to `- **Status:** active`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-20-english-narrator-default-attribution-design.md
git commit -m "docs(docs): mark narrator-default spec active after implementation"
```

---

## Manual acceptance (after merge, on the GPU box)

Not a code task — the live check that closes the loop:

1. Re-run analysis on the _Scepter of the Ancients_ chapter that showed the Stephanie misattribution (Confirm view).
2. Confirm the "She was lost." narration block is attributed to **narrator**, and the block surfaces as **one** "Low confidence" review stop (first sentence), not one per sentence.
3. Confirm real dialogue (whichever quote style the manuscript uses) still carries its character voice.

---

## Self-Review (completed by plan author)

- **Spec coverage:** Component 1 → Tasks 1-2; Component 2 (first-of-run clamp, both languages) → Task 2; corrected cast invariant → Task 3; drift-guard safety → Global Constraints + the `narrator`-is-valid fact (Task 2's output is only `narrator`/spoken ids); verification gates → Preflight + Task 4 Step 2; single-quote no-regression → Task 1 + Task 2 spoken-line assertions; scare-quote false-negative → Task 1 Step 1 test 3. Non-goals (no chunking, no prompt text, no setting) → nothing in the plan touches them.
- **No broken commits:** the rename + importer update share one commit (Task 2) with a typecheck gate (Step 5). Verified the only `server/src` importer is `analysis.ts:13`.
- **Placeholder scan:** none — every code step shows the actual code; every run step shows the command + expected result.
- **Type consistency:** `applyNarratorDefault(sentences: SentenceOutput[]): SentenceOutput[]` used identically in Tasks 2, 3; `forceNarratorOnNonSpokenLines` kept unchanged; `NARRATOR_ID` is the existing module const.
