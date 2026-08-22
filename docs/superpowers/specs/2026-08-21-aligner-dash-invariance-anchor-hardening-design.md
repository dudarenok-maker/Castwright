# Aligner dash-invariance fix — design

Status: v5 — §1/§2's mechanism was implemented and rejected in PR review pass 3;
the shipped mechanism is described in the v5 note at the head of "Design"
(v4 scope reduction retained; see "Revision history")
Date: 2026-08-21
Issue: [#2537](https://github.com/dudarenok-maker/Castwright/issues/2537)
Supersedes: the implementation on `fix/server-2537-dash-invariant-align` (PR
[#2577](https://github.com/dudarenok-maker/Castwright/pull/2577)) as it stands
at commit `9262412a` — see "Disposition of PR #2577" below.

## Revision history

- **v1 → v2**, after assumption-checker round 1: fixed a false
  "byte-identical by construction" proof, added language gating, corrected
  mischaracterizations of existing code, reclassified real-data validation
  as on-box acceptance work rather than a CI gate.
- **v2 → v3**, after assumption-checker round 2 + a real-data measurement:
  replaced an anchor-eligibility-tuning mechanism with a "reject-if-ambiguous
  / prefer-dash-context" disambiguation layer (Variants A/B), grounded in a
  measurement against the real *Ночной дозор* corpus.
- **v4 → v5 (this revision)**, after PR review pass 3 on PR #2577: v4's
  Design §1 (strip every leading dash-group from every needle) and §2
  (extend a match's raw start backward over a preceding dash run) were both
  implemented and both rejected as measured correctness regressions — §1
  because it throws away the with-dash needle's selectivity, §2 because it
  keys on the body rather than on the sentence and swallows a `---` scene
  rule into the following narration. Neither is reworded here; both sections
  are kept as history, marked REJECTED, and the shipped mechanism is stated
  in the v5 note at the head of "Design". Everything v4 says about the
  language gate (§3), scope and the Variant-C measurement is unchanged.
- **v3 → v4**, after assumption-checker round 3 (the final
  automatic round under this repo's 3-round review cap) **and a fourth
  real-data measurement**: round 3 found the v3 disambiguation mechanism
  (a) was never compared against a needle-fix-only baseline, so its
  necessity was unproven, and (b) had its own unresolved correctness fork
  (a dash-context tiebreak that can silently mis-bind narration). Rather
  than attempt a fourth mechanism, the missing control measurement ("Variant
  C" — needle-invariance fix alone, no disambiguation) was run against the
  same real corpus. **Result: Variant C has zero regressions on all four
  chapters tested, with equal-or-higher `alignedPct` than both hardened
  variants.** The disambiguation/anchor-hardening mechanism was not earning
  its keep — it was net-costing correctness relative to doing nothing extra.
  **v4 drops the entire "anchor + match hardening" mechanism** and ships
  only the needle-invariance fix. The anchor-hardening idea (`findAnchors`'
  own documented duplicate-anchor gap) is filed as a separate follow-up
  issue, to be designed independently with its own measurement, not bundled
  into #2537 again.

## Problem

`alignSentences` and `locateSentenceOffsets`
(`server/src/analyzer/dialogue-structure/aligner.ts`) locate each sentence in
a chapter's raw body by substring-searching a "needle" built from the
sentence's cached, normalized `text`. The inconsistency this design
tolerates is not a deterministic upstream `.replace()` stage; it is the
stage-2 model itself stochastically dropping (or reshaping) a leading
paragraph-dash marker on some sentences and not others (confirmed precedent:
#2306, "the model silently stripped the leading dash from its returned
text", `server/src/store/attribution-health.criteria.test.ts:60`). The
variation to tolerate is dash presence/absence, glyph choice
(`-`/`–`/`—`/`&mdash;`/`&ndash;`), spacing, and dash *count* — a
model-emitted line can carry more than one leading dash glyph in a single
occurrence (a raw `-- ` typewriter-style em dash, or occasionally a doubled
real em dash). Mid-run re-segmentation drift (a continuation segment gaining
a spurious leading dash where none exists in the raw text) is a distinct,
harder problem and is out of scope (see "Out of scope").

Today's needle construction (`normalize(s.text)`, no dash handling) inherits
this instability: the SAME sentence can locate a different raw span
depending on which form the model happened to emit for that particular
cached run. Confirmed on real data: 22 of 23 books in the local library are
unaffected, but the 23rd — *Ночной дозор*, a dash-dialogue-dense Russian
novel — shows 14 fields diverge when its cache is compared straight vs. with
every leading dash stripped (`docs/testing/onbox-acceptance-register.md`,
E11 §item 2). That comparison is an **acceptance probe**, not production
behavior — production never runs a deterministic strip; it is the tool used
to detect that the aligner's output depends on a property (dash presence) it
shouldn't.

Three implementation attempts on `fix/server-2537-dash-invariant-align` have
each failed independent PR review:

1. **Unconditional strip** (`40bee7ff`) — strips *one* leading dash from
   every needle regardless of cache form. Rejected on a **theoretical**
   false-match concern (a synthetic 2-sentence fixture where a short
   dash-stripped needle could bind inside an unrelated word) before an
   on-box run. **This session's real-data measurement (below) found no
   evidence of that failure mode on the actual target corpus** — the
   theoretical concern did not materialize in practice, though the specific
   commit still had the multi-dash and language-gating gaps this design
   fixes.
2. **"Keep the dash if the cache had one"** (`6dddbdc0`) — the needle
   construction is a literal identity transform
   (`hadLeadingDash[i] ? t : t.replace(...)` returns `t` on both branches).
   Confirmed both synthetically and on a real on-box re-run (identical
   14-field divergence).
3. Applies the same needle-construction no-op to `locateSentenceOffsets`
   (`3053f5dd`).

## Design

> **v5 — §1 and §2 below were implemented, measured, and REJECTED in PR review
> pass 3. They are kept as design history; the code does something else.** The
> shipped mechanism is described here, and the sections that follow it are
> accurate only for the language gate (§3) and the surrounding rationale.
>
> **Why §1 was rejected.** "Strip every leading dash-group from every needle"
> destroys the with-dash arm's selectivity. `"- да."` can only occur at a real
> dialogue marker; `"да."` occurs inside `правда`, `когда`, `всегда`, `вода`.
> Stripping unconditionally therefore made a needle the cache had recorded
> *correctly* start mis-binding — measured by the pass-3 reviewer at 1,134
> regressions and 0 improvements over 4,516 evaluations on a dash-dense
> Russian corpus, with the dash-stripped arm (the shape #2537 is actually
> about) unchanged from `main`. Invariance was achieved purely by degradation.
>
> **Why §2 was rejected.** Extending a match's raw start backward over
> "whatever dash happens to precede it" keys on the body, not on the sentence.
> A `---` scene rule (which `normalize` folds to a lone `-`) sits immediately
> before the next narration paragraph, so a plain narration sentence — which
> never had a dash to recover — had its span extended back over the separator
> and was flagged `lumped: true`. On the committed `the-coalfall-commission.ru.md`
> fixture with a faithful cache and no drift, `alignedPct` fell 100.00 → 93.10.
>
> **What ships instead.** Needle text is never rewritten; the *search* is what
> changes, and only for a needle that has no leading dash:
>
> - a needle that already carries its dash is searched verbatim — byte for byte
>   what `main` does, keeping the dash's selectivity;
> - a needle with no leading dash prefers an occurrence that IS preceded by a
>   paragraph dash and reports the dash's offset — the same offset the
>   dash-carrying form of that sentence produces — but ONLY when its own bare
>   first hit is a false substring match (mid-word, e.g. `"да."` inside
>   `"правда."`). A bare hit that already lands at a genuine word boundary is
>   an independently valid occurrence and is trusted as-is, with no forward
>   walk: pass 4's own review (PR #2577, "Q1") found that walking forward
>   unconditionally discarded a sentence whose exact text legitimately
>   recurred later in the chapter under a DIFFERENT line's dash, cross-binding
>   it onto that unrelated dash. Only when the bare hit IS a false substring
>   match does the search walk forward for a dash-prefixed occurrence,
>   falling back to the plain (false) hit if none exists anywhere;
> - a dash counts as a sentence's own only when no line break separates them,
>   so a scene rule on the previous line is never absorbed;
> - there is no backward-extension step at all: a dash-prefixed match already
>   starts at the dash, because the search that found it required one.
>
> Empty-needle handling is therefore moot — `"---"` normalizes to `"-"` and is
> searched as `"-"`, not rewritten to `""`. Everything §3 says about language
> gating still holds, and gate-off parity with `main` is exact (measured: 0
> span / `lumped` / `alignedPct` / offset differences over 9,306 evaluations).
>
> **Known residual, filed as [#2608](https://github.com/dudarenok-maker/Castwright/issues/2608).**
> The word-boundary check above only validates the LEFT side of a bare hit. A
> needle that is itself a strict prefix of a longer word can still pass as
> "genuine" and be wrongly trusted — pass 6 review confirmed this reaches the
> plain exact-match path too, not only the fuzzy-fallback prefix search. A
> pre-existing gap on `main`, not introduced here; needs a design decision
> before it can be fixed (see the issue).

### 1. Needle construction (both functions, unconditional) — REJECTED, see the v5 note above

```ts
const needles = sentences.map((s) => normalize(s.text).replace(/^(-\s*)+/, ''));
```

`(-\s*)+` loop-strips every leading dash-group, however many the model
emitted — a single `/^-\s*/` strip is insufficient whenever more than one
leading dash glyph is present (e.g. a raw `-- ` typewriter dash or a
doubled real em dash both normalize to `--`, and a single strip leaves one
dash behind). With the loop, `normalize("-- Да.").replace(/^(-\s*)+/, '')`
and `normalize("Да.").replace(/^(-\s*)+/, '')` are genuinely identical.

Extract a shared, independently-testable needle-builder helper (exported or
otherwise unit-testable) used by both `alignSentences` and
`locateSentenceOffsets`, so the invariance property test (Testing item 1)
can assert equality on the needle array itself, not infer it from behavior
— this is what would have caught attempt 2 immediately.

**Downstream, invariance holds cleanly**: every E11-diverging field
(`narratorIdSpoken`, `unknownOriginNarrator`, `unattributedSpeech`,
`splitSpeech`, `tagNarratorSpan`, per-chapter `attributableSpoken`) derives
from `alignSentences`' `spans` / `sentence.characterId` via
`server/src/store/attribution-health.ts:140-290`, and nothing else on that
path reads `s.text` directly. Identical needles ⇒ identical `locateNeedles`
output ⇒ identical measurement on that path.

**Empty needles**: if every leading dash-group is stripped and nothing
remains (a sentence cached as just a dash, or dash + whitespace), the needle
is `""`. `fillRun` already treats a zero-length needle as unresolved
(`aligner.ts:250`, `results[i] = null`) — existing, correct behavior;
Testing item 1 must exercise this case explicitly.

### 2. Backward-extension over the raw dash (both functions, looped, unconditional) — REJECTED, see the v5 note above

Keep the existing mechanism (extend a located match's raw start back over a
paragraph-leading dash + optional whitespace, only when it immediately
precedes the match at the start of a line) but **loop it to match multiple
leading dash glyphs**, the same way needle construction is looped. This is
not optional polish: on a raw `-- Да.` line, the current single-glyph regex
(`/([-–—])\s*$/`) consumes only the trailing hyphen, so `beforeDash` still
ends in `-` and the `/[\n\r]$/` start-of-line guard fails — **the extension
does not fire at all today** for a doubled-dash line, leaving the resolved
span short by the dash prefix. Loop the match the same way:
`/(?:[-–—]\s*)+$/` (or equivalent), consuming the whole leading dash-run
before checking what precedes it.

No `hadLeadingDash` gate — this logic is self-gating (it only fires when a
dash literally precedes the match at a line start in the raw body), so it
correctly no-ops for sentences whose raw manuscript line never had one and
correctly recovers the dash for ones that do, regardless of what the cache
stored.

`locateSentenceOffsets` needs the identical looped extension added (its
current gated, single-glyph version — from `3053f5dd` — must have its
`hadLeadingDash` gate removed and its regex looped, matching
`alignSentences` exactly, subject to the language-gating fallback in
§3 below).

### 3. Language gating

`dialogueOpen` is `null` for en/de/ja/zh
(`server/src/analyzer/dialogue-structure/lang/{en,de,ja,zh}.ts`), and
`server/src/analyzer/narrator-default.test.ts:96,109` pins as an explicit
invariant that a leading dash is **not** a dialogue marker in those
languages. Unconditional strip+extension applied to every language would
change span boundaries on English/German/Japanese/Chinese books — the
majority of the corpus — for zero benefit. **Both mechanisms above apply
only when the chapter's language has a non-null `dialogueOpen`** (ru/es/fr
today). When the gate is false, both fall back to today's (`main`) behavior
exactly — a testable parity requirement, not just an absent code path.

**Threading this through, verified against actual call sites:**

- `alignSentences`: all four production call sites already resolve a
  language/convention before calling it — `server/src/routes/analysis.ts:2298`
  (`conventionsFor(opts.stageCall.language)`), `attribution-health.ts` (from
  `input.language`), `evidence.ts:84-86` (a `language` parameter),
  `escalation.ts` (via `opts.stageCall`). Thread the resolved
  `dialogueOpen`-non-null boolean (or the convention itself) in as a new
  parameter.
- `locateSentenceOffsets`: its only production caller,
  `annotateSceneBreaks` (`scene-breaks.ts:45`), is itself called from
  exactly one place — `server/src/routes/analysis.ts:2385` — **in the same
  function that already resolves `conventions` at `analysis.ts:2298`, in
  scope at the call site.** This is one parameter on one function with one
  call site and the value already available locally — **not** a
  disproportionate plumbing change. Thread it through; there is no
  legitimate fallback-to-unchanged option here (an earlier draft of this
  spec proposed one on a mistaken belief that `annotateSceneBreaks` had a
  wider, harder-to-reach call graph — verified false).

## Real-data measurement

Three fix strategies were built and measured against the actual cached
*Ночной дозор* stage-2 sentences (`server/handoff/cache/mns_oyK7Po6BiT.json`)
and the real manuscript, on all four E11-flagged chapters (1, 6, 7, 8),
each compared to `main`'s current baseline via a per-sentence span diff:

- **Variant A** — needle fix + "reject-if-ambiguous" disambiguation.
- **Variant B** — needle fix + "prefer-dash-context" disambiguation.
- **Variant C** — needle fix alone (§1–§2 above), no disambiguation of any
  kind, otherwise identical to `main`'s existing anchor/infill matching.

| Chapter | baseline alignedPct | A regressions | B regressions | **C regressions** | A alignedPct | B alignedPct | **C alignedPct** |
|---|---|---|---|---|---|---|---|
| 1 | 98.02% | 7 | 3 | **0** | 99.39% | 99.53% | **99.64%** |
| 6 | 92.69% | 5 | 5 | **0** | 99.58% | 99.58% | **99.88%** |
| 7 | 92.02% | 1 | 1 | **0** | 99.57% | 99.57% | **99.63%** |
| 8 | 95.66% | 0 | 0 | **0** | 99.94% | 99.94% | **100.00%** |

("Regressions" = sentences correctly aligned on `main` that become unaligned
under the variant.)

**Variant C has zero regressions on every chapter tested, and equal-or-higher
`alignedPct` than both disambiguation-hardened variants on all four.** Two
scans specifically hunted for the false-match shape that got attempt 1
rejected in code review (a short dash-stripped needle, like `"да."` from
`"— Да."`, binding inside an unrelated word like `"правда"`): a span-overlap
scan (0 hits across all 375 changed sentences) and a direct raw-match scan
restricted to the 152 short dash-led needles specifically at risk of this
shape (0 hits). Two unrelated anomalies were found and are **not** this
failure shape — both are the file's own pre-existing, already-documented
"approximate the extent" limitation of the long-needle fuzzy-prefix fallback
(`fillRun`'s comment: "Anchor on the prefix... approximate the extent"),
present on `main` today for any needle with embedded markup or a paraphrase
drift, landing in the correct sentence/paragraph but off by a few characters
at one edge — not a wrong binding.

**Conclusion**: the theoretical false-match risk that motivated building a
disambiguation mechanism in v2/v3 did not materialize on the real target
corpus, and the disambiguation mechanisms that were built to guard against
it cost more correctness (7+5+1+0 and 3+5+1+0 combined regressions) than
they prevented (zero prevented, since Variant C — with no guard at all —
had zero regressions too). This is why v4 ships Variant C alone.

**Caveat, stated plainly**: this is one book, four chapters, ~7,900
sentences — not a corpus-wide guarantee. It is the same real book #2537 was
filed against and the corpus's own worst dash-density case (E11's
selection criterion), which is the strongest single-book evidence available
locally, but the on-box re-run in Testing item 3 below is still required
before the wider claim is trusted.

## Disposition of PR #2577

Rework the existing branch and PR in place. Replace the needle-construction
and backward-extension logic from all three prior commits outright,
including `locateSentenceOffsets`'s existing backward-extension block (gate
removed, regex looped, needle construction fixed to match). The bookkeeping
commits (release notes, on-box register note) get amended once the real fix
lands — they currently describe rejected/no-op mechanisms and a
subsequently-dropped disambiguation design, and need correcting to describe
what actually ships, including the measured numbers above.

## Testing

1. **Invariance property test** (both functions, only for languages where
   the language gate is true): generate sentence pairs varying dash count
   (1, 2, 3+ leading glyphs), glyph choice, and spacing, assert
   byte-identical needles via the shared needle-builder. Assert the
   with-dash needle differs from naive `normalize(s.text)` (this is what
   would have caught attempt 2). Include the empty-needle case, assert it
   resolves to `null`. Assert that when the language gate is false, needle
   construction and extension are both byte-identical to `main`'s current
   behavior.
2. **Regression test** for the attempt-1 repro (`"— Да."` vs. decoy
   `"правда"`): must now resolve to the **correct** speech span — per the
   real-data measurement, Variant C's existing anchor/interval-bounding
   (unmodified from `main`) is sufficient to avoid this collision on real
   text; a synthetic fixture that specifically defeats it (e.g. by removing
   all anchors, as the original repro did) is a legitimate, documented
   known-residual case (see below), not a merge blocker.
3. **Real-data validation (on-box acceptance work, not a CI gate)** — the
   cache and manuscript live only in the primary checkout's local
   workspace, not in any worktree, CI, or fresh clone. Before merge, the
   implementer re-runs the same measurement (per-sentence span diff vs.
   `main`) against the **actual shipped code** on the same four chapters,
   confirming zero regressions (or investigating and justifying any that
   appear, since the design measurement used a reconstruction, not the
   final diff) — attach the re-run's counts to the PR body. **Also run the
   actual E11 invariance check** (straight cache vs. dash-stripped-cache
   rerun, diffed field-by-field) on the same four chapters — this is the
   one instrument that directly tests the literal ticket property, and the
   harness used for the design measurement already has both the cache and
   the chapters loaded, so this is a cheap addition, not a separate
   effort. Neither of these discharges E11 item (2) itself, which is a
   whole-library (23-book), whole-chapter `measure-attribution.mjs`
   double-run — update the E11 register row to record the fix landed and
   was spot-validated with the numbers above, but the row stays open until
   the full on-box re-run is performed.
4. Existing `aligner.test.ts` / `scene-breaks.test.ts` suites must stay
   green, including updating `aligner.test.ts:231-258` (currently asserts
   with/without-dash offsets *differ* — must assert they're now the *same*)
   and re-deriving any hard-pinned `alignedPct` fixture value against the
   shipped implementation rather than assuming it's unaffected (the
   `83.33`-pinned fixture is likely unaffected, since needle construction
   alone rarely moves `alignedPct` on a non-dash-collision fixture, but
   confirm rather than assume). Verify `locateSentenceOffsets`'s docstring
   claim of sharing `alignSentences`' semantics (fuzzy fallback excepted)
   actually holds — by construction (shared helper) or an explicit parity
   test.
5. **Performance**: the loop-strip and looped-extension regexes are
   negligible additions to existing per-sentence work (no new full-haystack
   or per-candidate scans, unlike the dropped disambiguation mechanism) —
   a basic sanity benchmark against the validation chapters is still worth
   including in the PR body, but no specific budget concern is expected.

### Known residual (unchanged from `main`, not addressed by this design)

`findAnchors`' own code comment documents that anchors are selected by
length alone with no uniqueness check, so a duplicated ≥24-char sentence can
mis-anchor and strand its run. This is a pre-existing `#2187`-class
limitation, unrelated to dash handling, that this design does not attempt to
fix — see "Out of scope."

**Corrected in v5:** an earlier revision of this section also listed the
zero-anchor case — a dash-stripped `"да."` binding inside `"правда"` when its
run has no eligible anchor at all — as part of the same residual. That was
wrong on both counts. It is not `#2187`-class (it is dash handling, and it is
precisely #2537's own repro), and it is **not** a residual any more: the
shipped search prefers a dash-prefixed occurrence outright, so it resolves
correctly with no anchor bounding the run. `aligner.test.ts`'s
*"both cache forms of a dash-led reply resolve to the REAL speech span even
with zero anchors"* pins that, and is red on `origin/main` for exactly this
reason. A test asserting the mis-bind as expected behaviour was shipped by
attempt 3 and has been replaced.

## Out of scope

- **Anchor/match hardening** (the `findAnchors` duplicate-anchor gap, and
  general robustness in sparse/zero-anchor runs) — the v2/v3 disambiguation
  mechanisms explored this and were shown by real-data measurement to cost
  more than they saved. File as a **separate follow-up issue**, to be
  designed independently with its own measurement baseline (starting from
  Variant C's numbers, not from scratch) — do not bundle into a #2537 re-open.
- Fixing the model's own stochastic dash-dropping at the source.
- `cross-examine.ts:225` and `narrator-default.ts:79,101`'s direct reads of
  the cached sentence text's leading dash — separate consumers of the same
  upstream instability, outside the aligner, whose behavior still varies
  with cache form after this design ships. Worth their own follow-up issue.
- Mid-run re-segmentation drift (a continuation segment gaining a spurious
  leading dash not present in the raw text) — a different, harder problem
  than dash presence/absence on an otherwise-correctly-segmented sentence.
