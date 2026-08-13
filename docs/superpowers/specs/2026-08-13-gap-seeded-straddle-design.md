# The gap-seeded straddle, and what actually blocks the `quotePairs` widening — design

Status: **active — owner decided 2026-08-13: rule B (gap tier). "No destroyed
turns" is the reading.** · Issue: [#2288](https://github.com/dudarenok-maker/Castwright/issues/2288) (M2) · Blocks: [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286) / [#2279](https://github.com/dudarenok-maker/Castwright/issues/2279) · Follows: M1, [`2026-08-12-quote-delimiter-validity-design.md`](2026-08-12-quote-delimiter-validity-design.md) (shipped `e839a939`, PR [#2300](https://github.com/dudarenok-maker/Castwright/pull/2300))

Implementation plan: [`docs/superpowers/plans/2026-08-13-gap-seeded-straddle.md`](../plans/2026-08-13-gap-seeded-straddle.md)

---

## Summary

The mechanism is real and the fix direction is **pair tiering**: a language's
conventions gain a companion `secondaryQuotePairs`, and PR #2286's nine added
pairs land there rather than in `quotePairs`. Two forms of the tier were built
and measured. **Neither is unconditionally shippable, and the choice between
them is the owner's**, because they sit on opposite sides of the decision this
ticket has been circling since #1601.

| | `shipped` today | **A — paragraph tier** | **B — gap tier** |
|---|---:|---:|---:|
| item 1 · nine added pairs disqualified | 9 of 9 | **0 of 9** | 9 of 9 |
| item 2 · six-language sweep (F1) | 437 | **0** | 284 |
| item 3 · 140-book corpus | 938 / 0 / 0 / 0 / 0 | **same** | **same** |
| item 4 · empty-tier parse identity, 726,385 paragraphs | — | **0 differing** | **0 differing** |
| item 5 · `en`/`zh` nesting → OUTER | yes | **yes** | **yes** |
| straddle family (F2) hits | 1,760 | **0** | 796 |
| `gap × nest` cross-product (F3) hits | 12,715 | **0** | 6,084 |
| **shapes with a turn destroyed** — F2 | 473 | **0** | **0** |
| **shapes with a turn destroyed** — F3 | 1,053 | **0** | **0** |
| **nesting broken** — F3 | 0 | **0** | **0** |
| **turns destroyed** — per-candidate, all nine | 339 | **0** | **0** |
| **dialogue suppressed by a quoted title in narration** | 0 of 21 | **21 of 21, both turns** | **0 of 21** |
| **benefit retained** (F1 GAIN) | 1,043 | **212 (20%)** | **1,043 (100%)** |

**A clears the stated five-item bar and should not ship.** The bar does not
measure the two things that disqualify it: it destroys *every* dialogue turn in
a paragraph whose narration happens to quote a title in the primary convention
— verified, 21 of 21 shapes, both turns, in all six languages — and it discards
80% of what #2279 exists to buy. Both are invisible to all five acceptance
instruments by construction (§ *The suppression class*).

**B destroys no turn anywhere, breaks no nest, keeps the whole benefit, and
leaves 284 + 796 + 6,084 spurious runs** — narration read as speech on
*drifted* input, never a lost turn. That residual is precisely the cost the
standing owner answer refuses.

**So the decision is now priced.** It is no longer "is drifted-input corruption
acceptable in the abstract" but: *is 284 of 51,608 drifted shapes reading a
narration span as speech worth 100% of the widening plus zero destroyed turns,
versus zero such shapes at the cost of 80% of the widening and a systematic
dialogue loss in exactly the books the widening targets?* (284 is the F1
figure; the same trade reads 796 of 10,605 on F2 and 6,084 of 91,393 on F3.) The design
recommends **B**, and says why below — but the answer is the owner's, and the
plan gates on it.

Two findings about the *evidence* matter as much as the result, and both were
produced by attacking this document rather than by building it:

1. **The acceptance criterion can be passed without fixing the ticket.** Its 437
   shapes contain **zero destroyed turns** — confirmed by two independent
   predicates. § *The family the criterion was missing*.
2. **Neither the criterion nor any instrument built for it can see the
   suppression class**, which is what nearly shipped rule A. § *The suppression
   class*.

---

## The owner decision, and what it now costs

**Whether drifted-input corruption is an acceptable cost for recognising more
conventions.** German answered *no* — that is why #1601 pairs `„` with three
closers rather than widening the opener set — and that answer was extended to
the other six languages. Going into this design pass the owner confirmed that
answer stands.

**The measurement changes what the question is.** Under the old framing the two
options were "widen and corrupt 437" or "do not widen". There is now a third:

| option | drifted-input corruption | turns destroyed | benefit |
|---|---:|---:|---:|
| don't widen (today) | 0 | 0 | 0 |
| widen, no tier (#2286 as it stands) | 437 + 1,760 + 12,715 | 473 + 1,053 | 100% |
| **A** paragraph tier | **0** | **0 in the sweeps; total in the suppression class** | 20% |
| **B** gap tier | 284 + 796 + 6,084 | **0** | 100% |

The standing answer selects A over "widen, no tier". It does **not** obviously
select A over B, because B's residual is a strictly milder harm class than the
one the standing answer was formed against: #1601's German case destroyed
turns, and B destroys none. A, meanwhile, introduces a *new* destruction class
the standing answer would also refuse if it had been visible.

That is the decision, stated as the design owes it: **does the "no corruption
on drifted input" rule mean "no spurious speech spans", or "no destroyed
turns"?** #1601 is consistent with either reading; the two have never had to be
distinguished before.

### Decided, 2026-08-13 — "no destroyed turns". Rule B (gap tier) ships.

The repo owner selected **B**, presented with the priced table above. The
reading of record is now explicit: **a rule must never destroy a turn; a
spurious narration-read-as-speech span is a lesser harm and is accepted where
eliminating it would cost turns or benefit.**

The two residuals are accepted with it, and each is asymmetric in the way that
decided it: B's residual is **narration spoken aloud** — audible, attributable,
and recoverable by a later rule; A's residual is **dialogue silently lost** —
inaudible, and invisible to every instrument built for this ticket, which is
how it nearly shipped. That asymmetry, not the raw counts, is what the standing
German answer was actually protecting against.

> ### ⚠ CORRECTION, 2026-08-13 — B's residual as priced above is UNDERSTATED
>
> **The sentence above is the pricing the owner approved rule B on, and it is
> incomplete.** A review gate on PR #2286 — the first consumer to populate a
> secondary tier — found a third residual that neither this document nor any
> instrument built for it could see:
>
> **A gained secondary run landing inside a TAG CLAUSE truncates it, and the
> adjacent real turn loses its speaker.** The turn survives, so every
> turns-destroyed instrument reads 0, and the line is then read **in the wrong
> voice**:
>
> ```
> input: «Привет», сказал ‘Антон’.
> main:  speech[anton]="Привет" | tag[-]=", сказал ‘Антон’."
> tiered: speech[-]="Привет"    | tag[-]=", сказал " | speech[-]="Антон" | narration[-]="."
> ```
>
> Reproduced in `ru`, `es`, `fr` and `en`; the span-structure half was
> independently re-verified (2 spans on `main`, 4 on the widened tree, all three
> languages). Measured over the same 291-book corpus: **265 gained runs
> overlapping a `main` tag span, across 92 paragraphs** (zh 84, es 4, ja 3,
> fr 1).
>
> **A real turn losing its speaker is not "narration spoken aloud."** It is not
> recoverable by a later rule in the sense that sentence claims, and it is not
> attributable — it is the attribution that is destroyed. Read against the
> reading of record, it is closer to A's class than to B's.
>
> **Why every instrument here was blind to it:** the corpus comparison builds
> `buildNameIndex([], conv)` — an **empty roster** — and classifies on speech-run
> `[start,end)` geometry alone, so speaker fields are never populated and never
> compared. "0 lost / 0 merged / 0 split" is silent about attribution **by
> construction, not by measurement**. The generated sweeps and the residual pins
> compare span strings only. **Any future metric in this loop must be
> attribution-aware and must ship a positive control proving it can see this
> class.**
>
> Separately, and for the same reason this correction exists: the
> `sweep-six-langs` "0 destroyed of 51,608" figure is a **constant**. It reads 0
> with the straddle guard deleted, with the overlap guard deleted, and with the
> pairs moved back into the primary table; a German positive control confirms
> the counter itself works. **That family is not evidence about the tier and
> must not be cited as a gate.**
>
> **Disposition:** the decision for B over A stands — this does not make A
> better, since A destroys turns outright. What changes is that **B is not
> finished**. The tag-clause truncation is folded into the
> [#2315](https://github.com/dudarenok-maker/Castwright/issues/2315) design pass,
> which now covers both it and the primary-pair straddle, and PR #2286 is held in
> draft until that lands and the corpus is re-measured with an attribution-aware
> metric.

**This does not reopen #1601 or contradict the standing answer.** German
answered "drifted input must not corrupt" against a case that *destroyed
turns*; B destroys none. What the decision settles is the ambiguity nobody had
had to resolve before, not the earlier ruling.

**Item 1–2 of the ticket's acceptance criterion are formally superseded**, and
must not be re-imposed on the implementation: they measure spurious spans, and
the same measurement pass proved they contain zero destroyed turns — so they
were passable without fixing the ticket. The binding criteria are now the
turns-destroyed columns across all three families, the suppression class
(0 of 21), the corpus result (938 repairs / 0 merged / 0 lost), nesting, and
the 270-test suite.

---

## The mechanism

`findQuoteRuns` (`server/src/analyzer/dialogue-structure/parser.ts:341`) builds
one candidate per opener occurrence, then accepts leftmost-first (`:442-450`),
discarding any candidate that starts inside an already-accepted run. That rule
only suppresses candidates seeded *inside* a run. An opener glyph seeded in an
inter-run **gap**, whose nearest same-class closer sits at or beyond the next
genuine turn's opener, is accepted anyway — and the genuine turn is then
discarded for overlapping it.

Live, on the widened tables (both pass on `main`'s tables and fail on #2286's):

```
ru  «Привет», сказал он, глядя на ‘Фауста. «Пока», сказала она О’Брайену.
    main       ["Привет","Пока"]
    widened    ["Привет","Фауста. «Пока», сказала она О"]

en  “Hi,” he said, passing the «Faust poster. “Bye,” she said, near the «gallery».
    main       ["Hi,","Bye,"]
    widened    ["Hi,","Faust poster. “Bye,” she said, near the «gallery"]
```

M1's bound cannot help: it is armed by a *rejection*, and here nothing is
rejected. That is why M1 moved the widening number by exactly zero.

### Why no rule local to a candidate can decide it

A stray `‘…’` *containing* a genuine `«Пока»` turn, and a legitimate nest
`“He said ‘hi’ to me,”`, are **the identical interval geometry**: one outer
candidate strictly containing one inner candidate of a different class. One must
resolve to the inner run, the other to the outer. The distinguisher is not in
the interval, the glyphs, or the neighbours — it is *which convention the
paragraph is written in*. Every local rule measured below fails from one side or
the other, and none reaches zero.

---

## The family the criterion was missing

`sweep-six-langs.mts` builds each shape as *turn 1 · quoted sign · turn 2*, with
the stray quoted noun **between** the turns. A run seeded in the gap therefore
finds the sign's own closer and stops **before turn 2 begins**. Re-scored with
`2288-metric.mts`'s overlap classifier:

```
GAINED   430      MOVED      7      LOST 0   MERGED 0   SPLIT 0
```

**Not one destroyed turn** — so a rule could drive 437 → 0 by declining
spurious narration runs and leave every straddle in place.

**Corroborated by a second, independent predicate**, because the classifier
alone would not be enough to carry a claim this load-bearing: re-scoring the
same 437 with the sweep's own *text* test (the one that yields F2's 473
destructions) also returns **0 of 437 destroying a turn**. Two instruments with
different failure modes agree.

A second family (`m2-sweep2.mts`) supplies the missing geometry — stray opener
in the gap, its reachable closer **after** turn 2, the `О’Брайен` / `«gallery»`
shape:

```
{o1}Hi{c1}, he said, passing the {stray}Faust poster.
{o2}Bye{c2}, she said, near the gallery{late}.
```

51,608 shapes, 10,605 with a right reference: **1,760 corrupted, 473 destroying
a turn** under today's parser.

### Family 3 — the `gap × nest` cross-product

Families 1 and 2 both lack a nest. Neither therefore contains the cell where a
**legitimate nest** and a **gap-seeded stray** share one paragraph — which is
exactly the geometry § *Why no rule local to a candidate can decide it* calls
undecidable, and exactly where a rule that passes each family separately can
still fail. *Sweep families are the coverage; the defect lives in the
cross-product.*

```
{o1}He said {no}hi{nc} to me{c1}, she explained, passing the {stray}Faust poster.
{o2}Bye{c2}, she said, near the gallery{late}.
```

Outer pair × nest pair × turn-2 opener × turn-2 closer × (stray, late):
**145,732 shapes, 91,393 with a right reference.** Under `shipped` + widened
tables: **12,715 corrupted, 1,053 destroying a turn, 0 breaking nesting.**

Both tier rules break nesting on **0** of them. This was the one item the
adversarial pass left open, and it resolves in both rules' favour.

### What the classifier cannot see, stated because this document leans on it

The classifier reports **MERGED** only when a candidate run overlaps **two or
more** baseline runs. A run that swallows exactly *one* neighbouring turn
preserves the run count and a one-to-one overlap, and is reported **MOVED**:

```
es  «Hola», … el "cartel de Fausto. «Y tú», preguntó ella, … galería".
    ref  ["Hola","Y tú"]
    cand ["Hola","cartel de Fausto. «Y tú», preguntó ella, … galería"]
    → two runs before, two after, bijective overlap → MOVED
```

So on F2 the classifier reports 7 MERGED where the text predicate finds 473
destroyed turns. The classifier under-reports single-turn swallowing by ~66×.
It is still the right instrument for what it is used for here — *ruling
destruction in*, which it does conservatively — but a `MERGED 0` is **not** a
statement that nothing was destroyed, and no claim in this document rests on
one. Every destruction figure quoted is the text predicate's; the classifier is
reported alongside it, never instead of it.

---

## Candidate rules evaluated

All rules reuse the shipped (post-M1) candidate scan verbatim — same
`isRealCloser`, same per-glyph rejection bound, same `crossGlyphBound`, same
never-delete fallback — so any column difference is attributable to the one
mechanism that moved.

F1 = sign-in-the-gap family (the criterion's 437). F2 = straddle family.
REGR = the rule breaking today's shipped reading on `main`'s tables.
GAIN = F1 shapes where the widening recovers BOTH turns and the reference
recovers fewer — **what #2279 exists to buy**. Corpus = 140-book English,
baseline pre-#2288 `RULES.main`. SUPP = the suppression class, 21 shapes.
Anchors = 9 cases incl. both nesting invariants and both ticket
counter-examples, on the widened tables.

| rule | F1 | F1 REGR | **GAIN** | F2 | F2 destroy | F3 | F3 destroy | corpus harm | **SUPP** | anchors |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|
| `shipped` (today) | 437 | 0 | 1,043 | 1,760 | 473 | 12,715 | 1,053 | none (938 repairs) | 0 | 7/9 |
| **A′** role-based two-phase | 437 | 0 | — | — | — | — | — | not measured — F1 unmoved | — | 7/9 |
| **B′** shortest-first | 472 | 24 | — | — | — | — | — | **SPLIT 742** | — | 6/9 |
| **C** convention election, two-phase | 446 | 11 | — | 1,753 | 453 | — | — | **SPLIT 542, MERGED 1** | — | 9/9 |
| **C′** election, primary only | 2,304 | 1,363 | — | — | — | — | — | not measured | — | 8/9 |
| **S** straddle suppression | 275 | 27 | — | 1,013 | 217 | — | — | **LOST 66, SPLIT 7** | — | 7/9 |
| **S′** straddle suppression, any class | 247 | 27 | — | — | — | — | — | not measured | — | 8/9 |
| **G** unit-mark opener validity | 427 | 2 | — | — | — | — | — | not measured | — | 7/9 |
| **S+G** | 243 | 10 | — | 1,002 | 217 | — | — | **LOST 70, SPLIT 7** | — | 7/9 |
| **A** paragraph tier, filter form | **0** | **0** | 212 | **0** | **0** | — | — | none (938 repairs) | **21** | 9/9 |
| **A** paragraph tier, re-scan form | **0** | **0** | **212** | **0** | **0** | **0** | **0** | none (938 repairs) | **21** | 9/9 |
| paragraph tier, overlap-only | 430 | 0 | 1,043 | 1,223 | 0 | — | — | not measured | — | 9/9 |
| paragraph tier + straddle suppression | 0 | 27 | — | 0 | 0 | — | — | **LOST 66, SPLIT 7** | — | 9/9 |
| **B — gap tier** ★ | 284 | **0** | **1,043** | 796 | **0** | 6,084 | **0** | none (938 repairs) | **0** | 9/9 |

★ recommended, subject to the owner decision above.

Rows marked "not measured" were pruned on F1 alone, which — as the review of
this document pointed out — is a benefit-blind criterion. They are all
strictly worse than `shipped` or than A/B on a column that was measured, so
none is a live candidate; the gap is recorded rather than papered over.

**Why each non-tier rule is out**, one line each:

- **A′** moves nothing: the spurious opener is itself unambiguous, so it wins
  phase 1 exactly as it wins leftmost-wins.
- **B′** breaks nesting (6/9) and cuts 742 real English turns into fragments.
- **C** passes every anchor but *raises* F1 and splits 542 corpus paragraphs.
  Electing the convention by candidate count is systematically wrong for one
  outer turn nesting two inner quotations — the inner class wins on count.
- **S** is the only local rule that dents both families, and it **deletes 66
  real English runs**: a legitimately unclosed inner opener (a multi-paragraph
  quotation) is indistinguishable from a straddled one. It violates M1's
  never-delete invariant on real text.
- **tier + S** inherits that: 66 corpus LOST and 239 differing paragraphs even
  with an empty tier, so it is not a no-op on today's tables.

---

## The two tier forms

### A — paragraph tier

Scan the paragraph with `quotePairs` alone; re-scan with
`quotePairs ∪ secondaryQuotePairs` **only if the primary scan produced no run**.

### B — gap tier (recommended)

Accept primary-pair runs first; let secondary-pair candidates fill the
**remaining gaps**, declining any whose interior contains a **primary opener
glyph** — the signature of a secondary run that straddled *into* a primary turn
rather than sitting beside it.

B cannot delete a primary run and cannot alter a table with an empty tier, so
M1's never-delete invariant and the 270-test suite hold **by construction**
rather than by measurement.

### The suppression class — why A is not recommended

A's justification requires the primary scan to be a *convention detector*. It is
not: it is an **any-run detector**, and the never-delete fallback means almost
any stray primary opener with a later closer yields a run. So a
primary-convention quotation appearing in **narration** — a book title, a sign,
a scare quote — suppresses every genuine dialogue turn in that paragraph.
Verified live, and it is total:

```
es  Leía «Fausto» en la portada. "Hola", dijo él. "Adiós", dijo ella.
    main             ["Fausto"]
    widened no tier  ["Fausto","Hola","Adiós"]
    widened + A      ["Fausto"]            <- both turns lost
    widened + B      ["Fausto","Hola","Adiós"]

ja  彼は表紙の「ファウスト」を読んだ。“おはよう”と彼は言った。“さようなら”と彼女は言った。
    widened + A      ["ファウスト"]
    widened + B      ["ファウスト","おはよう","さようなら"]
```

Sized over every (primary pair as the narration title) × (added pair as the
dialogue convention) combination in all six languages: **21 of 21 shapes lose
BOTH turns under A. 0 of 21 under B.**

This is not an exotic shape. Corner brackets for titles in Japanese and
guillemets for titles in Spanish/French are routine — in exactly the books
typeset in the *secondary* convention, which are the only books where the
secondary tier matters at all.

**It is invisible to every instrument built for the acceptance criterion**, and
that is structural, not an oversight in any one of them: F1, F2 and the
per-candidate table all anchor "right" on the shipped-`main` reading, which here
recovers only the title and neither turn, so the shape is never scored; and
`m2-blindspot.mts` additionally requires the candidate to be *corrupt* (to
contain a narration word), which a bare title is not. A cleared all five items
with controls, and would have shipped.

### Why the paragraph is the scope for A, and the gap for B

`parseChapterStructure` splits a body by line and calls `parseQuoteParagraph`
once per line, so any tier decision is per paragraph unless that contract
changes. Verified: `findQuoteRuns` has exactly one call site (`parser.ts:460`)
and `parseDialogueSpans` does not recurse into it, so there is no second,
interior tier decision. Paragraph scope is right for the cross-chapter worry —
a secondary-convention turn in its own paragraph still parses.

B goes finer still: its unit is the *gap between primary runs*, which is what
makes it immune to the suppression class. A paragraph-level verdict is exactly
the thing that over-generalises from one quoted title.

### The second consumer: `isSpokenLine` reads both tiers

`isSpokenLine` (`server/src/analyzer/narrator-default.ts:34`), made
conventions-driven by #2245, is a second consumer of `quotePairs`. If the tier
applied there, #2286's pairs would land in a field it never reads and the
widening would fail to reach the narrator-default demotion — one of the two
things #2279 exists to fix, and a real dialogue line would be demoted to
narrator.

**`isSpokenLine` therefore reads `quotePairs ∪ secondaryQuotePairs`, with no
tier.** Safe for the same reason the tier is needed in `findQuoteRuns` and not
here: it computes no run boundary, so it cannot straddle. Its failure direction
is a false *positive* — "do not demote" — which is the conservative one for a
demote-only heuristic.

### Sequencing

**Engine first, tables second.** M2 ships the tier with every language's
`secondaryQuotePairs` empty — provably a no-op. #2286 then moves its nine pairs
into that field and lands.

---

## Invariants preserved, and how each was verified (rule B)

| invariant | verification | result |
|---|---|---|
| **Runs are disjoint** | acceptance is primary-then-gaps with an overlap test on every admission | by construction; asserted in the plan's Task 4 |
| **Nesting resolves to the OUTER run** (`en`, `zh`) | anchor cases 1–2, `main` **and** widened tables | 9/9 on both |
| **#1601 stays fixed** | anchor case 5, `de` | pass |
| **`dialogueOpen` untouched** | not on any code path this changes | by construction |
| **Never delete a run** | 140-book corpus, classifier | **LOST 0, MERGED 0, GAINED 0, SPLIT 0**; also by construction — B never removes a primary run |
| **M1's 938 repairs survive** | same run | 938 clean repairs, `brokenBoundary` 0, MOVED 950 — identical to `shipped` |
| **270-test suite stays green** | empty-tier no-op proof, below | 0 differing parses in 726,385 paragraphs |

> The corpus row is **938 clean repairs / SAME 173,317 / MOVED 950 / LOST 0 /
> GAINED 0 / MERGED 0 / SPLIT 0**. The acceptance item states five figures and
> omits MOVED; the 950 boundary moves are M1's, identical under every tier rule,
> and are recorded here so the tuple is not read as complete.

### The no-op proof for acceptance item 4

A design pass cannot run a suite against code it has not written; what it can do
is show the suite sees an unchanged parser. The 270 tests run against the
shipped tables, and no shipped table declares a secondary pair.

For B this is true **by construction** — `prim.length === pairs.length` returns
the shipped expression literally — and measured over the whole 331-book corpus,
7 languages, each against its own table, 726,385 paragraphs, 239,725 with runs:

```
DIFFERING 0
CONTROL (declare en ['‘','’'] secondary):  DIFFERING 14   — must be > 0
```

> **A correction, and why it is left visible.** An earlier revision of this
> document reported that control as **126**. It is **116** for rule A and
> **14** for rule B, reproducibly, across repeated runs; 126 could not be
> reproduced under any rule and was wrong. Given that this harness has a
> disclosed history of silently no-opping, an unreproducible control number was
> the single worst error the document contained, and it was caught by the
> adversarial pass rather than by me.

---

## Evidence, and what it cannot say

### Instruments

Reused unchanged: `2288-metric.mts` (overlap classifier + nine positive controls
that fire on import), `2288-corpus-lib.mts` + the 331-book corpus,
`sweep-six-langs.mts` / `2286-percandidate.mts` as the specification of the
acceptance figures, `rules.mjs`.

New, all in the session scratchpad, all in-memory, none touching
`C:\AudiobookWorkspace`, none editing a production file:

| file | what it is |
|---|---|
| `m2-engine.mjs` | the shipped candidate scan ported verbatim + every rule in the table |
| `m2-setup.mjs` | builds two patched *copies* of the module (main tables / #2286 tables) delegating `findQuoteRuns` to `M2_RULE` |
| `m2-sweep.mts` | family 1, with the criterion's blind spot closed |
| `m2-sweep2.mts` | family 2 — the straddle geometry |
| `m2-percandidate.mts` | acceptance item 1, over both families |
| `m2-corpus.mts` · `m2-identity.mts` · `m2-nest.mts` | items 3, 4, 5 |
| `m2-classify437.mts` | the reframing measurement |
| `m2-primary-residual.mts` · `m2-blindspot.mts` · `m2-delta-crosscheck.mts` | ground-truth scoring and the criterion's blind class |
| **`m2-suppress.mts`** | the suppression class — built only after the adversarial pass named it |
| `m2-verify-claims.mts` | the two claims this document would otherwise assert |
| `m2-report.md` | every figure with the command that produced it |

**Known instrument defect, not fixed:** `m2-classify437.mts` takes a `RULE`
argument but builds both run lists with `acceptLeftmost`, so it ignores it. The
`shipped` figure it is quoted for is correct; re-running it under any other rule
silently returns the `shipped` answer. Do not use it to score a rule.

### The criterion's own blind spot, closed in the instrument

Re-running the original sweep under a candidate rule parses **both** sides with
that rule. A rule that destroyed all output would make the `main` side un-right
everywhere, so nothing could be scored corrupt and the sweep would read **0 —
the same number a working rule reads.** Measured: `none` scores 0/51,608 there.

`m2-sweep.mts` therefore anchors "right" on a third reading — the **shipped**
parser on `main`'s tables — which no rule can move. The denominator is then
fixed at REFOK 11,519 / BOTH 847 for every row, and `none` scores **11,519 of
11,519**.

> **A wiring defect this caught.** The first harness copied `m2-engine.mjs` into
> each module tree, giving each parser its own module instance; the tier set
> from the scratchpad root never reached them, and three tier rules reported the
> shipped number and read as "no effect". The tier now travels in
> `process.env`, which cannot be duplicated that way.

### Controls on every zero

| zero | control | result |
|---|---|---|
| B: F2 destroy = 0 | `--no-tier` | **1,760 hits / 473 destroyed** |
| B: F3 destroy = 0, nesting broken = 0 | `--no-tier` | **12,715 hits / 1,053 destroyed**; `none` → 91,393 / 91,393 / 85,528 nests broken |
| B: SUPP = 0 of 21 | rule A on the same family | **21 of 21 lose both turns** |
| B: corpus LOST/MERGED = 0 | the classifier's nine controls, incl. the merge case the old containment metric scored as a repair | all pass, asserted on import |
| B: 0 differing parses | declare a real secondary pair | **14 differing** |
| A: F1 = 0 | `--no-tier` | **437** |
| A: 0 of 9 pairs disqualified | `--no-tier` | **9 of 9** |

### What the corpus cannot say

Nothing, about this class — stated because it has misled this strand twice.

The 140-book English arm contains **no guillemet at all**: counted, 0 opening
and 0 closing occurrences across 389,020 paragraphs, in 0 of 140 books. So
declaring #2286's `en` addition in either tier leaves all 174,267 run-carrying
paragraphs `SAME`, and that identity is evidence about the corpus, not the rule.
**The corpus establishes safety; every necessity claim here rests on the
generated families.**

---

## Residuals

### 1. The gap-seeded straddle is not fixed — it is not exercised

Neither rule makes a language's *existing* pairs safe. On today's tables, with
no widening:

```
es  «Hola, dijo él. «Adiós», dijo ella.     →  ["Hola, dijo él. «Adiós"]
```

Sized on the straddle family's 2,456 shapes that are well-formed under the
widened table: `main` **corrupts 579** of them today. M2 moves none of that.

> The companion figure — `main` "destroys" 1,704 — is **not** a straddle count
> and an earlier revision of this document wrongly implied it was. The shape set
> is filtered by well-formedness under the **widened** table, so most of those
> 1,704 are turns typeset in a convention `main` does not recognise at all. 579
> is the genuine straddle figure.

A reader who takes "M2 fixed the straddle" from the ticket title will be wrong.
What M2 fixes is the *blocking relationship* between the straddle and
#2279/#2286.

### 2. Rule B leaves 284 (F1) + 796 (F2) + 6,084 (F3) spurious runs

Narration read as speech on drifted input. **Zero destroyed turns** in either
family and in all nine per-candidate rows. This is the residual the owner
decision is about.

### 3. Rule A, if chosen, carries the suppression class

21 of 21, both turns, all six languages — and 80% of the benefit forgone. § *The
suppression class*.

### 4. A paragraph that genuinely mixes conventions (rule A only)

```
ru  «Привет», сказал он. ‘Hello,’ said the Englishman.
    widened + A   ["Привет"]          widened + B   ["Привет","Hello,"]
```

### 5. 87 shapes the acceptance criterion structurally cannot see (rule A)

Reference not right, reference not corrupt, candidate corrupt — skipped by every
`reference-right / candidate-corrupt` sweep. `es 4 · fr 20 · ru 6 · en 5 ·
zh 28 · ja 24 = 87`. Cross-checked against the corruption delta (666 − 579 = 87)
with 0 shapes moving the other way, so the two independent figures agree for a
measured reason.

### 6. German

Out of scope, unchanged. German's `«…»` stays out regardless — `de` already
carries `['»','«']`. Whether tiering makes German's `"…"` / `“…”` additions
shippable is a separate question no measurement here addresses.

### 7. Units

"Turns destroyed" throughout is a **shape** count with a per-shape predicate
("either constructed turn is missing"), ceiling 2,456 on the fixed set and
10,605 on F2 — not a count of individual turns. An earlier revision wrote
"~800 destroyed turns"; it should have read "~800 shapes".

---

## Rejected

- **Import-time normalisation** (ticket option 3) — a destructive edit to the
  source of record, a different blast radius, needs its own design pass.
- **Any acceptance-order change** (rows A′, B′, C, C′) — each destroys nesting
  or splits real turns, reproducing M1's finding that acceptance is the one
  thing not to touch.
- **Straddle suppression in any form** (S, S′, S+G, tier+S) — deletes real runs
  on real English.
- **Inferring the convention from the paragraph** (rule C) — worse-measuring
  than declaring it, and strictly more machinery.

---

## Scope

**In:** `secondaryQuotePairs` on the conventions type, empty for all seven
languages; the chosen tier rule in `findQuoteRuns`; `isSpokenLine` reading both
tiers; tests for the tier, every invariant, the suppression class, and the
straddle family committed as a generated regression test.

**Out:** the table additions themselves (#2286 lands them once this ships),
German, `dialogueOpen`, the primary-pair straddle (residual 1), import-time
normalisation.

---

## Assumption-checker findings

A mandatory adversarial pass (fresh non-fork subagent, Opus) was run on
revision 1 of this document. It re-ran every instrument. Dispositions:

| # | finding | disposition |
|---|---|---|
| ⚠ | **The recommended rule's central premise is false** — "a paragraph with a primary run is written in the primary convention"; the primary scan is an any-run detector, so a quoted title in narration suppresses all dialogue. Verified in five languages; invisible to every instrument. | **Accepted, and it changed the recommendation.** Independently reproduced and sized (`m2-suppress.mts`, 21 of 21 lose both turns). Rule A demoted; rule B designed and measured to fix it (0 of 21). |
| 1 | The item-4 control figure **126** is not reproducible (116 for A, 14 for B); and the harness defaults to a different rule than the one recommended. | **Accepted.** Corrected, with the error left visible in § *The no-op proof*. The default-rule hazard is why every figure now names its rule. |
| 2 | "Turns destroyed" is a **shape** count, not a turn count. | **Accepted.** Residual 7; the owner-decision table no longer says "turns". |
| 3 | Residual 1 attributed `main`'s 1,704 to the straddle; the shape set is well-formed under the *widened* table, so most are unrecognised-convention misses. | **Accepted.** Residual 1 now quotes 579 as the straddle figure and says why 1,704 is not. |
| 4 | The classifier reports MOVED, not MERGED, when a run swallows exactly one turn — it under-reports destruction ~66× — while the document elevates it. | **Accepted.** § *What the classifier cannot see* added; the reframing claim is now carried by two independent predicates, and no claim rests on a `MERGED 0`. |
| 5 | The rules table had **no benefit column**, so a do-nothing rule would win it; rows were pruned on a benefit-blind criterion. | **Accepted.** GAIN is now a column; it is what disqualifies A (212 vs 1,043) as much as the suppression class. Pruned rows are flagged as pruned. |
| 6 | The corpus tuple omits MOVED 950. | **Accepted.** Recorded under the invariants table. |
| 7 | `m2-classify437.mts` ignores its `RULE` argument. | **Accepted, not fixed.** Documented as a known instrument defect under § *Instruments*; the one figure it is quoted for is correct. |
| — | *Survived attack:* the five acceptance items genuinely pass under rule A; the "437 contain zero destroyed turns" reframing is sound and was corroborated with a second predicate; "no tier-crossing opener" confirmed; `findQuoteRuns` has exactly one call site so paragraph scope is correct; empty-tier no-op is provable by construction. | Recorded as-is. |
| 8 | *Suspect:* family 2 has **no `gap × nest` cell** — no shape places a legitimate nest and a gap-seeded stray in one paragraph, the geometry § *Why no rule local to a candidate can decide it* calls undecidable. | **Accepted and CLOSED, not deferred.** Family 3 was built (`m2-sweep3.mts`, 145,732 shapes, 91,393 scored): `shipped` 12,715 hits / 1,053 destroyed / 0 nesting broken; **both tier rules break nesting on 0**, and B destroys on 0. The cross-product does not separate them. |
