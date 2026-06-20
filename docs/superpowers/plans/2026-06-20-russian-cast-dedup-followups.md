# Russian-cast-dedup Follow-ups (srv-44 / srv-45) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two bounded follow-ups filed off the Russian cast de-dup + tone branch — (srv-44 #960) make the reuse-guard seam honor the dedup id remap on re-analysis, and (srv-45 #961) lock the tolerant-validation contract on the Gemini analyzer path.

**Architecture:** Both are surgical, server-only, test-first changes. srv-44 lands as an ambiguity-guarded same-name fallback in `seedReuseGuardsFromPriorCast` (helper-level, no route change) — strictly simpler than threading `composeRewrites`/`applyRewriteToPriorCast` through `analysis.ts`, and unit-testable. srv-45 is a single new slow-tier test case mirroring the existing Ollama two-schema test.

**Tech Stack:** TypeScript, Vitest (server node env; gemini.test.ts runs in the `test:server-slow` tier via `server/vitest.config.slow.ts`), Zod v4.

## Global Constraints

- Server-only. No frontend, no sidecar, no openapi change.
- TDD: every change ships a paired test that fails before and passes after.
- Test files under `src/analyzer/` and `src/store/` MUST `import { describe, it, expect } from 'vitest'` (and `vi`, `beforeEach` etc. as used) — vitest globals are NOT enabled, and a missing import is a typecheck error that the vitest run + pre-commit will not catch.
- Match existing file style; design tokens / conventions unchanged.
- No behavior change to the main analysis route or to `mergeAnalysisResultWithExistingCast` / `applyRewriteToPriorCast`.

---

### Task 1: srv-44 — same-name fallback in `seedReuseGuardsFromPriorCast`

**Files:**
- Modify: `server/src/store/merge-analysis-cast.ts` (function `seedReuseGuardsFromPriorCast`, ~lines 239-252)
- Test: `server/src/store/merge-analysis-cast.test.ts` (existing `describe('seedReuseGuardsFromPriorCast', …)` block, ~line 184)

**Context / why:** On re-analysis the dedup pass collapses a legacy prior id (`olga`) onto a canonical survivor (`ольга`). In the **subset (chapter-retry) route** the reuse-guard seam runs *after* dedup: `seedReuseGuardsFromPriorCast(priorCastForMerge, enriched)` — `enriched` already carries the survivor `ольга`, but `priorCastForMerge` still has the raw legacy `olga`, so the id-keyed seed misses and the survivor gets no `matchedFrom`/`notLinkedTo`. `linkSeriesReuseAtAnalysis` then ignores the user's prior link and `notLinkedTo` decision. The fix mirrors the ambiguity-guarded same-name fallback already in `mergeAnalysisResultWithExistingCast` (same file, ~lines 114-141): when the id misses, match a single same-(normalised)-name prior row to a single same-name fresh row. Post-dedup the subset roster is unambiguous so the bridge fires; the main route's *pre-dedup* roster has two same-name rows so the ambiguity guard makes it a safe no-op there (its seam is already id-aligned pre-dedup).

**Interfaces:**
- Consumes: `normaliseForMatch` (already imported in the file), `CastRecord` type.
- Produces: no signature change — `seedReuseGuardsFromPriorCast<T>(existing, fresh): void` still mutates `fresh` in place.

- [ ] **Step 1: Write the failing tests** in the existing `seedReuseGuardsFromPriorCast` describe block:

```ts
it('seeds onto a same-name survivor when the id was remapped by dedup (collapsed-source)', () => {
  // Legacy prior cast voiced/linked under the pre-dedup id `olga`; re-analysis
  // produced the canonical survivor `ольга`. The id misses → name-fallback bridges.
  const existing: C[] = [
    {
      id: 'olga',
      name: 'Ольга',
      notLinkedTo: [{ bookId: 'b1', characterId: 'other' }],
      matchedFrom: { bookId: 'b0', characterId: 'olga', confidence: 0.8 },
    },
  ];
  const fresh: C[] = [{ id: 'ольга', name: 'Ольга' }];
  seedReuseGuardsFromPriorCast(existing, fresh);
  expect(fresh[0].notLinkedTo).toEqual([{ bookId: 'b1', characterId: 'other' }]);
  expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'olga', confidence: 0.8 });
});

it('does NOT use the name-fallback when two fresh rows share a name (ambiguous — pre-dedup main route)', () => {
  const existing: C[] = [{ id: 'olga', name: 'Ольга', matchedFrom: { bookId: 'b0', characterId: 'olga' } }];
  // Pre-dedup roster: both surface ids present, same name → ambiguous, no guess.
  const fresh: C[] = [
    { id: 'olga', name: 'Ольга' },
    { id: 'ольга', name: 'Ольга' },
  ];
  seedReuseGuardsFromPriorCast(existing, fresh);
  expect(fresh[0].matchedFrom).toEqual({ bookId: 'b0', characterId: 'olga' }); // id match still works
  expect(fresh[1].matchedFrom).toBeUndefined(); // ambiguous fresh name → not seeded
});

it('does NOT use the name-fallback when two prior rows share a name (ambiguous source)', () => {
  const existing: C[] = [
    { id: 'olga', name: 'Ольга', matchedFrom: { bookId: 'b0', characterId: 'olga' } },
    { id: 'olga2', name: 'Ольга', matchedFrom: { bookId: 'b9', characterId: 'olga2' } },
  ];
  const fresh: C[] = [{ id: 'ольга', name: 'Ольга' }];
  seedReuseGuardsFromPriorCast(existing, fresh);
  expect(fresh[0].matchedFrom).toBeUndefined(); // can't pick between two prior rows
});

it('id match takes precedence over the name-fallback', () => {
  const existing: C[] = [
    { id: 'ольга', name: 'Ольга', matchedFrom: { bookId: 'right', characterId: 'ольга' } },
    { id: 'olga', name: 'Ольга', matchedFrom: { bookId: 'wrong', characterId: 'olga' } },
  ];
  const fresh: C[] = [{ id: 'ольга', name: 'Ольга' }];
  seedReuseGuardsFromPriorCast(existing, fresh);
  // exact id present on both sides → ambiguous name guard also trips, but id wins regardless
  expect((fresh[0].matchedFrom as { bookId: string }).bookId).toBe('right');
});
```

- [ ] **Step 2: Run them to confirm they fail** (the collapsed-source test fails: survivor not seeded):

`cd server && npx vitest run src/store/merge-analysis-cast.test.ts`
Expected: the `collapsed-source` test FAILS (`matchedFrom` undefined); the two ambiguity tests PASS already (no fallback exists yet) — keep them, they pin the guard.

- [ ] **Step 3: Implement the name-fallback.** Replace the body of `seedReuseGuardsFromPriorCast` with:

```ts
export function seedReuseGuardsFromPriorCast<
  T extends { id: string; notLinkedTo?: unknown; matchedFrom?: unknown },
>(existing: ReadonlyArray<CastRecord>, fresh: T[]): void {
  if (!existing.length) return;
  const byId = new Map(existing.map((c) => [c.id, c]));

  /* Name-fallback for dedup id remap (srv-44): on re-analysis the dedup pass
     collapses a legacy prior id onto a canonical survivor, so the prior cast's
     guard row no longer matches the survivor by id. Bridge a SINGLE same-name
     prior row to a SINGLE same-name fresh row, mirroring the ambiguity-guarded
     fallback in mergeAnalysisResultWithExistingCast. Guard against guessing: a
     normalised name shared by >1 prior OR >1 fresh row falls back to id-only. */
  const nameOf = (c: { name?: unknown }): string =>
    typeof c.name === 'string' ? normaliseForMatch(c.name) : '';
  const freshNameCounts = new Map<string, number>();
  for (const f of fresh) {
    const key = nameOf(f as { name?: unknown });
    if (key) freshNameCounts.set(key, (freshNameCounts.get(key) ?? 0) + 1);
  }
  const existingByName = new Map<string, CastRecord>();
  const ambiguousExistingNames = new Set<string>();
  for (const old of existing) {
    const key = nameOf(old);
    if (!key) continue;
    if (existingByName.has(key)) ambiguousExistingNames.add(key);
    else existingByName.set(key, old);
  }

  for (const f of fresh) {
    let old = byId.get(f.id);
    if (!old) {
      const key = nameOf(f as { name?: unknown });
      if (key && !ambiguousExistingNames.has(key) && freshNameCounts.get(key) === 1) {
        old = existingByName.get(key);
      }
    }
    if (!old) continue;
    if (f.notLinkedTo === undefined && old.notLinkedTo !== undefined)
      f.notLinkedTo = old.notLinkedTo as T['notLinkedTo'];
    if (f.matchedFrom === undefined && old.matchedFrom !== undefined)
      f.matchedFrom = old.matchedFrom as T['matchedFrom'];
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass** + the rest of the file stays green:

`cd server && npx vitest run src/store/merge-analysis-cast.test.ts`
Expected: PASS (all `seedReuseGuardsFromPriorCast` + `mergeAnalysisResultWithExistingCast` + `applyRewriteToPriorCast` tests).

- [ ] **Step 5: Typecheck the server** so a missing import / type slip is caught (vitest run does not typecheck):

`npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add server/src/store/merge-analysis-cast.ts server/src/store/merge-analysis-cast.test.ts
git commit -m "fix(server): seed reuse guards onto dedup survivor by name (srv-44)"
```

---

### Task 2: srv-45 — Gemini slow-tier tone-less validation regression test

**Files:**
- Test: `server/src/analyzer/gemini.test.ts` (new `describe` block; runs in the `test:server-slow` tier via `server/vitest.config.slow.ts`)

**Context / why:** Task 7 of the parent branch split `runStage` into a required-tone grammar schema + a tolerant (optional-tone) validation schema. The Ollama path has a load-bearing unit test (`ollama.test.ts` → `describe('OllamaAnalyzer — two-schema runStage (grammar vs validation)')`, ~line 306). The Gemini path is structurally identical (`_grammarSchema` accepted-but-unused; validates with the optional-tone `stage1ChapterSchema`) but has no Gemini-specific assertion that a tone-less response is tolerated. Gemini is the shipped cloud default engine, so lock the contract there too.

**Interfaces:**
- Consumes: the existing gemini.test.ts harness — `generateContentStream` mock, `asyncFromArray`, `chunksOf`, `new GeminiAnalyzer({ apiKey: 'test-key', model })`, `runStage1Chapter`. (Read the file top + the `runStage1Chapter — Phase 0a` describe at ~line 181 to mirror the harness exactly.)
- Gemini does NOT feed the grammar schema to the API (no constrained decoding), so — unlike the Ollama test — assert ONLY validation tolerance: a tone-less response validates with no retry. Do NOT assert anything about the request body's `format`/grammar.

- [ ] **Step 1: Write the failing-safe test.** Add near the existing `runStage1Chapter` describe block:

```ts
describe('GeminiAnalyzer.runStage1Chapter — two-schema runStage tolerates a tone-less response (srv-45)', () => {
  it('a stage-1 response with NO tone validates with no retry (non-fatal)', async () => {
    /* The validation schema (stage1ChapterSchema → characterSchema) marks tone
       optional; a missing tone must NOT fail parseAndValidate or trigger the
       single retry. Mirrors the Ollama two-schema test, validation half only. */
    const noTone = JSON.stringify({
      characters: [{ id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' }],
      chapters: [{ id: 1, title: 'One' }],
    });
    generateContentStream.mockResolvedValue(
      asyncFromArray(chunksOf(noTone, 24).map((text) => ({ text }))),
    );

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-3.1-flash-lite' });

    const result = await analyzer.runStage1Chapter('m_gemini_no_tone', 1, '# stage1 prompt', {});

    expect(generateContentStream).toHaveBeenCalledTimes(1); // no retry
    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].tone).toBeUndefined(); // absent is fine
  });
});
```

> Implementer note: confirm against the harness — `runStage1Chapter` arity/signature, whether `chapters` is required in the assembled payload (the file's `STAGE1_RESPONSE` includes `chapters: [{ id, title }]`; keep it), and the exact import path for `GeminiAnalyzer`. If the existing tests import `GeminiAnalyzer` at top rather than dynamically, follow that pattern. Adjust the mock-shape (`{ text }`) only if the file's other `runStage1Chapter` tests differ.

- [ ] **Step 2: Run it (slow tier)** to confirm it passes against the real two-schema `runStage`:

`cd server && npx vitest run --config vitest.config.slow.ts src/analyzer/gemini.test.ts`
Expected: PASS (this is a regression LOCK — it asserts the shipped behavior; it should pass on the current tree and would FAIL if a future change reverts Gemini to required-tone validation). Confirm `toHaveBeenCalledTimes(1)` holds (no retry path taken).

- [ ] **Step 3: Sanity-check the lock bites.** Temporarily imagine swapping the validation schema to a required-tone one would fail this test — no code change needed, just confirm the assertion targets validation tolerance (tone undefined, single call). Leave the test as the guard.

- [ ] **Step 4: Typecheck**

`npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/gemini.test.ts
git commit -m "test(server): lock tolerant tone-less validation on the Gemini path (srv-45)"
```

---

## Self-review notes

- Spec coverage: srv-44 acceptance (re-analysis re-stamps the guard against the canonical survivor) → Task 1 collapsed-source test. srv-45 acceptance (Gemini tolerates tone-less stage-1) → Task 2. ✓
- The chosen srv-44 fix deviates from the issue's suggested "thread `composeRewrites`/`applyRewriteToPriorCast` through the seam" — note this in the PR: the helper-level name-fallback is simpler, unit-testable, covers the actual (subset-route) gap, and is a safe no-op on the id-aligned pre-dedup main route. Record the residual: a prior `notLinkedTo`-without-`matchedFrom` row combined with a same-run mis-link is corrected at persist by the `mergeAnalysisResultWithExistingCast` overlay (which forces prior `matchedFrom`/`notLinkedTo`), and the name-fallback now also pre-seeds the survivor so `linkSeriesReuseAtAnalysis` never stamps the contradicting link on the subset route.
- No placeholders; exact code given for both tasks.
