# The tag-clause guard declines genuine turns â€” design

Status: **active â€” owner decided 2026-08-18: fix defect B (the false positive), price defect A as an accepted residual. Encoding: the colon separator rule, after three others were built and falsified. Round-2 adversarial pass folded; one owner question re-opened (Â§ "The question this re-opens").** Â· Issue: [#2346](https://github.com/dudarenok-maker/Castwright/issues/2346) Â· Follows: [`2026-08-13-primary-pair-straddle-design.md`](2026-08-13-primary-pair-straddle-design.md) ([#2315](https://github.com/dudarenok-maker/Castwright/issues/2315), PR [#2340](https://github.com/dudarenok-maker/Castwright/pull/2340)) Â· Strand: [#2288](https://github.com/dudarenok-maker/Castwright/issues/2288) M1/M2, [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286)

---

## Summary

`cutsATagClause` (`parser.ts:439`) uses **"does a primary run end before this
candidate?"** as its proxy for **"is this verb a trailing tag?"** The proxy is
wrong in both directions:

| | defect | measured, 331 books | a fix means |
|---|---|---|---|
| **A** | guard **inert** â€” a name inside secondary quotes is admitted, the adjacent turn loses its speaker | **â‰¤21** of 1,164 proxy firings | making the guard decline **more** |
| **B** | guard **fires wrongly** â€” a *leading* tag's genuine turn is dropped | **1** unambiguous case of 102 declines | making the guard decline **less** |

**B ships. A is accepted and pinned.** Fixing A requires decline-widening â€” the
move that re-declines 5,892 spans in `pg/zh/23835.txt` and reinstates PR #2340
round 1's MAJOR finding. Fixing B is admit-only and, measured end-to-end,
changes **2 paragraphs in 726,385**.

### The case B is about

`pg/de/63460.txt`: `â€¦dann` **`sagte`** `er nur in seiner knurrigen Weise`**`:`**
`Â«Schnickschnack und Finger davon! Das versteht ihr nicht!Â»`

An unrelated earlier primary run (`Â»Tick-Tackâ€¦Â«`, a clock) sets
`precededByPrimaryRun`; the clause carries `sagte`; the guard declines the
candidate as a name in a tag clause. It is the entire spoken sentence, dropped.

## Three encodings were built and falsified

Recorded because each is individually plausible and two were recommended before
being killed. This is the design's most durable content.

| encoding | verdict | falsified by |
|---|---|---|
| **1.** per-language `tagPrecedesTurn` | dead | German uses **both** orders â€” trailing `, sagte er.` and leading `sagte er â€¦: Â«â€¦Â»` |
| **2.** candidate is NAME-SHAPED | dead | a sentence-shaped candidate can **contain** a roster name. Probed: `â€žHalloâ€œ, sagte Â«Der Mann heisst Ulebuhle!Â»` keeps `speaker=ule` today; the rule admits it and strips the speaker |
| **3.** candidate contains a ROSTER NAME | dead | already rejected by #2315 (`2026-08-13-primary-pair-straddle-design.md:755-758`, *"fails on a turn that is a bare name"*). Probing also broke M2 residual 2 + 4 `tier-sweep` cases â€” **5 failures** |
| **4.** COLON separator | **ships** | survives measurement 1; see the honest limits below |

Encodings 2 and 3 fail from opposite sides for one reason: each picks a property
of the **candidate**, while the distinction being drawn is a property of the
**separator**.

## The rule

```ts
function cutsATagClause(line: string, cand: QuoteRun, primaryRuns: QuoteRun[], conv: LanguageConventions): boolean {
  /* #2346. A colon immediately before the candidate means the verb INTRODUCES
     what follows â€” `sagte er â€¦: Â«â€¦Â»`, the Latin analogue of CJK's `ï¼š`. The
     guard's remaining tests assume the verb ATTRIBUTES something already
     parsed, so they must not run on a leading tag.

     The trailing-whitespace strip is LOAD-BEARING, not tidying: the target
     paragraph's colon is followed by a space, and the raw colon-adjacent count
     across the whole corpus is ZERO. Remove the strip and the fix does nothing
     at all, silently. */
  const lastCh = line.slice(0, cand.start).replace(/\s+$/u, '').slice(-1);
  if (lastCh === ':' || lastCh === 'ï¼š') return false;
  /* â€¦existing precededByPrimaryRun / sentence-boundary / hasStem logic, unchangedâ€¦ */
}
```

## What this rule actually is

**Where it fires, the guard is switched off entirely.** It is an early
`return false` ahead of every other test. That is the mechanism, stated plainly,
because round 2 showed the previous draft obscured it behind an instrument that
could not see it.

It is safe **not** because of any general property, but because the real corpus
contains only two paragraphs where it fires, and both were read. If colon-typeset
tag clauses were common, this rule would remove the guard's protection for all of
them. That is an empirical bound, not a structural one, and it must be restated
if the tables or the corpus ever change.

## Measured

Instruments and corpus: **`C:\Claude\castwright-corpus\`** (preserved 2026-08-18;
see its `README.md`). All runs are against the **real parser**, not a port.

### 1. Corpus delta â€” CONFIRMED, and the only instrument with power here

```
lang   declined   colon-preceded (WOULD FLIP)   name-shaped
de           1                            1              0
ja           1                            0              1
zh         100                            1             51
TOTAL      102                            2             52
```

Independently reproduced to the unit by the round-2 reviewer from a
from-scratch instrument: 331 books, 726,385 paragraphs, 102 declines, same
per-language split. The `name-shaped` column also reproduces the figures
published independently in the #2346 issue comment.

A full-parse A/B over the corpus closes the second-order question â€” whether an
admitted run perturbs anything else in its paragraph:

```
declines   SHIPPED 102 â†’ +COLON 100  (delta -2)
paragraphs CHANGED 2 Â· speech +2 Â· tag 0 Â· narration +1
books touched: pg/de/63460.txt (1), pg/zh/52200.txt (1)
```

Nothing outside the flip set moves, including through
`parseQuoteParagraph:706-719`'s narrationâ†’tag reclassification.

**Both flips are adjudicated:**

| lang | book | verdict |
|---|---|---|
| `de` | `pg/de/63460.txt` | **the target.** The turn is recovered as its own speech span |
| `zh` | `pg/zh/52200.txt` | **gain.** A tag containing a nested quoted turn splits into `tag` + `speech` + `narration`; a genuine turn is recovered and **no speaker changes** |

The `zh` flip has one incidental effect worth recording: its residue demotes from
`tag` to `narration`, because the **traditional** form of "said" is absent from
`zh.speechVerbStems` (simplified-only). Pre-existing and unrelated to this rule â€”
it is the source of the `narration +1` above.

### 2. Attribution â€” RETRACTED as evidence for this rule

An earlier draft reported the attribution family as certifying this change. **It
does not, and the claim is withdrawn.**

- **0 of the family's 42 case bodies contain a colon.** Its verb separators are
  `, dijo `, `, said `, and the CJK equivalents. The rule's predicate cannot fire
  on a single case, so the "shipped" and "+colon rule" rows were identical *by
  construction*. Reading that identity as reassurance was the error.
- **The denominator was also wrong.** The family hardcodes six languages and
  omits **German** â€” the language of the target and of the only unambiguous flip.
  The German-inclusive family is **66 cases with a firing control of 32**, which
  `de.ts:78-79` already records: *"0 of 66 with the guard live vs 32 of 66 lost
  without it."*
- **Supplied by round 2, the missing arm:** the same family rebuilt with a colon
  separator loses **32 of 66** speakers with the rule live â€” identical to the
  guard-off control. Consistent with "where it fires, the guard is off".

Correspondingly, the corpus measurement's `name-shaped` column does **not** prove
harmlessness. It is computed with `buildNameIndex([], conv)` â€” an empty roster â€”
which #2315's own instrument header calls *"silent about attribution BY
CONSTRUCTION, not by measurement."* The earlier draft reused that phrase to mean
the opposite of its source. The `name-shaped` column bounds **blast radius**, and
nothing more.

### 3. Behavioural probes (real parser)

| case | shipped | + colon rule |
|---|---|---|
| `pg/de/63460` real paragraph | turn swallowed into the tag | **own speech span â€” turn saved**, `speaker: null` |
| `â€žHalloâ€œ, sagte Â«Der Mann heisst Ulebuhle!Â»` (encoding 2's counter-example) | `Hallo` = `ule` | unchanged (no colon) |
| `â€œHiâ€, he said. The sign said Â«StopÂ». â€œByeâ€, she said.` (M2 residual 2) | declined | unchanged (no colon) |
| `â€œHiâ€, he said. Then she called: Â«UlebuhleÂ»` (encoding 3's failure) | declined | **admitted** |
| `â€œHiâ€, he said: Â«Anton is here!Â»` | `Hi` = `anton` | `Hi` = **null** â€” see below |

**The target's recovered turn carries `speaker: null`**, and the neighbouring
`Tick-Tack` turn is `null` in both arms. **This ships a segmentation fix, not an
attribution fix** â€” a line that was silently dropped is now spoken. The
release-note wording must say that.

### 4. Suite

`src/analyzer/dialogue-structure/` â€” **14 files, 381 tests, all green** with the
rule applied. (An earlier draft said 382; that was the count with the new
regression test already present. After acceptance item 2 lands, expect 382.)

Only one shipped fixture puts a colon before a secondary candidate â€”
`parser.test.ts:367-370` â€” and it stays green only because that clause carries no
verb stem, so `hasStem` already returns false. **That is a coincidence, not a
guarantee**, and it must be named in a comment so a future change cannot break it
silently.

## The question this re-opens

Round 2's constructed case `â€œHiâ€, he said: Â«Anton is here!Â»` moves `Hi` from
`anton` to `null`. Whether that is a **regression or a correction is genuinely
contested and is not settled here**: `Anton` appears inside a *different turn*,
not in the tag, so attributing `Hi` to it is arguably a false attribution that
the rule removes. The 32-of-66 colon-family figure inherits the same ambiguity.

**This is an owner-facing question, not an implementation choice.** It does not
block the two real-corpus flips, which are adjudicated above and are the whole
shipping delta â€” but it decides how the rule is described, and whether a
follow-up is owed. It is flagged rather than resolved.

## Acceptance

Every item names how it can fail. An item that cannot fail is not a criterion â€”
round 1 and round 2 each found several, so this list is deliberately shorter and
blunter than its predecessors.

1. **The corpus delta is exactly the two adjudicated flips.** Re-run the
   instrumented A/B: `102 â†’ 100`, 2 paragraphs changed, touched books
   `pg/de/63460.txt` and `pg/zh/52200.txt`. *Fails if* the flip set differs in
   size or membership. **This is the deciding item** â€” the only measurement with
   discriminating power over this change.
2. **The German turn is recovered** on the real paragraph (not a reduced shape),
   as its own speech span. *Fails if* the rule is absent, mis-scoped, or if the
   whitespace strip is removed.
3. **Mutation receipt with observed output, twice**: delete the rule, and
   separately delete only `.replace(/\s+$/u, '')`. Both must go red; paste the
   actual failure text. The second mutant is the silent one.
4. **`parser.test.ts:367-370` stays green and gains a comment** explaining that it
   survives on `hasStem`, not on the colon test.
5. **The 381-test suite stays green** (382 once item 2's test lands) â€” necessary,
   never sufficient; this suite is documented as blind to attribution.
6. **No attribution claim is made without a colon-bearing, German-inclusive
   family (66 cases) and a firing control that actually fires.** A run reporting
   `0 lost` whose firing control did not show 32 is void.
7. **A corpus replay is not clearance.** Two wrong diagnoses in this strand passed
   a clean 0-of-747-chapter replay. Item 1 decides because its flip set is
   *enumerated and read*, not because it is a corpus run.

## Residual: defect A, accepted and priced

**â‰¤21** of 1,164 proxy firings. **Do not target the raw 1,164** â€” â‰¥1,143 (98.2%)
are sentence-shaped second turns, not names, and driving it to zero reinstates the
5,892-span regression on `pg/zh/23835.txt`.

**A and B are disjoint populations**, separated by `precededByPrimaryRun`: A is
measured where the guard is *inert*, B where it *declines*. Footprints barely
overlap (A: `es`/`fr`/`zh`; B: `de`/`ja`/`zh`). Never average them.

The pinned gap test (`parser.test.ts:1375`) **stays** â€” A remains real.

## Chores this change makes owed

- **Defect B needs an issue to close.** #2346's title and body are entirely about
  defect A; B was folded in by the 2026-08-13 comment explicitly to avoid a second
  ticket. Re-scoping #2346 to A alone leaves the PR with nothing to `Closes`, and
  `main`'s required `pr-issue-link` check makes that a **merge blocker**. Either
  file a `bug` issue for B and `Closes` it, or keep #2346 open and use `Refs`.
- **Instruments preserved.** `C:\Claude\castwright-corpus\s2346\ab.mts` (per-paragraph span signature for the corpus A/B) and `C:\Claude\castwright-corpus\s2346\decline-log.patch` (the decline logger for `parser.ts`) are now preserved by absolute path. Acceptance items 1 and 3 are executable from this spec alone; see `s2346/README.md` for usage.
- `parser.ts:409-438` â€” the guard's header documents a two-test rule; document the
  colon test, why it runs first, and that it disables the guard where it fires.
- `parser.test.ts:1410` â€” "expected to start FAILING the moment #2346 is fixed"
  becomes false. Reword to name **defect A**.
- `parser.test.ts:459-465` â€” describe header no longer describes the guard.
- **Release notes: describe a segmentation fix**, not an attribution fix â€” a line
  that was silently dropped is now spoken. The recovered turn has no speaker.
- **Correct the arity claim.** `de.ts:64-66` records that the Swiss entry changes
  the parse in **16 of 63,941** German paragraphs â€” 15 with exactly one `Â«` and
  **1 with two or more, a gain**. "Unreachable at two or more" is contradicted by
  the lines it cites.

## Not in scope

- **Defect A** in any form, including the `out`-based repair.
- **Encodings 1â€“3**, falsified above and recorded so they are not re-proposed.
- **#2352** â€” German's reversed primary/secondary pairs; a separate open decision.
- Broadening the separator set to `;` or `â€”` (the rule is narrower than its own
  rationale; deliberately, pending evidence).
- Any change to the tables, the primary tier, `scanQuoteRuns`, or `crossExamine`'s
  `dialogueOpen` contract.

## Instruments

**`C:\Claude\castwright-corpus\`** â€” preserved 2026-08-18 out of session temp,
where it was one cleanup from being lost. `2288-corpus-lib.mts` (loader;
`loadGutenberg` over 7 languages = 231 books, `loadStandardEbooks` = 100, the
**331** every figure cites â€” out of 491 files total across 11 languages),
`s2286/mc-cost-real.mts` (the decline inventory), `s2315/attrib.mts` (the
attribution family â€” **six languages only; add German before using it**),
`s2346/` (the #2346 colon-rule A/B: `ab.mts` for span signatures,
`decline-log.patch` for the decline logger, `README.md` for usage). Its
`README.md` carries the rewiring notes and the known-good reference figures.
