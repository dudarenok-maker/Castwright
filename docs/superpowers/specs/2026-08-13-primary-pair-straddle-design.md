# The primary-pair straddle, and the tag-clause cut — design

Status: **stable — shipped**, all three owner decisions answered (Task 0) and
implemented per
[the plan](../plans/2026-08-13-primary-pair-straddle.md)'s Ship notes ·
Issue: [#2315](https://github.com/dudarenok-maker/Castwright/issues/2315) ·
Blocks: [#2286](https://github.com/dudarenok-maker/Castwright/pull/2286) (held in
draft until this lands) ·
Follows: M1
[`2026-08-12-quote-delimiter-validity-design.md`](2026-08-12-quote-delimiter-validity-design.md)
(shipped `e839a939`, PR [#2300](https://github.com/dudarenok-maker/Castwright/pull/2300))
and M2
[`2026-08-13-gap-seeded-straddle-design.md`](2026-08-13-gap-seeded-straddle-design.md)
(shipped `69ced6c5`, PR [#2319](https://github.com/dudarenok-maker/Castwright/pull/2319)) —
this is that document's **residual 1**, plus a defect in its shipped rule that
its own residual pricing did not anticipate.

Implementation plan:
[`docs/superpowers/plans/2026-08-13-primary-pair-straddle.md`](../plans/2026-08-13-primary-pair-straddle.md)

---

## Summary

**This design covers two defects, not one.** They live in the same acceptance
loop, and a rule for either must not reintroduce the other.

**Defect 1 — the primary-pair straddle (#2315).** A turn is destroyed when a
paragraph re-opens a quote glyph it never closed. Live on `main` today, on
correctly typeset input, using only a language's own `quotePairs`.

**Defect 2 — the tag-clause cut** (found by the review gate on PR #2286, added to
this pass by the repo owner). A run *gained* by the widening lands inside a **tag
clause**, truncates it, and the adjacent real turn **loses its speaker** — so it
is read in the wrong voice. The turn survives, so every turns-destroyed
instrument in this strand reads 0.

Two rules, one in each half of `findQuoteRuns`, independent by construction:

> **The RE-OPEN BOUND** (defect 1, primary scan). A quotation run may not contain
> a further occurrence of its own opening glyph, **provided no opener glyph of
> any class appears between the run's own opener and that occurrence**. When it
> does, the run ends there — with no closing delimiter, still emitted — and the
> scan resumes from there.
>
> **The TAG-CLAUSE GUARD** (defect 2, secondary admission). A secondary-tier
> candidate is declined when the **clause** its opener sits in — from the later
> of the preceding primary run's end and the last sentence-final punctuation —
> carries a speech or beat verb stem.

| | shipped (today) | **both rules** |
|---|---:|---:|
| straddle family, turns destroyed | **396 of 805** | **172 of 805** |
| invariant anchors | 17 of 22 | **19 of 22** |
| **attribution: turns that lose their speaker** | **21 of 42** | **0 of 42** |
| corpus, English, M1's tuple | 938 / 0 / 0 / 0 / 0 | **938 / 0 / 0 / 0 / 0**, SPLIT 34 |
| corpus, 7 languages, speech text lost | — | **0 characters, 0 mid-word cuts** |
| M2's families, shapes repaired / regressed | — | **+1,762 / −20**, nesting regressions **0**, suppression **0 of 21** |
| the 308-test suite | — | **7 fail**, all number-pinning |

The re-open bound does not take the destroyed count to zero and **no rule
measured here does**. The residual — 172 shapes, all *cross-glyph* and
*symmetric-delimiter* straddles — is answer 3 of the ticket, proposed **with the
measured prevalence figure the ticket demands**: the geometry it hides in occurs
in **5,267 of 239,725 real corpus paragraphs (2.20%)**, is byte-for-byte
identical to legitimate nesting, and the rule that acts on it removes **601,392
characters of real speech**.

Five findings about the *evidence* matter as much as the result:

1. **The ticket's headline number is a different number.** `579` is a
   **corruption** count, not a destruction count, on a shape set defined by the
   **widened** table. Measured as the ticket describes it: **396 destroyed of
   805**, seven languages including `de`, which the earlier family omitted.
2. **For the dominant sub-case there is no candidate to choose between.** The
   scan resumes at the end of an accepted run, so a same-glyph re-open never
   produces a candidate. Every acceptance-order rule is *structurally incapable*
   of fixing 258 of the 396.
3. **A third sub-mechanism the ticket does not describe**: a paragraph with **no
   stray glyph at all** loses a turn when one glyph is both a closer of one pair
   and the opener of another (`ru`'s `“`).
4. **Depth ≥ 3 nesting re-uses depth 1's glyph.** The first revision of this
   document recommended a rule that fragmented every such turn. Found by the
   adversarial pass; the proviso is the fix and four anchors pin it.
5. **Three of the acceptance criteria cannot be met as written** — one because
   its number has no referent, one because it contradicts the fix, and one
   (the new tag-cut criterion) because its corpus proxy counts legitimate gains.
   § *The acceptance items that are not met*.

---

## The ticket's number

The ticket states: *"`findQuoteRuns` destroys 579 of 2,456 well-formed two-turn
shapes on `main` today, using only a language's own primary `quotePairs`."*

Reproduced (`m2-primary-residual.mts`, unchanged):

```
lang  table   shapes  corrupt  destroyed
es    main       117       36         85
fr    main       117       18        108
ru    main       775      215        457
en    main       336       96        210
zh    main       775      150        568
ja    main       336       64        276
TOTAL           2456      579       1704
```

`579` is the **corrupt** column — a speech span containing a narration word. The
destroyed column on that shape set is `1,704`. M2's spec quotes 579 correctly, as
a corruption figure; the ticket carries the number across to the word "destroys".

The shape set is also not the one the sentence describes: `wellFormed` is
evaluated against the **widened** table and the glyph universe is
`main ∪ widened`, so the `main` row mixes genuine straddles with turns typeset in
conventions `main` does not carry — the same objection M2's own spec raises
against reading `1,704` as a straddle count, one level further.

**Measured as the ticket describes it** (`s2315/family.mts`): every glyph from
the language's own `quotePairs`; both turns pairing an opener with *its own*
declared closer; no widening anywhere. Ground truth is the construction, not a
parser reading.

```
lang  shapes  DESTROYED  corrupt   |  no-stray control
de       176        104      104   |  16 shapes, 0 destroyed
en       117         54       54   |   9 shapes, 0 destroyed
es        28         16       16   |   4 shapes, 0 destroyed
fr         3          2        2   |   1 shape,  0 destroyed
ja        28         16       16   |   4 shapes, 0 destroyed
ru       336        150      136   |  16 shapes, 1 DESTROYED  <- see case 3
zh       117         54       54   |   9 shapes, 0 destroyed
TOTAL    805        396      382
```

**396 of 805.** "The 579 goes to 0" therefore has no well-defined referent; it is
restated as *"the 396 goes to 0"*, and the recommendation does not meet it.

---

## Defect 1 — the mechanism

`findQuoteRuns` → `scanQuoteRuns`
(`server/src/analyzer/dialogue-structure/parser.ts:390`) builds one candidate per
opener occurrence and accepts leftmost-first. Three distinct shapes make a turn
disappear.

### Case 1 — the same-glyph re-open (258 of 396)

```
fr  «Bonjour», dit-il, regardant le «panneau de Faust. «Et toi», demanda-t-elle.
    today   ["Bonjour", "panneau de Faust. «Et toi"]
```

An unterminated `«` takes the next `»` — turn 2's own closer. **Turn 2 produces
no candidate at all**: the per-opener scan sets `pos = end.at + end.glyph.length`
(`parser.ts:488`), so the second `«` is inside the accepted range and is never
visited.

This reframes the ticket. Its answer 1 is "intra-tier gap-scoping by some
ordering", and M2's rejected-rules table is entirely acceptance-order rules.
**There is nothing to order.** A candidate list with one candidate has one
acceptance. The fix must change what the *scan* produces. `fr`, whose table has a
single pair, is entirely this case.

### Case 2 — the cross-glyph stray (137 of 396)

```
es  «Hola», dijo él, mirando el “cartel de Fausto. «Y tú», preguntó ella, cerca de la galería”.
    today   ["Hola", "cartel de Fausto. «Y tú», preguntó ella, cerca de la galería"]
```

Turn 2 *does* produce a candidate; leftmost-wins discards it. This interval
geometry is **byte-for-byte the geometry of a legitimate nest**
(`“He said ‘hi’ to me,”`). M2 separated the two with a *tier* fact; within one
tier there is no tier fact. § *Why the cross-glyph case is not decidable here*.

### Case 3 — the closer-as-opener collision (the ticket does not describe this one)

```
ru  „Привет“, сказал он. “Пока”, сказала она.
    today   ["Привет"]                          <- turn 2 destroyed
```

**No stray glyph. No drift. Both turns well-formed under `ru`'s own table.** `ru`
pairs both `„“` and `“”`, so the `“` closing turn 1 is also a valid opener. The
run it seeds is discarded for overlapping turn 1 — and the cursor has by then
passed turn 2's genuine `“`. Surfaced by the family instrument's own no-stray
control, which exists to prove it does not cry wolf on clean input.

### Depth ≥ 3 — already broken, and a careless fix makes it worse

No language nests a pair inside itself; they **alternate by depth**, so **depth 3
re-uses depth 1's glyph**:

```
en  “He told me, ‘She said “no” to him,’ and walked off,” Mary explained.
    today   ["He told me, ‘She said “no"]     <- ALREADY wrong, truncated at depth 3's closer
```

`main` is already wrong here; that is a **pre-existing defect, out of scope**. A
rule that treats *any* re-occurrence as a re-open turns it into a **worse** one:

```
    plain re-open bound  ["He told me, ‘She said ", "no"]
```

— one turn becomes a container plus a **one-word speech span**, which the render
attributes and voices separately. That is not the harm class the reading of
record accepts; it is a turn fragmented. The proviso refuses it and four anchors
(18–21, one of them a corpus paragraph) pin it. **No family or anchor in this
document's first revision covered depth ≥ 3** — the same structural gap M2 was
caught with on `gap × nest`.

### Why the cross-glyph case is not decidable here

Bounding at *any* interior opener (`R2`) is the ceiling: 396 → **52**. Its price
on the 331 supported-language books:

```
R2_anyOpener   changed paragraphs 6221
lang   changed  TEXT-PRESERVING  TEXT-LOSING  alnum chars lost  MIDWORD
en        3002              728         2274            436755       20
zh        2686              784         1902            142596      300
…
TOTAL     6221             1954         4267            601392      321
```

**601,392 characters of real speech stop being speech**, 321 runs end mid-word,
anchors fall to 10 of 22. The population it acts on is **5,267 of 239,725 corpus
paragraphs with runs (2.20%)**, and a random sample of it is legitimate nesting
throughout. That is the answer-3 prevalence figure: *the residual hides inside a
population that is overwhelmingly correct, and any rule acting on it has to be
right about all 5,267.*

---

## Defect 2 — the tag-clause cut

Added to this design pass by the repo owner after a review gate on PR #2286.
**M2's shipped rule B has it**, and M2's own residual pricing did not anticipate
it.

```
ru, roster [{id:'anton', name:'Антон'}]

  «Привет», сказал ‘Антон’.
    main   speech[anton]="Привет" | tag[-]=", сказал ‘Антон’."
    M2     speech[-]="Привет" | tag[-]=", сказал " | speech[-]="Антон" | narration[-]="."
```

The gained secondary run sits in the gap, M2's tier admits it (no primary opener
inside, so it is not a straddle), it **truncates the tag**, and `findRosterName`
never reaches `Антон`. The turn survives with **no speaker**, and is then read in
the narrator's voice or the wrong character's. Identical in `es`, `fr`, `en`,
`zh`, `ja`.

### Why every existing instrument is blind to it

The corpus comparison builds `buildNameIndex([], conv)` — an **empty roster** —
and classifies on speech-run `[start, end)` geometry alone. Speaker fields are
never populated, so never compared. **"0 lost / 0 merged / 0 split" is silent
about attribution by construction, not by measurement.** The generated sweeps and
the committed `parser.test.ts` residual pins compare span *strings* only.

### The correction to M2's residual pricing

M2's design of record prices rule B's residual as *"narration spoken aloud —
audible, attributable, and recoverable by a later rule"*, and the owner approved
rule B on that pricing. **That sentence is now known to be understated.** The
residual also contains **a real turn losing its speaker**, which is neither
audible as an error nor attributable nor obviously recoverable: the line simply
plays in the wrong voice, and nothing downstream flags it. This design records
the correction rather than repeating the original sentence; it does not reopen
the decision, because the fix below removes the class rather than re-pricing it.

### The rule

> A secondary-tier candidate is declined when the **clause** its opener sits in
> carries a speech or beat verb stem. The clause runs from the later of (the
> preceding primary run's end) and (just after the last sentence-final
> punctuation before the candidate) up to the candidate's opener.

The discriminator is a **sentence boundary**, not a verb alone:

```
, сказал            verb, NO sentence end  -> inside the tag clause      -> DECLINE
, сказал он.        verb, sentence end     -> a new sentence, a turn     -> ADMIT
 en la portada.     no verb                -> narration (M2's SUPP class)-> ADMIT
```

Scoping the window to the **gap** rather than to the **clause** was measured
first and only moved the corpus proxy from 265 to 165: in a long paragraph the
gap contains earlier sentence-final punctuation, so the guard read "a new
sentence starts here" for a candidate sitting mid-clause several sentences later.

**It is secondary-tier only, so it is a measured no-op on every shipped table**
(all `secondaryQuotePairs` are empty): the family, the anchors and both corpus
arms are byte-identical with and without it. It costs nothing until #2286 lands,
and #2286 is the consumer waiting on it.

### Corrected by the PR #2340 review gate (implementation-time)

The rule above, as first implemented, was **polarity-inverted for any
language whose canonical dialogue-tag order is VERB then quote** (zh, ja:
`他说，"你好"`) — the mirror image of the Latin trailing-tag shape (`"Hi," said
Anton`) this section's own worked example is built from. The
clause-before-candidate model read a leading verb as proof of a name-tag
regardless of whether any turn had actually been captured to attribute,
which on one real Chinese book falsely declined 93.7% of its speech spans.
**Fix, not a re-decision**: the guard now requires a PRIMARY run to actually
precede the candidate before it evaluates a verb at all — the sentence above
("the adjacent real turn loses its speaker") always presupposed this; the
implementation simply hadn't checked it. **Correction (a second review pass
on this same PR found the sentence below stated too broadly — see the "F2"
paragraph after this one for what it actually does):** ~~This doesn't change
the rule's behaviour on the shape this section documents (a primary run
always precedes in the Latin trailing-tag construction), and it isn't a
per-language property — the same structural check is language-agnostic.~~
True only of the CONSTRUCTED family; against #2286's real tables it measurably
changes 271 non-CJK spans across 203 real es/fr paragraphs (reduced
over-suppression of quoted narration phrases, not lost speakers), and it
leaves a real gap that is not CJK-specific either. Separately, the
sentence-boundary scan was hardened against a decimal point, a semicolon,
and a mid-clause ellipsis defeating it (none of `.!?…` was previously
excluded for these cases). Full measurement, the corrected corpus figure
against #2286's actual tables (101 across 48 paragraphs, down from an
unfixed 7,438 across 1,489), and the mutation evidence: the implementation
plan's Ship notes, "Round 2 — PR #2340 Premium review gate".

**F2 — a known, filed gap, PR #2340 round 2 (not fixed here).** The primary-
run precondition above turns the guard off entirely for a paragraph typed
WHOLLY in a secondary-tier convention — no primary run anywhere means
nothing for the precondition to find, in ANY language, not only CJK. The
obvious repair (check the accepted-run list instead of the primary-run list
alone) fixes that but re-declines 5,892 spans in the same real Chinese book
this section's own MAJOR finding was about, at corpus scale — the real
discriminator is a word-order typology question ("does the verb attribute
the PRECEDING turn, or introduce the FOLLOWING one") with more than one
defensible encoding, not decided here. Measured exposed population against
#2286's real tables: 2,202 real paragraphs carry a secondary-tier-only turn,
1,164 of which a would-lose-a-speaker proxy fires on, 94% of that from the
same one book. Full detail, the two candidate encodings, and the measured
cost of the naive repair: implementation plan Ship notes, "Round 2,
continued", and issue
[#2346](https://github.com/dudarenok-maker/Castwright/issues/2346).

---

## Candidate rules evaluated

All rules reuse the shipped (post-M1, post-M2) scan and tier verbatim, with one
parameter added each, so any column difference is attributable to the one
mechanism that moved. The port is asserted byte-identical to the unpatched parser
across 1,190,634 corpus paragraphs before any rule is scored.

FAMILY = turns destroyed of 805. ANCHORS = the 22 invariant cases. ARM A = the
140-book English corpus vs the pre-#2288 baseline. LOST/GAINED = alphanumeric
characters that stop/start being speech, 7 languages, 331 books. ATTRIB =
speakers lost of 42.

| rule | FAMILY | ANCHORS | ARM A tuple | ARM A SPLIT | changed | LOST | GAINED | MERGED | ATTRIB |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|
| `shipped` (today) | 396 | 17/22 | 938 / 0 / 0 / 0 / 0 | 0 | — | — | — | — | **21** |
| `none` — negative control | 805 | 4/22 | — | — | — | — | — | — | — |
| **B** shortest-first (ticket answer 1) | 274 | 11/22 | not measured | — | 5,278 | **1,226,585** | — | — | — |
| **R2** bound at ANY interior opener | **52** | 10/22 | not measured | — | 6,221 | **601,392** | — | — | — |
| **R3** bound at an UNRESOLVED interior opener | 164 | 15/22 | not measured | — | — | — | — | — | — |
| **R4** established class (ticket answer 2) | **123** | 15/22 | 938 / 0 / 0 / 0 / 0 | 125 | 1,410 | not measured | — | — | — |
| **R1** re-open bound, plain | 164 | 15/22 | 938 / 0 / 0 / 0 / 0 | 125 | 1,399 | **0** | — | 1 | — |
| **R1b** + nested-run exemption | 164 | 15/22 | 938 / 0 / 0 / 0 / 0 | 118 | 1,391 | **0** | 393 | 1 | — |
| **R1c** + plain-prefix proviso ★ | **172** | **19/22** | **938 / 0 / 0 / 0 / 0** | **34** | **1,231** | **0** | **65** | **0** | 21 |
| **R1c + G** (both rules) ★ | **172** | **19/22** | **938 / 0 / 0 / 0 / 0** | **34** | **1,231** | **0** | **65** | **0** | **0** |

★ recommended. The last two rows are identical everywhere except ATTRIB, which is
the measured proof that the guard is a no-op on today's tables and that the two
rules are independent.

**Why each rejected rule is out**, one line each:

- **Shortest-first** returns `["hi"]` for `“He said ‘hi’ to me,”` and loses
  1,226,585 characters of real speech. Re-measured here rather than cited from
  M2, so the instrument is shown reproducing the failure it was built to catch.
- **R2** is the ceiling, not a candidate. Its value is the *bound on what any
  bounding rule can achieve* — even R2 leaves 52 (32 with a symmetric ASCII `"`
  stray, 20 with a `„` stray). **That 52 is the floor of this approach.**
- **R3** never fires where R1 does not: in this family the inner opener always
  resolves inside the outer run.
- **R4** is the ticket's answer 2 in its only non-destructive form. It buys 41
  shapes over R1 and **fails anchor 16**:

  ```
  en  He wrote ‘hi’ on the board. “He said ‘hi’ to me,” she added.
      R4  ["hi", "He said ", "hi"]        <- the nest is cut in half
  ```

  A quoted *word in narration* changes how a later turn parses: the
  **suppression class that disqualified M2's rule A**, reincarnated one level
  down. It also fails anchors 14, 15 and all four depth-3 anchors, and adds 4
  mid-word breaks on the English corpus that R1c does not.
- **R1** breaks **155 legitimate `ru` nests** in M2's F3 cross-product.
- **R1b** fixes that and still fails all four depth-3 anchors. It is retained as
  **R1c's own mutant** — R1c with the proviso removed — and is how the proviso is
  shown to be load-bearing.

---

## The recommended rules

### Re-open bound — four properties

1. **It truncates, it never deletes.** `«Bonjour», … le «panneau de Faust. «Et
   toi», …` → `["Bonjour", "panneau de Faust. ", "Et toi"]`: turn 2 recovered,
   the middle span narration read as speech — the accepted lesser harm. Deleting
   instead (mutant `dropRun`) loses **367,436 characters** of real speech.
2. **It resumes at the cut.** This is what lets turn 2 be seen at all in case 1.
   Not resuming (mutant `noResume`) returns the family score to **exactly** the
   shipped 396 and loses 192,525 characters.
3. **It refuses whenever nesting is in play.** The proviso is the signature of an
   unterminated quotation followed by the next turn and not of any nest at any
   depth: a nest always puts a lower-depth opener in between.
4. **It is cheap.** `+10–13%` on `findQuoteRuns` over 726,385 paragraphs
   (measured twice). The analyzer is model-bound by three orders of magnitude.

### What it fixes, on real books

1,231 paragraphs across all seven languages change, and **every one is
text-preserving**:

```
lang   changed  TEXT-PRESERVING  TEXT-LOSING  alnum chars lost  MIDWORD
de          97               97            0                 0        0
en          34               34            0                 0        0
es          46               46            0                 0        0
fr         232              232            0                 0        0
ja          75               75            0                 0        0
ru           3                3            0                 0        0
zh         744              744            0                 0        0
TOTAL     1231             1231            0                 0        0
```

Overwhelmingly one shape — a paragraph continuing a quotation (opening delimiter,
no closer of its own) that also contains a quoted turn, which today merges into
one run ending at the *inner* turn's closer:

```
zh  …眾鬼嘩然並出，曰：「爾恃符咒拘遣我，今符咒已失，不畏爾矣。」聚而攢擊。…
    today  ["…眾鬼嘩然並出，曰：「爾恃符咒拘遣我，今符咒已失，不畏爾矣。"]
    R1c    ["…眾鬼嘩然並出，曰：", "爾恃符咒拘遣我，今符咒已失，不畏爾矣。"]
```

The recovered run sits next to its own speech tag (`曰：`), so the change improves
attribution as well as boundaries. **1,231 paragraphs per 331 books** — worth
stating plainly, because the corpus was previously reported as having nothing to
say about this class.

---

## Invariants preserved, and how each was verified

| invariant | verification | result |
|---|---|---|
| **Runs stay disjoint** | the truncated run ends at `cut`; the scan resumes at `cut`; half-open intervals | by construction; asserted in the plan |
| **Nesting → OUTER run** (`en`, `zh`) at depth 2 | anchors 1–4, three exact-match; M2's F3, 11,140 shapes | 4/4; **0 nesting regressions** |
| **Nesting not FRAGMENTED at depth ≥ 3** | anchors 18–21, one a corpus paragraph | 4/4 (R1, R1b, R2, R4: 0/4) |
| **M1's rules survive** | anchors 5–7 | 3/3 |
| **#1601 stays fixed** | anchor 8, `de` | pass |
| **Never delete a run** | the truncated run is emitted; corpus | **0 characters lost, 0 mid-word**, all 331 books |
| **No over-generation on the fixed cases** | anchors 1, 9, 12, 13 assert the **exact** span list | 4/4 |
| **Attribution is not lost** | attribution-aware family, real roster, both controls firing | **0 of 42** (shipped: 21) |
| **The guard is a no-op on shipped tables** | family, anchors and arm A run with and without it | byte-identical: 172, 19/22, 938/0/0/0/0 + SPLIT 34 |
| **M1's corpus tuple** | 140-book English, overlap classifier | **938 / 0 MERGED / 0 LOST / 0 GAINED — met. `0 SPLIT` NOT met: 34.** |
| **M2's criteria** | pairwise over F1/F2/F3 + suppression class, #2286's pairs as `secondaryQuotePairs` | repaired 1,762, regressed 20, nesting regressions 0, **suppression 0 of 21**. "0 destroyed" NOT met: 20. |
| **`crossExamine`'s `dialogueOpen` contract** | not on any code path this changes | by construction |
| **`isSpokenLine`** | computes no run boundary; untouched | by construction |
| **308-test suite** | run against a throwaway prototype patch, then reverted | **7 fail**, all number-pinning |

M2's pairwise detail, identical with and without the guard:

```
family  shapes  shipped-destroy  R1c(+G)-destroy  REPAIRED  REGRESSED | NEST-REGR
F1        2356              565              255       310          0 |         0
F2        2456              812              401       415          4 |         0
F3       11140             6964             5943      1037         16 |         0
SUPP        21                0                0         0          0 |         0
```

An absolute destroy count on these families is **not** comparable with M2's,
which scored only shapes whose reference reading was already right. The delta on
one fixed shape set is.

---

## The acceptance items that are not met

Four items across the two briefs are not met. All are stated here, in the section
that says so — an earlier revision demoted one into a residual and the
adversarial pass called it.

### 1. `0 SPLIT` on the English corpus — 34 splits (1,225 across seven languages)

**The earlier proposal to replace `SPLIT` with `TEXT-LOSING` is withdrawn.** The
adversarial pass established that `TEXT-LOSING` is near-unfailable *for a
truncate-and-resume rule by construction*: the emitted prefix plus the resumed run
re-cover the text, and the never-delete fallback closes the last escape. Offering
it as a replacement for the criterion that contains the harm would be loosening
the bar to fit the result. It is reported as a figure, not proposed as a
criterion.

What is offered instead is the **full enumeration**. All 4,732 fresh speech spans
across the 1,231 changed paragraphs, classified by size and by whether a
speech/beat verb stem sits within 60 characters on either side:

```
                      fresh spans   TAGGED (turn-shaped)   untagged
all 7 languages             4,732                  4,003        729
of which English               42                     13         29
```

**85% of the recovered spans sit next to a speech tag.** English is the weakest
language for this and also the smallest change (34 paragraphs of 174,267): its
fresh spans are mostly short quoted matter inside quoted letters and documents,
where today's parse and the new one are both defensible and neither loses text.

The honest trade: **a text-preserving split turns one speech span into two, which
the render attributes and voices separately.** Where the second span is a turn
with its own tag (4,003 of 4,732) that is a repair; where it is a quoted word
(729) it is a new one-span turn that did not exist. No rule in the evidence gets
the first without some of the second.

### 2. "0 turns destroyed across all three sweep families" — 20 regressions

All `ru`, all one mechanism:

```
ru  «Он сказал „привет“ мне», объяснил он, глядя на “Фауста. «Пока», сказала она, около галереи”.
    shipped  ["Он сказал „привет“ мне", "Пока"]
    R1c      ["Он сказал „привет“ мне", "Фауста. «Пока», сказала она, около галереи"]
```

Shipped gets this right **by accident**: the phantom `“` candidate seeded at turn
1's closer consumes the `“` scan cursor and thereby prevents the stray `“` from
being visited. Resuming at the cut removes the accident and the shape falls
through to the cross-glyph residual. Net: **1,762 repaired, 20 regressed.**

### 3. "0 gained runs truncating a tag span, over the corpus" — 156, and the criterion is the wrong instrument

The coordinator's figure is **reproduced exactly**: 265 gained runs across 92
paragraphs (zh 84, es 4, ja 3, fr 1), over 111,835 paragraphs carrying a `main`
tag span. The guard takes it to **156 across 71**. It does **not** reach 0, and
the residual is **not the defect class**. Sampled:

```
es  … un vendedor pregonaba patatas asadas, llamándolas "chuletas de huerta", …
ja  … 「靑草の生ひ茂りたる愁しみ。」… "Sudden Light" …
ja  … 「書物の喜び」 "biblio-bliss" という言葉は …
```

These are quoted titles, foreign-language phrases and coinages inside long
narration passages that `main` reclassified as `tag` because a speech verb
appears *somewhere* in them. Separating them out costs no speaker; several are
improvements.

Sharpened orthographically — only a gained run carrying a **name-shaped token**
can cost a speaker, since that is what `findRosterName` reads — the proxy reports
**6 of the 265** in Latin scripts, with **257 in CJK where the proxy cannot
decide** (no case distinction). The guard moves the Latin-script figure 6 → 5,
and the combined rule reports 7. **The proxy is too blunt to serve as the
acceptance criterion**: it counts opportunities, and its numbers move for reasons
unrelated to attribution.

**The criterion that can be met, and is:** the attribution-aware family, where
the roster is known by construction and the speaker field is actually read.

```
                                                   cases  ATTRIBUTED  SPEAKER-LOST  EXTRA-SPEECH-SPANS
main tables (POSITIVE CONTROL, no secondary pair)     42          42             0                   0
wide tables, shipped M2 tier                          42          21            21                  21
wide tables, + tag-clause guard                       42          42             0                   0
```

Both required controls fire: the positive control proves the metric can read a
speaker at all; the shipped row proves it can see the class. **21 → 0.**

### 4. The 308-test suite — 7 tests fail

Run for real against a throwaway patch of `parser.ts`, reverted immediately
(`git status` clean afterwards). All seven are expectations pinning a number, and
one pins the defect itself:

| test | what happens |
|---|---|
| `parser.test.ts` › `residual 1: the straddle inside a language's own PRIMARY pairs is untouched` | expects `['Hola, dijo él. «Adiós']`, gets `['Hola, dijo él. ', 'Adiós']`. **This test exists to pin #2315.** Invert it, do not repair it. |
| `tier-sweep.test.ts` × 6 (`F2`/`F3` × `en`/`es`/`ru`) | "differs from ref on N scored shapes": `88→96`, `116→124`, `225→261`, `618→662`, `114→133`, `258→277`. Mutation-proof controls to re-baseline; purpose unchanged. |

> Under `R1b` there was an eighth, substantive failure — a spurious `gallery`
> span on M2's showcase example. R1c's proviso removes it. Recorded because the
> earlier revision argued that failure was acceptable and it turned out not to
> have to be.

---

## Instruments, controls, and proof they can fail

Reused unchanged: `2288-metric.mts` (overlap classifier plus ten positive
controls that fire on import — the only reused instrument that can see a merge),
`2288-corpus-lib.mts` + the corpus (491 books, of which **331** are in the seven
supported languages — 726,385 paragraphs, the same set and count M2 measured),
`rules.mjs`, `m2-primary-residual.mts` (to reproduce the 579).

New, all under `scratchpad/s2315/`, all in memory, none touching
`C:\AudiobookWorkspace`, none editing a production file:

| file | what it is |
|---|---|
| `setup.mjs` | builds two patched copies of the module tree — `main/` and `wide/` (#2286's nine pairs as `secondaryQuotePairs`) — delegating at the **call site**, so a rule can see `conv` |
| `engine.mjs` | verbatim port of the shipped scan + tier, every candidate rule, the guard, and two mutants |
| `equivalence.mts` | **control 0** — the port vs the real parser over the whole corpus |
| `family.mts` | the 805-shape family, scored against the construction |
| `anchors.mts` | 22 invariant cases: `want` (superset), `forbid` (over-generation), `exact` |
| **`attrib.mts`** | **the attribution-aware metric** — real roster, speaker fields read and compared, with its positive and firing controls |
| **`tagcut.mts`** | the tag-cut class at corpus scale, raw and orthographically sharpened |
| `corpus.mts` | arm A (M1's tuple) and arm B (7 languages, own tables) |
| `adjudicate.mts` | `TEXT-PRESERVING` / `TEXT-LOSING` / `MIDWORD` per changed paragraph |
| `classify-splits.mts` | every fresh span, by size and speech-tag adjacency |
| `gain.mts` | narration that becomes speech, and the run-count delta |
| `m2check.mts` | M2's F1/F2/F3 + suppression class, pairwise |
| `prevalence.mts` | the residual geometry's size in real books |
| `perf.mts` | cost |

### Control 0 — the harness itself

```
S2315_RULE=shipped         paragraphs 1190634  DIFFERING 0
S2315_RULE=R1_sameOpener   paragraphs 1190634  DIFFERING 1379
```

The second line is the control on the first: without it, "identical" is also what
a harness that never wired the delegation up reports — the failure `m2-setup.mjs`
hit during M2. Re-run after the injection moved to the call site. The classifier
is calibrated the same way: arm A under `shipped` reproduces M1's published tuple
**exactly** — `SAME 173,317 / MOVED 950 / 938 / 0 / 0 / 0 / 0`.

### Every zero has a positive control

| zero | control | result |
|---|---|---|
| family destroyed at all | `none` | **805 of 805, 4/22 anchors** |
| the family does not cry wolf on clean input | the no-stray rows | 59 shapes, **1 destroyed** — a real defect (case 3) |
| the anchors can fail | `R2`, `B_shortest`, `shipped` | 10/22, 11/22, 17/22 |
| the anchors can see OVER-generation | anchors 1, 9, 12, 13 are exact-match | R1b's spurious `gallery` span fails an exact anchor a superset anchor passes |
| depth-3 fragmentation is detectable | `R1`, `R1b`, `R2`, `R4` | **0 of 4** depth-3 anchors each |
| nesting breakage is detectable | `R1` on M2's F3 | **155 nesting regressions** |
| corpus text-loss is detectable | `R2`, `B_shortest` | **601,392** and **1,226,585** characters |
| **the attribution metric can read a speaker** | main tables, no secondary pair | **42 of 42 attributed** |
| **the attribution metric can see the class** | wide tables, shipped M2 tier | **21 of 42 speakers lost** |
| the corpus can report LOST/MERGED | the classifier's ten controls | all pass, asserted on import |

### Mutation — each mechanism has its own mutant

| mutation | family | corrupt | anchors | TEXT-LOSING | chars lost | ATTRIB |
|---|---:|---:|---:|---:|---:|---:|
| **R1c + G** (none) | **172** | 390 | **19/22** | **0 of 1,231** | **0** | **0** |
| `noResume` — do not resume at the cut | **396** | 382 | 17/22 | 1,225 of 1,225 | 192,525 | — |
| `dropRun` — truncate by deleting the run | 172 | **164** | 17/22 | 1,225 of 1,231 | 367,436 | — |
| **proviso removed** (= rule `R1b`) | 164 | 390 | **15/22** — all four depth-3 anchors fail | 0 of 1,391 | 0 | — |
| **guard removed** (= rule `R1c`) | 172 | 390 | 19/22 | 0 of 1,231 | 0 | **21** |
| **guard scoped to the GAP not the CLAUSE** | 172 | 390 | 19/22 | 0 | 0 | 0, but corpus proxy 265→165 not →156 |

`noResume` returns the family to *exactly* the shipped 396 — the sharpest
available evidence that the family instrument measures the mechanism and not
something adjacent. The last two rows are the mutants the first revision did not
have.

### What the evidence cannot say

- **A corpus replay shows safety, never sufficiency.** Two wrong diagnoses in
  this strand passed a clean replay.
- **The 805-shape family contains no nest**, which is why `R2` wins its headline
  metric. The counterweight is the 22 anchors and M2's F3. A family cell crossing
  *nest × depth-3 × stray* still does not exist and is named as a gap.
- **The attribution metric is a constructed family, not a corpus.** It proves the
  class exists and that the guard closes it; it does not size the class in real
  manuscripts. The corpus proxy sizes the *opportunity* at 265, and the sharpened
  proxy cannot decide 257 of those because CJK has no case.
- **Per-language denominators are wildly uneven**: en 174,267 paragraphs with
  runs · zh 30,395 · de 23,666 · fr 6,427 · es 4,207 · ja 622 · **ru 141**. `ru`
  carries 84 of the 172 residual shapes, all of case 3, and all 20 M2 regressions
  — on 141 corpus paragraphs. **The corpus says almost nothing about `ru`.**
- **`sweep-six-langs`'s "0 destroyed of 51,608" is a constant** — it reads 0 with
  both tier guards deleted and with the pairs moved back to primary. It is not
  used as a gate anywhere in this design.
- **Nothing here measures whether a truncated run is read aloud acceptably.**
  On-box; the plan opens a register row.

---

## Residuals

1. **172 of 805 — the cross-glyph and symmetric-delimiter straddles.** Answer 3,
   accepted with the 2.20% prevalence figure. `R2`'s residual (52) is a **strict
   subset** — measured: destroyed by both 52, by R1c only 120, **by R2 only 0** —
   so the entire distance to the ceiling is bought by destroying nesting.
2. **20 M2-family shapes regressed, all `ru`.** § *The acceptance items that are
   not met*, item 2.
3. **Depth ≥ 3 nesting is still mis-parsed.** `main` truncates at the depth-3
   closer and R1c leaves that untouched. Fixing it needs a closer search that
   skips closers belonging to nested runs — a nesting-aware parser, a different
   blast radius, its own design pass. R1c guarantees only that it does not make
   it worse, and four anchors pin exactly that.
4. **156 corpus paragraphs still show a gained run overlapping a `main` tag
   span.** Adjudicated by sampling as quoted titles and phrases inside
   verb-bearing narration, not tag clauses naming a speaker. Not closed, and the
   proxy cannot close it. § item 3.
5. **Case 3 is fixed only because it is same-glyph.** The general shape — one
   glyph serving as closer of one pair and opener of another — is a property of
   `ru`'s table alone today.
6. **German is in scope here and was not before.** `de` carries 104 of the 396
   and 97 of the 1,231 corpus paragraphs.
7. **Same-glyph nesting is cut.** `»Er sagte »nein« zu mir«` →
   `["Er sagte ", "nein"]`. No language's convention nests a pair inside itself.

---

## Rejected

- **Any acceptance-order rule** for defect 1. For 65% of it there is no candidate
  to order, so these cannot succeed even in principle.
- **`R4` / ticket answer 2.** Reintroduces the suppression class for 41 shapes
  and fails all four depth-3 anchors.
- **Acting on the cross-glyph geometry at all** (`R2` and everything like it).
  601,392 characters of real speech.
- **Replacing `0 SPLIT` with `0 TEXT-LOSING`.** Withdrawn: the substitute cannot
  fail for this rule class.
- **The corpus tag-cut proxy as an acceptance criterion.** It counts legitimate
  gains and cannot decide CJK. Replaced by the attribution-aware family, not by a
  looser version of itself.
- **Roster-aware run selection** (declining a secondary candidate whose interior
  is a cast name). It would need `findQuoteRuns` to take the `NameIndex`, and it
  fails on a turn that is a bare name (`«Антон!», сказала она.`). The
  sentence-boundary discriminator needs no roster and does not have that failure.
- **Import-time normalisation** — inherited from M2's rejected list.

---

## The decisions for the owner, and their price

### ✅ Decided, 2026-08-13 — all three as recommended

| | decision | what it supersedes |
|---|---|---|
| **A** | **Text-preserving splits are accepted.** Tasks 1–7 proceed. | The stated `0 SPLIT` acceptance item, which no correct rule can meet — un-swallowing a turn *is* a split to an overlap classifier. Bind to text preservation (0 characters, 0 mid-word) plus the adjudication that 85 % of the 4,732 fresh spans sit next to a speech tag. |
| **B** | **172 accepted as a partial fix** (396 → 172), 20 `ru` regressions in M2's families accepted with it; the 2.20 % residual (5,267 of 239,725) is pinned, not chased. | "The 579 goes to 0." **`579` has no referent** — it is a *corruption* count on a shape set defined by the **widened** table, whose destroyed count is 1,704. Measured as the ticket describes, each language's own `quotePairs`, the figure is **396 of 805**. |
| **C** | **The tag-cut criterion binds to the attribution-aware family** — 0 of 42 speakers lost, positive control 42/42, firing control 21 lost. The corpus proxy is reported as scale and adjudicated residual. | "265/92 re-measured to 0", set by the coordinating thread before this pass measured it. The proxy **cannot decide 257 of its own 265** cases (CJK has no case distinction), and its 156 residual is quoted titles and foreign phrases inside verb-bearing narration — **not** tag clauses naming a speaker. |

**Why B does not get chased further.** The only measured rule below 172 that
keeps nesting is `R4`, whose price is the suppression class; below that is `R2`,
which loses **601,392 characters of real speech**. Both prices are invariants the
owner has already protected, so 172 is the floor that respects them.

**Do not reinstate `TEXT-LOSING` as a substitute for `0 SPLIT`.** The adversarial
pass showed a truncate-and-resume rule cannot fail it — it is a criterion with no
discriminating power, which is why it was withdrawn rather than adopted.

**The reading of record is untouched.** A rule must never destroy a turn; these
answers accept *splits that preserve every character* and a *measured, pinned*
residual, neither of which is a destroyed turn.

---

*Original framing, retained because it is the evidence behind the answers:*

All three are Task 0 of the plan; nothing else starts until they are answered.
None reopens the reading of record, and this design sits on the same side of it.

**Decision A — text-preserving splits.** `0 SPLIT` is not achievable by any rule
that stops a container swallowing the turn inside it, because un-swallowing *is*
a split. No substitute criterion is offered.

> Is a split that loses no speech text, where **85% of the new spans sit next to
> a speech tag** and 15% are quoted words promoted to their own span, an
> acceptable price for 1,231 paragraphs across seven languages parsing
> turn-by-turn where they merged?

- *Accept*: the re-open bound ships — 34 English splits, 1,225 across seven
  languages, 0 characters of speech lost, 0 mid-word cuts, 65 characters of
  narration read as speech.
- *Refuse*: nothing in the bound family can ship, defect 1 stays at 396 of 805,
  and #2315 closes as answer 3 in full. **The tag-clause guard is unaffected and
  should ship regardless** — it is a separate rule for a separate defect.

**Decision B — the 396, not the 579.** The stated target has no referent. The
re-open bound takes the corrected figure from **396 to 172**, at the cost of 20
`ru` regressions in M2's families. Accept a partial fix, or hold out for zero?

- *Accept*: 224 of 396 fixed net; both decidable sub-mechanisms closed; the
  undecidable one documented with a measured prevalence and pinned by tests.
- *Hold out*: the only measured rule below 172 that keeps nesting is `R4`, whose
  price is the suppression class; below that is `R2`, whose price is 601,392
  characters. There is no third option in the evidence.

**Decision C — how the tag-cut criterion is stated.** The brief asks for *"0
gained runs truncating a tag span, measured over the corpus, and the 265/92
re-measured to 0"*. That proxy counts legitimate gains (quoted titles in
verb-bearing narration) and cannot decide 257 of its own 265 because CJK has no
case. Bind instead to the **attribution-aware family — 0 of 42 speakers lost,
with a positive control that attributes 42 of 42 and a firing control that loses
21** — and report the corpus proxy (265 → 156) as *scale and adjudicated
residual* rather than as a gate?

- *Accept*: the criterion measures the harm it names, and the guard meets it.
- *Refuse*: the criterion cannot be met by this rule or, on the evidence, by any
  rule — the residual it counts is not the defect.

---

## Scope

**In:** the re-open bound with its plain-prefix proviso in `scanQuoteRuns`; the
tag-clause guard in `findQuoteRuns`'s secondary admission; tests for all three
sub-mechanisms of defect 1, both nesting depths, defect 2 with a real roster, M1's
three rules, #1601, the M2 pairwise deltas, and the residuals pinned as
residuals; re-baselining the seven tests listed above.

**Out:** the cross-glyph and symmetric-delimiter straddles (residual 1); depth ≥ 3
nesting (residual 3 — pre-existing, needs its own design pass); `dialogueOpen`;
`isSpokenLine`; the `quotePairs` table additions themselves (#2286 lands them
once this ships); import-time normalisation.

---

## Assumption-checker findings

A mandatory adversarial pass (fresh non-fork subagent, Opus) was run on revision 1
of this document, which recommended `R1b` and covered defect 1 only. It re-ran
every instrument. Dispositions:

| # | finding | disposition |
|---|---|---|
| ⚠ | **The recommended rule's central premise is false** — "nesting is cross-glyph in every shipped table". Every language alternates by DEPTH, so depth 3 re-uses depth 1's glyph and R1b cuts `“He told me, ‘She said “no” to him,’ …”` into a container plus a one-word span. Verified in en/zh/ru/de. `nest × depth ≥ 3` appeared in no family and no anchor. | **Accepted, and it changed the recommendation.** Reproduced independently. R1c designed and measured; four depth-3 anchors added, one a corpus paragraph; R1b retained as R1c's own mutant. |
| A1 | The 118 English SPLITs were asserted to be repairs and none was adjudicated; 50 recover a span of ≤3 words, 65 are depth-3 alternation, including a real turn (`druthers`) fragmented. | **Accepted.** R1c removes the depth-3 cases (118 → 34 English). All 4,732 fresh spans are now classified by size and speech-tag adjacency. |
| A2 | **The `SPLIT` → `TEXT-LOSING` restatement is a criterion the rule cannot fail.** | **Accepted; withdrawn.** `0 SPLIT` is reported as unmet with the population enumerated instead. |
| A3 | A third binding item ("0 destroyed across all three sweep families", 23 regressions) was demoted to a residual. | **Accepted.** Promoted; the section lists all unmet items. |
| B1 | "R1b meets that on all seven languages" was contradicted by arm B: 8 GAINED, 1 MERGED. | **Accepted.** R1c has 0 MERGED and 6 GAINED; claims are per-figure. |
| B2 | R1b's own harm class was never priced while R2's was priced to six digits. | **Accepted.** GAINED characters (65) and the run-count delta (+4,732) are columns; `gain.mts` is a listed instrument. |
| B3 | "Every failure is an expectation pinning a number" was contradicted by the document's own table. | **Accepted and now true**: under R1c the substantive eighth failure disappears. |
| B4 | The corpus safety claim is near-empty where the defect concentrates — `ru` has 141 paragraphs with runs. | **Accepted.** Per-language denominators stated, with the explicit warning about `ru`. |
| B5 | The family contains no nest, which is why `R2` wins its headline metric. | **Accepted.** Stated as a limitation; the missing `nest × depth-3 × stray` cell recorded as a gap. |
| B6 | The family and anchors could not distinguish R1b from R1; the nest exemption had no mutant. | **Accepted.** The proviso now has four anchors and its own mutant row. |
| B7 | Family `corrupt` regresses 382 → 390; anchors used a superset predicate blind to over-generation; perf was +9.7% not +13%. | **Accepted.** `corrupt` is in the family output; four anchors are exact-match and four are `forbid`; perf is quoted as a range. |
| — | *Survived attack:* control 0; every family figure; the "579 is a corruption count" correction; both mutants biting; the M2 pairwise table including R1's 155 nesting regressions; R4's price and anchor 16's realism; "shipped is right by accident" on the `ru` regressions; the 2.20% prevalence; case 1's "there is nothing to order". | Recorded as-is. |

**What changed after the pass, from the coordinating thread's new requirement:**
defect 2 (the tag-clause cut) was added to scope with its own rule, its own
attribution-aware instrument and controls, and its own owner decision;
M2's residual pricing was corrected; the corpus proxy the requirement named was
built, reproduced at 265/92, and then shown to be the wrong gate.
