# Aligner dash-invariance + anchor hardening — design

Status: approved for planning (revised twice after assumption-checker passes
— see "Revision history")
Date: 2026-08-21
Issue: [#2537](https://github.com/dudarenok-maker/Castwright/issues/2537)
Supersedes: the implementation on `fix/server-2537-dash-invariant-align` (PR
[#2577](https://github.com/dudarenok-maker/Castwright/pull/2577)) as it stands
at commit `9262412a` — see "Disposition of PR #2577" below.

## Revision history

**v1 → v2**, after assumption-checker round 1: fixed a false "byte-identical
by construction" proof (didn't loop over multiple leading dashes), added
language gating, corrected mischaracterizations of what code already existed,
reclassified the real-data validation as on-box acceptance work rather than a
CI gate, and replaced anchor-eligibility tuning with a reject-if-ambiguous
principle. See git history for v1's full text if needed.

**v2 → v3 (this revision)**, after assumption-checker round 2 AND a real-data
measurement run against the actual target corpus:

- Round 2 found v2's reject-if-ambiguous mechanism (a) failed its own merge
  gate on the branch's own committed regression fixture, and (b) demoted
  `alignedPct` without acknowledging it gates a real production cliff (the
  80% `flagOnly` floor in `cross-examine.ts`). It also found the
  backward-extension regex fix from v1→v2 was applied to the needle-strip
  regex but not to the offset-extension regex, and that
  `locateSentenceOffsets`'s only production caller (`scene-breaks.ts`) has no
  language available to gate on.
- Rather than guess a third mechanism, a real-data measurement was run
  against the actual cached *Ночной дозор* corpus (all four E11-flagged
  chapters), comparing the reject-if-ambiguous mechanism ("Variant A") against
  an alternative that prefers the dash-context-matching occurrence instead of
  rejecting ambiguity outright ("Variant B"). Full method and results:
  see "Real-data measurement" below. v3 adopts Variant B, grounded in that
  data, and fixes the two remaining round-2 defects (regex loop,
  `locateSentenceOffsets` language plumbing).

## Problem

`alignSentences` and `locateSentenceOffsets`
(`server/src/analyzer/dialogue-structure/aligner.ts`) locate each sentence in
a chapter's raw body by substring-searching a "needle" built from the
sentence's cached, normalized `text`. The inconsistency this design tolerates
is not a deterministic upstream `.replace()` stage; it is the stage-2 model
itself stochastically dropping (or reshaping) a leading paragraph-dash marker
on some sentences and not others (confirmed precedent: #2306, "the model
silently stripped the leading dash from its returned text",
`server/src/store/attribution-health.criteria.test.ts:60`). The variation to
tolerate is broader than "dash present vs. absent" — glyph choice, spacing,
and dash *count* (a continuation segment sometimes gains a spurious extra
leading dash, per `aligner.test.ts:407-415`) all vary too. This design
tolerates dash presence/absence, glyph choice, spacing, and count; mid-run
re-segmentation drift is out of scope (see "Out of scope").

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
   every needle regardless of cache form. Reopens a real false-match risk in
   sparse-anchor runs (below). Rejected before an on-box run.
2. **"Keep the dash if the cache had one"** (`6dddbdc0`) — the needle
   construction is a literal identity transform
   (`hadLeadingDash[i] ? t : t.replace(...)` returns `t` on both branches).
   Confirmed both synthetically and on a real on-box re-run (identical
   14-field divergence). Its unconditional backward-extension is a real,
   live behavior change that is *not* a no-op, though.
3. Applies the same needle-construction no-op to `locateSentenceOffsets`
   (`3053f5dd`); its backward-extension for that function is real and
   already gated on the (defective) `hadLeadingDash` flag — the work owed
   there is deleting the gate and fixing the needle construction, not adding
   new logic.

## Needle construction: loop-stripping is necessary, and sufficient downstream

`normalize(s.text).replace(/^-\s*/, '')` (stripping *one* leading dash) is
not sufficient — it fails when the model emits more than one leading dash
glyph (e.g. `"—— Да."`, the doubled-dash shape `aligner.test.ts:407-415`
documents as real model behavior). Trace it: `normalize("—— Да.")` →
`"-- да."`; stripping one leading `-\s*` leaves `"- да."` — still carrying a
dash, not equal to `normalize("Да.").replace(/^-\s*/, '') === "да."`.

The corrected construction strips **all** leading dash-groups:

```ts
const needles = sentences.map((s) => normalize(s.text).replace(/^(-\s*)+/, ''));
```

`(-\s*)+` repeats until no leading `-` remains, however many the model
emitted. Both `alignSentences` and `locateSentenceOffsets` must use this
exact form; extract a shared, independently-testable needle-builder helper
(exported or otherwise unit-testable) so the invariance property test
(Testing item 1) can assert equality on the needle array itself, not infer it
from behavior — this is what would have caught attempt 2 immediately.

**Downstream, invariance holds cleanly**: every E11-diverging field
(`narratorIdSpoken`, `unknownOriginNarrator`, `unattributedSpeech`,
`splitSpeech`, `tagNarratorSpan`, per-chapter `attributableSpoken`) derives
from `alignSentences`' `spans` / `sentence.characterId` via
`server/src/store/attribution-health.ts:140-290`, and nothing else on that
path reads `s.text` directly. Identical needles ⇒ identical `locateNeedles`
output ⇒ identical measurement on that path. (`cross-examine.ts:225` is a
**separate** consumer reading the cached sentence text's leading dash
directly, outside the aligner — out of scope, see "Out of scope".)

**Empty needles**: if every leading dash-group is stripped and nothing
remains (a sentence cached as just a dash, or dash + whitespace), the needle
is `""`. `fillRun` already treats a zero-length needle as unresolved
(`aligner.ts:250`, `results[i] = null`) — existing, correct behavior; Testing
item 1 must exercise this case explicitly.

## Language gating

`dialogueOpen` is `null` for en/de/ja/zh
(`server/src/analyzer/dialogue-structure/lang/{en,de,ja,zh}.ts`), and
`server/src/analyzer/narrator-default.test.ts:96,109` pins as an explicit
invariant that a leading dash is **not** a dialogue marker in those
languages — it can be real content. Unconditional strip+extension applied to
every language would change span boundaries on English/German/Japanese/
Chinese books — the majority of the corpus — for zero benefit. **The strip,
the backward-extension, and the disambiguation logic below all apply only
when the chapter's language has a non-null `dialogueOpen`** (ru/es/fr today).
When the gate is false, everything falls back to today's (`main`) behavior
exactly.

**Threading this through is not uniform across the two functions:**

- `alignSentences`: all four production call sites already resolve a
  language/convention before calling it —
  `server/src/routes/analysis.ts:2298` (`conventionsFor(opts.stageCall.language)`),
  `attribution-health.ts` (from `input.language`), `evidence.ts:84-86` (a
  `language` parameter), `escalation.ts` (via `opts.stageCall`). Threading the
  resolved `dialogueOpen`-non-null boolean (or the convention itself) in as a
  new parameter is straightforward.
- `locateSentenceOffsets`: its only production caller is
  `scene-breaks.ts:52` (`annotateSceneBreaks(sentences, body)`,
  `scene-breaks.ts:45`), which has **no language parameter today** — and
  `aligner.ts`'s own docstring states this function deliberately "runs on
  every chapter regardless of whether the dialogue-structure engine is
  active," i.e. including chapters where no convention has ever been
  resolved. Two options, implementer's choice, but the fallback direction
  must be conservative:
  1. Thread a language/convention parameter through `annotateSceneBreaks`
     and its own callers (check where those are — likely near wherever
     chapter language is already known from analysis) — real but bounded
     plumbing.
  2. If threading it through is disproportionate to this fix's scope, default
     `locateSentenceOffsets` to **no dash handling** (today's `main`
     behavior, unconditionally) whenever no language is available at the call
     site, and only enable the new logic on the calls where a language
     happens to be plumbed in already, if any. This sacrifices closing
     `locateSentenceOffsets`'s share of #2537 for chapters processed via
     `annotateSceneBreaks` alone, but never regresses anything, and is
     explicitly an acceptable interim scope reduction — record it as a
     follow-up rather than silently under-scoping.

## Anchor + match hardening: the corrected mechanism (Variant B)

The file already has a robustness mechanism for short/common needles:
`#2187`'s two-pass anchor system. Needles ≥ `ANCHOR_MIN_LEN` (24 normalized
chars) become "anchors" in a first pass (`findAnchors`) and bound a monotonic
cursor; every shorter needle is resolved in a second pass (`fillRun`),
strictly confined to the interval between its two neighboring anchors —
"structurally impossible" to escape, **provided anchors exist reasonably
close on both sides**. Attempt 1's rejected regression only reproduces in a
run with no anchor at all, where Pass B's search is effectively unbounded and
a short needle can bind to the wrong occurrence of common text.
`findAnchors`' own code comment also documents an adjacent, pre-existing gap:
anchors are chosen by length alone with no uniqueness check, so a duplicated
≥24-char sentence can mis-anchor and strand its run.

Two mechanisms were built and measured against real data (see "Real-data
measurement" below) rather than chosen by argument alone:

- **Variant A — reject-if-ambiguous**: when a match (anchor or infill) has a
  second, indistinguishable occurrence nearby, discard it as ambiguous
  (return unaligned) rather than silently accepting the first hit.
- **Variant B — prefer-dash-context**: when a match has a second
  indistinguishable occurrence, **prefer whichever candidate sits immediately
  after a paragraph-leading dash at the start of a line in the raw body** —
  reusing the exact predicate the file already computes for backward-
  extension. Fall back to Variant A's reject-as-ambiguous behavior only when
  zero or more-than-one candidate satisfies that predicate.

**Measured result: Variant B strictly dominates or matches Variant A on
every real chapter tested** — never worse, and on chapter 1 recovers 4 of 7
of Variant A's residual regressions via genuinely dash-invariant matching
(hand-verified: both cache forms of the recovered sentences produce the
identical stripped needle). **Ship Variant B.**

### Mechanism, precisely

- **Pass A (`findAnchors`)**: unchanged eligibility floor (`ANCHOR_MIN_LEN`).
  When a candidate ≥ `ANCHOR_MIN_LEN` has a second occurrence later in the
  remaining haystack: if the language gate is on and exactly one of the
  occurrences is immediately preceded by a paragraph-leading dash at a line
  start, anchor on that one; otherwise, skip the candidate (leave it for Pass
  B) exactly as Variant A would. This closes the *forward*-duplicate
  sub-case of the documented anchor gap, with dash-context as a tiebreaker
  where the language gate applies — it does **not** close the behind-cursor
  sub-case (see residual).
- **Pass B (`fillRun`)**: for a needle below `ANCHOR_MIN_LEN`, when a second
  occurrence exists within a bounded local window (the file's existing
  `WINDOW` = 4096 chars, measured **forward from the located position**, not
  from the run's cursor — the anchor point must be the position `findMatch`
  actually returned, since `findMatch`'s unbounded fallback can return a
  position outside a naive `[cursor, cursor+WINDOW)` slice): same dash-context
  tiebreak — prefer the sole occurrence immediately preceded by a
  paragraph-leading dash at a line start, when exactly one qualifies;
  otherwise treat as unresolved.

This is deliberately **not** full Approach B from the original design
discussion (uniqueness-gated matching for every short needle everywhere, no
tiebreak, no local-window scoping) — it is scoped to a bounded local window
and prefers a real signal over blind rejection where one is available.

### Real-data measurement

Method: reconstructed both variants against the actual `main` `aligner.ts`,
ran against the real cached *Ночной дозор* stage-2 sentences
(`server/handoff/cache/mns_oyK7Po6BiT.json`) and the real manuscript
(`C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch
Tetralogy\Ночной дозор\manuscript.epub`), on all four E11-flagged chapters
(1, 6, 7, 8), comparing each variant's per-sentence resolved spans against
`main`'s baseline.

| Chapter | sentences | baseline alignedPct | Variant A | Variant B | A regressions (correct→unaligned) | B regressions |
|---|---|---|---|---|---|---|
| 1 | 2777 | 98.02% | 99.39% | **99.53%** | 7 | **3** |
| 6 | 1682 | 92.69% | 99.58% | 99.58% (identical to A) | 5 | 5 |
| 7 | 1867 | 92.02% | 99.57% | 99.57% (identical to A) | 1 | 1 |
| 8 | 1543 | 95.66% | 99.94% | 99.94% (identical to A) | 0 | 0 |

**The 80% production floor (`cross-examine.ts:58`, `flagOnly = alignedPct <
80`) was never at risk** — both variants land at 99.4–99.9% on every chapter
tested, well above `main`'s already-safe 92–98% baseline. v2's concern about
`alignedPct` cliff risk does not materialize on real data; it remains true
that `alignedPct` alone is not a sufficient correctness instrument (a
false-positive match still counts as aligned), so the per-sentence diff below
is still the primary bar — but the floor-crossing risk specifically is
resolved by measurement, not argument.

**Where B improves on A** (chapter 1, hand-verified): sentences like
`"- Нет."` where the body contains `"Нет. Пока нет."` — two candidate
occurrences, only the first preceded by a real paragraph-leading dash. A
rejects both as ambiguous (regression: this was correctly aligned on `main`).
B correctly picks the dash-preceded one (recovery). Verified the with-dash
and without-dash cached forms of this sentence produce the identical
stripped needle, confirming the recovery is genuinely dash-invariant, not
coincidental.

**Where B cannot help (identical to A)**: chapters 6, 7, 8's ambiguous cases
each had either zero or multiple candidates satisfying the dash-context
predicate, so B correctly falls back to A's behavior. Inspected samples of
A/B's residual regressions on chapter 6 (5 sentences: `"- Верни мне мое,"`,
`"- Да."` ×2, `"Иной."`, `"Холодно."`) — **3 of 5 have no leading dash at
all**. These are not dash-handling defects; they are the pre-existing cost
of rejecting/disambiguating *any* short, locally-duplicated needle,
independent of #2537. This design does not attempt to recover them (see
residual below) — they are a small, quantified, and correctly-attributed
cost, not a hidden regression.

### Explicit residual (not closed by this design)

1. A short needle whose only nearby duplicate is **not** dash-context-
   resolvable (neither/both candidates satisfy the predicate, or the
   ambiguity is unrelated to dash marking at all — e.g. two occurrences of a
   plain word like "Иной." or "Холодно.") still resolves to unaligned rather
   than correct. Measured cost: 0–5 sentences per real chapter tested (see
   table above), against 45–142 real recoveries per chapter. Accepted as a
   pre-existing #2187-class limitation this design narrows, not one it
   fully closes.
2. **The behind-cursor duplicate-anchor sub-case is not addressed** — a
   structural limitation of the monotonic-cursor architecture generally, not
   reachable by a local candidate-selection check. State this in the code
   (matching the file's existing "KNOWN RESIDUAL" comment pattern).
3. The dash-context predicate is anchored on "preceded by a real newline" —
   the chapter-1 measurement found this misses turns whose EPUB source
   physically joins multiple dialogue lines onto one line (no `\n` between
   them). Not fixed here; note as a nameable follow-up limitation, not a
   silent gap.

### Disposition of PR #2577

Rework the existing branch and PR in place. Replace the needle-construction
and backward-extension logic from all three prior commits outright,
including `locateSentenceOffsets`'s existing backward-extension block (gate
removed, needle construction fixed to match, subject to the language-gating
fallback above). The bookkeeping commits (release notes, on-box register
note) get amended once the real fix lands and is validated — they currently
describe rejected/no-op mechanisms and need correcting to describe what
actually ships, including the measured numbers above.

**Also fix, since this section is being rewritten regardless**: the
backward-extension regex (`aligner.ts:353`, `:423` on the current branch,
and its `locateSentenceOffsets` twin) matches exactly one dash glyph
(`/([-–—])\s*$/`); this must loop the same way the needle-strip regex does,
or a doubled-dash line's raw span extends inconsistently with a single-dash
line's. `--` at line start is a **documented model behavior**
(`aligner.ts:95-100`'s own comment: "the model's typewriter-style em dash"),
not a rare edge case — this is not optional polish.

## Testing

`alignedPct` alone is never a sufficient pass/fail signal (it rises on a
false-positive match) — the real-data measurement above resolves the
*floor-crossing* risk specifically, but per-sentence diffing (item 4) remains
the primary correctness instrument.

1. **Invariance property test** (both functions, only for languages where
   the language gate is true): generate sentence pairs varying dash count (1,
   2, 3+ leading glyphs), glyph choice (`-`/`–`/`—`/`&mdash;`/`&ndash;`), and
   spacing, assert byte-identical needles via the shared needle-builder.
   Assert the with-dash needle differs from naive `normalize(s.text)`.
   Include the empty-needle case, assert it resolves to `null`. Assert that
   when the language gate is false, needle construction is byte-identical to
   `main`'s current behavior.
2. **Regression tests**, with an outcome now grounded in measurement rather
   than asserted: the attempt-1 repro (`"— Да."` vs. decoy `"правда"` with
   no dash before the decoy) must resolve to the **correct** speech span
   under Variant B (since exactly one candidate is dash-context-valid) — this
   supersedes v2's requirement that it resolve to `spans: []`, which was
   only correct for Variant A. Add a second fixture modeled on the
   real chapter-6 residual (two candidates, NEITHER or BOTH dash-context-
   valid, or ambiguity unrelated to dashes) and assert it resolves to
   `spans: []`, documented explicitly as the accepted residual case, not a
   silent gap.
3. **Anchor/window disambiguation unit tests**: (a) a duplicated ≥24-char
   sentence with exactly one dash-context-valid candidate anchors on the
   right one; (b) with zero or multiple valid candidates, it's skipped
   (left for Pass B); (c) same three cases for a sub-`ANCHOR_MIN_LEN` needle
   in Pass B's local window; (d) a short needle whose only other occurrence
   is **outside** the local window still resolves normally (protects
   `alignedPct` on legitimately repeated short dialogue spread across a long
   run).
4. **Real-data validation (on-box acceptance work, not a CI gate)** — the
   cache and manuscript live only in the primary checkout's local workspace,
   not in any worktree, CI, or fresh clone. This design's own measurement
   (table above) already discharges the bulk of this requirement for the
   chosen mechanism; the implementer's job before merge is to re-run the same
   comparison against the **actual shipped implementation** (not the
   reconstructed variant used for design measurement) on the same four
   chapters, confirm the numbers match or improve on the table above, and
   attach the re-run's counts to the PR body. This does **not** discharge E11
   item (2) (a whole-library, whole-chapter `measure-attribution.mjs`
   double-run) — update the E11 register row to record the fix landed and
   was spot-validated on four chapters with the numbers above, but the row
   stays open until the full on-box re-run is actually performed.
5. Existing `aligner.test.ts` / `scene-breaks.test.ts` suites, other than the
   fixtures explicitly reworked per item 2 above, must stay green — including
   `aligner.test.ts:231-258` (offsets differ with/without dash — must be
   updated to assert they're now the SAME, per the corrected invariant) and
   any hard-pinned `alignedPct` value fixture (e.g. one pinning `83.33`) —
   re-derive the expected number against the shipped implementation rather
   than assuming it's unaffected.
6. **Performance**: the disambiguation checks add real cost. Benchmark the
   actual implementation against one dash-dense and one low-dash-density
   chapter, report both numbers in the PR body — if either exceeds roughly
   2× the pre-fix baseline, flag it for a follow-up rather than shipping
   silently.

## Out of scope

- Approach C (composite-needle localization for consecutive short dialogue
  blocks) — a follow-up if the residual above is hit often enough in
  practice to matter beyond what's already measured.
- Full Approach B from the original design discussion (uniqueness-gated
  matching for every needle length everywhere, no dash-context tiebreak, no
  local-window scoping) — not pursued; superseded by the measured, scoped
  mechanism above.
- Fixing the model's own stochastic dash-dropping at the source.
- `cross-examine.ts:225`'s direct read of the cached sentence text's leading
  dash — a separate consumer of the same upstream instability, outside the
  aligner. Worth its own follow-up issue.
- Behind-cursor duplicate-anchor resolution (residual #2) — would need a
  non-monotonic or lookback-capable matching scheme.
- The dash-context predicate's newline-anchoring gap (residual #3) against
  EPUB sources that join multiple dialogue turns onto one physical line.
- Threading a language parameter through `annotateSceneBreaks`/
  `locateSentenceOffsets`'s wider call graph, if the implementer takes the
  conservative fallback option in "Language gating" instead.
