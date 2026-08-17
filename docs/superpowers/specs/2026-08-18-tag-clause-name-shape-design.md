# The tag-clause guard declines genuine turns — design

Status: **active — owner decided 2026-08-18: fix defect B (the false positive), price defect A as an accepted residual. Encoding: a name-shape conjunct.** · Issue: [#2346](https://github.com/dudarenok-maker/Castwright/issues/2346) · Follows: [`2026-08-13-primary-pair-straddle-design.md`](2026-08-13-primary-pair-straddle-design.md) ([#2315](https://github.com/dudarenok-maker/Castwright/issues/2315), shipped PR [#2340](https://github.com/dudarenok-maker/Castwright/pull/2340)) · Strand: [#2288](https://github.com/dudarenok-maker/Castwright/issues/2288) M1/M2, [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286)

---

## Summary

`cutsATagClause` (`server/src/analyzer/dialogue-structure/parser.ts:439`) exists
to stop a gained secondary-tier run from truncating a tag clause and stripping
the neighbouring turn's speaker. It uses **"does a primary run end before this
candidate?"** as its proxy for **"is this verb a trailing tag?"** That proxy is
wrong in *both* directions, producing two mirror defects.

This design fixes one of them and prices the other. The two are not equally
priced and not equally risky, and that asymmetry — not their raw counts — is
what decided the scope.

| | defect | measured harm, 331 books / 7 languages | a fix means |
|---|---|---:|---|
| **A** | guard **inert** — the proxy is false when no primary run *precedes*, so a name inside secondary quotes is admitted as speech and the adjacent real turn loses its speaker | **≤21** of 1,164 proxy firings | making the guard decline **more** |
| **B** | guard **fires wrongly** — an unrelated earlier primary run makes the proxy true, and a *leading* tag's genuine turn is silently dropped | **1** unambiguous case, of 102 total declines | making the guard decline **less** |

**B ships. A is accepted and pinned.**

## Why this split, and not "fix both"

The issue asks for a single discriminator separating *"the verb belongs to the
preceding turn's trailing tag"* (decline) from *"the verb introduces the
following turn"* (admit). Both defects do resolve to that one question. But the
two directions have opposite risk profiles:

- **Fixing B is admit-only.** It can only move candidates *out* of the 102
  declines, and all 102 are enumerated (`scratchpad/s2286/mc-cost-real.mts`).
  The blast radius is bounded by a list we hold.
- **Fixing A is decline-widening**, with no such bound. The obvious repair —
  pass `out` (primary plus already-accepted secondary runs) instead of
  `primaryRuns` — fixes A's three cases and **re-declines 5,892 genuine spans in
  `pg/zh/23835.txt`**, reinstating PR #2340 round 1's MAJOR finding under a new
  trigger, in the same book that finding was about.

B is also the defect that **destroys a turn**, which the reading of record
established for this strand — *"a rule must never destroy a turn; a spurious
narration-read-as-speech span is a lesser harm"* (#2288 Task 0, decided
2026-08-13) — refuses categorically rather than numerically. One instance in 331
books does not make that principle inapplicable; it makes it cheap to honour.

### The case B is about

`pg/de/63460.txt`:

> …Aber wenn wir Ulebuhle nach all dem fragten, dann **sagte** er nur in seiner
> knurrigen Weise**:** «Schnickschnack und Finger davon! Das versteht ihr nicht!»

An unrelated primary-tier run earlier in the paragraph (`»Tick-Tack …
Tick-Tack«`, a clock) sets `precededByPrimaryRun`; the clause back to the
nearest sentence boundary contains `sagte`; the guard declines the candidate as
a name inside a tag clause. It is not a name — it is the entire spoken
sentence, and it is silently dropped.

This also disposes of the issue's **option 1** (a per-language
`tagPrecedesTurn` flag): German's dominant convention is verb-*after*-turn, yet
here it is verb-before-turn via a colon. One flag per language cannot express a
language that does both.

## The rule

One new conjunct, placed first so the guard's whole meaning stays readable in
one function:

```ts
function cutsATagClause(line: string, cand: QuoteRun, primaryRuns: QuoteRun[], conv: LanguageConventions): boolean {
  /* #2346. This guard exists to stop a NAME-shaped run truncating a tag clause
     and stripping the neighbouring turn's speaker. A candidate that cannot be a
     name is never that harm, so it is never declined — which is what stopped a
     genuine German turn (`sagte er …: «…»`) from being dropped. */
  if (!isNameShaped(line.slice(cand.start + cand.openLen, cand.end - cand.closeLen))) return false;
  /* …existing precededByPrimaryRun / sentence-boundary / hasStem logic, unchanged… */
}
```

## Why this is safe by construction, not by measurement

`cutsATagClause` has exactly one call site (`parser.ts:500`), in the form:

```ts
if (cutsATagClause(line, c, primaryRuns, conv)) continue;
```

It can only ever **decline** a candidate; it never accepts, creates, or moves
one. Adding a conjunct can therefore only *shrink* the decline set. Three
properties follow without needing a corpus run:

1. it cannot delete a primary run (it never sees the accept path for one);
2. it cannot create a run that did not already exist as a candidate;
3. it is a provable no-op on any language whose `secondaryQuotePairs` is empty,
   because `findQuoteRuns` returns before the guard is reached
   (`parser.ts:484`).

M1's never-delete invariant and the 270-test `dialogue-structure` suite hold by
construction, in the same way M2's rule B held them. Measurement is still owed
for *how much* moves — see Acceptance — but not for *whether the change is
containable*.

## The predicate

```ts
/** #2346. The ticket's own NAME-shaped classifier, moved from the measurement
    instrument into the parser so the guard and the published ≤21 harm figure
    share ONE definition. */
function isNameShaped(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if ([...t].some((ch) => SENTENCE_END_CHARS.has(ch))) return false;
  return CJK_RE.test(t) ? [...t].length <= 5 : t.split(/\s+/).length <= 3;
}
```

Three deliberate choices:

- **Thresholds are the ticket's, not fresh ones.** ≤3 words / ≤5 CJK characters,
  unpunctuated, is the exact classifier PR #2340 round 3 used to establish that
  the raw 1,164 proxy overstated defect A's harm by ~100× and the real figure is
  ≤21. Re-deriving a threshold here would mean the fix and the published number
  no longer refer to the same thing — the recurring defect in this strand has
  been a figure measured against one rule presented as evidence for another.
- **"Unpunctuated" reuses `SENTENCE_END_CHARS`** (`parser.ts:374` — `.!?。！？`),
  the constant the guard's own sentence-boundary walk already uses. Sentence
  punctuation is exactly what separates a clause from a name.
- **`[...t].length` counts code points, not UTF-16 units.** `name-matcher.ts:68`
  already documents supplementary-plane Han (CJK Ext-B, U+20000+) as a real
  case, where `.length` would double-count every glyph.

### One bias inversion, named on purpose

The classifier was built as a **generous upper bound on NAME-shaped**, so that
defect A's harm figure could not be accused of under-counting. Reused as a
runtime conjunct, that generosity inverts: *generous toward NAME-shaped* means
*generous toward declining*, which is the direction of defect B — the very thing
being fixed.

This is accepted deliberately, because the conservative direction here is the
one that changes least: a stricter predicate would flip more of the 102 declines
than the evidence supports. It is safe for the target case specifically —
`«Schnickschnack und Finger davon! Das versteht ihr nicht!»` is two sentences
carrying `!`, so it is sentence-shaped under any threshold in this family. The
inversion is recorded here so that a future tightening is a deliberate act
rather than a rediscovery.

### Where `CJK_RE` comes from

`CJK_RE` is currently module-local to `name-matcher.ts:54`. It must be
**exported and imported**, not copied — a second regex defining "is this CJK"
is precisely the duplicated-mechanism shape this codebase's conventions refuse
(cf. "don't add a second id matcher" in CLAUDE.md).

## What should move

Predicted, **to be verified rather than assumed** — of the 102 corpus declines:

| lang | declined today | name-shaped → still declined | sentence-shaped → now admitted |
|---|---:|---:|---:|
| `de` | 1 | 0 | **1** ← the target; turn saved |
| `ja` | 1 | 1 | 0 |
| `zh` | 100 | 51 | 49 |
| `en`/`es`/`fr`/`ru` | 0 | 0 | 0 |
| **total** | **102** | **52** | **50** |

The 49 `zh` flips are almost entirely one messy plain-text edition
(`pg/zh/24264.txt`, 紅樓夢) whose unbalanced quote punctuation sweeps narration
into candidate spans. Read in context, most are not dialogue. Admitting them
therefore buys nothing and costs narration-read-as-speech — **explicitly the
lesser harm class** under the reading of record, and the price of a rule stated
in terms of the guard's purpose rather than fitted to one book.

## Acceptance

1. **The German turn survives.** A regression test on the `pg/de/63460.txt`
   shape: `sagte` + colon + a sentence-shaped secondary candidate yields the
   speech span. Red before the change, green after.
2. **Mutation receipt with observed output.** Remove the conjunct, re-run, and
   report the actual failure text — not a claim that it fails.
3. **Defect A is untouched.** The three pinned cases at `parser.test.ts:1420`,
   `:1426`, `:1432` stay green *unchanged*. An admit-only rule cannot fix them,
   so a flip there means the change is not admit-only.
4. **Round 1's MAJOR finding does not return.** The zh leading-tag family
   (`reopen-sweep.test.ts:405`) stays green, and `pg/zh/23835.txt` shows **no**
   newly-declined spans.
5. **Corpus movement matches the table above** — `mc-cost-real.mts` re-run:
   102 → 52 declines, with **zero** name-shaped declines lost.
6. **The 270-test `dialogue-structure` + `narrator-default` suite stays green.**
7. **A corpus replay is not clearance.** Three diagnoses in this strand have
   been wrong and two passed a clean 0-of-747-chapter replay. The corpus shows
   safety, never sufficiency; item 1's generated shape is the instrument that
   decides.

### Expected, and requiring adjudication rather than silent repair

The guard's own suite (`parser.test.ts:466`, "with real `secondaryQuotePairs`")
was written when the guard had two conjuncts. Any case there whose candidate is
sentence-shaped **will now be admitted**. Each such flip must be adjudicated
individually and its expectation updated *with a comment saying why* — a test
adjusted merely to pass again is how a guard silently loses its purpose.

## Residual: defect A, accepted and priced

Defect A stays open, at a measured **≤21** of 1,164 proxy firings (2,202
paragraphs exposed at paragraph level; 2,221 paragraphs / 8,802 runs at run
level — the paragraph figure is a conservative under-count, not an over-count).

**Do not target the raw 1,164.** It fires on an ordinary correctly-parsed
two-turn paragraph as readily as on the harmful shape, and 94% of its mass is
the former. A fix that drives it toward zero will very likely reinstate the
5,892-span regression on `pg/zh/23835.txt`.

The pinned gap test (`parser.test.ts:1375`) **stays**, because defect A remains
real. Its comment does not: it currently reads *"this test is expected to start
FAILING the moment #2346 is fixed, at which point it should be deleted"*. With B
fixed and A priced, that sentence becomes false and must be corrected in the
same diff.

## Chores this change makes owed

Each is fixed in this round, not filed (CLAUDE.md, *Incidental findings*):

- `parser.test.ts:1410` — the "expected to start FAILING" comment, above.
- `parser.ts:409-438` — the guard's header comment describes a two-conjunct
  rule and must describe the third, including why it exists.
- `#2346` — re-scoped to defect A alone, carrying the accepted price, so the
  ticket stops claiming a decision is owed on B.
- Both release-notes documents (`docs/release-notes-next.md` and
  `RELEASE_NOTES.md`) — this is a user-visible attribution fix.
- The issue's claim that it *"blocks full closure of #2286"* is restated: with
  A priced, it does not.

## Not in scope

- **Defect A**, in any form — including the `out`-based repair, which is
  rejected above with a measured reason.
- **The colon/separator encoding** (the issue's option 2) and the
  **roster-name encoding**. Both were considered and set aside on 2026-08-18;
  recorded in this document's decision line so they are not re-litigated as
  new ideas.
- **#2352** (German `»…«` primary vs `«…»` secondary being exact reverses) — a
  separate, still-open decision on a different mechanism.
- Any change to `quotePairs` / `secondaryQuotePairs` tables.
- Any change to the primary tier, `scanQuoteRuns`, or `crossExamine`'s
  `dialogueOpen` contract.

## Instruments — do not rebuild

`scratchpad/s2286/mc-cost-real.mts` (the 102-decline inventory),
`mc-de-sample-full.mts`, `remeasure-report.md`; `scratchpad/s2315/`'s
`reprice-f2-exposed.mts`, `reprice-f2-classify.mts`, `reprice-f2-runlevel.mts`.
The 331-book corpus is listed in
[#2288 comment 5275015405](https://github.com/dudarenok-maker/Castwright/issues/2288#issuecomment-5275015405).
