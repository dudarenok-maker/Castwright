# The tag-clause guard declines genuine turns — design

Status: **active — owner decided 2026-08-18: fix defect B (the false positive), price defect A as an accepted residual. Encoding: the colon separator rule (issue option 2), after two other encodings were built and falsified.** · Issue: [#2346](https://github.com/dudarenok-maker/Castwright/issues/2346) · Follows: [`2026-08-13-primary-pair-straddle-design.md`](2026-08-13-primary-pair-straddle-design.md) ([#2315](https://github.com/dudarenok-maker/Castwright/issues/2315), shipped PR [#2340](https://github.com/dudarenok-maker/Castwright/pull/2340)) · Strand: [#2288](https://github.com/dudarenok-maker/Castwright/issues/2288) M1/M2, [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286)

---

## Summary

`cutsATagClause` (`server/src/analyzer/dialogue-structure/parser.ts:439`) uses
**"does a primary run end before this candidate?"** as its proxy for **"is this
verb a trailing tag?"** The proxy is wrong in both directions:

| | defect | measured, 331 books / 7 languages | a fix means |
|---|---|---|---|
| **A** | guard **inert** — no primary run precedes, so a name inside secondary quotes is admitted and the adjacent turn loses its speaker | **≤21** of 1,164 proxy firings | making the guard decline **more** |
| **B** | guard **fires wrongly** — an unrelated earlier primary run makes the proxy true and a *leading* tag's genuine turn is dropped | **1** unambiguous case of 102 declines | making the guard decline **less** |

**B ships, via a colon rule. A is accepted and pinned.** Fixing A requires
decline-widening — the move that re-declines 5,892 spans in `pg/zh/23835.txt`
and reinstates PR #2340 round 1's MAJOR finding. Fixing B is admit-only and,
measured, touches **2 of 102** declines.

### The case B is about

`pg/de/63460.txt`:

> …Aber wenn wir Ulebuhle nach all dem fragten, dann **sagte** er nur in seiner
> knurrigen Weise**:** «Schnickschnack und Finger davon! Das versteht ihr nicht!»

An unrelated primary run earlier in the paragraph (`»Tick-Tack … Tick-Tack«`, a
clock) sets `precededByPrimaryRun`; the clause carries `sagte`; the guard
declines the candidate as a name inside a tag clause. It is the entire spoken
sentence, and it is silently dropped.

## Three encodings were built and run. Two are dead.

This section is the design's main content, because the two dead encodings are
individually plausible and each was recommended before being falsified. Recording
why they die is what stops them being re-proposed.

| encoding | verdict | falsified by |
|---|---|---|
| **1. per-language `tagPrecedesTurn` flag** | dead | German uses **both** orders — trailing `, sagte er.` and leading `sagte er …: «…»`. One flag per language cannot express it. (#2346 comment, 2026-08-13) |
| **2. candidate is NAME-SHAPED** (short, unpunctuated, ≤3 words / ≤5 CJK chars) | dead | A sentence-shaped candidate can **contain** a roster name. Probed on the real parser: `„Hallo“, sagte «Der Mann heisst Ulebuhle!»` keeps `speaker=ule` today because the guard fires; under this rule the candidate is admitted, the name is swallowed into a speech span, and the neighbouring turn loses its speaker. It **reintroduces defect 2** — the harm the guard exists for. |
| **3. candidate contains a ROSTER NAME** | dead | Already evaluated and rejected by the #2315 design (`2026-08-13-primary-pair-straddle-design.md`, rejected-rules list): *"it fails on a turn that is a bare name (`«Антон!», сказала она.`)"*. Probed independently: it also breaks M2 residual 2 (`parser.test.ts`, `The sign said «Stop».`) and 4 `tier-sweep` cases — **5 failures**, because it neutralises the guard for every candidate that merely lacks a name. |
| **4. COLON separator** (issue option 2) | **survives** | measured below |

Encodings 2 and 3 fail from opposite sides and for the same underlying reason:
each picks a property of the **candidate**, and the distinction being drawn is a
property of the **separator** between the verb and the candidate.

## The rule

```ts
function cutsATagClause(line: string, cand: QuoteRun, primaryRuns: QuoteRun[], conv: LanguageConventions): boolean {
  /* #2346. A colon immediately before the candidate means the verb INTRODUCES
     what follows — `sagte er …: «…»`, the Latin analogue of CJK's `：`. The
     guard's remaining tests all assume the verb ATTRIBUTES something already
     parsed, so they must not run on a leading tag. */
  const lastCh = line.slice(0, cand.start).replace(/\s+$/u, '').slice(-1);
  if (lastCh === ':' || lastCh === '：') return false;
  /* …existing precededByPrimaryRun / sentence-boundary / hasStem logic, unchanged… */
}
```

Three lines, no new plumbing, no signature change, no new dependency. It is
**admit-only**: it can only remove candidates from the decline set.

**Admit-only is not the same as safe**, and this document does not claim it is.
The guard's purpose is preventing *speaker loss on the adjacent turn*, not
preventing run deletion; admitting more runs is one of the ways speaker loss is
produced (`parser.ts:409-412`, and the #2315 design's correction to M2's residual
pricing). Safety here rests on the attribution measurement below, not on the
shape of the change.

## Measured

All four measurements were run against the **real parser** in this worktree, not
a port. Instruments and corpus are session `c1002188`'s scratchpad (331 books:
`books/` 391 files, `epubs/en/` 100) — they exist and were re-run, not cited.

### 1. Corpus decline delta — the blast radius

Every decline the shipped guard makes across the 331-book corpus, tallied by the
character preceding the candidate:

```
lang   declined   colon-preceded (WOULD FLIP)   name-shaped   colon & name-shaped
de           1                            1              0                     0
ja           1                            0              1                     0
zh         100                            1             51                     0
TOTAL      102                            2             52                     0
```

**2 of 102 flip. Zero of them are name-shaped**, so the rule cannot cost a
speaker by swallowing a name — the mechanism defect 2 is about is untouched by
construction of the measurement, not by assumption.

The preceding-character histogram explains why the CJK exposure feared when this
option was first raised does not materialise: `zh` declines sit after ordinary
Han characters (`個` 10, `著` 8, `說` 7, `，` 6, `道` 3 …), because CJK leading
tags are typed `高颎道：“…”` and `“…”` is a **primary** zh pair — those candidates
never reach the guard at all.

The two flips, in full:

| lang | book | candidate | status |
|---|---|---|---|
| `de` | `pg/de/63460.txt` | `Schnickschnack und Finger davon! Das versteht ihr nicht!` | **the target — the turn this design exists to save** |
| `zh` | `pg/zh/52200.txt` | `我圖他潤肺。` | sentence-shaped, inside a nested-quote passage. **Not yet adjudicated in context — an acceptance item, not a cleared case.** |

### 2. Attribution — the instrument that carries the safety case

#2315's design names the attribution-aware family as the instrument that decides
safety, because every geometry instrument in this strand is blind to speaker loss
by construction. Reproduced here against the real parser, all four arms in one
process:

```
arm                                             cases  ATTRIBUTED  SPEAKER-LOST  TURN-LOST  EXTRA
POSITIVE CONTROL (no secondary pair declared)      42          42             0          0      0
FIRING CONTROL  (wide tables, guard OFF)           42          21            21          0     21
wide tables, SHIPPED guard                         42          42             0          0      0
wide tables, SHIPPED guard + COLON RULE            42          42             0          0      0
```

**Both required controls fire.** The positive control proves the metric can read
a speaker at all; the firing control proves it can see the class (21 lost with
the guard off). This independently reproduces #2315's published **21 → 0**. The
colon rule moves nothing.

### 3. Behavioural probes on the real parser

| case | shipped | + colon rule |
|---|---|---|
| `pg/de/63460` target shape | turn swallowed into the tag | **own speech span — turn saved** |
| `„Hallo“, sagte «Der Mann heisst Ulebuhle!»` (encoding 2's counter-example) | `Hallo` speaker=`ule` | **unchanged** |
| `“Hi”, he said. The sign said «Stop». “Bye”, she said.` (M2 residual 2) | `«Stop»` declined | **unchanged** |
| `“Hi”, he said. Then she called: «Ulebuhle»` (encoding 3's bare-name failure) | declined | **admitted** |

### 4. Suite

`server/src/analyzer/dialogue-structure/` — **382 of 382 pass** with the rule
applied (encoding 3, for contrast, produced 5 failures). This is **necessary and
not sufficient**: the same suite is documented as blind to attribution, which is
why measurement 2 exists.

## Acceptance

Each item can fail, and the note says how. An item that cannot fail is not an
acceptance criterion.

1. **The German turn survives.** A regression test on the `pg/de/63460.txt`
   shape. *Fails if* the rule is absent or mis-scoped — verified red-before /
   green-after during design.
2. **Mutation receipt with observed output.** Delete the two-line rule, re-run,
   and paste the actual failure text.
3. **M2 residual 2 stays declined** (`parser.test.ts`, `The sign said «Stop».`).
   *Fails if* the rule over-admits — encoding 3 failed exactly here, so this is a
   live check, not a formality.
4. **The attribution family reports 42/42/0 with BOTH controls firing.** A run
   whose firing control does not show 21 lost is void and must not be reported as
   a pass.
5. **The corpus decline delta is exactly the 2 rows above**, and
   `colon & name-shaped` is **0**. *Fails if* the flip set differs in size or
   membership.
6. **The `zh` flip (`pg/zh/52200.txt`) is read in context and adjudicated** as
   gain, neutral, or cost, and the verdict recorded. It is currently unread.
7. **The 382-test suite stays green** — necessary, not sufficient (see above).
8. **A corpus replay is not clearance.** Three diagnoses in this strand have been
   wrong and two passed a clean 0-of-747-chapter replay. Items 1 and 4 decide.

## Residual: defect A, accepted and priced

Defect A stays open at **≤21** of 1,164 proxy firings (2,202 paragraphs exposed
at paragraph level; 2,221 paragraphs / 8,802 runs at run level — the paragraph
figure is a conservative under-count).

**Do not target the raw 1,164.** It fires on ordinary correctly-parsed two-turn
paragraphs as readily as on the harmful shape; ≥1,143 of 1,164 (98.2%) are
sentence-shaped second turns, not names. Driving it toward zero will very likely
reinstate the 5,892-span regression on `pg/zh/23835.txt`.

**A and B are disjoint populations, not two slices of one measurement.**
`precededByPrimaryRun` separates them: A is measured where the guard is *inert*,
B where the guard *declines*. Their language footprints barely overlap — A is
`es`/`fr`/`zh`, B is `de`/`ja`/`zh`. Any future work must not average them.

The pinned gap test (`parser.test.ts:1375`) **stays** — defect A remains real.

## Chores this change makes owed

- `parser.test.ts:1410` — "expected to start FAILING the moment #2346 is fixed"
  becomes false once B ships and A is priced. Reword to name **defect A**.
- `parser.ts:409-438` — the guard's header documents a two-test rule; it must
  document the colon test and why it comes first.
- `parser.test.ts:459-465` — the describe header describes the guard as declining
  "when a primary-tier turn precedes it **and** the clause carries a verb stem".
  Now incomplete.
- **#2346 re-scoped to defect A alone**, carrying its price, and its "blocks full
  closure of #2286" line corrected — with A priced, it does not.
- Both release-notes documents — this is a user-visible attribution fix.
- **State the arity limit.** The German target is a `«…»` secondary run after a
  `»…«` primary — the #2352 reversed-pair collision. `de.ts:63-71` records that a
  **second** Swiss quote in the same paragraph seeds a primary run that swallows
  the attribution anyway. So this fix saves the turn at **one** Swiss quote per
  paragraph and is unreachable at two or more. That qualification belongs in the
  test comment and the release note.

## Not in scope

- **Defect A** in any form, including the `out`-based repair.
- **Encodings 1–3**, falsified above. Recorded so they are not re-proposed.
- **#2352** — German's reversed primary/secondary pairs; a separate open decision.
- Any change to the tables, the primary tier, `scanQuoteRuns`, or `crossExamine`'s
  `dialogueOpen` contract.

## Instruments

Session `c1002188` scratchpad — `2288-corpus-lib.mts` (loader + the 331-book
corpus), `s2286/mc-cost-real.mts` (the decline inventory), `s2315/attrib.mts`
(the attribution family, whose four arms this design re-derives against the real
parser). **These are in a Claude session temp directory, not the repository** —
they are not repo-relative paths, and nothing in git preserves them.
