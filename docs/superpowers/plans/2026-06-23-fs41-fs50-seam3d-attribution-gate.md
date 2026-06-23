# fs-41/fs-50 Seam 3d — Gate the English-only attribution guard for non-English (§4.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the missing-speaker "roster guard" + the `recover-tagged-lines` narrator-flip **explicitly skip for non-English books** (threading the book language), instead of silently running their English-only `[A-Z]`+verb heuristics — which produce **false positives for German** (every German noun is capitalized) and **false negatives for ES/FR** (verb-before-name inversion). Per spec §4.3, this is the "gate off + document" path; per-language localisation is a tracked follow-up.

**Architecture:** Five pure-ish functions (`validateRosterCoverage`, `validateAttributionCoverage`, `runStage1WithRosterGuard`, `recoverTaggedNarratorLines`, `taggedSpeakerIds`) gain an optional `language` parameter **defaulting to `'en'`** and early-return a no-op (no issues / no flips / empty set) when `isNonEnglish(language)`. The default keeps every existing caller and test English with zero churn; only the real call sites in `analysis.ts` + `fold-minor-cast.ts` are updated to pass the book language.

**Tech Stack:** TypeScript (ESM, `.js` imports), Node 20+, Vitest.

## Global Constraints

- **English behaviour unchanged.** Every existing `roster-coverage.test.ts` / `recover-tagged-lines.test.ts` assertion stays green. They call the functions WITHOUT a `language` arg → the `'en'` default → identical behaviour. Do NOT modify an existing English assertion.
- **The verb list is NOT changed.** `dialogue-verbs.ts`, the `.mjs` hotfix copy, and the `dialogue-verbs-drift.test.mjs` parity test are untouched (this seam gates WHEN the guard runs, not the verbs).
- **Gate predicate:** reuse `isNonEnglish(language)` from `server/src/tts/language.js` (Russian `ru`, Spanish `es`, French `fr`, German `de` all skip; only `en` runs).
- **Document the loss:** each gated function carries a comment + the change is noted in the PR — non-English books lose the missing-speaker safety net (a deliberate v1 tradeoff vs German false positives).
- ESM `.js` imports. Commit `<type>(<scope>): <subject>`. Husky pre-commit runs the server test leg (green, no `--no-verify`). Work from the worktree `C:/Claude/Audiobook-Generator-wt-fs41`, branch `docs/docs-fs41-fs50-seam3d-attribution`.

---

### Task 1: Gate the roster/attribution coverage guard for non-English

**Files:**
- Modify: `server/src/analyzer/roster-coverage.ts` (`validateRosterCoverage`, `validateAttributionCoverage`, `runStage1WithRosterGuard`)
- Modify: `server/src/routes/analysis.ts` (the `runStage1Guarded` wrapper at ~line 529 + its callers at ~:2783/:4608 — thread the book language) and any direct `validateAttributionCoverage` call site
- Test: `server/src/analyzer/roster-coverage.test.ts`

**Interfaces:**
- `validateRosterCoverage(body, rosterNames, thresholds, language?: string)` — `language` defaults to `'en'`; when `isNonEnglish(language)`, returns the "no issues" verdict immediately (read the function's existing return type for the empty/ok shape — e.g. `{ missing: [], ... }` / the `ok` verdict).
- `validateAttributionCoverage(..., language?: string)` — same gate.
- `runStage1WithRosterGuard(opts)` — `opts` gains `language?: string` (default `'en'`), passed to `validateRosterCoverage`.

- [ ] **Step 1: Write the failing tests** — append to `server/src/analyzer/roster-coverage.test.ts`:

```typescript
describe('roster guard — non-English gate (seam 3d)', () => {
  it('skips the roster guard for a German book (no false positives from capitalised nouns)', () => {
    // German prose: every noun is capitalised; "Diener"/"Frau" before a verb would
    // false-flag as missing speakers if the English guard ran.
    const body = '„Ja", sagte der Diener. „Nein", antwortete die Frau. „Schnell", rief der Soldat.';
    const res = validateRosterCoverage(body, new Set<string>(), DEFAULT_THRESHOLDS, 'de');
    expect(res.missing).toEqual([]); // gated off → no missing-speaker flags
  });

  it('still runs the guard for English (default language) — Lessom regression intact', () => {
    // existing English Lessom-style body still flags the missing speaker (no language arg = 'en')
    const body = '"Hello," Lessom said. "Again," Lessom repeated. "Yes," Lessom agreed.';
    const res = validateRosterCoverage(body, new Set<string>(), DEFAULT_THRESHOLDS);
    expect(res.missing.map((m) => m.toLowerCase())).toContain('lessom');
  });
});
```

(Use the actual exported threshold constant / return-field names from the file — read them; the snippet uses `DEFAULT_THRESHOLDS`/`res.missing` as placeholders for whatever the file exports. Match the file.)

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/roster-coverage.test.ts`
Expected: FAIL — the German case currently runs the English guard and flags `Diener`/`Frau`/`Soldat` as missing speakers (`language` param doesn't exist yet).

- [ ] **Step 3: Implement the gate** — in `server/src/analyzer/roster-coverage.ts`:

(a) Import the predicate: `import { isNonEnglish } from '../tts/language.js';`

(b) Add `language: string = 'en'` as the last parameter of `validateRosterCoverage` and `validateAttributionCoverage`; at the top of each body, early-return the no-issues result:

```typescript
// fs-41/fs-50 §4.3 — the [A-Z]+verb roster heuristic is English-only (German
// capitalises every noun → false positives; ES/FR invert verb/name → false
// negatives). Gate it off for non-English; localisation is a follow-up.
if (isNonEnglish(language)) return /* the function's empty/ok verdict */;
```

(c) Add `language?: string` to `runStage1WithRosterGuard`'s `opts` and pass `opts.language ?? 'en'` into the `validateRosterCoverage` call.

(d) In `server/src/routes/analysis.ts`: add `language` to `runStage1Guarded`'s `opts` (line ~529) and pass it through to `runStage1WithRosterGuard`; at the two `runStage1Guarded({...})` call sites (~:2783, ~:4608) pass the in-scope book language (read the file to find the variable — likely `bookLanguage` / `normaliseBookLanguage(state.language)`). If `validateAttributionCoverage` is called directly in `analysis.ts` (grep it), pass the language there too.

- [ ] **Step 4: Run to verify pass — gate + the full English suite**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/roster-coverage.test.ts`
Expected: PASS — the German-skip + English-Lessom cases AND every pre-existing English assertion (they pass no `language` → `'en'` default → unchanged).

- [ ] **Step 5: Typecheck (the analysis.ts threading)**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npm run typecheck`
Expected: PASS — the new optional params + call-site threading are type-consistent.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/roster-coverage.ts server/src/routes/analysis.ts server/src/analyzer/roster-coverage.test.ts
git commit -m "feat(server): gate the English-only roster/attribution guard off for non-English"
```

---

### Task 2: Gate `recover-tagged-lines` (narrator-flip) for non-English

**Files:**
- Modify: `server/src/analyzer/recover-tagged-lines.ts` (`recoverTaggedNarratorLines`, `taggedSpeakerIds`)
- Modify: `server/src/routes/analysis.ts` (the two `recoverTaggedNarratorLines(...)` calls at ~:3925, ~:4929) + `server/src/analyzer/fold-minor-cast.ts` (the `taggedSpeakerIds(...)` call at ~:315)
- Test: `server/src/analyzer/recover-tagged-lines.test.ts`

**Interfaces:**
- `recoverTaggedNarratorLines(sentences, roster, language?: string)` — `language` defaults `'en'`; when `isNonEnglish`, returns `{ sentences, flipped: 0, byId: {} }` (read the actual return shape) — no flips.
- `taggedSpeakerIds(sentences, roster, language?: string)` — when `isNonEnglish`, returns `new Set<string>()`.

- [ ] **Step 1: Write the failing tests** — append to `server/src/analyzer/recover-tagged-lines.test.ts`:

```typescript
describe('recover-tagged-lines — non-English gate (seam 3d)', () => {
  it('does not flip narrator lines for a German book (avoids false re-attribution)', () => {
    // A German narrator line followed by a "Diener sagte"-style tag must NOT be flipped
    // (the English [A-Z]+verb heuristic would mis-attribute it).
    const sentences = /* a narrator sentence + a German-tagged sentence, mirror the English fixtures */;
    const out = recoverTaggedNarratorLines(sentences, roster, 'de');
    expect(out.flipped).toBe(0);
  });
  it('returns no tagged speakers for a non-English book', () => {
    expect(taggedSpeakerIds(sentences, roster, 'de').size).toBe(0);
  });
});
```

(Build the `sentences`/`roster` fixtures by mirroring the existing English fixtures in this test file — read them. The point is: with `'de'`, both functions no-op.)

- [ ] **Step 2: Run to verify failure**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/recover-tagged-lines.test.ts`
Expected: FAIL — `language` param doesn't exist; the functions run the English heuristic.

- [ ] **Step 3: Implement** — in `server/src/analyzer/recover-tagged-lines.ts`:

(a) `import { isNonEnglish } from '../tts/language.js';`

(b) Add `language: string = 'en'` as the last param to `recoverTaggedNarratorLines` and `taggedSpeakerIds`; early-return the no-op result at the top of each body when `isNonEnglish(language)` (same §4.3 comment as Task 1).

(c) In `server/src/routes/analysis.ts`, pass the in-scope book language to the two `recoverTaggedNarratorLines(...)` calls (~:3925, ~:4929).

(d) In `server/src/analyzer/fold-minor-cast.ts`, the `taggedSpeakerIds(sentences, characters)` call (~:315) — `foldMinorCast` already receives a `language` (it uses `normaliseBookLanguage(language)` for the ru path); pass that language to `taggedSpeakerIds`.

- [ ] **Step 4: Run to verify pass — gate + the full English suites**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npx vitest run src/analyzer/recover-tagged-lines.test.ts src/analyzer/fold-minor-cast.test.ts`
Expected: PASS — the German-skip cases AND every pre-existing English assertion (default `'en'`).

- [ ] **Step 5: Typecheck + broader analyzer suite**

Run: `cd C:/Claude/Audiobook-Generator-wt-fs41/server && npm run typecheck && npx vitest run src/analyzer`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/recover-tagged-lines.ts server/src/routes/analysis.ts server/src/analyzer/fold-minor-cast.ts server/src/analyzer/recover-tagged-lines.test.ts
git commit -m "feat(server): gate narrator-flip recovery off for non-English books"
```

---

## Self-Review

- **Spec coverage (§4.3):** the English-only `[A-Z]`+verb roster guard + the narrator-flip recovery are explicitly gated off for non-English (not silently no-op) ✓ (T1, T2); the German false-positive + ES/FR false-negative hazards are eliminated; the loss is documented + a localisation follow-up is noted. The verb list / drift test are untouched.
- **Placeholder scan:** the test snippets say "read the actual return-field/threshold names / mirror the existing fixtures" — these are concrete instructions to match the file's real shapes, not vague TODOs. Every code step shows the gate code + the import.
- **Type consistency:** `isNonEnglish` is the single gate predicate across both files; the `language?: string` (default `'en'`) param is spelled identically on all five functions; the default keeps existing callers/tests English.
- **English-unchanged check:** every English test passes no `language` arg → `'en'` → identical behaviour; T1/T2 Step 4 re-run the full suites.

**Tracked follow-up (note in the PR, not this seam):** localise the guard per language — Russian first (Unicode `\p{L}` names + Russian verbs + dash quotes — the map says medium lift, brings it from accidental-no-op to functional), then ES/FR with a `verbBeforeName` flag; German likely needs an NER fallback.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-fs41-fs50-seam3d-attribution-gate.md`. Subagent-Driven recommended (both tasks thread the book language through the large `analysis.ts`). Remaining analyze-half PRs after this: §4.5 token divisor, §4.6 prompt skills, §4.7 front-matter boilerplate strip.
