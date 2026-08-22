---
status: draft
shipped: null
owner: null
---

# Aligner dash-invariance fix

> Status: draft
> Key files: `server/src/analyzer/dialogue-structure/aligner.ts`,
> `server/src/analyzer/scene-breaks.ts`,
> `server/src/routes/analysis.ts`, `server/src/store/attribution-health.ts`,
> `server/src/analyzer/dialogue-structure/evidence.ts`,
> `server/src/analyzer/dialogue-structure/escalation.ts`
> URL surface: none (analyzer-internal; no UI/route-shape change)
> OpenAPI ops: none

Design spec (full rationale, revision history, real-data measurement):
[`docs/superpowers/specs/2026-08-21-aligner-dash-invariance-anchor-hardening-design.md`](../superpowers/specs/2026-08-21-aligner-dash-invariance-anchor-hardening-design.md)
(v4 — ships needle-invariance only; the anchor-hardening mechanism explored in
v2/v3 was dropped after real-data measurement showed it cost more correctness
than it saved, and is filed separately, see "Out of scope" below).

> **Superseded mechanism (spec v5, updated pass 5).** PR review pass 3 rejected
> the design's §1 (strip every leading dash-group from every needle) and §2
> (extend a match's raw start backward over a preceding dash run) as measured
> correctness regressions. The tasks below still describe those two, and are
> kept as history. **What actually ships:** needle text is never rewritten;
> only the *search* changes, and only for a needle with no leading dash — it
> prefers an occurrence preceded by that sentence's own paragraph dash (same
> line, no line break between) and reports the dash's offset, but ONLY when
> its own bare first hit is a false substring match (mid-word — the "да."
> inside "правда." shape); a bare hit that already lands at a genuine word
> boundary is trusted as-is, with no forward walk (pass 4 shipped the
> mechanism, pass 4's own review then found this omission — "Q1" — and pass 5
> confirmed the fix). There is no backward-extension step. See the "v5" note
> at the head of the spec's "Design" section. The language gate (Task 3) and
> every parity invariant below are unaffected and shipped as written. **Known
> residual, filed as [#2608](https://github.com/dudarenok-maker/Castwright/issues/2608):**
> the word-boundary check only validates the LEFT side of a match, so a
> fuzzy-fallback prefix anchor (which by construction usually ends mid-word)
> can still be wrongly trusted — a pre-existing gap, not introduced by this
> fix, needing a design decision on how the fuzzy path's truncation point
> should be treated.

Issue: [#2537](https://github.com/dudarenok-maker/Castwright/issues/2537)
Supersedes in place: `fix/server-2537-dash-invariant-align`
([PR #2577](https://github.com/dudarenok-maker/Castwright/pull/2577)) at
commit `9262412a` — rework, don't re-branch.

## Benefit / Rationale

- **User:** dialogue attribution (character assignment, narrator-span
  detection, split-speech/unattributed-speech flags) stops depending on an
  accident of which raw form the analyzer model happened to emit for a
  sentence's leading dash. Whether this closes the 14 diverging fields on
  *Ночной дозор* (E11 register item 2) is **not yet measured for the shipped
  mechanism** — that is the on-box acceptance E11 still owes; the earlier
  "concretely fixes 14 fields" wording described a mechanism that was
  rejected and never ran against that corpus.
- **Technical:** `alignSentences`/`locateSentenceOffsets` become provably
  invariant to dash presence/glyph/count/spacing on languages where a
  leading dash is a dialogue marker (ru/es/fr) — a property that is now unit
  tested directly on the needle-builder, not inferred from behavior.
- **Architectural:** n/a — no interface change beyond one new parameter
  threaded to two functions; no persisted-shape change.

## Architectural impact

- **New seams:** `alignSentences` and `locateSentenceOffsets` each gain one
  new parameter (a resolved "is this language's leading dash a dialogue
  marker" boolean, or the convention object itself — implementer's choice,
  see Task 1) sourced from `conventionsFor(language).dialogueOpen !== null`.
  A shared, independently-unit-testable needle-builder helper is extracted
  for use by both functions.
- **Invariants preserved:** when the language gate is false (en/de/ja/zh),
  both functions' needle construction and backward-extension are
  byte-identical to today's `main` behavior — this is a tested parity
  requirement, not an assumption. `fillRun`'s existing zero-length-needle →
  `null` handling is unchanged — and, since the shipped mechanism never
  rewrites needle text, it is no longer reachable by a dash-only sentence:
  a `"---"` scene rule normalizes to `"-"` and is searched as `"-"`. (Under
  the rejected §1 it stripped to `""`, which silently dropped every scene
  separator from `alignedPct`.)
- **Migration story:** n/a — no persisted data shape changes.
- **Reversibility:** revert the diff; no data migration to unwind. The
  `#2187` anchor/infill logic is untouched (v4 dropped the disambiguation
  mechanism entirely), so any regression is isolated to needle construction
  and backward-extension, not the matching algorithm itself.

## Invariants to preserve

1. When `conventionsFor(language).dialogueOpen === null` (en/de/ja/zh per
   `server/src/analyzer/dialogue-structure/lang/{en,de,ja,zh}.ts`), needle
   construction and backward-extension in both functions must be
   byte-identical to `main`'s current (pre-fix) behavior.
2. `narrator-default.test.ts:96,109` pins that a leading dash is not a
   dialogue marker in en/de/ja/zh — this design must not change that.
3. `fillRun`'s zero-length-needle handling (`aligner.ts:250`,
   `results[i] = null`) is unchanged.
4. `locateSentenceOffsets`'s docstring claim of sharing `alignSentences`'
   semantics (fuzzy fallback excepted) must continue to hold — verify by
   construction (shared helper) or an explicit parity test.

## Task breakdown

Each task is one implementer dispatch (test-first, per
`subagent-driven-development`), reviewed by a task-review pass before the
next starts.

### Task 1 — Shared needle-builder + loop-strip needle construction

- Extract a shared, exported (or otherwise independently unit-testable)
  needle-builder function used by both `alignSentences` and
  `locateSentenceOffsets`.
- Implementation: `normalize(s.text).replace(/^(-\s*)+/, '')`, applied only
  when the new language-gate parameter is true; when false, behavior is
  `normalize(s.text)` unchanged (today's `main` behavior).
- Paired tests: the needle-builder unit test from spec Testing item 1 —
  dash count (1/2/3+ glyphs), glyph choice (`-`/`–`/`—`/entities), spacing,
  empty-needle case (assert `null` downstream), and the gate-false parity
  assertion (byte-identical to `normalize(s.text)`).
- **Entry point:** `aligner.ts`'s current needle-construction lines in both
  `alignSentences` and `locateSentenceOffsets` (the no-op `6dddbdc0`/
  `3053f5dd` logic being replaced).

### Task 2 — Looped backward-extension, both functions

- Loop the existing single-glyph trailing-dash regex
  (`/([-–—])\s*$/` → `/(?:[-–—]\s*)+$/` or equivalent) in `alignSentences`'
  backward-extension block, so a doubled/typewriter-style leading dash
  (`-- `) is fully consumed before checking the start-of-line guard.
- Apply the identical looped extension to `locateSentenceOffsets`, removing
  its current `hadLeadingDash` gate entirely (self-gating: fires only when a
  dash literally precedes the match at a raw line start, independent of
  what the cache stored).
- No language gate needed on the extension itself beyond what's inherited
  from needle construction already being dash-stripped — but confirm via
  the gate-false parity test in Task 1 that with the gate off, the
  extension also never fires differently than `main` (since the needle
  never gets dash-stripped in that case, the match position is the same as
  today, so the pre-existing extension logic already behaves identically —
  verify this rather than assume).
- Paired tests: doubled-dash raw-line fixture asserting full recovery of
  the raw span; parity test that a non-dash raw line is unaffected.

### Task 3 — Language-gate plumbing to all call sites

- Thread the new parameter through:
  - `alignSentences`: `server/src/routes/analysis.ts:2298/2304`,
    `attribution-health.ts:173`, `evidence.ts:84-92`, `escalation.ts:212`.
  - `locateSentenceOffsets` → `annotateSceneBreaks`
    (`scene-breaks.ts:45`) → its sole caller `analysis.ts:2385`, using the
    `conventions` value already resolved at `analysis.ts:2298` in the same
    function.
- No fallback-to-unchanged-behavior path is needed anywhere — every call
  site already has the language/convention in scope (verified in the
  design's review round 3; do not reintroduce the earlier, disproven
  "wider call graph" concern).
- Paired tests: a call-site-level test (or extending existing route/
  attribution-health tests) confirming the gate value actually reaches the
  aligner functions correctly for at least one ru-language fixture and one
  en-language fixture.

### Task 4 — Regression fixtures + existing suite updates

- Update `aligner.test.ts:231-258` (currently asserts with/without-dash
  offsets *differ*) to assert they are now the *same*.
- Re-derive (confirm, don't assume) the hard-pinned `alignedPct` fixture
  (~`83.33`, aligner.test.ts) against the shipped implementation.
- Add the attempt-1 regression fixture (`"— Да."` vs. decoy `"правда"`):
  assert it now resolves to the **correct** speech span (Variant C's
  unmodified anchor/interval-bounding is sufficient on real text — see
  design spec's real-data measurement). A synthetic fixture that strips all
  anchors to specifically defeat this is a documented known-residual case
  (see "Out of scope"), not a merge blocker for this task.
- Confirm `scene-breaks.test.ts` stays green; add a parity case if the
  gate-false path isn't already covered there.

### Task 5 — Real-data validation + bookkeeping (on-box, pre-merge)

Not a CI gate — cache/manuscript live only in the primary checkout's local
workspace.

- Re-run the design's per-sentence span-diff measurement (vs. `main`) against
  the **actual shipped code** on the same four *Ночной дозор* chapters
  (1, 6, 7, 8), confirming zero regressions (investigate/justify any that
  appear — the design measurement used a reconstruction, not the final
  diff). Attach counts to the PR body.
- Run the actual E11 invariance check (straight cache vs.
  dash-stripped-cache rerun, diffed field-by-field) on the same four
  chapters — cheap addition using the same loaded harness. This does not by
  itself discharge E11 item (2) (a whole-library, whole-chapter
  `measure-attribution.mjs` double-run) — update that register row to
  record the fix landed and was spot-validated, but leave it open until the
  full run.
- Basic sanity benchmark confirming no measurable perf regression (expected:
  negligible, per-sentence regex work only).
- Amend the branch's existing bookkeeping commits (release notes, on-box
  register note) which currently describe the rejected no-op mechanism and
  the since-dropped disambiguation design — correct them to describe what
  actually ships, including the measured numbers.

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/dialogue-structure/aligner.test.ts`):
  needle-builder invariance property test (Task 1), looped-extension
  doubled-dash fixture (Task 2), attempt-1 regression fixture now resolving
  correctly (Task 4), updated with/without-dash-offsets-equal assertion
  (Task 4), re-derived `alignedPct` fixture (Task 4).
- Vitest server (`scene-breaks.test.ts`): parity coverage for the
  gate-false path (Task 2/4).
- Call-site coverage (Task 3): at least one ru-language and one en-language
  fixture confirming the gate value reaches the aligner functions.

### Manual acceptance walkthrough

Not applicable — no UI surface. On-box acceptance (Task 5) is the
real-behavior verification for this plan; see
`docs/testing/onbox-acceptance-register.md` E11 §item 2.

## Out of scope

- **Anchor/match hardening** (`findAnchors`' duplicate-anchor gap, general
  robustness in sparse/zero-anchor runs) — explored as v2/v3's
  disambiguation mechanisms, shown by real-data measurement (design spec's
  "Real-data measurement" section) to cost more correctness than it saved.
  File as a **separate follow-up issue**, designed independently starting
  from Variant C's numbers, not bundled into a #2537 re-open.
- Fixing the model's own stochastic dash-dropping at the source.
- `cross-examine.ts:225` and `narrator-default.ts:79,101`'s direct reads of
  cached sentence text's leading dash — separate consumers of the same
  upstream instability, outside the aligner. Worth their own follow-up
  issue.
- Mid-run re-segmentation drift (a continuation segment gaining a spurious
  leading dash not present in the raw text).

## Ship notes

(Filled in when status flips to `stable`.)
