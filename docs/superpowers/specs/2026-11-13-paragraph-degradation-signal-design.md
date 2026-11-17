---
status: draft
issue: 2254
refs: [2253, 2267, 2275, 2306, 2320, 4165, 4217]
date: 2026-11-13
revision: 9 (owner decisions 17–19 on the PR #4184 assumption-checker pass 8, 2026-11-17)
decisions: owner decisions 1–10 of 2026-11-15, 11–13 of 2026-11-16 and 14–19 of 2026-11-17 are binding and are written in below (1–3 drove revision 3, 4–6 revision 4, 7–9 revision 5, 10 revision 6, 11–13 revision 7, 14–16 revision 8, 17–19 revision 9; decision 10 drops the twin experiment and decision 14 drops 1C, and the parts of earlier decisions that served only them lapse); the items under "Decisions made in revision 9" (and the surviving ones from revisions 3–8) are owed owner confirmation
gate: assumption-checker pass 8 on revision 8 cleared it (0 Critical, 0 Significant, 9 Minor); revision 9 folds those Minors and owner decisions 17–19, and awaits owner approval before decomposition
verified-at: 08742125 (origin/main, 2026-11-17)
---

# Paragraph-degradation signal: surfacing it, and proving what it costs (#2254)

Filename when committed:
`docs/superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md`.
Design thread only. No code is written here. Verified against `main` @
`08742125` (revision 8 was verified @ `33f3647c`, revision 7 @ `dbc30a2a`,
revision 6 @ `25c65c0a`, revision 5 @ `1e295990`, revision 4 @ `c16da893`,
revision 3 @ `a9918640`, revision 2 @ `3792b84b`). Between `33f3647c` and
`08742125` (#4234) the only server changes are in `routes/chapter-qa-repair.ts`,
`routes/chapter-splice.ts`, `routes/failure-*.ts`, `routes/setup-readiness.ts`
and `server/src/tts/**`; between `dbc30a2a` and `33f3647c` they were in
`server/src/export/**`, `routes/export.ts` and two lines of
`routes/chapters-restructure.ts`. This design cites none of those, so every
anchor below reads the same. The anchors revision 8 added
(`cross-examine.ts:350`, the alignment floor; `:371-385`, the below-floor
branch; `analysis.ts:3723`, the hard-coded floor of 80; and `analysis.ts:3736`,
the escalation skip below it) were re-read at `08742125`. Paths under
`attribution-eval/` mean `server/src/analyzer/attribution-eval/`; paths under
`dialogue-structure/` mean `server/src/analyzer/dialogue-structure/`.

**Scope authority.** CLAUDE.md lists "New features" as out of scope until told
otherwise. #2254's close-blocker 2 (owner comment, 2026-08-13: "wire the signal
into the import/analysis surfacing so a degraded book is flagged") is that
instruction. It covers the user-facing surface designed here and nothing
beyond it.

## Revision 9 changelog

"AC8" is the PR #4184 comment headed "Assumption-checker pass 8 (head
523aafb6…)". It **cleared the gate**: 0 Critical, 0 Significant and 9 Minor
(M-1 to M-9), plus three questions. The owner answered those on 2026-11-17;
the answers are **owner decisions 17–19** below. The numbers in this revision
come from AC8's own scripts (`rejoin.mts`, `rejoin-para.mts`, `block-join.mts`,
`libscan.mts`, `density-ch.mts`, `wrap-one.mts`, `worst-para.mts`). None is
committed. Each AC8 finding and its resolution:

| # | Finding | Resolution |
|---|---|---|
| M-1 | R8-1's re-join is a lower bound, not "AC7's bound": a wrap destroys a match only by breaking before a dash or a capital, which is never a continuation line, so the re-join cannot restore it. At 80 columns it lifts only 7 of 58 real 10–12-opener paragraphs to 10 | **Owner decision 17.** The re-join applies only to a book the **count arm alone** flags (a few stray print-conversion breaks, share < 2%). A book the share arm flags is disqualified outright, like a PDF. The count-arm check is fail-closed: stray breaks only, and a **neighbour window** (the line before and the line after each fragment, joined with a space, which restores any match a break destroyed at those boundaries) under 10 everywhere (R9-5). "Exact bound" and "the only clean, dialogue-dense ru dash book on the box" are corrected where they appear (§2, §4.4 step 1, decision 15, R8-1, the revision 8 changelog). The library holds 95 qualifying titles in the part AC8's scan reached, 91 of them not line-wrapped at all |
| M-2 | The scanner's process dies on one EPUB: epub2 throws `linkparts.shift is not a function` on an empty `href=""` from a zip callback no `try` can reach | **Fixed.** The scanner parses each file in its own child process. A file that throws, crashes its child or times out is reported **unparsed**, a scan outcome, and the scan goes on. A test pins it (R9-1, §4.4 step 1, Phase 7). The production crash is #4239, fixed separately by PR #4241 (epub2's `getChapterRaw`); #4242 is the systemic epub2 question, which is why isolation stays whatever #4241 does |
| M-3 | The swap cost uses the book's mean chapter; the real next candidates are the two largest; "next-densest" and §4.4's hidden-turn order disagree | **Owner decision 18.** Swaps go in hidden-turn count order: ch7 (≈ 14,051 words, ≈ 1.1 h), then ch1 (≈ 17,860 words, ≈ 1.4 h). Expected run ≈ 1.6–3.9 h, worst case ≈ 5.3 h. The 3 h 18 m ceiling does not cover a five-chapter run, which carries 65.4% of the book's words (§4.4 "On-box cost", §4.6) |
| M-4 | "Not computed" has no next step; a re-capture's effect on the settled pick is unspecified; "three picked chapters" is stale; nothing tests it | **Owner decision 19.** A *not computed* 1A is recorded, the capture defect is fixed, the chapters are re-captured, the pick re-settles and the two-swap cap resets. The row stays open until 1A is computed. Every other capture-defect re-capture follows the same rule (R9-2). "Three picked chapters" now reads "the picked chapters". Phase 7 tests fewer-than-three, not computed and the re-settle (§4.4 step 2, "How blocker 1 closes", Phase 7) |
| M-5 | Below the floor `narration-demote` still fires, so recovery still moves mixed sentences and a swapped-out chapter holds 1A evidence | **Fixed.** §4.4's floor bullet now says what the code does (`cross-examine.ts:371-385`) and why the chapter still leaves the pick: it cannot show the tag decisions recovery exists to feed. A swapped-out chapter's 1A counts are **reported apart** and never count toward the verdict, `n` or the hand-check (owner decision 16's intent) (R9-3) |
| M-6 | The blind sheet's "line" can be a whole 11,000–13,000-character merged paragraph; no precedence between mixed and two-speaker; `--score` takes any id | **Fixed.** The sheet marks the sentence inside its line, and shows a window around it when the line is long. *Two speakers* takes precedence over *mixed*. `--score` checks every judged id against the pinned roster and fails loudly on any other (R9-4, §4.3, §4.4, Phase 7) |
| M-7 | §5's "or class report" is 1C's lever rule left behind | **Fixed.** Deleted |
| M-8 | R7-5's "not line-wrapped" clause and R7-2's 1.8% / 9.3% rates are superseded but unmarked | **Fixed.** Both are marked in place |
| M-9 | Дневной дозор reproduces; the ru fixture's 6 dash-opening paragraphs include two `---` rules; AC7's scarcity claim is false; "19,000" should be "19,000 and above" | **Fixed.** Дневной дозор is restored as **confirmed** (29.4 per 1,000 words, 36 paragraphs at ≥ 10, 0 / 2,426 continuation lines). The fixture's count is restated (4 in the dialogue section, plus two `---` rules that `dialogueOpen` matches, a small accepted skew). The scarcity claim is corrected. The reach table reads "19,000 and above" (§4.4, §4.5) |
| Value | The library holds a clean 12-opener monologue paragraph | **Stated** as the expected outcome: step 1 very likely records a breach, the threshold stays provisional, and the notice will fire on that clean book (§2, §4.4 step 1) |
| Q1–Q3 | The three questions | Owner decisions 17, 18 and 19 |
| R8 grades | AC8's grading of R8-1 … R8-3 | R8-1 is replaced by owner decision 17. R8-2 is amended by owner decisions 18 and 19. R8-3 is amended by R9-4 |
| CI | `check:register-citations` | Passes locally (no new register ID is cited) |

## Decisions made in revision 9 (owner to confirm)

These are choices owner decisions 17–19 did not settle.

- **R9-1 · The scanner isolates every file.** Each file is parsed in its own
  child process with a time limit. An unparsed file is listed with its
  error's first line. It neither blocks nor supports the label, because a
  file `parseManuscript` cannot parse cannot be imported, so the notice cannot
  show on it. An unparsed book from the #2254 corpus is recorded as such on
  the run sheet.
- **R9-2 · Any capture-defect re-capture re-settles the pick.** A re-capture
  makes new raw takes and new alignments. So, as owner decision 19 sets for
  *not computed*, the pick is settled again from the head of the candidate
  list and the two-swap cap resets. That keeps two runners from settling
  different picks after the same re-capture.
- **R9-3 · A swapped-out chapter's 1A counts are reported, not judged.** They
  sit in their own table. Its changed sentences enter neither `n` nor the
  blind sheet, so the hand-check's 30 judgements all go to the verdict.
- **R9-4 · The blind sheet's marker and window, and `--score`'s roster
  check.** The sentence is wrapped in `⟦ ⟧` inside its recovery-off line.
  When that line runs past 1,200 characters, the sheet shows 400 characters
  either side of the sentence, with `…` at each cut and the sentence's
  character offset. *Two speakers* outranks *mixed*. `--score` refuses a
  judged value that is not a pinned roster id, `narrator`, *can't tell* or
  *two speakers*, names each such item, and writes no score.
- **R9-5 · The count-arm check is isolation plus a neighbour window.**
  Owner decision 17 says a count-arm book may qualify and must fail closed;
  it does not say how. A continuation line counts as a stray break only
  when no other continuation line touches or sits within two lines of its
  fragment, and the window of the line before, the fragment and the line
  after, joined with a space, holds fewer than 10 openers. The space join
  restores any match a break destroyed at the window's edges, which the
  fragment alone cannot (§4.4 step 1).

## Revision 8 changelog (history)

"AC7" is the PR #4184 comment headed "Assumption-checker pass 7 (head
af677096…)". It found 0 Critical, 1 Significant and 7 Minor, and judged that
1C does not earn its 30 judgements. The owner answered its three questions
on 2026-11-17; those answers are **owner decisions 14–16** below. The
numbers in this revision come from AC7's own scripts (`cont-lines.mts`,
`classes.mts`, `dprime.mts`, `hg-large.mjs`). None is committed. Each AC7
finding, and whether it was **resolved by removal** (it existed only for
1C) or **fixed**:

| # | Finding | Resolution |
|---|---|---|
| S1 | 1C's verdict, trigger and lever are fixed before any judging | **Resolved by removal** (owner decision 14). The per-class counts of confident decisions stay, as a plain report with no verdict (§4.3, §4.4) |
| M-1 | The ≥ 10 continuation-line arm disqualifies the only clean, dialogue-dense ru dash book on the box; the label rule ignores a breach in a line-wrapped book | **Fixed** (owner decision 15). A wrap disqualifies a calibration book only if re-joining its continuation lines could lift a paragraph to ≥ 10 (R8-1). The label rule now counts a breach in **any** scanned book. That box book (29.7 dash turns per 1,000 words, 4,491 dash turns, at most 8 after re-joining) would qualify (§2, §4.4 step 1). [Corrected, AC8 M-1 and M-9: the re-join is a lower bound, not an exact one, and it now applies only to count-arm books (owner decision 17); that story collection re-joins to at most 4. It was not the only such book: 95 titles qualify in the part of the library AC8's scan reached.] |
| M-2 | A picked chapter below the 80% alignment floor makes no confident tag decisions; ch6 ran at 65% on 2026-09-05 | **Fixed** (owner decision 16). The pick is settled after capture, swapping a below-floor chapter for the next-densest one that clears it [the next by hidden-turn count, owner decision 18]; the runner reports alignment and `flagOnly` per chapter; the cost bound is stated (R8-2, §4.4 step 2) |
| M-3 | The no-effect rates and "500 and above" are wrong past n = 500 | **Fixed.** The reach table now reads to n = 19,000, where the *makes them worse* bar moves to 9. The no-effect rates are at most 2.1% and 10.0% (§4.4 "Verdict") |
| M-4 | (d′) holds ordinary speech–beat–speech paragraphs, not merges | **Resolved by removal.** (d′) existed only for 1C's sampling, and no surviving text uses it |
| M-5 | `Ŵ` not unbiased; no spare tie-break; the blind sheet names no parse; the mixed rule assumes one turn | First two: **resolved by removal**. Last two: **fixed** (R8-3, §4.3, §4.4) |
| M-6 | `ru.md` is not purely «»-quoted; Дневной дозор's figures are unverifiable | **Fixed.** Both restated in §4.4 step 1 and §4.5 |
| M-7 | The "up to 2 in parallel" line is from the 2026-09-07 cloud run | **Fixed.** "On-box cost" says so, and says the 2026-09-05 slot count is unrecorded |
| Q1–Q3 | The three questions | Owner decisions 14, 15 and 16 |
| R7 grades | AC7's grading of R7-1 … R7-11 | See owner decision 14 and the revision 7 decisions' heading. R7-5 stands |
| CI | `check:register-citations` | Passes locally (no new register ID is cited) |

## Decisions made in revision 8 (owner to confirm; R8-1 replaced by owner decision 17; R8-2 amended by owner decisions 18 and 19; R8-3 amended by R9-4)

These are choices owner decisions 14–16 did not settle. The text below is as
revision 8 wrote it; §2–§4 hold the current rules.

- **R8-1 · The re-join rule** (§4.4 step 1). Each line and the
  continuation lines directly after it are joined, with one space, into one
  paragraph and counted as one. No match can straddle a join, so the count
  is exactly the sum of the lines' counts, AC7's bound. **A PDF stays
  disqualified outright:** its layout breaks often fall before a capital or
  a dash, which the continuation test cannot see. [Replaced by owner
  decision 17, AC8 M-1. "No match straddles a join" holds, but the count is
  a lower bound, not a bound: every hard wrap, not only a PDF's, breaks
  before a capital or a dash, and the re-join cannot see those breaks.]
- **R8-2 · The pick caps substitutions at two.** At most five chapters are
  captured. If fewer than three clear the floor by then, 1A is computed on
  those that did, and the recorded outcome says how many and why. If none
  did, 1A is **not computed** and, like a void, does not discharge the row. This keeps
  the worst case at two extra chapter captures, not the whole book.
- **R8-3 · Blind sheet and two-speaker sentences.**
  - The sheet shows the sentence's line in the **recovery-off** parse (the
    imported text), with the line either side. That parse is the same for
    both arms, so it gives away neither answer.
  - A sentence that holds turns by two different speakers (`— Да? — Нет.`)
    has no single right id. The judge marks it **two speakers**, it is
    scored **neutral**, and it is counted apart from the other mixed
    sentences.

## Revision 7 changelog (history)

"AC6" is the PR #4184 comment headed "Assumption-checker pass 6 (head
b87361ed…)". It found 0 Critical, 1 Significant and 11 Minor. The owner
answered its three questions on 2026-11-16; those answers are **owner
decisions 11–13** below. The numbers in this revision come from AC6's own
`signtest.mjs` and `wrap-measure.mjs`, extended as `hypergeo.mjs` and
`hypergeo-margin.mjs` (the exact finite-population test, its reach, and
1C's per-class reach), `wrap-measure-wide.mjs`
(wraps up to 800 columns) and `density.mts` (dash-turn density and
continuation lines on imported text, read-only through `parseManuscript`).
None is committed. Each AC6 finding and its resolution:

| # | Finding | Resolution |
|---|---|---|
| S1 | R6-1's binomial sign test misfits a finite target: a census of 18 improvements and 8 regressions reads *no clear direction*, a census of 1 and 6 never fires *makes them worse*, and a sample of 30 from 40 is under-powered. The test's reach is unstated, and both directions share one bar though their follow-ups differ | **Owner decision 11.** The verdict is about this capture's changed sentences. At `n ≤ 30` every one is judged and the counts decide: *improves* at `I − R ≥ 3`, *makes them worse* at `R − I ≥ 1`. At `n > 30`, 30 are drawn and an exact finite-population test of the same two claims decides, one-sided, at 0.025 for *improves* and 0.10 for *makes them worse*. Harm needs the smaller margin and the looser level. The reach is tabled for `n` = 40, 100 and 500 (R7-1, R7-2, §4.4 "Verdicts") |
| M-1 | "Ceiling measured" is an inference: production ran two chapters at once, the harness runs one, and the likely picks are retry-heavy | **Fixed in place.** Re-derived on the measured likely pick (ch5, ch8 and ch6; 34.6% of the book's words) as ≈ 1.1–2.8 h, estimated, close to AC6's ≈ 1–2.7 h. 3 h 18 m is now an **inferred** ceiling, with its condition stated. The harness stays one chapter at a time, and §4.4 says so (R7-9, §4.4 "On-box cost") |
| M-2 | The 5% cut misses a 200-column wrap (4.3%); EPUB and MOBI can be line-wrapped and are never tested | **Owner decision 13.** The test runs on every format's imported text. The cut is ≥ 2% of lines **or** ≥ 10 continuation lines. Every measured fixture wrap that splits a paragraph clears it, and both real EPUBs on the box have 0 continuation lines. What still escapes is stated (R7-6, §2, §4.4 step 1) |
| M-3 | Step 1 drops the provisional label on "no breach"; §2 and §4.5 keep it when no clean, dialogue-dense ru book exists; "dialogue-dense" has no number | **Owner decision 13.** One rule, used in step 1, §2 and §4.5: no breach **and** at least one clean, dialogue-dense ru dash book. Dialogue-dense means ≥ 25 dash turns per 1,000 words and ≥ 1,000 dash turns, calibrated on Ночной дозор (36.0) and the fixtures (R7-5) |
| M-4 | The `flags` clone test cannot catch a clone taken after escalation | **Fixed in place.** The characterisation test gains a fifth input in which escalation actually fills a line. `onStages.flags` must still hold that line's index (§4.2) |
| M-5 | 1C's 12% bound is misapplied; its reach, class (b), class (d) and the trigger | **Owner decision 12** (R7-3, R7-4). Lapsed with 1C in revision 8 (owner decision 14) |
| M-6 | Notice A's second sentence is a calibration claim, false at a same-speaker resumption | **Fixed in place, by labelling.** The wording is unchanged. §2 and §3 now say that each notice's first sentence is true by construction and its second is a calibration claim, which "usually" hedges. R6-10's "true by construction" is corrected to cover the first sentence only |
| M-7 | When only some chapters' controls fail, the row discharges on the rest, with a known seam defect unfixed | **Fixed in place.** Any chapter's control failure blocks the verdict and the discharge. A replay defect is re-measured from the saved captures, and a capture defect re-captures the chapters it affects (R7-7) |
| M-8 | A sentence that crosses a line break can meet both (a) and (c), and "its paragraph" is undefined for it | **Fixed in place.** A sentence's line, in either parse, is the line holding the start of the first span it aligns to. (a) holds if any of its spans lies on a recovered line, and (c) reads its line in the recovery-off parse. The precedence puts a crossing sentence in (a). 1A and 1C use the same rule (R7-8, §4.3) |
| M-9 | `--dump` hydrates through `findBookBy`, whose self-heal can write `state.json`; a capture that dies mid-book has no resume rule | **Fixed in place.** The dump goes through a read-only record builder extracted from `hydrateFromDisk`, with a test that `state.json` is untouched. Each saved capture carries the escalation budget left, and `--resume` restores it and re-captures only the chapter that died (R7-10) |
| M-10 | R3-3's rationale still cites the twin's reference-book pick | **Fixed in place.** R3-3 is marked: the decision stands, its rationale lapsed with the twin, and it now rests on one owner session and one row |
| M-11 | The judges are not blinded, and the rubric has no rule for a sentence that spans narration and a turn | **Fixed in place.** The judge names the true speaker from a sheet that shows no arm's or engine's answer, and `--score` derives each judgement. A mixed sentence's right answer is the turn's speaker, and mixed sentences are counted apart (R7-11) |
| Gap | Without the twin, class (c) may be thin | **Stated** for 1C. Lapsed with 1C in revision 8 |
| Q1–Q3 | The three questions | Owner decisions 11, 12 and 13 |
| R6 grades | AC6's grading of R6-1 … R6-10 | R6-1 is superseded by R7-1 and R7-2, R6-2 by R7-3 and R7-4, and R6-7 by R7-6. R6-3 is amended by R7-7, R6-6 by R7-8 and R6-10 by the M-6 label. R6-4's test is strengthened (M-4). R6-5, R6-8 and R6-9 stand |
| CI | `check:register-citations` | Passes locally (no new register ID is cited) |

## Decisions made in revision 7 (owner to confirm; R7-3 and R7-4 lapsed with 1C in revision 8; R7-6 and R7-11 amended by it; R7-2's rates and R7-5's line-wrap clause superseded)

These are choices owner decisions 11–13 did not settle. Each one is the
option most consistent with them. Owner decision 14 (revision 8) drops 1C,
so R7-3 and R7-4 lapse, and so does R7-11's "left out of `n_k`" clause.
R7-6 is amended by owner decisions 15 and 17, and R7-11 by R8-3 and R9-4.
R7-2's no-effect rates were corrected by AC7 M-3, and R7-5's "not
line-wrapped" clause is overridden by owner decisions 15 and 17 (AC8 M-8);
both are marked in place. The text below is as revision 7 wrote it; §2–§4
hold the current rules.

- **R7-1 · The census bars: *improves* at `I − R ≥ 3`, *makes them worse* at
  `R − I ≥ 1`.** In a census the counts are the answer, apart from the judge.
  A margin of 3 means *improves* survives any one misjudged sentence, since a
  flip moves `I − R` by 2. Harm needs only a net regression. One misjudged
  sentence can therefore produce *makes them worse* from a take with no net
  effect. That is deliberate: a false alarm files a design item that starts
  by measuring, while a missed regression files nothing.
- **R7-2 · The sample test, and its two levels.** At `n > 30` the same two
  claims are read about all `n` changed sentences, and each is tested
  exactly against the sample of 30:
  - its p-value is the largest, over every split of the `n` sentences the
    null allows, of the multivariate hypergeometric probability of a sample
    difference at least as extreme;
  - *improves* needs one-sided p < 0.025, the level of the old two-sided
    test;
  - *makes them worse* needs one-sided p < 0.10.

  Keeping the census margins keeps the test continuous with the census: at
  `n = 31`, *improves* needs a sample `I − R ≥ 4`. With no effect, a sample
  reads *improves* at most 1.8% of the time and *makes them worse* at most
  9.3%. [Superseded, AC7 M-3 and AC8 M-8: those are the `n = 500` rates.
  At `n` = 2,000–5,000 they are 2.1% and 9.9–10.0%; the exact test keeps
  each at or under its level, §4.4 "Verdict".]
- **R7-3 · The 1C allocation** and **R7-4 · the `Ŵ_hi` follow-up
  trigger.** Lapsed with 1C (owner decision 14); AC7 S1 showed the trigger
  fired before any judging.
- **R7-5 · "Dialogue-dense" means ≥ 25 dash turns per 1,000 words, and
  ≥ 1,000 dash turns.**
  - A dash turn is a dash-opening paragraph or a `countTurnOpeners` match.
    The density counts both, so it reads the same on a merged copy as on a
    clean one.
  - 25 is Ночной дозор's sparsest chapter (ch7, 26.8) rounded down. The
    book reads 36.0, and the dialogue-dense fixture 33.7.
  - 1,000 turns is about a quarter of Ночной дозор's 3,739. A clean book
    needs enough dialogue paragraphs to have had a chance to breach, and the
    fixtures' 14 turns are not that.
  - A "clean, dialogue-dense ru dash book" is also not line-wrapped, and has
    no chapter at ≥ 10 on its imported text. [The "not line-wrapped" clause
    is overridden by owner decisions 15 and 17, AC8 M-8: a book only the
    count arm flags can qualify, §4.4 step 1.]
- **R7-6 · Line-wrapped: every PDF, and any other book whose imported text
  has continuation lines making up ≥ 2% of its non-blank lines, or numbering
  ≥ 10.**
  - The share arm catches every measured fixture wrap that splits a
    paragraph, the 200-column one included.
  - The count arm catches a wide wrap in a book-length file, where a few
    split paragraphs are a tiny share.
  - A false flag only withholds a book from the "no breach" evidence. It
    never hides a breach, so the test errs toward flagging.
- **R7-7 · Any chapter's control failure blocks the verdict and the
  discharge.** A control mismatch is a seam defect. Dropping that chapter
  would leave the defect unfixed and the verdict on fewer chapters than were
  picked.
- **R7-8 · A sentence's line is the line holding the start of the first span
  it aligns to.** Recovery is length-preserving, so that offset names a line
  in both parses. An unaligned sentence has no line and is (d).
- **R7-9 · The harness stays one chapter at a time.** Running serially
  consumes the shared escalation budget in chapter order, and it makes the
  runner's per-chapter wall-clock and its estimate after chapter 1 mean one
  thing. The cost is stated for serial capture.
- **R7-10 · The dump goes through a read-only record builder, and a dead
  capture resumes.**
  - `buildManuscriptRecord(bookDir, state)` is extracted from
    `hydrateFromDisk` and called by it unchanged. So the dump and analysis
    build the same string, and the dump never runs `findBookBy`'s self-heal.
  - `--resume` keeps the saved chapters, restores the escalation budget from
    the last one, and captures again only the chapter that died.
- **R7-11 · Blind judging, and the mixed-sentence rule.**
  - The judge names the speaker before seeing any answer.
  - For a sentence that holds narration and a turn, the turn's speaker is
    the right answer, because the turn is what a listener hears misvoiced.
  - "Can't tell" counts as neutral in 1A, and is left out of `n_k` in 1C.

## Revision 6 changelog (history)

"AC5" is the PR #4184 comment headed "Assumption-checker pass 5 (head
4c5bc2c7…)". It found 0 Critical, 4 Significant and 9 Minor, and gave a
separate value verdict: the Ночной дозор half answers blocker 1, and the twin
half is not worth running unconditionally. The owner answered its first
question on 2026-11-15 by dropping the twin; that answer is **owner
decision 10** below. Each AC5 finding, and whether it was **resolved by
removal** (it existed only for the twin) or **fixed in place**:

| # | Finding | Resolution |
|---|---|---|
| S1 | The power table and R5-12 score one merged capture, but the recorded verdict needs M and M2 to agree; at the owner's 9000-char budget a true zero effect is recorded *not degrading* only 14–50% of the time | **Resolved by removal** (owner decision 10). The twin, its power table and R5-12 are gone |
| S2 | Stage 2 carries the previous chunk's last speaker and two paragraphs across every seam (`stage2-chunk.ts:465-473`), so clean chunks are not independent clusters and the bootstrap SE runs low | **Resolved by removal.** No bootstrap is left. The Ночной дозор verdicts come from hand-checks of sentences sampled from one capture, and §4.4 states that they describe that raw take of those chapters, nothing wider (R6-1, R6-2) |
| S3 | The cost table quoted the 2026-08-12/13 run, whose 16 GB model spilled over PCIe and is no longer on the box | **Fixed in place.** Re-based on the 2026-09-05 run (`qwen38-cw-iq3-80k`, phase 1 ≈ 3 h 18 m for the whole book, `onbox-wave11-group-c-results/step-2-c2c3c4-run.md:29-31`). The Ночной дозор step is now an estimated ≈ 1–2 h of wall-clock, with a measured ceiling of ≈ 3 h 18 m, and the table says which figure is which (§4.4 "On-box cost") |
| S4 | One rule over four statistics feeding two recorded verdicts, with no rule for combining them; a 5 pp bar cannot see a several-fold rise in the small confident-disagreement base | The four twin statistics are **removed**. **Fixed in place** for what remains: 1A and 1C each record one verdict, each with its combining rule, and the 1C bar is a count sized to a 30-judgement sample, not a percentage (R6-1, R6-2, §4.4 "Verdicts") |
| M-1 | The table's "clean chunks" column counts clusters the bootstrap drops | **Resolved by removal** |
| M-2 | `onStages` carries no flag, so "not flagged" cannot be read; the bucket is not the flag | **Fixed in place.** Phase 5 adds a fourth `onStages` field, `flags`, a clone of `examined.flags` (`cross-examine.ts:47`), and the confident filter reads it by sentence index (R6-4) |
| M-3 | A fail-loud check that runs after the captures throws away hours of capture | **Fixed in place.** The runner saves each chapter's capture before any check runs, and measures from the saved files; a failed check is fixed and re-run with `--from-captures`, with no model (R6-5) |
| M-4 | `isSceneSeparatorUnit` is a closure inside `splitBodyIntoChunks`, not an export | **Resolved by removal** (the degrade script is gone) |
| M-5 | The 20% continuation cut misses an 80-column hard wrap (16.4%); Markdown is untested | **Fixed in place.** The cut is now 5%. Both committed ru fixtures, hard-wrapped at 60–120 columns, score 6.3–50.6%; unwrapped, or one paragraph per line, they score 0%. The scanner's tests add wrapped `.txt` and `.md` fixtures (R6-7) |
| M-6 | Notice A's second sentence says "lines"; its third names a cause; `DASH` also admits an ASCII hyphen | **Fixed in place.** A's second sentence now reads "Each of those places would usually start a new paragraph", and the cause sentence is deleted; the voice-pass constraints now forbid both. §2 names the ASCII-hyphen match as a calibration risk, not construction (R6-10, §2, §3.1) |
| M-7 | Classes (a) and (c) can both hold for one sentence | **Fixed in place.** Class (c) is judged on the sentence's **imported** paragraph (the recovery-off parse). Recovery never splits a paragraph that opens with a dash (`paragraph-recovery.ts:100`), so (a) and (c) are now disjoint. The precedence (a) > (b) > (c) > (d) makes the classification total regardless (R6-6) |
| M-8 | A CRLF `.txt` collapses each chapter to one chunk | **Resolved by removal.** The hand-exported twin `.txt` is gone. The runner's only input is the scanner's dump of the hydrated body, the very string analysis reads, so the runner applies no normalisation of its own (§4.4 step 2) |
| M-9 | `assertHintsPairWithState` throws, and its result depends on the current titles | **Fixed in place.** B calls it in a `try`/`catch` of `HintsOutOfSyncError` only, on every request after the memo lookup, and never memoises it; a route test changes only `state.json`'s title state under a cached record and sees the key follow (R6-8, §3.2) |
| Q1 | Run the twin unconditionally, behind a pilot, or not at all | **Owner decision 10: not at all.** A pilot-first design is recorded under "Out of scope" (§5) |
| Q2, Q3 | The bootstrap unit under carry; the bar for `cM − cN` | **Resolved by removal.** Q3's small-base concern carries over to the Ночной дозор confident count, which now has a count bar (R6-2) |
| R5 grades | AC5's safe / gap / weak / unsafe grading of R5-1 … R5-13 | R5-1, R5-2, R5-4, R5-5, R5-10 and R5-12 lapse with the twin. R5-3 gains R6-4 and R6-5; R5-7 gains R6-8; R5-9's cut is replaced by R6-7. The rest stand |
| CI | `check:register-citations` fails: the spec cited a Group B row ID that does not exist yet | Every citation now reads "a new Group B register row (ID allocated at implementation)", or "the new register row" after first use. The check passes locally |

## Decisions made in revision 6 (owner to confirm; R6-1, R6-2 and R6-7 superseded by revision 7; R6-3, R6-6 and R6-10 amended by it; R6-2 lapsed with 1C in revision 8)

These are choices owner decision 10 did not settle. Each one is the option
most consistent with it. Revision 7 replaces R6-1 with R7-1 and R7-2, R6-2
with R7-3 and R7-4, and R6-7 with R7-6. It amends R6-3 (R7-7) and R6-6
(R7-8), and corrects R6-10's label (AC6 M-6). The text below is as
revision 6 wrote it; §2–§4 hold the current rules.

- **R6-1 · 1A records one verdict, decided by its hand-check.** The exact
  counts say how many sentences recovery changes, but not whether each change
  is better or worse; only the hand-check says that. So the verdict uses the
  hand-check alone: a two-sided exact sign test of improvements against
  regressions, ignoring neutrals, at p < 0.05. The counts give the scale
  beside it (§4.4 "Verdicts").
- **R6-2 · 1C's count verdict.** Superseded by R7-3 and R7-4, and lapsed
  with 1C in revision 8.
- **R6-3 · How the verdicts close blocker 1.** 1A answers the owner's
  2026-08-13 question directly. *Improves* keeps the issue's effect claim;
  *changes no speaker* or *no clear direction* downgrades it to a
  metric/acceptance improvement, the owner's own alternative; *makes them
  worse* downgrades it and files design work on recovery's evidence rule.
  1C is recorded beside it as the residual harm (§4.4).
- **R6-4 · `onStages` exposes the flags.** It gains `flags`, a clone of
  `examined.flags`, in the engine branch. The confident filter's "not
  flagged" is "the index is not in `flags`". Today every decision at ≥ 0.9 is
  unflagged, so this changes no count. It keeps R5-3's future-proofing
  conjunct readable.
- **R6-5 · Captures are saved before anything checks them.** The runner
  writes each chapter's capture to the scratch directory as soon as it
  returns, and the measurement reads only the saved files. Any fail-loud
  check, such as R5-3's unknown reason, therefore costs a re-run with
  `--from-captures`, never a re-capture.
- **R6-6 · Class (c) is judged on the imported paragraph; precedence is
  (a) > (b) > (c) > (d).** Judging (c) on the recovery-off parse matches its
  purpose (a paragraph that was dash-open in the imported text) and makes it
  disjoint from (a) by construction. The precedence settles any case the
  definitions miss, so two implementations cannot disagree.
- **R6-7 · The line-wrap cut is 5%.** On the committed fixtures, every wrap
  width from 60 to 120 columns clears it (6.3% at the narrowest margin), and
  every unwrapped shape scores 0%. A wrap wider than 120 columns leaves most
  dialogue paragraphs on one line, so the measure barely under-reads it.
  [False for the paragraphs that can breach, AC6 M-2. A fixture wrap at 200
  columns scores 4.3%; superseded by R7-6.]
- **R6-8 · B's pairing check runs per request.** `assertHintsPairWithState`
  depends on the current titles and `titleOverridden`, which change without
  replacing the hydrated record, so it runs after the memo lookup on every
  request, inside a `try`/`catch` of `HintsOutOfSyncError` only.
- **R6-9 · Phase 6 is withdrawn, and the phase numbers are kept.** Its two
  changes to `computeAttributionMeasurement` served only the twin. Keeping
  the numbers keeps every earlier changelog's phase references valid.
- **R6-10 · Notice A loses its cause sentence and says "places".** This is
  the shortest wording that stays true by construction; the voice pass may
  rephrase within the constraints in §3.1. [Corrected, AC6 M-6: only the
  first sentence is true by construction. The second is a calibration claim,
  hedged by "usually" (§2).]

## Revision 5 changelog (history)

"AC4" is the PR #4184 comment headed "Assumption-checker pass 4 (head
b682b582…)". The owner answered its three questions on 2026-11-15; those
answers are **owner decisions 7–9** below. The numbers in this revision come
from the checker's own simulation (`cluster-sim.mjs`), extended for owner
decision 7 as `cluster-sim-r5.mjs`: the same packer, degrade rule, chapter
generator and seed, plus a Monte-Carlo power study (§4.4 "Power"). Neither
script is committed. Each AC4 finding and where it is resolved:

| # | Finding | Resolution |
|---|---|---|
| C1 | 🔴 Chunk-union clusters collapse to 1.5–7 per chapter; the per-chapter floor makes 1B and the twin half of 1C inconclusive on nearly every book; the design effect is about 4–42, not 1.9 | **Owner decision 7.** The bootstrap resamples the **clean twin's own chunks** (C1 and C2 share them, being one body at one budget), and every reference span is assigned to one by its start offset. Merging no longer chains clusters. The floor is a **book total**, ≥ 20 clean chunks (R5-2), checked **before** any capture (§4.4 step 4). Power is recomputed by simulation at the measured 20–97 turns per clean chunk (the checker's 30–400 was for union clusters), including the "point estimate ≥ 5 pp" conjunct: at 1500 turns *degrading* is reached with 80% power only for an effect of about **7–14 pp**, and a true zero effect reads *not degrading* only **31–89%** of the time. The on-box GPU cost is stated: about **14–36 h** for the twin, plus 2–12 h for Ночной дозор. What the twin can and cannot conclude is stated plainly (§4.4 "Power") |
| S1 | 1C's confident count misses `narration-demote` and `tag-span-narrator` (0.9, unflagged), the #2253 rewrite itself | **Owner decision 8.** The confident filter is now structural, confidence ≥ 0.9 and unflagged, which at `1e295990` is exactly five reasons: `tag-confirm:*`, `tag-correct:*`, `tag-span-narrator`, `narration-confirm`, `narration-demote` (`cross-examine.ts:130`, `:144`, `:261`, `:274`, `:286`). Any other reason passing the filter fails the run loudly (R5-3). Class (b) now covers `narration-demote` too. Counts are reported by class **and** reason (§4.3) |
| S2 | Class (c) catches ordinary resumptions (`— Привет, — сказал Антон. — Как дела?`); the verbless-tag downgrade undercuts R4-3's rationale | **Owner decision 8.** Class (c) needs a **degraded** dash-open paragraph, ≥ `MERGED_TURNS_DEGRADED` `TURN_IN_PARAGRAPH` matches. R4-3's rationale now names the downgrade (`parser.ts:163-168`): the dash-open third measures that shape's real cost, which includes whole paragraphs going unanchored and flagged. The runner reports how many degraded dash-open paragraphs were downgraded, so a thin class (c) is visible, not silent (R5-11) |
| S3 | The notices say "lines of dialogue run together", but the measure counts openers; B dropped "usually"; the S5 changelog row describes wording that does not ship | **Owner decision 9.** Both notices now say "ten or more places where a line of dialogue begins mid-paragraph", and **both** carry "usually" (§3.1, §3.2). §2 says which part is construction and which is calibration. The revision-4 S5 row below now describes what revision 4 actually shipped, and points here |
| M-a | `:3728` cannot move into `runStructureEngine`; Phase 5 both deep-equals `onStages` and adds fields to it | The extraction is `:3714-3727`; `result.sentences = examined.sentences` (`:3728`) stays in the caller. The characterisation test compares only `sentences`, `structureReport` and the **pre-existing** `onStages` fields (`raw`, `deterministic`, `reasons`), with `toEqual`; a separate assertion pins the three new fields. "Byte-identical" is dropped (§4.2) |
| M-b | (holds) | No change. The vacuity of the "`final` equals `deterministic`" conjunct for the filtered reasons is stated; it stays as a guard (§4.3) |
| M-c | "The one sentence" is undefined for multi-sentence spans; `orphanSpoken` can't be reproduced from one `value`; the runner's `cast` and tag-span values are unspecified | A span counts only when **every** sentence in its `sentenceIndices` passes; its class is its lowest-index sentence's, and mixed-class spans are reported (R5-4). `emitSpans` emits **speech** spans only, so tag spans need no new value logic, and a `split` value carries `hasOrphan`, so `orphan + split∧hasOrphan = orphanSpoken` (R5-5). The runner's `cast` is the reference book's `cast.json` characters, the file the pinned roster was built from (§4.3) |
| M-d | Alignment is a normalised text search, not offset identity; `splitBodyIntoChunks` takes a `charBudget` | §4.3 now says the merged arm's sentences align to the clean body because the twin differs **only in whitespace** and the aligner collapses whitespace runs (`aligner.ts:126`, `:584`). Chunks are recomputed as `splitBodyIntoChunks(body, resolveStage2ChunkCharBudget(capacity, body))` (`stage2-chunk.ts:71-85`, `:142`) (§4.4) |
| M-e | The line-wrap flag (median line < 100 chars) misfires: the clean ru dash fixture's median is 50 | Replaced by a continuation test: a TXT is line-wrapped when ≥ 20% of its non-blank lines directly follow another non-blank line and start with a lowercase letter. The clean fixture scores 0% (R5-9, §4.4 step 1) |
| M-f | A same-count mispairing (merge plus split, then a lost hints file) also misnames chapters (#3837) | R4-7 is widened: a `hintsSource: 'parse'` record emits the key only when `assertHintsPairWithState(state, hints, parseTitles)` passes (`workspace/restructure.ts:787`), which is count/id plus the positional title test #3837's restructure uses. The residual (mismatches only at synthesized or overridden titles) is stated (R5-7, §3.2) |
| M-g | The #4217 what-if needs per-chapter HTML, which `parseManuscript` doesn't keep | The scanner rewrites a scratch copy of the EPUB (a `<br/>` after each dropped block closer) and runs that copy through `parseManuscript` too, so both parses share every EPUB path (`epub.ts:162-164`, `:277-279`, `assembleManuscript`). Chapters pair only when both parses give the same count and titles; otherwise the book is "what-if not aligned". MOBI is "what-if not computed" (R5-8, §4.4 step 1) |
| M-h | R4-4's "DASH then whitespace" is not ru's `dialogueOpen` (`^\s*DASH\s*`) | Every "opens with a dash" test in this design is the language's own `conventions.dialogueOpen` (`lang/ru.ts:22`): R4-3, R4-4, the scanner's counts and class (c). Phase 1 no longer exports a `DASH` factory (R5-6) |
| M-i | R4-3 leaves the dash-opening predicate, the base of `i` and `* * *` separators undefined | Defined: `dialogueOpen`; `i` counts runs from **0**; a run whose preceding paragraph is a scene separator (no attributable words, the `stage2-chunk.ts` test) is treated as having no paragraph before it, so it becomes dash-open and the scene break and its forced chunk boundary survive in M (R5-10) |
| M-j | The on-box cost is never stated | Stated per step (§4.4 "On-box cost"), as an upper bound at the run sheet's whole-analysis rate |
| Q1–Q3 | The three questions | Owner decisions 7, 8 and 9 |

## Decisions made in revision 5 (owner to confirm; R5-1, R5-2, R5-4, R5-5, R5-10 and R5-12 lapsed with the twin; R5-11 lapsed with 1C; R5-3, R5-7 and R5-9 amended by revision 6)

These are choices owner decisions 7–9 did not settle. Each one is the option
most consistent with them. Owner decision 10 drops the twin, so the six
decisions that served only it lapse; R5-3 gains R6-4 and R6-5, R5-7 gains
R6-8, and R5-9's cut is replaced by R6-7. The text below is as revision 5
wrote it, except that a lapsed decision now keeps only its title (revision
8).

- **R5-1 · The bootstrap is not stratified by chapter.** Lapsed with the
  twin in revision 6 (owner decision 10).
- **R5-2 · The cluster floor is ≥ 20 clean chunks for the book.** Lapsed
  with the twin in revision 6 (owner decision 10).
- **R5-3 · The confident filter is structural.** It is "confidence ≥ 0.9 and
  not flagged", not a reason list, so a reason added to `crossExamine` later
  cannot silently escape it. The runner asserts that every decision passing
  the filter carries one of the five known reasons, and fails loudly on any
  other, so a new reason gets a class decision, not a default.
- **R5-4 · A multi-sentence span counts only if every sentence passes.**
  Lapsed with the twin in revision 6 (owner decision 10).
- **R5-5 · `emitSpans` covers speech spans only.** Lapsed with the twin in
  revision 6 (owner decision 10).
- **R5-6 · One "opens with a dash" predicate: `conventions.dialogueOpen`.**
  The parser, `dashOpenedPara` (`attribution-health.ts`) and #2253's rescue
  already use it. Mid-paragraph openers stay `TURN_IN_PARAGRAPH`, the
  measure's own. A dash glued to the following word therefore opens a
  paragraph for every tool here, as it does for the engine.
- **R5-7 · B on a `parse` record needs the title test as well as the
  count.** This is #3837's own test for the same hazard, called as
  `assertHintsPairWithState` with `parseTitles`. It cannot see a mispairing
  confined to positions with a synthesized (`Chapter N`) or user-overridden
  title; that residual is stated, not closed. #3837's stronger sentence-based
  check (`workspace/hints-proof.ts`) needs saved analysis sentences, which
  `GET /state` would have to load on the hottest read route, so B does not
  use it.
- **R5-8 · The #4217 what-if is a rewritten EPUB copy, EPUB only.** It
  reuses the import path unchanged, rather than rebuilding the per-chapter
  HTML in the scanner. MOBI's HTML is inside a compressed binary, so its
  what-if is reported as not computed.
- **R5-9 · Line-wrap is a continuation test.** A hard wrap breaks lines
  mid-sentence, so the next line usually starts lowercase. A paragraph-per-line
  file starts each line with a capital or a dash. The 20% cut is a planning
  figure: the clean fixture scores 0%, and the scanner prints each TXT's share
  so the owner can see the margin.
- **R5-10 · R4-3 never folds a run across a scene separator.** Lapsed with
  the twin in revision 6 (owner decision 10).
- **R5-11 · The runner reports the verbless-tag downgrade.** Lapsed with 1C
  in revision 8 (owner decision 14).
- **R5-12 · The achieved detectable effect accounts for the 5 pp conjunct.**
  Lapsed with the twin in revision 6 (owner decision 10).
- **R5-13 · F2 is already discharged.** #4165's PR rewrote the stale
  "opt-in / Default OFF" comments and the suite title, so Phase 0 is F3 only
  (§1.5).

## Revision 4 changelog (history)

"AC3" is the PR #4184 comment headed "Assumption-checker pass 3 (head
a3a6beff…)". The owner answered its three questions on 2026-11-15; those
answers are **owner decisions 4–6** below (decisions 1–3 are the earlier
2026-11-15 set that drove revision 3). Each AC3 finding and where it is
resolved:

| # | Finding | Resolution |
|---|---|---|
| C(a) | 🔴 1C's confident-wrong count looks only in dash-open body paragraphs. The twin has none (R3-6 folds into narration), and 34 of Ночной дозор's 39 breaching paragraphs open with narration | **Owner decision 5.** 1C counts confident disagreements by **class** on the merged arm's **post-recovery** structure: (a) lines recovery split out (tag anchoring, `parser.ts:74-78`, scored `tag-correct`/`tag-confirm`), (b) dash turns recovery left unsplit (`narration-confirm`), (c) dash-open merged paragraphs (§4.3 "1C confident disagreements"). The degrade script now also builds dash-open merged paragraphs (R4-3) |
| C(b) | 🔴 R3-2's agreement-set reference zeroes its own noise term and is not paired | **Owner decision 4.** R3-2 and its 30-line hand-check are withdrawn. 1C is `hM = [M.final ≠ C1.final]` against `hN = [C2.final ≠ C1.final]`, both on C1's reference span set (§4.4 step 6) |
| C(c) | 🔴 C1's confident-wrong count is 0 by construction | **Owner decision 4.** The clean-noise count is **C2's** confident disagreements with C1, on the same span set and rule as M's. C1 against itself is never counted (§4.4 step 6) |
| S1 | Spans aren't independent; 5 pp is a coin flip at 300 turns; narrator share has no noise term | (Cluster unit and power figures **superseded by revision 5, AC4 C1**.) Cluster bootstrap over **chunk clusters** (§4.4 "Verdicts"). Realistic power stated: at 300 turns the minimum detectable effect is about 10–14 pp, not 5. The reference run adds chapters up to 1500 turns (about 5 pp) (R4-5). The narrator-share comparison is now paired against C2. A non-inconclusive verdict is re-checked on a second merged capture (R4-6) |
| S2 | `computeAttributionMeasurement` returns totals only; no instrument produces per-span vectors | Phase 6 adds an opt-in `emitSpans` output: one record per source span with its value (resolved id, split, unattributed, orphan) and its sentence indices, from the module's own parse and alignment (§4.3 "Measurement"). The split/unattributed rule is defined |
| S3 | The replay lacks the deduplicated roster; live-vs-replay mixes two code paths | `onStages` gains the deduplicated `stage1` the engine used, and the post-recovery `paras` and `alignment`. 1A now compares **two replays** (recovery on vs off), and the recovery-on replay must reproduce live `deterministic` exactly, or that chapter's 1A is void (§4.3 "1A engine replay") |
| S4 | Ночной дозор's 1A/1C measures miss hidden turns; the chapter pick favours the least-merged chapters | 1A on Ночной дозор is **per model sentence** (one raw, so both arms share one sentence list), over **turn sentences** defined from the text, not from spans (§4.3). Chapters are picked by **hidden-turn count** (sum of mid-paragraph turn openers), not dash-opening turns (§4.4 step 2) |
| S5 | "Much of the dialogue … for each speaker" is not implied by a max-in-one-paragraph measure; "cannot occur in clean text" is a calibration property | Revision 4 shipped "a paragraph with ten or more **lines of dialogue run together**": A added "where each line would usually start its own paragraph", and B had no "usually". That counted openers as lines, and B lost the hedge (AC4 S3). **Superseded by owner decision 9 (revision 5):** both now say "ten or more places where a line of dialogue begins mid-paragraph", with "usually" (§3.1, §3.2). §2 and Decision 4 state "cannot occur in clean text" and the uk/bg extension as **calibration results** (#2267 §2.1), not constructions |
| S6 | The register row's step 1 can't tell a false positive from an extractor-made merge | **Owner decision 6.** "Clean" is judged on the **imported** text. A #4217 (F4) merge counts as a true positive. The scanner shows the owner the worst imported paragraph and reports each book's #4217 exposure (§4.4 step 1) |
| M1 | The `runStructureEngine` span includes escalation; its return can't carry `conventions`/`rosterIds`; no zero-change proof | The extraction is now exactly name index → parse → windows → align → crossExamine (`analysis.ts:3714-3728`). It returns `{ examined, paras, alignment, rosterIds }`. The gate, `detSnapshot`, escalation, `structureReport`, the else-branch and `annotateSceneBreaks` stay in `attributeChapterStage2`. A characterisation test pins byte-identical output for four inputs before the extraction (§4.2) |
| M2 | Anchors moved +2 at `c16da893` | All anchors re-read at `c16da893` (header) |
| M3 | The harness differs from production (capacity, model, escalation budget, dedup constraints, roles, callback names) | Each is either matched or stated in a table (§4.3 "Harness vs production") |
| M4 | The reason filter needs a prefix match, and misses `tag-confirm` | The filter is `tag-correct:*`, `tag-confirm:*` and `narration-confirm`, matched by prefix (§4.3) |
| M5 | `WeakMap` value type contradicts `{ language, ids }`; exclusion not in the key; a `parse`-hinted record's ids may mismatch | The memo is `WeakMap<ManuscriptRecord, { language, ids }>` and caches **unfiltered** ids; exclusion is applied per request. A `hintsSource: 'parse'` record whose chapter count differs from `state.json`'s omits the key (R4-7) (§3.2) |
| M6 | 1A measures post-crossExamine, not post-engine | 1A is named **post-crossExamine** everywhere. That escalation's compensation is unmeasured is stated as a limit (§4.1) |
| M7 | Ночной дозор's chapter text has no defined source | It is the **hydrated record's** body (`getOrHydrateManuscript`, what analysis and `GET /state` read), dumped by the scanner. The runner and the measurement read that one string (§4.4 step 2) |
| M8 | PDF and hard-wrapped TXT under-read, so a scan of them can't confirm the threshold | Stated. The scanner flags line-wrapped books, and they don't count toward "no breach" (§4.4 step 1, §2) |
| M9 | "Every phase except 8 and 9 touches `server/`" contradicts Phase 3's cell | Reworded: every phase except 3, 8 and 9 (§5) |
| Row 3 | Confident-wrong count empty by construction | C(a)–C(c) above |
| Row 9 | Bootstrap not paired for 1C, anticonservative | C(b), S1 |
| Row 13 | Recovery-off switch alone can't give per-span vectors | S2 |
| Row 18 | uk/bg "stays true" is a calibration property | S5 |
| Q1–Q3 | The three questions | Owner decisions 4, 5 and 6 |

## Decisions made in revision 4 (owner to confirm; R4-3, R4-4, R4-5 and R4-7 amended by revision 5; R4-2, R4-3, R4-5 and R4-6 lapsed with the twin in revision 6)

These are choices owner decisions 4–6 did not settle. Each one is the option
most consistent with them. Owner decision 10 (revision 6) drops the twin, so
R4-2, R4-3, R4-5 and R4-6 lapse; R4-1, R4-4, R4-7 and R4-8 stand. Revision 5 amends four of them without reopening
them: R4-3 gains its predicate, its run base and its separator rule (R5-6,
R5-10) and a corrected rationale (owner decision 8); R4-4 uses
`dialogueOpen` (R5-6); R4-5's floor is now in chunks as well as turns
(R5-2); R4-7 adds the title test (R5-7). The text below is as revision 4
wrote it, except that a lapsed decision now keeps only its title (revision
8); §3–§4 hold the amended rules.

- **R4-1 · 1A is two replays, with a control.** Revision 3 compared a live
  snapshot with a replay. Now both arms are replays over one captured `raw`
  and the deduplicated roster the engine used. A third, recovery-on replay
  must equal the live `deterministic` snapshot exactly. If it doesn't, that
  chapter's 1A is reported void, not computed. This replaces R3-1's
  live-vs-replay comparison and keeps its "no model" property.
- **R4-2 · The twin's pairing space is the clean body's span set, parsed
  with production defaults (recovery on).** Lapsed with the twin in revision
  6 (owner decision 10).
- **R4-3 · The degrade script builds both merge shapes.** Lapsed with the
  twin in revision 6 (owner decision 10).
- **R4-4 · A "turn sentence" is defined from the text.** A model sentence is
  a turn sentence when its text opens with a dialogue dash or contains a
  mid-paragraph turn opener, by legibility's own `DASH` and
  `TURN_IN_PARAGRAPH` (exported in Phase 1, so there is still one
  predicate). This is how the Ночной дозор measures see hidden turns that no
  speech span covers.
- **R4-5 · The reference run takes chapters up to 1500 turns.** Lapsed with
  the twin in revision 6 (owner decision 10).
- **R4-6 · A second merged capture confirms a non-inconclusive verdict.**
  Lapsed with the twin in revision 6 (owner decision 10).
- **R4-7 · B omits the key on a chapter-count mismatch.** When the hydrated
  record has `hintsSource: 'parse'` and its chapter count differs from
  `state.json`'s, `GET /state` omits `paragraphsMergedChapters` rather than
  guess an id mapping (`store/manuscripts.ts:200`, the `hintsFromParse`
  fallback). Absent means "not measured", which is already the contract.
- **R4-8 · The scanner reports #4217 exposure with a scanner-local
  what-if.** For EPUB and MOBI chapters it counts the block closers
  `stripHtml` drops (`</div>`, `</li>`, `</blockquote>`, `</h1>`–`</h6>`)
  and re-measures legibility as if they were breaks. A flagged chapter whose
  count falls below 10 under that what-if is labelled **extractor-merged
  (#4217)**. The what-if lives only in the scanner and changes no production
  extraction (that is #4217's own design pass).

## Revision 3 changelog (history)

Revision 2 had two assumption-checker passes on PR #4184. "AC1" is the pass
headed "Assumption-checker pass 1 (head 50f5659e)"; "AC2" is the one headed
"assumption-checker pass: revision 2 does not clear the gate". Each finding
and where it is resolved (line anchors in this history table are as of
`a9918640`; the body below uses `c16da893`):

| # | Finding | Source | Resolution |
|---|---|---|---|
| 1 | 🔴 The analysis cache is post-engine (crossExamine output plus escalation's in-place edits), not raw stage-2 | AC1, AC2 | **Owner decision 1.** The cache-replay design is gone: there is no cache read, no stub analyzer and no `replay-structure-ab.mts`. Raw stage-2 is captured live through plan 265's `attributeChapterStage2` `onStages` seam, which returns the pre-engine `raw` snapshot (`analysis.ts:3696`) (§4.3) |
| 2 | 🔴 B's "speakers" claim is not true by construction (roster source, engine/recovery toggles, provenance can't tell them apart) | AC1, AC2 | **Owner decision 2.** Decision 2 falls back to (i): both surfaces make the source claim only. B no longer uses `cast.json`, recovery or the structure engine. All "couldn't check who says those lines" wording is removed (§2, §3.2) |
| 3 | Confident mis-correction in dash-open paragraphs (`tag-correct` 0.9, `narration-confirm` 0.95) is unmeasured, and it is the #2253 harm class | AC1 | **Owner decision 1.** Blocker 1 now measures post-engine harm on the merged twin directly, with a dedicated confident-wrong count (§4.1 part 1C, §4.4) |
| 4 | "Only unrecovered turns keep low confidence" is false | AC1 | Decision 2's rationale is rewritten: it no longer depends on any confidence claim (§Owner decisions 2) |
| 5 | The source claim blames the file for merges Castwright's own extractor makes (`stripHtml` breaks only on `</p>`, `<br>` and `<hr>`) | AC1 | The wording now claims only that the **imported text** runs dialogue together. It names no cause and suggests "a different copy or format" (§3.1, §3.2). Changing the extractor is filed as F4, which needs a design pass (§1.5) |
| 6 | Phase 2 (26-book false-positive check) is not agent work | AC1, AC2 | **Owner decision 3.** It is now step 1 of the owner-run new Group B register row (ID allocated at implementation). Agents build only the scanner (Phase 7). The threshold ships as **provisional** and no UI phase waits on the check (§2, §4.4, §5) |
| 7 | Threshold 10 is uncalibrated; the Phase-2 gate is circular; the residual threshold is never measured; no PDF/MOBI sources were checked | AC1 | Provisional label, stated limit (§2). The residual measure is gone with Decision 2 (ii). The scanner covers every `parseManuscript` format and reports format per book (§4.4 step 1) |
| 8 | No fallback when no clean, dialogue-dense ru book exists | AC1, AC2 | **Owner decision 3.** The threshold stays provisional, calibrated on the authored fixtures. The twin-based parts of blocker 1 record a third verdict, *inconclusive*, and the Ночной дозор parts still run (§4.4, §4.5) |
| 9 | 1B's verdict rule has no statistical power (5 pp is about 1 SE at ~100 turns) | AC1 | The rule now pools spans across the 3 chapters (≥ 300 turns, already required) and uses a paired, chapter-stratified bootstrap. It needs both a 95% CI lower bound above 0 and a ≥ 5 pp effect. When the reference is underpowered or absent, the verdict is *inconclusive*, never *source/metric only* (§4.4) |
| 10 | A second harness would duplicate `attribution-eval/run-eval.ts`; the 9000-char chunking trap | AC1, AC2 minor | Phase 7 extracts `captureChapterStages` from `evalFixture` and reuses it; `evalFixture` calls it unchanged. Chunk shape is recorded per arm, and the degrade script merges only dialogue runs (§4.3) |
| 11 | A stub analyzer won't pass cached sentences through the coverage guard unchanged | AC2 | Gone with item 1: no stub. Live runs keep the coverage guard on, as production does, and record its retries and splits (§4.3) |
| 12 | `ImportCandidate` is hand-written | AC2 | Phase 2 hand-edits `src/lib/types.ts` `ImportCandidate`. The openapi edit and `openapi:types` stay, to keep the contract in step (§3.1) |
| 13 | `computeAttributionMeasurement` already takes explicit bodies and sentences, so it needs a recovery-off switch, not a reference-body mode | AC2 | Phase 6 is now only that switch. The `measure-attribution.mjs` pass-through is dropped, because the runner calls the function in-process (§4.3) |
| 14 | The Phase-8 instrument passes `roster: []` (`attribution-health-io.ts:220`) | AC1 minor | The runner passes the pinned harness roster directly. The library path through `-io.ts` is untouched (§4.3) |
| 15 | Script review's `buildStructureEvidence` is a third channel from recovery to final output | AC2 | Added to §1.2. Script review stays out of 1A/1B scope, and the scope note says so (§4.1) |
| 16 | More phases touch `server/` than revision 2 said; 3, 5 and 6 were unordered | AC2 | The phase table now marks scope per phase, and every server-touching phase runs in one serial chain (§5) |
| 17 | Phase 9 (live-view publish) is not Cheap tier | AC2 | **Owner decision 3.** It is main-thread work, not a dispatched phase (§5 Phase 8) |
| 18 | `ru` detection fires for any text that is ≥ 30% Cyrillic (`detect-language.ts`), so uk/bg books are included | AC1 minor | Accepted and stated: those languages also open each turn with a dash, so the source claim stays true. The false-positive risk sits under the provisional label, and the scanner reports detected and declared language per book (§Owner decisions 4) |
| 19 | `responsive/` e2e gives no PR-time mobile coverage, because PR CI runs chromium only | AC1 minor | The spec stays under `responsive/` (release-time phone and tablet). It also gets a chromium-project case at a 375 px viewport, so PR CI covers phone width (§3.1, §3.2) |
| 20 | The extra `GET /state` cost is unmeasured (~14 client call sites) | AC1 minor | The result is memoised per `ManuscriptRecord` with a `WeakMap`, so the cost is one regex pass per hydration, not per request. A route test pins this (§3.2) |
| 21 | A and B use different language rationales (a ru override shows A and never B) | AC1 minor | Both now key on the language the **user has set**: A shows only while the confirm form's selected language is in `NOTICE_LANGUAGES`, and B uses the persisted language. The remaining gap (detected en, overridden to ru) is stated (§3.1) |
| 22 | `mergedTurns` / `chapterMergedTurns` have no UI consumer; raw vs residual unspecified | AC1, AC2 minor | Both fields are dropped. The wire carries only booleans or ids (§3.1, §3.2) |
| 23 | The mock import always returns one chapter (`src/lib/api.ts:934`) | AC1 minor | The title cap is pinned by the component test only, and e2e covers shown/not-shown (§3.1) |
| 24 | Decision 1 contradicts §3.2's no-cast branch | AC1 minor | Gone: B no longer depends on a cast |
| 25 | The 10.8% ch5 figure is not an engine-level reading | AC2 minor | Reworded as the #2306 pre-crossExamine narrated-speech share (`stage2-coverage.ts` `narratedSpeechShare`) (§1.4) |
| 26 | The 1A mock is underspecified, and it skips the wrong-`narrator` case | AC1, AC2 minor | §4.2 now specifies two arms: an in-roster non-narrator wrong id, and a wrong `narrator` |
| 27 | Numbering slip: "Phase 6's harness" | AC2 minor | Phases are renumbered. §1.5 now points at Phase 7 |
| 28 | Register group: B or C? | AC1 minor | B. The harness runs chapters live from a pinned roster, so no whole-book Ночной дозор re-analysis session (Group C's prerequisite) is needed (§Owner decisions 6) |
| 29 | The 2026-09-05 analysis cache is gone | AC1 minor | No longer relevant, because no cache is read. The "~4 h fresh run" precondition is dropped (§4.4) |
| 30 | Phase 2's corpus is not enumerated, so an agent cannot run it | AC1 minor | It is owner-run now. The scanner takes a directory, and the run sheet lists the books by title (§4.4 step 1) |
| 31 | Questions owed (AC1 1–3, AC2 1–3) | AC1, AC2 | Q1 (raw source): owner decision 1. Q2 (what "speakers" means): owner decision 2. Q3 (who runs 2 and 9; no clean book): owner decision 3. AC1 Q3 (post-engine harm; "couldn't check"): owner decisions 1 and 2 |

## Decisions made in revision 3 (owner to confirm; R3-1, R3-2 and R3-6 superseded by revision 4; R3-4 lapsed with the twin in revision 6; R3-3's rationale lapsed with it, and R3-3 stands)

These are choices the binding owner decisions did not settle. Each one is the
option most consistent with them.

- **R3-1 · (superseded by R4-1: two replays plus a control) 1A replays the engine from a live raw take, not a second live run.**
  Each chapter gets one live capture (recovery on, production defaults). 1A
  then re-runs only the deterministic engine over that same captured `raw`,
  with recovery off. There is no analyzer stub and no coverage guard, because
  only `crossExamine` re-runs. Two live runs (recovery on and off) would mix
  model noise into a question that is about the engine alone. Escalation needs
  a model, so 1A compares the post-crossExamine (`deterministic`) snapshots.
  Escalation's share is reported separately from the live run (§4.3).
- **R3-2 · (withdrawn by owner decision 4) The post-engine reference for the twin is a C1∩C2 agreement set,
  checked by hand.** The twin has no human labels, and labelling 3 chapters by
  hand (plan 265's `--silver` path) is owner time the decision did not commit.
  The reference is every span where both clean runs' **final** speakers agree.
  A 30-line hand-check of M-vs-reference disagreements estimates how often the
  reference itself is wrong (§4.4).
- **R3-3 · One register row, and the false-positive check is its step 1.** The
  library-wide legibility scan that serves as the false-positive check is the
  same scan that picks the clean reference book, so both run in one session
  (§4.4). [The rationale lapsed with the twin in revision 6, AC6 M-10. The
  decision stands on its own: the scan and the Ночной дозор run are one owner
  session on one box, so one row records both.]
- **R3-4 · A third verdict, *inconclusive*.** Blocker 1 records it when no
  qualifying reference exists, or when the bootstrap CI crosses 0. It
  discharges the row. #2254's blocker 1 then closes on the Ночной дозор
  evidence (1A plus the 1C hand-check), with the twin limitation named in the
  verdict comment.
- **R3-5 · Notice gating keys on the user's chosen language** (finding 21),
  and the client mirrors `NOTICE_LANGUAGES` with a source-of-truth comment.
  The other option, A ignoring the selected language, was revision 2's "a fact
  about the file". It loses because that "fact" is only computed for detected
  ru, and it would leave A and B disagreeing after save.
- **R3-6 · (superseded by R4-3: both merge shapes) The degrade script merges dialogue runs only.** It folds each run
  of consecutive dash-opening paragraphs into the paragraph before it (the
  Calibre damage shape), rather than every `\n\n`. That keeps narration
  paragraph breaks, and with them the chunk boundaries between turns, closer
  to the clean twin's. It stays deterministic and length-preserving, and it
  needs no seed.

## Owner decisions

> **Accepted 2026-11-13; amended by the owner 2026-11-15.** Decisions 1, 3, 4,
> 5 and 7 stand from revision 2. Decision 2 is now (i) (owner decision 2 of
> 2026-11-15). Decision 6 is unchanged in group and is reasoned again below.
> Decision 3's threshold is now provisional (owner decision 3 of 2026-11-15).
> Owner decisions 4–6 of 2026-11-15 (revision 4) settle how blocker 1 is
> measured and how the register row's step 1 judges "clean"; owner decisions
> 7–9 (revision 5) settle the bootstrap unit, the confident count and the
> notice wording; owner decision 10 (revision 6) drops the twin experiment;
> owner decisions 11–13 of 2026-11-16 (revision 7) settle 1A's target and
> bars, 1C's allocation and trigger, and when the threshold stops being
> provisional; owner decisions 14–16 of 2026-11-17 (revision 8) drop 1C,
> narrow the line-wrap disqualification and settle the chapter pick after
> capture; owner decisions 17–19 of 2026-11-17 (revision 9) confine the
> re-join to count-arm books, order the swaps by hidden-turn count and say
> what follows a *not computed* 1A. They are written into §2–§4 and listed at
> the end of this section. (The numbered list below is the 2026-11-13 set, cited as
> "Decision N"; "owner decision N" means the later set, 1–10 of 2026-11-15,
> 11–13 of 2026-11-16 and 14–19 of 2026-11-17.)

1. **Surfaces.**
   - Options: **A** a notice on the confirm view at import · **B** a
     per-chapter caption in the manuscript view, worked out each time the book
     is read · **C** the analysis log only.
   - *A + B, with A first.* A alone misses books already in the library,
     *Ночной дозор* among them. B alone appears only after the book is saved.
     Both make the same claim (Decision 2), so B needs no cast and shows before
     any analysis.
2. **What each notice claims: (i), the source claim only** (owner decision,
   2026-11-15).
   - Both surfaces claim only what the measure counts: that the **imported
     text** of a chapter has a paragraph with ten or more places where a line
     of dialogue begins mid-paragraph, each of which would usually start its
     own paragraph, and that a different copy or format may help (wording per
     owner decision 9). The count of places and the single paragraph are true
     by construction of the measure. That such a paragraph
     is merged dialogue is a **calibration result** (#2267 §2.1), which is why
     the wording says "usually" (§2). The claim holds whoever caused the
     merge, whether that was the source file or Castwright's own extractor
     (F4, #4217).
   - Revision 2's option (ii), a "harder to tell who's speaking" claim from a
     post-recovery residual, is **withdrawn**. It cannot be made true by
     construction:
     - The engine's name index comes from the deduped stage-1 roster
       (`analysis.ts:3632-3638`, `:3714`), but B could only rebuild one from
       `cast.json`.
     - `analyzer.structure.enabled` is a live toggle (`registry.ts:1313-1320`)
       and so is recovery's history (default-on only since #2320), while
       provenance's `structureEngineVersion: 1` cannot tell those cases apart.
     - Dash-open paragraphs skip recovery (`paragraph-recovery.ts:100`), yet
       tags anchor across merged speech inside them (`parser.ts:49-79`,
       `:171`). The result is a *confident*, unflagged `tag-correct` (0.9) or
       `narration-confirm` (0.95) (`cross-examine.ts:23-37`, `:144`, `:274`),
       so even residual merged turns are not reliably "unchecked".
   - **No notice says Castwright "couldn't check" anything,** because for some
     of those lines the engine did reassign the speaker.
3. **Measure.**
   - Options: `measureChapterLegibility` ≥ 10 (#2267) ·
     `assessParagraphStructure().hiddenFraction` (#2320, uncalibrated).
   - *Legibility, with the threshold labelled provisional.* `hiddenFraction`
     counts every dash glyph, including ASCII hyphens inside words such as
     `где-то` (`structure-report.ts` `DASH`, not whitespace-bounded). It reads
     0.54–0.93 on 14 Russian EPUBs where recovery restored about 0 turns.
   - Legibility's threshold of 10 rests on one real clean ru book plus three
     authored texts (#2267 §2.2). It ships as **provisional** (owner decision,
     2026-11-15) until step 1 of a new Group B register row (ID allocated at
     implementation) records the library scan, and §2 states the limit.
4. **Languages.**
   - Options: ru only · ru/es/fr.
   - *ru only for the user notice.* es and fr are **uncalibrated**:
     - the #2267 calibration covered only authored-clean es/fr Coalfall text;
     - no real es/fr dash-dialogue source was measured;
     - `legibility.ts` `TURN_IN_PARAGRAPH` (`:8`) requires `\s+` after the
       dash, so standard Spanish typography (`—Hola —dijo—.`, with the dash
       glued to the word) can never match.

     es/fr stay operator-log only until a separate calibration lands. That is
     out of scope here, and the exclusion is recorded in the regression plan.
   - **"ru" here means a book whose language is ru,** and detection assigns
     `ru` to any sample that is ≥ 30% Cyrillic (`detect-language.ts:100`,
     `SCRIPT_THRESHOLD` at `:36`). Ukrainian, Bulgarian and other Cyrillic
     books therefore get the notice unless the user changes the language.
     That is accepted. **Whether the threshold separates clean from merged
     text in those languages is an uncalibrated assumption, not a
     construction:** they also open each turn with a dash, which makes ten
     mid-paragraph turn openers as unusual as in Russian, but no uk/bg book
     was measured. Their false-positive rate sits under Decision 3's
     provisional label. The register row's scan reports detected and declared language
     per book, so a non-ru breach shows up and is the first calibration
     evidence for it.
5. **`assessParagraphStructure`** (no production caller).
   - Options: delete it with its test · keep it as an offline-study export.
   - *Delete*, through report-fix-record. It is a pre-existing dead-code
     finding either way.
6. **Register group: B** (local Ollama analyzer, no TTS). The row is a new
   Group B register row (ID allocated at implementation, in Phase 8). AC1 asked
   whether this belongs in Group C ("one *Ночной дозор* re-analysis session").
   It does not. The procedure runs chapters live through the attribution-eval
   harness from a pinned roster, and never re-analyses a whole book.
7. **Dismiss control.** *None in v1.* The notice is static text. A dismiss
   button would add a touch target, persistence and another test.

**Owner decisions 4–6 (2026-11-15, revision 4; binding):**

- **4 · 1C's "harm" is measured against the clean twin's output.** The merged
  twin's final speakers are compared with the clean twin's final speakers,
  paired span by span, the same way 1B pairs the raw ones. R3-2's
  agreement-set reference and its hand-check are withdrawn. 1C answers
  "does merging change the final answer", not absolute accuracy. Its noise
  term is a genuine paired clean-vs-clean comparison, and the clean-side
  confident count is no longer 0 by construction.
- **5 · 1A and 1C cover both paragraph shapes.** They are measured over the
  post-recovery paragraph structure plus the model's sentences, so the
  narration-opening merges (34 of Ночной дозор's 39 breaching paragraphs) are
  in scope. Confident disagreements are counted where they actually occur:
  lines recovery splits out (`parser.ts` tag anchoring → `cross-examine.ts`
  `tag-correct`) and dash turns recovery leaves unsplit (`narration-confirm`).
  The degrade script also produces dash-opening merged paragraphs, not only
  folds into the preceding narration.
- **6 · In the register row's step 1, "clean" is judged on the imported text.** An EPUB
  whose `<div>` paragraphs Castwright's extractor merged (#4217) counts as a
  **true positive**, because the notice's claim is about the imported text.
  The scanner reports which books #4217 affects.

**Owner decisions 7–9 (2026-11-15, revision 5; binding):**

- **7 · The bootstrap resamples the clean twin's own chunks.** The merged
  arm's spans are assigned to them by start offset, so merging no longer
  chains clusters together. The minimum-clusters floor is a **book total**,
  not a per-chapter average. Power is recomputed honestly from the
  simulation, the detectable effect includes the "point estimate ≥ 5 pp"
  conjunct, and the on-box GPU cost is stated. If the honest power still
  leaves the twin unable to reach a verdict, the spec says so plainly and
  states what the run can and cannot conclude.
- **8 · The narrator overrides are counted, and class (c) is tightened.**
  1C's confident count includes `narration-demote` (0.9,
  `cross-examine.ts:286`, the #2253 rewrite) and `tag-span-narrator` (0.9,
  `:261`). Class (c) requires a genuinely degraded paragraph
  (≥ `MERGED_TURNS_DEGRADED` openers), not ≥ 1 `TURN_IN_PARAGRAPH` match.
  R4-3's rationale addresses the verbless-tag downgrade
  (`parser.ts:163-168`).
- **9 · The notices count openers.** They say "ten or more places where a
  line of dialogue begins mid-paragraph", or equivalent wording that is true
  by construction. **Both** notices carry the "usually" hedge §2 relies on.
  The revision-4 changelog's S5 row describes what actually ships.

**Owner decision 10 (2026-11-15, revision 6; binding):**

- **10 · Drop the twin experiment.** Blocker 1 closes on the Ночной дозор
  half: 1A's exact counts plus the two hand-checks. That answers the owner's
  2026-08-13 wording ("confirm it is fixing a user-facing problem"). Withdrawn,
  with every phase, test, register-row step and acceptance criterion that
  existed only for them: revision 5's §4.4 steps 3–7; the clean/merged twin
  (C1, C2, M, M2); the degrade script and R4-3; the cluster bootstrap and its
  floor; the power table and R5-12; and the 1B/1C twin verdicts. A merge-cost
  number for clean books is **out of scope**. If it is ever wanted, it is a
  separate future design that starts behind a pilot: capture C1 and C2 first,
  project the detectable effect from their measured noise, and only then
  spend M and M2 (§5 "Out of scope").
- **What lapses with it.** Owner decision 4 (1C against the clean twin) and
  owner decision 7 (the bootstrap unit) lapse entirely. Owner decision 5
  stands for 1A and 1C on Ночной дозор; its sentence about the degrade script
  lapses. Owner decision 8 stands, except its sentence about R4-3's
  rationale.

**Owner decisions 11–13 (2026-11-16, revision 7; binding):**

- **11 · 1A's verdict is about this capture's changed sentences**, not
  about recovery in general.
  - If `n ≤ 30`, every changed sentence is judged and the verdict comes from
    the counts directly, with no test.
  - If `n > 30`, 30 are sampled and the exact finite-population
    (hypergeometric) test decides.
  - *Makes them worse* gets a lower bar than *improves*, so harm is easier
    to flag than benefit is to claim. The two bars and their reach are
    stated (R7-1, R7-2, §4.4).
- **12 · 1C's samples are re-spread** across (a), (c) and (d′), with a
  trigger on `Ŵ_hi`. Lapsed with 1C (owner decision 14).
- **13 · The threshold drops "provisional" only with at least one clean,
  dialogue-dense ru book.**
  - "Dialogue-dense" gets a number, calibrated on the committed ru fixtures
    and on Ночной дозор's own opener density (R7-5).
  - The line-wrap check runs on every format, EPUB and MOBI included,
    because `stripHtml` keeps raw newlines inside `<p>`
    (`html-utils.ts:79-98`).
  - The 200-column wrap that slipped under the cut is addressed (R7-6).

**Owner decisions 14–16 (2026-11-17, revision 8; binding):**

- **14 · Drop 1C.** Blocker 1 closes on 1A alone. Withdrawn, with every
  phase step, test, register-row step and acceptance criterion that existed
  only for them: 1C's hand-check sampling and allocation, its verdict, `Ŵ`
  and `Ŵ_hi`, its trigger and follow-up rule, and class (d′). The per-class
  counts of confident decisions stay, as a **plain report with no
  verdict**, so the size of each class is on record for any later design.
  - **What lapses with it.** Owner decision 12 lapses entirely, and so do
    R7-3 and R7-4. Owner decisions 5 and 8 stand for 1A and the class
    report; their 1C parts lapse. R5-11's downgrade count served 1C's sample
    size and lapses. R6-3's "1C is recorded beside it" lapses. AC7 S1 is
    resolved by removal.
- **15 · A line wrap disqualifies a calibration book only if it matters:**
  only if re-joining its continuation lines could lift some chapter's
  paragraph to ≥ 10 openers (R8-1). The density bar of 25 dash turns per
  1,000 words stays. The label rule counts a breach in any scanned book,
  line-wrapped or not. [Narrowed by owner decision 17. It was taken partly
  on two claims from AC7 that AC8 showed false: that the re-join gives an
  exact bound (it gives a lower bound), and that the box holds only one
  qualifying book (it holds 95 titles in the part AC8's scan reached, 91 of
  which need no re-join).]
- **16 · Pick the Ночной дозор chapters after the first capture.** The
  runner reports alignment and `flagOnly` for every chapter. A picked chapter
  below the 80% alignment floor is swapped for the next-densest chapter that
  clears it (R8-2, §4.4 step 2). ["Next-densest" is amended by owner
  decision 18: the next by hidden-turn count.]

**Owner decisions 17–19 (2026-11-17, revision 9; binding):**

- **17 · The re-join applies only to a book the count arm alone flags**: a
  book with ≥ 10 continuation lines that make up under 2% of its non-blank
  lines, which is a handful of stray print-conversion breaks. A book the
  share arm flags (≥ 2%) is genuinely hard-wrapped and is disqualified as a
  calibration book outright, like a PDF. This replaces R8-1's general rule.
  The rule fails closed (§4.4 step 1): a count-arm book qualifies only when
  the check positively shows stray breaks, and any doubt disqualifies it.
  The re-join count is a lower bound: hard-wrapped at 80 columns, it
  reaches 10 for only 7 of 58 real paragraphs that hold 10–12 openers.
- **18 · A swap takes the next chapter by hidden-turn count**, the order
  §4.4 already uses: ch7 (≈ 14,051 words, ≈ 1.1 h), then ch1 (≈ 17,860
  words, ≈ 1.4 h). The expected run is ≈ 1.6–3.9 h and the worst case
  ≈ 5.3 h. The inferred 3 h 18 m ceiling does not cover a five-chapter run
  (§4.4 "On-box cost").
- **19 · A *not computed* 1A** (no captured chapter clears the floor) is
  recorded. The capture defect is then fixed and the chapters are captured
  again. The pick is settled afresh and the two-swap cap resets. The
  register row stays open until 1A is computed.

## 1 · What actually shipped (verified @ `25c65c0a`)

### 1.1 The intake signal: computed nowhere in production

`assessParagraphStructure` (`dialogue-structure/structure-report.ts`)
has exactly one reference outside itself: its own test
(`structure-report.test.ts`). It is not called, persisted, logged, put in
openapi, or used by the client. Nothing runs it at all.

### 1.2 Recovery: on by default, with no off switch, reaching output through three channels

- `parseChapterStructure` runs `splitEvidencedInteriorTurns` unless the caller
  passes `{ recoverMidParagraphTurns: false }` (option at `parser.ts:96`,
  default applied at `:105`). Recovery is **length-preserving**: it only
  replaces the one whitespace character before an evidenced dash with `\n`
  (`paragraph-recovery.ts:119-132`, in UTF-16 units since #4165). So a
  recovered line is exactly a line
  whose start offset is not a line start in the recovery-off parse of the same
  body. §4.3 relies on that.
- No production caller passes the flag:
  - `routes/analysis.ts:3715` (the engine);
  - `dialogue-structure/evidence.ts:90` (script-review evidence);
  - `store/attribution-health.ts:171` (the measurement).

  There is no setting or env var. Only tests turn it off.
- At `analysis.ts:3713` the whole structure engine runs only when
  `analyzer.structure.enabled` is true **and** the language has conventions.
- **The model never sees recovered text.** The stage-2 prompt gets the raw
  chapter body (`analysis.ts:3644-3677`). Recovery reaches final output
  through **three** channels:
  1. `crossExamine` (`analysis.ts:3720-3728`);
  2. escalation, which re-queries windows over the same recovered `paras`
     (`:3735-3767`, the `escalateFlaggedWindows` call at `:3747-3759`);
  3. **script review**: `buildStructureEvidence` (`routes/script-review.ts:919`
     → `evidence.ts:90`) parses with recovery on, and its hints go into the
     review prompt.

### 1.3 A calibrated degradation measure already exists, but only the operator sees it

- `measureChapterLegibility` (`legibility.ts:28-41`, #2267) returns the
  largest number of mid-paragraph turn openers in **one** paragraph:
  `[.!?…:]\s+DASH\s+(?=\p{Lu})` (`:8`). It splits on `\n`, and it counts every
  paragraph, including one that opens with a dash, by design (its header
  comment).
- The threshold of **10** exists **only** in
  `2026-08-12-merged-turn-legibility-design.md` §2.2, not in code.
- It is computed at analysis start and printed to stdout as
  `[analysis:structure] ch=N scope=book merged=K`. Only the book-level maximum
  is persisted (`state.json` → `analysisProvenance.maxMergedTurnsInParagraph`;
  type in `workspace/scan.ts:328`).
- It reaches the client only inside the permissive `state` blob. The
  hand-written client `BookStateJson`/`BookStateResponse`
  (`src/lib/types.ts:361`, `:455`) has no such field, and nothing reads it.
- #2267 §5: "No UI surface … a user-facing warning is a separate decision."
  This document is that decision.

### 1.4 Stale or wrong in the issue thread

1. **Blocker 1's premise is stale.** The 2026-08-11 *Correction* comment
   already refuted the −0.073 "attribution survives" claim on the engine path:
   ch5 was 69.7% narrator after the engine, against 11.4% from the model. #2253
   stopped that rewrite.

   The 2026-09-05 Group C run, after #2253 and #2320, logged ch5 at **10.8%**.
   That figure is the #2306 coverage check's **pre-crossExamine**
   narrated-speech share (`stage2-coverage.ts:197` `narratedSpeechShare`), so
   it is not an engine-level reading. The same run also **refused to persist**:
   its drift guard declined to write `cast.json`/`state.json`
   (`night-watch-reanalysis-onbox-acceptance.md` §4).

   What is still open:
   - **(a)** Does recovery change post-crossExamine speakers, and for the
     better?
   - **(c)** Where do the engine's confident decisions sit in merged text?
     (Revision 3 from AC1.) Owner decision 14 keeps only the counts, with no
     judgement of whether they are right.
   - Revision 5's **(b)**, whether merged paragraphing degrades the *model's
     raw* attribution, and its question of how much merging changes the final
     answer against a clean copy, needed the twin. Owner decision 10 puts both
     out of scope.
2. **The measure is wrong** (Decision 3).
3. **Stale "opt-in / Default OFF" comments: fixed on `main`.** At `c16da893`
   the `paragraph-recovery.ts` header (line 5) and `:45`, and the suite title
   `paragraph-recovery.test.ts:13`, still said opt-in. #4165's PR
   (`d91afacc`, `de079951`) rewrote all three; at `1e295990` they read
   "Conservative recovery", "Recovery runs by default" and "on by default,
   conservative". Only PR #2320's title still says it, and a merged PR's title
   is history, not a defect.
4. **The denominator moved across #2320.** `spokenTotal` for *Ночной дозор*
   went 1928 → 2122 (+194, exactly #2320's recovered spans). That is because
   `attribution-health.ts:171` parses with recovery on. Narrator-share
   comparisons that cross #2320 compare different span sets. §4 therefore
   never compares span-based figures across structures: Ночной дозор's 1A
   pairs per model sentence (R4-4).
5. Already corrected in the thread, repeated so nobody re-opens them:
   - the parser splits on `\n`, not `\n\n`;
   - the ru-dash fixture is not derived from this book;
   - the extraction branch is dead;
   - **ch1 is itself degraded.** Legibility is 58–133 on every chapter except
     ch3, and ch1 hides +208 turns. It is not a clean control.

### 1.5 Incidental findings

- **F1 (#4165, closed 2026-11-15):** UTF-16 vs code-point index mismatch
  in `paragraph-recovery.ts`. Merged on `main` before `1e295990`, so Phase 7's
  tools and the on-box run use the fixed recovery, and the gates on #4165
  below are met.
- **F2 (chore): discharged on `main`** by #4165's PR (§1.4 item 3, R5-13).
  Nothing is owed.
- **F3 (dead code):** `assessParagraphStructure`. Phase 0, per Decision 5.
- **F4 = #4217 (open, needs a design pass):** `stripHtml`
  (`parsers/html-utils.ts:79-97`) converts only `<br>`, `<hr>` and `</p>` to
  line breaks. Every other block closer (`</div>`, `</li>`, `</blockquote>`,
  `</h*>`) is stripped silently, which merges paragraphs in EPUB/MOBI sources
  whose paragraphs are `<div>`s. It is not fixed here because the fix changes
  the chapter bodies of books already in the library. `hydrateFromDisk`
  re-parses the source file (`store/manuscripts.ts:155-167`), so persisted
  sentence offsets would shift under existing books. **The decision owed (in
  #4217):** which block closers become paragraph breaks, and how existing
  books are migrated or pinned to the old extraction. Until then, Decision 2's
  wording keeps the notices true for these merges, and owner decision 6 makes
  them true positives in the register row's scan.

## 2 · Measure and threshold

- **Phase 1** adds to `legibility.ts`:
  - `MERGED_TURNS_DEGRADED = 10`, with a comment marking it **provisional**
    and naming the new Group B register row (ID allocated at
    implementation) as the calibration that will confirm it;
  - `isParagraphDegraded(body, language): boolean | undefined`.
    It returns `undefined` when the language is null, not in
    `NOTICE_LANGUAGES`, or has no conventions: not measured, never `false`
    (#2267 "absent ≠ clean");
  - `NOTICE_LANGUAGES = ['ru']` (Decision 4);
  - an export of the existing `TURN_IN_PARAGRAPH` pattern (as a
    fresh-`RegExp` factory, so no caller shares `lastIndex` on a `g` regex),
    plus `countTurnOpeners(body): number`, the **sum** of matches over the
    chapter. The scanner and the runner use these (R4-4, §4.4 step 2).
    `measureChapterLegibility` keeps its own behaviour. No `DASH` export:
    every "opens with a dash" test in this design is the language's own
    `conventions.dialogueOpen` (R5-6).

  Every server surface calls these. The client mirrors only
  `NOTICE_LANGUAGES` (§3.1) and the mock's threshold (§3.1 M), each with a
  comment naming its source of truth.
- **What is true by construction, and what is calibration.** By construction:
  the flag means that **one** paragraph of the imported text contains **ten
  or more** places where a sentence ends and a dash (an em dash, an en dash
  or an ASCII hyphen, `legibility.ts:3`) plus a capital letter follows. The
  notices claim exactly that count, as "ten or more places where a line of
  dialogue begins mid-paragraph" (owner decision 9, §3.1, §3.2), and nothing
  about speakers, lines, cause or who merged it. They count **places**, not
  lines: a resumption after a tag (`— А, — сказал он. — Б.`) is one
  speaker's line but two places, and each notice's **first** sentence stays
  true for it. Each notice's **second** sentence ("each … would usually
  start a new paragraph") is a calibration claim, not construction (AC6
  M-6). At that resumption, the `. — Б` place would not start a new
  paragraph in standard typography, which the parser calls "the single-tag
  continuation case" (`parser.ts:45-48`). "Usually" is what covers it. "A line
  of dialogue" names the mid-paragraph dash by its ru convention (it opens
  direct speech, or resumes it), not by the regex: a hyphen used as a dash
  before a capital (`1999 г. - Москва`) matches too. That is rare in prose,
  and it sits under the provisional label with the rest of the
  calibration. By **calibration**, not
  construction: that such a paragraph is merged dialogue. The legibility
  design says so itself ("false positives are sparse and merges are dense …
  the property the whole design now rests on", #2267 §2.1). Russian
  typography does allow several speakers' replies with no author's words to
  share one paragraph, so **both** notices say each such place would
  **usually** start its own paragraph. Without "usually", B's sentence would
  assert that typography as a rule.
- **The threshold is provisional** (owner decision 3, 2026-11-15). It is
  calibrated on one real clean ru book plus the authored fixtures. The
  library-wide false-positive scan is step 1 of the owner-run register row
  (§4.4). It is **not** a merge gate for any UI phase: per CLAUDE.md,
  owed acceptance converts into a row. A breach on a book the owner judges
  clean **on its imported text** (owner decision 6) is recorded on the row,
  and the threshold decision it forces goes to the owner. **The label is
  dropped only when step 1 finds both** no breach in any scanned book,
  line-wrapped or not, **and** at least one clean, dialogue-dense ru dash
  book (owner decisions 13, 15 and 17, R7-5). A wrap can only lower a book's
  counts, so a breach in a line-wrapped book is at least as strong as
  anyone's. Without such a book the threshold stays
  provisional indefinitely, however many other books the scan holds, and
  the regression plan says so in those words. An English book, a ru book
  whose dialogue is «» quoted, or a sparse ru dash book cannot breach, so a
  scan of them holds no evidence about the threshold.
- **The expected outcome, said plainly** (AC8's value verdict). The owner's
  library, step 1's input, holds a **clean** paragraph at **12** openers:
  one speaker's monologue broken by the author's words, in a Russian-language
  novel. Step 1 will very likely record it as a breach. The threshold then
  stays provisional, the threshold decision goes to the owner, and the
  notice will fire on that clean book. That is the designed path, not a
  defect.
- **Formats the measure under-reads.** The measure splits on `\n`, so any
  imported text that is line-wrapped makes every visual line its own
  paragraph, and a merge reads low. That costs false negatives (a silent
  notice), never false positives. It also means a line-wrapped book can be
  the clean calibration book only when the count arm alone flags it, a few
  stray breaks, and the fail-closed check of §4.4 step 1 passes (owner
  decisions 15 and 17). A genuinely hard-wrapped book never can. It happens
  in every format:
  - a PDF, always;
  - a hard-wrapped TXT or Markdown file, which `parseText` does not reflow;
  - an EPUB or MOBI whose XHTML wraps the text inside its paragraphs.
    `stripHtml` turns `</p>`, `<br>` and `<hr>` into breaks but keeps any
    raw newline inside a `<p>` (`html-utils.ts:79-98`), and the EPUB path
    adds no whitespace fold (`epub.ts:162`). That extractor behaviour
    belongs with #4217 (F4), whose fix shifts stored offsets, so it is not
    changed here.

  The scanner therefore tests every format's imported text for line wrap
  (R7-6), and checks a count-arm book's stray breaks (owner decision 17).
- **What a false positive costs:** a Heads-up box suggesting a cleaner copy
  of a book that did not need one. There is no blocking, no data change and
  no analysis change. That is why shipping a provisional threshold is
  acceptable.
- **Excluded chapters** are never counted or named.

## 3 · Surfacing options (blocker 2)

### 3.1 Option A: import-time notice on the confirm view

**Data path:**

1. `server/src/routes/import.ts`: language detection at `:119`, candidate
   builder from `:145` (chapters mapped at `:159`). When `detected.language`
   is in `NOTICE_LANGUAGES`, add **one** optional field to each
   `candidate.chapters[]` item: `paragraphsMerged?: true`. It is omitted
   otherwise, and there is no count field.
2. Types, in two places:
   - `openapi.yaml` `ImportCandidate` (`:7227`), its `chapters.items`, then
     `npm run openapi:types`, which keeps the contract in step;
   - **hand-edit** `src/lib/types.ts:199` `ImportCandidate`, which is
     hand-written and is the type the client uses: add
     `paragraphsMerged?: boolean` to the `chapters` element type.

   The client already holds `candidate`, so there is no new slice.
3. `src/views/confirm-metadata.tsx`: reuse the amber **"Heads-up:"** box
   markup of `duplicatePositionBook` (`:275-282`).
   - Shown when at least one non-excluded chapter has `paragraphsMerged`
     **and** the form's currently selected language is in the client mirror of
     `NOTICE_LANGUAGES` (R3-5). A ru-detected book overridden to another
     language hides the box, matching what B will do after save.
   - **The stated gap:** an en-detected book overridden to ru shows no A
     notice, because A only measures what detection called ru. B shows the
     caption after save. This is accepted, because detection is wrong in that
     case and B covers it.
   - Names up to three chapter titles, then "and N more".
4. **Client mirror of `NOTICE_LANGUAGES`:** one exported constant in
   `src/lib/` with a comment naming `legibility.ts` as its source of truth.
   This is the same precedent as item 5.
5. **Mock mirror (M):** `mockImportManuscript` (`src/lib/api.ts:890`). It
   already mirrors server heuristics (Cyrillic ratio ≥ 30% → `ru`, and the
   series-from-title parenthetical). It sets `paragraphsMerged` when the
   ru-detected chapter has a single paragraph holding ≥ 10 `[.!?…:] — Upper`
   openers. A comment names `MERGED_TURNS_DEGRADED` as its source of truth.
   The mock always returns **one** chapter (`:934`), so e2e cannot exercise
   the three-title cap. The component test pins it.

**Wording** (claims only what the measure counts, owner decision 9; final
pass through `castwright-voice`, which may rephrase but must keep "a
paragraph", "ten or more", "places", "mid-paragraph", "imported text" and
"usually", must not turn places into lines, and must not name a cause,
R6-10):

> **Heads-up:** in 5 chapters (Chapter 4, Chapter 5, Chapter 6 and 2 more),
> the imported text has a paragraph with ten or more places where a line of
> dialogue begins mid-paragraph. Each of those places would usually start a
> new paragraph. A different copy or format of this book may give a better
> result.

"Ten or more places where a line of dialogue begins mid-paragraph" is the
plain-words reading of "ten or more sentence-end + dash + capital openers in
one paragraph", the one thing the measure counts (§2). It counts places, not
lines, so a same-speaker resumption keeps the first sentence true. The second
sentence is a calibration claim, hedged by "usually" (§2, AC6 M-6); R6-10's
"true by construction" holds for the first sentence only. The wording asserts no
share of the chapter, no speaker change and no cause. That keeps it true when
Castwright's own extractor did the merge (F4, #4217).

**Mobile/touch:**
- Static text, nothing interactive, so no 44 px obligations.
- At 375 px the box (`-mt-2 px-4 py-2.5 text-xs` padding, three titles) runs
  to about **9–10 lines** (revision 6 drops revision 5's cause sentence).
  That is acceptable inside the scrolling confirm
  form, and the three-title cap keeps it there.

**Tests:**
- route test: merged ru → flag; clean ru → no flag; es and en → no field;
- `confirm-metadata.test.tsx`: shown; hidden after an override to a
  non-notice language; hidden when only excluded chapters are affected; the
  "and N more" cap;
- **e2e `e2e/responsive/paragraph-structure-notice.spec.ts`.** Under
  `responsive/`, the `mobile-chrome` and `tablet-chrome` projects
  (`playwright.config.ts:123-132`) pick it up at release time
  (`test:e2e:mobile`). PR CI runs the chromium project only (`verify.yml`
  `npm run test:e2e`), so the spec **also** has a chromium case at a
  375 × 812 viewport. That case is the PR-time phone-width check. No
  `coverage.spec.ts` case is added, because that file is one case per new
  *view* and this is not one.

**Blast radius:**
- One regex pass per chapter over text already in memory.
- One additive optional wire field.
- No persistence, no lock.

### 3.2 Option B: per-chapter caption in the manuscript view (source claim)

**Data path:**

1. `server/src/routes/book-state.ts` `GET /state`. It already calls
   `getOrHydrateManuscript(state.manuscriptId)` (`:843`).
   - Language comes from `bookStateLanguageOrNull(state)`
     (`workspace/scan.ts:403`). The display variant must not be used,
     because an unset language has to mean "not measured".
   - For each chapter of a `NOTICE_LANGUAGES` book, compute
     `isParagraphDegraded(body, language)` on the hydrated body. There is no
     recovery, no name index and no cast (Decision 2).
   - Emit `paragraphsMergedChapters?: number[]` (chapter ids). **Omit the
     key** when the hydrated record is missing, the language is null or out of
     scope, no non-excluded chapter is flagged, or the record has
     `hintsSource: 'parse'` and fails
     `assertHintsPairWithState(state, record.chapterHints, record.parseTitles)`
     (`workspace/restructure.ts:787`, R4-7 as amended by R5-7). That one call
     checks count and ids **and**, given `parseTitles`, the positional title
     test `parseTitlesPairWithState` (`:761`), which is how #3837's
     restructure route judges the same hazard. The title test catches a
     same-count mispairing (a merge plus a split, then a lost or stale hints
     file), which `hintsFromParse` hides by re-titling from `state.json`
     (`store/manuscripts.ts:78-86`). **Residual, stated:** `titlePairsAt`
     (`:771`) passes a position whose parse title was synthesized
     (`Chapter N`, stored as `null`) or whose state title the user
     overrode, so a mispairing confined to such positions still emits.
   - **How the pairing check is called (R6-8).** `assertHintsPairWithState`
     returns `void` and throws `HintsOutOfSyncError` (`:787-796`), so B wraps
     the call in a `try`/`catch` that catches that class only and omits the
     key. It runs on **every request**, after the memo lookup, and is never
     memoised: its result depends on the current state's titles and
     `titleOverridden` (`:775`), which a rename or a title override changes
     without replacing the hydrated record.
   - **Memoised per hydrated record:** a module-level
     `WeakMap<ManuscriptRecord, { language: string; ids: number[] }>`. The
     cached `ids` are **unfiltered** (every chapter the record holds).
     Exclusion is applied per request from the current state, so the memo's
     correctness does not depend on the exclude toggle replacing the record
     (it does today, `book-state.ts:2392-2399`). The pairing check above is
     likewise per request. `getOrHydrateManuscript`
     returns the same object until a put or remove replaces it
     (`store/manuscripts.ts:107-128`), so a replaced record recomputes and the
     old entry is garbage-collected. A request whose language differs from
     the cached one recomputes, so a language change takes effect without a
     re-hydrate. The cost is one regex pass over the book per hydration, not
     per request.
   - Derived read only: nothing is written, so there is no `state.json`
     schema bump and no lock involvement.
2. Types: `openapi.yaml` `BookStateResponse` (`:10214`) plus
   `npm run openapi:types`. **Also hand-edit** `src/lib/types.ts:455`
   `BookStateResponse` (hand-written), and the **mock `/state`** builder in
   `src/lib/api.ts`, so e2e can seed a flagged chapter.
3. Hydrate in `src/store/chapters-slice.ts`, beside `chapterCharacters`
   (`:358`).
4. `src/views/manuscript.tsx` chapter header (the
   `manuscript-restructuring-banner` block, `:1157`): one
   `basis-full text-xs text-ink/60` line with the banner's markup.

**Wording** (same claim as A, including "usually"; final pass through
`castwright-voice` under the same constraints):

> In the imported text, this chapter has a paragraph with ten or more places
> where a line of dialogue begins mid-paragraph. Each would usually start its
> own paragraph.

As in A, the first sentence is true by construction and the second is the
calibration claim that "usually" hedges (§2).

**Mobile/touch:** a wrapping, non-interactive caption. There is no
hover-only content (touch-equivalence rule).

**Tests:**
- route test: merged ru → id listed; English, null language and missing
  record → key absent; excluded chapters omitted, **including after an
  exclude toggle on the same cached record** (the filter is per request);
  `parse`-hinted chapter-count mismatch → key absent; `parse`-hinted
  same-count record whose parse titles don't pair → key absent; that same
  **cached** record after `state.json` alone changes so the titles pair (the
  mismatched chapter's `titleOverridden` set) → key present on the next
  request, and back again (the check is per request); **two requests on one
  record compute once** (a spy on `isParagraphDegraded`); a replaced record
  recomputes;
- slice test;
- `manuscript.test.tsx`;
- e2e case in the same `responsive/` spec, including its 375 px chromium
  case: navigate ch1 → ch2 → ch1 against the mock `/state`.

**Blast radius:** one memoised regex pass per hydration on the hottest read
route. No recovery runs on it.

### 3.3 Option C: log only

Promote the stdout `merged=` line to the phase log. It is transient and shows
mid-run. **Not recommended** as the deliverable.

## 4 · Blocker 1: what degradation costs the final output

### 4.1 Split the question

| Part | Question | Model? | Settled by |
|---|---|---|---|
| **1A** | With the model's raw take held fixed, does recovery change **post-crossExamine** speakers, and for the better? | No for the counts (two engine replays over one live raw take, R4-1); one live capture per chapter | committed test (§4.2) + Ночной дозор counts and hand-check (§4.4 step 2) |
| **Class report** | In merged text, **where do the engine's confident decisions sit?** The #2253 harm class: unflagged, high-confidence speakers, counted by class and reason (owner decisions 5, 8 and 14). A plain report: no verdict, no hand-check | Yes (the same capture) | Ночной дозор counts (§4.4 step 2) |

**Not measured here.** Revision 5's 1B (does merging degrade the model's raw
attribution?) and its twin half of 1C needed a clean/merged twin (owner
decision 10). Revision 7's 1C (are the confident decisions right?) is
dropped (owner decision 14). A merge-cost number for clean books is out of
scope (§5). 1A and the class report describe **one** merged book, *Ночной
дозор*, as it is in the library. They say what recovery does to it and where
its confident output sits; they do not say whether that output is right,
or what merging costs a book that was clean.

**Stated limits:**
- **1A stops at crossExamine** (AC3 M6). Escalation needs a model, and only
  a live run escalates. How much escalation compensates for recovery-off
  flags is therefore not measured. Escalation's own effect within the live
  capture (`final` vs `deterministic`) is reported.
- **Script review** (channel 3 in §1.2) is out of 1A's scope. It is an
  opt-in, later pass with its own model call, and attributing its effect to
  recovery would need a second A/B run. The harness's `review` option exists
  if a later round wants that.

### 4.2 1A as a committed regression test

Add arms to `analysis.structure-fixture.test.ts`. The merged body is
`MERGED_NARRATION_BODY`, derived in the test from the committed ru-dash scene,
so no new fixture file is needed. The file already sets
`STAGE2_COVERAGE_RETRIES=0` for its body-blind mocks, and the new arms inherit
that.

- **Arm 1, wrong in-roster speaker.** The mock returns an **in-roster,
  non-narrator** wrong id on a recovered, name-tagged turn. The
  "kept and flagged" path exists only for that shape (`cross-examine.ts`
  roster check).
  - recovery on: `corrected` to the tag speaker at `TAG_CORRECT` (0.9);
  - recovery off: the wrong id is kept and flagged below 0.75 (#2253).
- **Arm 2, wrong `narrator`.** The mock returns `narrator` on the same turn.
  - recovery on: `corrected` to the tag speaker;
  - recovery off: **expected** `narration-confirm` at 0.95, unflagged
    (`cross-examine.ts:274`). Off, the turn is an **unsplit dash turn inside
    a narration-open paragraph**, which is class (b) of the
    confident-decision report (§4.3).
  - The implementer runs the arm first and pins what it observes. If the
    off outcome is not confident-wrong, that is reported back to the design
    thread before the test is committed, not edited to pass.

**Seam (Phase 5).** Extract exactly the evidence-and-crossExamine body of the
engine branch (`analysis.ts:3714-3727`: `buildNameIndex` →
`parseChapterStructure` → `findFirstPersonCharacter` → `resolveWindows` →
`alignSentences` → `rosterIds` → `crossExamine`) into an exported:

```
runStructureEngine({ sentences, body, stage1, conventions, structureOptions? })
  → { examined, paras, alignment, rosterIds }
```

- `stage1` is the **already-deduplicated** roster
  (`analysis.ts:3632-3638`); `conventions` is the non-null value the caller
  already resolved; `structureOptions?: ParseChapterOptions` reaches the
  `parseChapterStructure` call. That internal parameter is not a setting.
  It is also threaded through `attributeChapterStage2`'s own opts for the
  arms above.
- **What stays in `attributeChapterStage2`, unchanged:** the
  `analyzer.structure.enabled && conventions` gate (`:3712-3713`),
  `result.sentences = examined.sentences` (`:3728`; the extracted function
  has no `result`, so this assignment stays in the caller and consumes the
  returned `examined`), the `detSnapshot` clone right after crossExamine
  (`:3729`), escalation
  (`:3735-3767`, which consumes `examined.sentences`, `examined.flags`,
  `paras` and `rosterIds`), `structureReport` (`:3769`, which reads
  `conventions.language`), the log line, the `applyNarratorDefault`
  else-branch (`:3783-3792`) and `annotateSceneBreaks` (`:3799`).
- **`onStages` gains four fields** (additive; only the harness passes
  `onStages`): `stage1`, the deduplicated roster the engine used; and, in the
  engine branch only, `paras`, `alignment` and `flags` (R6-4), cloned when
  crossExamine returns: at `:3729`, beside `detSnapshot`, **before**
  escalation. The clone point matters for `flags`. Escalation splices
  `examined.flags` in place for every line it fills
  (`escalation.ts:282-296`), and `onStages` fires only after escalation and
  `annotateSceneBreaks` (`analysis.ts:3800-3806`), so a clone taken there
  would read a list escalation has already edited (AC6 M-4). `flags` is `examined.flags`
  (`Array<{ index, reason }>`, `cross-examine.ts:47`, filled at `:392`), the
  only per-sentence flag marker: a `reasons` entry's `bucket` is not the flag
  (`alt-correct-flag` and `narration-demote:first` are bucket `corrected` and
  flagged, `:166`, `:278-284`). That is what §4.3's replay and classification
  need without re-deriving anything.
- **Zero-behaviour-change proof.** Before the extraction, and before the
  `onStages` additions, the Phase-5 agent commits a characterisation test
  that records `attributeChapterStage2`'s `sentences`, `structureReport` and
  the **pre-existing** `onStages` fields (`raw`, `deterministic`, `reasons`)
  for five inputs:
  - engine on;
  - `flagOnly` (alignment below the 80% floor);
  - knob off;
  - a language with no conventions;
  - engine on with escalation **filling a line**: a mock escalation reply
    assigns a roster id to one flagged, fill-eligible line with no tag-name
    span, so `escalateFlaggedWindows` applies it (`escalation.ts:277-296`).

  The comparison is deep equality (`toEqual`), not byte identity. It keeps
  comparing only those fields after the four new fields land, so the
  additions cannot fail it. A separate assertion in the same file pins the
  new fields:
  - `stage1` in all five inputs, equal to the deduplicated roster;
  - `paras`, `alignment` and `flags` for the three engine-branch inputs,
    absent for knob-off and no-conventions;
  - `flags` equal to `examined.flags` as crossExamine returned it.

  On the escalation-fill input, `onStages.flags` must still hold the filled
  line's index, while the returned sentence carries the escalated id. A clone
  taken when `onStages` fires would lack that index and fail. The existing
  tests stay green.

### 4.3 The measuring instruments

**Raw source: live capture through plan 265's harness** (owner decision 1,
2026-11-15). There is no cache read anywhere in this design.

- `evalFixture` (`attribution-eval/run-eval.ts:168`) already calls
  `attributeChapterStage2` live with `onStages` (`:196-205`), and `onStages`
  delivers:
  - `raw`, cloned before the engine runs (`analysis.ts:3698`);
  - `deterministic`, after crossExamine and before escalation (`:3729`);
  - `reasons`, aligned 1:1 to `deterministic`;
  - and, after Phase 5, `stage1`, `paras`, `alignment` and `flags`.

  The return value is the final, post-escalation take. Escalation changes ids
  on flagged lines in place and never the sentence count, so `final[i]`,
  `deterministic[i]` and `reasons[i]` describe the same sentence.
- **Phase 7 extracts, it does not copy.** It pulls the body of `evalFixture`
  up to and including the `attributeChapterStage2` call into an exported
  `captureChapterStages(opts) → { raw, deterministic, final, reasons, flags,
  stage1, paras, alignment, structureReport, chunks }`. `evalFixture` calls
  it, and its scoring stays byte-identical (`run-eval.test.ts` stays green).
  `captureChapterStages` takes a plain `chapterText` and roster, so no
  `LabelledChapter` truth is needed. It also takes an optional
  `structureOptions`, an explicit `capacity`, and an optional shared
  `structureBudget` (below).
- **Roster:** pinned for the book, built with `buildRosterSnapshot`
  (`attribution-eval/capture.ts:63`) from the library book's `cast.json`.
  This is plan 265's own roster-pinning, which prevents id drift between
  chapters.

**Harness vs production** (AC3 M3). Each difference is matched or stated:

| Aspect | Production (`analysis.ts:7633-7646`) | Harness today | This design |
|---|---|---|---|
| Chunk capacity | `resolveCapacity({ engine, model })` of the active analyzer | Gemini's unless `engine === 'qwen'` (`run-eval.ts:191-194`) | **Matched.** The runner resolves `capacity` from the owner's actual engine and model and passes it in |
| Model | the owner's configured analyzer | `qwen3.5:9b` unless `EVAL_QWEN_MODEL` is set (`run-eval-cli.ts:91`) | **Matched.** The runner takes a required `--model` with no default, and the run sheet records it |
| Escalation budget | one `structureBudget` per **book**, shared across chapters (`:7645`, `maxWindowsPerBook`) | none, so each chapter gets a fresh per-book default (`:3744-3746`) | **Matched.** The runner passes one shared budget object across the book's captured chapters |
| Dedup constraints | plan 291's `planConstraints` for a plan-applied roster; `undefined` for a first analysis's rolling roster (`:7642`) | none | **Stated.** The harness has no plan, so it passes none, which is production's first-analysis shape |
| Roster roles | `cast.json` roles | `rosterToStage1` sets every role to `'character'` (`run-eval.ts:85-97`) | **Stated.** Kept, because changing it would change `evalFixture` scoring |
| Eval-rate wrapper | `attributeChapterStage2WithEval` (`:3904-3918`) | direct call | **Stated.** It only folds sub-calls into one eval-rate record; no attribution effect |
| Coverage guard | on | on | Same. The `STAGE2_COVERAGE_RETRIES=0` fixture trick is for body-blind mocks and is **not** used here |
| Escalation mode | owner default `'local'` (`registry.ts:1323-1331`) | config | Same; the prerequisites pin it |

Absolute shares are therefore the harness's. 1A compares two replays of one
capture, so none of these differences enters it.

- **Chunking (the 9000-char note).** Stage 2 splits a chapter over
  `analyzer.stage2.chunkCharBudget` (default 9000, lower for local engines:
  `max(1000, min(0.3 × num_ctx × 2, 9000))`, `registry.ts:123-140`) at
  blank-line boundaries only (`stage2-chunk.ts:142` `splitBodyIntoChunks`,
  which is lossless). A merged paragraph is never split and becomes its own
  chunk, and the sentence-split fallback applies if it truncates
  (`stage2-chunk.ts:196` `splitParagraphIntoSentences`). That is part of what
  a merged book costs in production, so it is **reported**:
  `captureChapterStages` threads counters through `attributeChapterStage2`'s
  `onChunk`, `onCoverageRetry`, `onCoverageExhausted` and
  `onDeterministicSplit` callbacks (`analysis.ts:3584-3594`) and returns them
  as `chunks`, and the report states chunk count, coverage retries and
  deterministic splits per chapter.

**1A engine replay (R4-1):** for each captured chapter, the runner calls
`runStructureEngine` three times over the **same** captured `raw`, with the
captured deduplicated `stage1` and the chapter's conventions:
1. **control**, recovery on. It must deep-equal the live `deterministic`
   snapshot. If not, that chapter's 1A is reported **void**, with the first
   differing sentence. One void chapter blocks the 1A verdict and the
   discharge (R7-7, §4.4 "How blocker 1 closes");
2. **on**, recovery on (the control's output, reused);
3. **off**, `{ recoverMidParagraphTurns: false }`.

1A compares **on** with **off**, two outputs of one code path. Both share
one sentence list (one `raw`), so they pair **per model sentence** by index.
No analyzer and no coverage guard are involved.

**Turn sentences (R4-4, R5-6).** A model sentence is a **turn sentence** when
its text matches the language's `conventions.dialogueOpen` (ru:
`^\s*DASH\s*`, whitespace optional, `lang/ru.ts:22`, the test the parser and
#2253's rescue use) or contains a `TURN_IN_PARAGRAPH` match. This is decided
from the text, so it includes the hidden turns that sit inside a narration
span and add no speech span to any span set (AC3 S4).

**The confident-decision report (owner decisions 5, 8 and 14).** A sentence
`i` of the live capture counts when all of these hold:
- it is a turn sentence;
- its `deterministic` confidence is ≥ 0.9 and `i` is **not** in `flags`
  (R5-3, R6-4). At `25c65c0a` that is exactly five reasons, all unflagged:
  `tag-confirm:<id>` (0.95, `cross-examine.ts:130`), `tag-correct:<id>`
  (0.9, `:144`), `tag-span-narrator` (0.9, `:261`), `narration-confirm`
  (0.95, `:274`) and `narration-demote` (0.9, `:286`). The last two differ in
  a way that matters: `narration-confirm` is the **model** saying narrator,
  while `narration-demote` is the **engine** overriding the model to
  narrator, the #2253 rewrite itself. It still happens in merged text
  wherever #2253's rescue (`isConventionRescue`, `:236-239`) does not fire: a
  model sentence that merged narration with a turn (`Антон обернулся. — Ты
  кто?`), or a dash line the model gave to `unknown-male`/`unknown-female`.
  From the second sentence of such a run on, the result is
  `narration-demote` at 0.9, unflagged (`:276-286`; the run's first sentence
  is `narration-demote:first`, flagged at ≤ 0.5). The measurement checks
  every passing decision's reason against these five (prefix match for the
  two `:<id>` forms, exact for the rest) and **fails** on any other, so a
  reason added later gets a class decision instead of a silent default. It
  fails after the capture is saved (R6-5), so the fix costs no model time;
- its `final` id equals its `deterministic` id, so escalation left the
  engine's decision standing. For these five reasons the conjunct is vacuous
  today, because escalation rewrites only flagged lines
  (`escalation.ts:277-296`, AC4 M-b). It stays as a guard against that
  changing.

Each counted sentence is then **classified**, in this order of precedence
(R6-6); a sentence takes the first class it meets. **Lines** (R7-8, AC6
M-8): the aligner attaches a sentence to every span it overlaps
(`aligner.ts:598`), so a model sentence that runs across an imported line
break can touch two lines. A **recovered line** is a line of the
recovery-on parse whose start offset is not a line start in the
recovery-off parse of the same body. That is exact, because recovery is
length-preserving (§1.2). A sentence's **line**, in either parse, is the
line holding the start offset of the first span it aligns to. Offsets are
shared by both parses, so that one offset names a line in each. An unaligned
sentence has no line and is (d). (a) and (b) read the recovery-on parse,
and (c) reads the recovery-off parse, the imported text's own paragraphs.
- **(a) recovery-split line:** any span the sentence aligns to lies on a
  recovered line. This is tag anchoring across a split-out line
  (`parser.ts:74-78`), scored `tag-correct`/`tag-confirm`;
- **(b) unsplit dash turn:** a turn sentence aligned only to `narration`
  spans in a narration-open paragraph, which recovery left unsplit
  (`parser.ts:717-729`), scored `narration-confirm` (the model said
  narrator) or `narration-demote` (the engine overrode the model);
- **(c) degraded dash-open paragraph:** the sentence's line **in the
  recovery-off parse** (the imported text's own paragraph) matches
  `dialogueOpen` **and** holds ≥ `MERGED_TURNS_DEGRADED` `TURN_IN_PARAGRAPH`
  matches (owner decision 8). Tags anchor across the merged speech there
  (`parser.ts:171`). Recovery never splits a paragraph that opens with a dash
  (`paragraph-recovery.ts:100`), so a sentence that sits on one line cannot
  meet both (a) and (c). A sentence that crosses a line break can meet both,
  and the precedence puts it in (a). The threshold is what keeps an ordinary
  dash paragraph out: `— Привет, — сказал Антон. — Как дела?` has one match
  (`. — Как`), a same-speaker resumption that is standard Russian typography
  (`parser.ts:47-48`), and is (d);
- **(d) other:** anything else, reported so nothing is dropped.
  `tag-span-narrator` (a sentence aligned only to tag spans) lands in (a),
  (c) or (d) by where it sits; it is never (b), which needs narration spans.

Every class is reported **by reason** as well as in total, so
`narration-demote` and `narration-confirm` in class (b) are never summed out
of sight. The report is counts only: nothing in it is judged, and no rule
reads it (owner decision 14). 1A's changed sentences are classified by the
same rule, with the same parses: (a) and (b) on the recovery-on parse, and
(c) on the recovery-off parse.

The runner's unit tests include one fixture per class (a), (b) and (c), with a
mock analyzer and a tag that anchors following speech to the wrong speaker,
and the counter must place each in its class. Further fixtures check: a
`tag-correct:<id>` reason is matched by prefix; a `narration-demote` run in
an unrescued narration-open paragraph is counted in (b); an ordinary
dash paragraph with one resumption is **not** (c); a recovered line whose
own text is dash-open with ≥ 10 openers is (a), not (c); a sentence that
crosses a line break, touching a recovered line and a degraded dash-open
line, is (a); an unaligned sentence is (d); a sentence whose index is in
`flags` is not counted; and an unknown confident reason fails the
measurement while the saved capture survives it.

- **The #2254 runner** (Phase 7): a committed, read-only server-side script,
  `server/scripts/paragraph-degradation-ab.mts`. It reads a manifest of
  `{ chapterId, chapterTextPath, rosterPath }`, calls
  `captureChapterStages` per chapter and **saves each capture** (every field
  `captureChapterStages` returns) to the scratch directory as soon as it
  returns, before any check runs (R6-5). Each saved capture also records the
  shared escalation budget's `remainingWindows` after that chapter (R7-10).
  It then runs the 1A replays and the measurement from the saved files, and
  writes one JSON report plus a Markdown table. Its other modes:
  - `--from-captures` skips the capture and measures saved files only, with
    no model;
  - `--resume` continues a capture that died mid-run, such as on an OOM or a
    contended GPU. It keeps every chapter that has a saved capture, restores
    the budget from the last one, and captures again only the chapter that
    died, from its start, discarding that chapter's partial work. Each
    chapter is still one live capture;
  - it writes 1A's hand-check (§4.4) as a **blind sheet**: per item, the
    sentence's text and its line **in the recovery-off parse** (the
    imported text, the same for both arms), with the line either side, and
    no speaker from either arm or from the engine. The sentence is marked
    inside its line with `⟦ ⟧`, at the offsets of the spans it aligns to.
    A merged line can run to 11,000–13,000 characters in the likely pick
    (AC8 M-6), so a line longer than 1,200 characters is shown as a window
    of 400 characters either side of the sentence, with `…` at each cut
    and the sentence's character offset (R9-4). An unaligned sentence has
    no line (R7-8), so the sheet shows its text alone and says so.
    `--score <sheet>` reads the
    filled sheet and derives each judgement (R7-11, R8-3). It first checks
    every judged value against the pinned roster: anything that is not a
    roster id, `narrator`, *can't tell* or *two speakers* fails the run,
    naming each such item, and no score is written until the sheet is
    fixed. A typo therefore cannot score silently as neutral (R9-4).

  It captures one chapter at a time (R7-9). After each capture it prints the
  chapter's alignment (`structureReport.alignedPct`) and `flagOnly`, the
  fields crossExamine sets when alignment is below the 80% floor
  (`cross-examine.ts:350`), and it settles the pick from them (§4.4 step 2,
  owner decisions 16, 18 and 19). Like plan 265's runner it never
  runs in `test:all`, and its inputs (real books) are never committed.

### 4.4 On-box procedure (new Group B register row, ID allocated at implementation; owner-run)

**Prerequisites:**
- local Ollama on the owner's default analysis model, passed to the runner
  as `--model` and recorded;
- `analyzer.structure.enabled = true`, `allowCloudFallback: false`,
  escalation at the owner's default;
- the owner's library (Calibre and the workspace) on the box;
- no re-imports of library books: the scanner and the runner read text and a
  pinned roster and write only their reports, captures and text dumps, to a
  scratch directory outside the workspace. They read the workspace without
  the scan's self-heal, so nothing under it is written (R7-10, step 2).

**Gate before step 2:** #4165 has merged (met: closed 2026-11-15, on `main`
since `1e295990`). The run notes the build it ran on.

1. **Library legibility scan (the false-positive check).**
   - Run the Phase-7 scanner over the owner's library directory. It parses
     every file with `parseManuscript`, the import path, so what it measures
     is the **imported text** (owner decision 6). Formats: EPUB, MOBI, PDF,
     Markdown and plain text (`parsers/index.ts`).
   - **Each file is parsed in isolation** (R9-1, AC8 M-2). One EPUB in the
     owner's library kills its host process: epub2 throws `TypeError:
     linkparts.shift is not a function` on an empty `href=""`, from a zip
     callback that no `await` or `try` can reach. So the scanner parses each
     file in its own child process with a time limit. A file whose parse
     throws, whose child dies, or which runs out of time is reported
     **unparsed**, with its error's first line, and the scan goes on. The
     summary lists every unparsed file and their count; an unparsed file
     neither blocks nor supports the label (R9-1). The import-path crash is
     #4239, fixed separately by PR #4241, which moves the EPUB read to
     epub2's `getChapterRaw`. Other epub2 callbacks can still throw (#4242,
     the systemic question), so the isolation stays whatever #4241 does.
   - Per book it reports: format; detected and declared language; per
     chapter, legibility (the maximum), `countTurnOpeners` (the sum) and
     dash-opening paragraph counts (paragraphs matching `dialogueOpen`,
     R5-6); the book maximum; and three flags:
     - **line-wrapped** (R7-6, replacing R5-9 and R6-7): every PDF, and a
       book of any other format whose imported chapter bodies have
       **continuation lines** making up ≥ **2%** of their non-blank lines,
       **or** numbering ≥ **10**. The other formats are EPUB, MOBI, Markdown
       and plain text (owner decision 13).
       - **The test.** A continuation line directly follows another
         non-blank line (a single `\n`) and starts with a lowercase letter
         (`\p{Ll}`): a hard wrap breaks lines mid-sentence, while a
         one-paragraph-per-line file starts each line with a capital or a
         dash. It reads the imported text, so it covers a hard-wrapped TXT
         or Markdown file and an EPUB or MOBI that wraps inside a `<p>` (§2).
       - **Measured** (`wrap-measure-wide.mjs`, `density.mts`). Both
         committed ru fixtures clear 2% at every width from 60 to 400
         columns that splits a paragraph (the ru-dash fixture's narrowest
         margin is 4.3% at 200 columns, which revision 6's 5% cut missed),
         and score 0% unwrapped. *Ночной дозор* has 0 continuation lines in
         3,333, and *Дневной дозор* 0 in 2,426. That second figure is
         **confirmed**: the book is in the owner's Calibre library, step 1's
         input, and AC8 reproduced it exactly (AC8 M-9).
       - **The limit, stated.** A wrap that splits fewer than 10 lines, and
         under 2% of a book, escapes the test. If those lines are the book's
         few longest paragraphs, the measure under-reads exactly the
         paragraphs that could breach. The scanner prints each book's
         continuation count and share, so the owner sees the margin.
     - **stray breaks** (owner decision 17, replacing R8-1). Which
       line-wrapped books may still be the calibration book:
       - **Disqualified outright:** every PDF, and every book the **share
         arm** flags (continuation lines ≥ 2% of its non-blank lines). Such
         a book is genuinely hard-wrapped.
       - **Checked:** a book the **count arm alone** flags (≥ 10
         continuation lines, under 2%), a handful of stray print-conversion
         breaks. It stays a candidate only when **both** of these hold for
         every continuation line, and is disqualified otherwise:
         - **isolation:** the line is a stray break, not part of a wrapped
           run. The lines directly before and after its fragment (the line
           it continues plus every continuation line directly after it) are
           not continuation lines, and no other continuation line sits
           within two lines of the fragment;
         - **neighbour window:** the line before the fragment, the
           fragment, and the line after it, joined with one space, hold
           fewer than 10 `TURN_IN_PARAGRAPH` matches. Joining with a space
           restores any match a break destroyed at those two boundaries
           (`. — Да` broken before the dash), which the fragment alone
           cannot see.
       - **Why it fails closed.** The re-join of a fragment is only a
         **lower bound** (AC8 M-1). A wrap destroys a match only by
         breaking before a dash or a capital, and a line that starts with
         either is never a continuation line, so re-joining continuation
         lines never restores it. AC8 folded the dash runs of two clean ru
         story collections into the paragraph before them, giving 101
         paragraphs that truly hold 10–19 openers, and hard-wrapped them
         (`rejoin-para.mts`). At 80 columns the re-join reaches 10 for only
         7 of the 58 at 10–12 openers (8 of 30 at 13–15, 2 of 13 at 16–19);
         at 200 columns, for 20 of 58, 13 of 30 and 9 of 13. On the
         library's real clean 12-opener paragraph, its re-joined maximum is
         4 to 7 at widths from 60 to 200 columns (`wrap-one.mts`). So the re-join never
         certifies a hard-wrapped book; only a book the check positively
         shows to hold stray breaks stays in. What the check cannot see is
         a break before a capital or a dash with no continuation line near
         it. That residual is the same one every unflagged book carries,
         R7-6's stated limit, and the check admits nothing beyond it.
       - The scanner prints, per line-wrapped book, which arm flagged it
         and, for a count-arm book, its isolation result and its largest
         neighbour window. A line-wrapped book's breaches still count (§2),
         so the only cost of disqualifying one is losing a calibration book.
       - **Measured on the box** (AC7's `cont-lines.mts`, AC8's
         `rejoin.mts` and `libscan.mts`). A clean ru dash-dialogue story
         collection outside the workspace (about 151k words) has 14
         continuation lines in 5,420 (0.26%), from print-conversion breaks.
         The count arm alone flags it, no two splits are adjacent, and its
         largest re-joined fragment holds 4. Whether its neighbour windows
         all stay under 10 is step 1's to report. The calibration book does
         not depend on it: AC8's scan of the part of the library it reached
         found **95** distinct titles that pass the clean, dialogue-dense
         test, **91** of them not line-wrapped at all, so no re-join
         applies. The four that qualified only through R8-1's re-join held
         at most 8 after it, and their continuation lines were stray breaks,
         verse or epigraphs;
     - **#4217 exposure** (R4-8, as amended by R5-8). For an EPUB, the
       scanner writes a scratch copy whose XHTML entries have a `<br/>`
       inserted after every block closer `stripHtml` drops (`</div>`,
       `</li>`, `</blockquote>`, `</h1>`–`</h6>`), and runs **that copy**
       through `parseManuscript` as well. Both parses therefore go through
       every EPUB path unchanged: epub2's `getChapter` and the raw-zip body
       (`epub.ts:162`, `:277`), the empty-document drop (`:164`, `:279`) and
       `assembleManuscript` (`:174`, `:303`). The two chapter lists pair by
       position only when they have the same count and the same titles;
       otherwise the book is reported **what-if not aligned** and no chapter
       is labelled. For a paired chapter, the scanner reports the closers
       inserted and the what-if legibility. A flagged chapter whose what-if
       legibility falls below 10 is labelled **extractor-merged (#4217)**.
       MOBI's HTML sits inside a compressed binary, so a MOBI's what-if is
       **not computed**, and that is reported per book. The book list shows
       labelled books first, so the owner can see which books #4217 affects.
       Nothing here changes production extraction (#4217's own design pass).
   - **Dialogue density** (R7-5).
     - Per book, the scanner also reports its **dash turns**: dash-opening
       paragraphs plus `countTurnOpeners`, over every chapter of the
       imported text. It reports them as a total and per 1,000 words.
     - A book is **dialogue-dense** at ≥ **25 dash turns per 1,000 words**
       and ≥ **1,000 dash turns**.
     - A merge moves a turn from the start of a paragraph to its middle, and
       the density counts both, so a merged copy reads about the same as a
       clean one. That is what lets a merged book calibrate it.
     - Calibration (`density.mts`, through `parseManuscript`):
       - *Ночной дозор* reads **36.0** per 1,000 words (3,739 dash turns in
         103,751 words). Its chapters read 26.8–45.5.
       - The committed ru-dash fixture reads 33.7, but holds only 14 dash
         turns by this count (§4.5's 13 turns, plus one dash-opening line
         that is not a turn).
       - `the-coalfall-commission.ru.md` reads 22.5. Its dialogue is mostly
         «» quoted, but it has a dash-dialogue section (`ru.md:63-69`) with
         4 dash-opening paragraphs, which supply much of that figure. The 6
         dash-opening paragraphs counted in all include two `---` Markdown
         rules, one per imported chapter, which `dialogueOpen` matches (AC8
         M-9). So the density counts a dash-led scene rule as a dash turn.
         The skew is accepted: a rule adds one turn, against the hundreds a
         dialogue-dense chapter holds, so it can tip only a book within a
         few tenths of 25 per 1,000 words, and filtering rules would make
         the scanner's predicate differ from the parser's (R5-6).
         The workspace's «» Castwright EPUB (*Заказ Коалфолла*) reads **8.8**
         (AC7 M-6), so a «» book sits well below 25.
       - 25 is Ночной дозор's sparsest chapter (ch7, 26.8) rounded down, and
         1,000 turns is about a quarter of its total.
       - *Дневной дозор* reads 29.4 and is merged (36 paragraphs at ≥ 10),
         so it is no clean candidate. These figures are **confirmed**: AC8
         reproduced them exactly on the copy in the owner's Calibre library
         (AC8 M-9; AC7 had looked only in the workspace).
       - The clean story collection above reads **29.7** per 1,000 words,
         with 4,491 dash turns and a legibility maximum of 4. It qualifies
         only if its count-arm check passes (owner decision 17). It is not
         the only candidate: AC7's "the only clean, dialogue-dense ru dash
         book on the box" was false (AC8 M-9), since 95 titles qualify in
         the part of the library AC8's scan reached.
     - A **clean, dialogue-dense ru dash book** is a book detected or
       declared ru that is dialogue-dense, is parsed, is not a PDF, is
       either not line-wrapped or flagged by the count arm alone and passes
       its stray-break check (owner decision 17, R9-5), and has no chapter
       at ≥ 10 on its imported text. Each such book is listed by title.
   - For every chapter at ≥ 10, the scanner prints the **worst imported
     paragraph** (its first 400 characters and its count), so the owner
     judges the text the notice is about, not the book as a reader renders
     it.
   - The run sheet lists the 26 books from the #2254 corpus comment by title,
     and the owner confirms each was scanned.
   - The owner marks each flagged chapter **merged** or **clean** by reading
     that imported paragraph. A chapter judged clean on its imported text
     (for example, legitimate several-speaker replies in one paragraph) is a
     **breach**. It is recorded with the chapter, its count and its format,
     and the threshold decision goes to the owner. One breach is expected:
     the library's clean 12-opener monologue paragraph (§2, "The expected
     outcome"). An **extractor-merged
     (#4217)** chapter is a **true positive**, not a breach (owner
     decision 6), and is listed as such on the row.
   - `MERGED_TURNS_DEGRADED` loses its provisional label only when **both**
     of these hold (owner decisions 13, 15 and 17, §2):
     - there is no breach in any scanned book, line-wrapped or not;
     - at least one clean, dialogue-dense ru dash book was scanned.

     It loses the label in a follow-up commit that cites this row and names
     that book. Otherwise the label stays, and the run sheet records which
     condition failed. A non-ru Cyrillic book is reported separately
     (Decision 4).
2. **1A and the class report on real data: Ночной дозор.** No fresh whole-book analysis and
   no cache: the 2026-09-05 cache is gone, and nothing reads one.
   - **Text source (AC3 M7, AC6 M-9):** the **hydrated record's** chapter
     bodies, the strings analysis and `GET /state` read, including any
     restructure held in `manuscript-hints.json`. The scanner dumps them
     once (`--dump <bookDir> --chapters <ids>`) to `.txt` in the scratch
     directory, byte for byte.
     - **It does not go through `getOrHydrateManuscript`**
       (`store/manuscripts.ts:140`). That path resolves the book with
       `findBookByManuscriptId` → `findBookBy`, which applies the scan's lazy
       self-heal, `backfillAudioModelKeysFromSegments`
       (`workspace/scan.ts:1126`). The heal writes `state.json` when any
       chapter changes (`persistHealPatches`, `:1347`), and it would write
       from the script's own process, unserialised against a running
       server's in-process locks.
     - **Instead**, Phase 7 extracts the body of `hydrateFromDisk` after its
       book lookup (`store/manuscripts.ts:159-218`) into an exported builder,
       `buildManuscriptRecord(bookDir, state)`. `hydrateFromDisk` calls it
       unchanged. The dump reads `state.json` with
       `readStateJsonWithRecovery` (`workspace/state-migrate.ts:183`), which
       only reads, and then calls the builder. So the dump builds the same
       record analysis does, and writes nothing under the workspace.
     - **A test pins this.** After a dump of a book whose segments files
       the self-heal would have back-filled, that book's `state.json` is
       byte for byte unchanged.

     The runner and the measurement both read that one file per chapter and
     apply **no** normalisation of their own, so the runner chunks and
     parses exactly the string production analysis would (AC5 M-8).
   - **Chapter pick, settled after capture (AC3 S4, owner decisions 16, 18
     and 19, R8-2).**
     - **Candidates.** Every chapter except ch3 (the one clean chapter), in
       descending `countTurnOpeners` (hidden turns). On the EPUB as parsed
       the order starts ch5, ch8, ch6, ch7, ch1. Swaps take the candidates
       in this same order (owner decision 18), not by density.
     - **Capture.** The runner captures the first three candidates live,
       with the pinned roster, one chapter at a time (R7-9). Each capture is
       saved before anything is measured (R6-5), with the escalation budget
       left after it. If a capture dies mid-run, the run continues with
       `--resume`, which captures again only the chapter that died (R7-10).
     - **The floor.** After each capture the runner reports the chapter's
       alignment and `flagOnly`, for every chapter it captures. Below the
       80% floor (`cross-examine.ts:350`, the value hard-coded at
       `analysis.ts:3723`), crossExamine makes no correction from window or
       tag evidence (`cross-examine.ts:371-385`). Every sentence takes the
       flag-only pass-through (`flag-only-floor`, which also flags a
       pure-narration sentence already `narrator`), with one exception: a
       sentence aligned only to narration that the model gave to a
       character is still demoted, `narration-demote` at 0.9, unless
       #2253's rescue fires (`isConventionRescue`, `:236-239`, a dash-led
       sentence only). So a below-floor chapter makes no `tag-confirm`,
       `tag-correct`, `tag-span-narrator` or `narration-confirm` decision,
       the decisions recovery's tag anchoring exists to feed, and it cannot
       show the improvement recovery is meant to bring. It is **not** empty
       of 1A evidence (AC8 M-5). Recovery decides which sentences the
       demote reaches: for an unrescued mixed sentence (`Антон обернулся.
       — Ты кто?`), recovery **off** sees narration spans only and demotes
       it to `narrator`, while recovery **on** finds a speech span on the
       recovered line and leaves it flagged with the model's id. That is
       the #2253 shape. Alignment depends on the model's raw take, so it is
       known only after the capture.
     - **The swap.** A captured chapter below the floor leaves the pick. The
       runner captures the next candidate not yet captured, and repeats
       until three captured chapters clear the floor, or until two swaps
       have been made (R8-2). A swapped-out chapter's capture is kept, and
       its control still runs (R7-7). Its 1A counts (changed sentences by
       class, narrator share on vs off) are 1A evidence and are **reported
       apart**, in their own table. Per owner decision 16 they never count
       toward the verdict: its changed sentences enter neither `n` nor the
       blind sheet (R9-3), and it stays out of the class report's totals.
     - **Fewer than three.** If the swap cap is reached with only one or two
       captured chapters clear of the floor, 1A is computed on those, and
       the recorded outcome says how many and why (R8-2).
     - **None clear: not computed** (owner decision 19). 1A is recorded as
       **not computed**. That is treated as a capture defect: the defect is
       fixed, and the chapters are captured again. The pick is then settled afresh from the head of the
       candidate list, and the two-swap cap resets. The row stays open until
       1A is computed. Any other capture-defect re-capture (R7-7) settles the
       pick the same way (R9-2). A re-capture uses the **same analyzer model
       and settings** as the first capture (owner decision 20, 2026-11-17): a
       model change would make the verdict describe a setup users don't run. If
       the same model still clears no chapter, 1A stays **not computed** with
       that reason recorded, and the row stays open for the owner to revisit.
     - Record each chapter's hidden-turn count, dash-opening paragraph
       count, alignment and `flagOnly`, whether it was swapped out, and
       each re-capture with its cause.
   - Per picked chapter, record:
     - **1A (per model sentence, R4-1/R4-4):** the control result (pass or
       void); sentences whose post-crossExamine speaker differs, on vs off,
       over all sentences and over turn sentences; narrator share over turn
       sentences, on vs off; confirmed/corrected/flagged/unresolved each
       way. Every changed sentence is tagged with its class ((a)–(d), §4.3).
       1A has no model noise, because both replays share one `raw`, so these
       are exact counts, not estimates. They describe one raw take;
     - **the class report:** the confident decisions on turn sentences
       (§4.3), counted by class and by reason, with no verdict;
     - chunk shape and escalation's share (`final` vs `deterministic`).
   - **Hand-check (owner, blind, R7-11, R8-3, AC6 M-11).**
     - **How the owner judges.** The owner fills in the runner's blind
       sheet (§4.3). For each item they see the sentence and its line in
       the recovery-off parse with the line either side, and no speaker
       from either arm or from the engine. They write the true speaker (a
       roster id or `narrator`), or **can't tell**. `--score` then derives each judgement, so the judge
       never learns which answer came from which arm, or what the engine
       said, before naming the speaker.
     - **Rubric for a mixed sentence.** A mixed sentence is one model
       sentence that holds narration and a turn, such as `Антон обернулся.
       — Ты кто?`. Its right answer is the **turn's speaker**, because the
       turn is what a listener hears misvoiced. The owner also marks it
       **mixed**, and mixed sentences are counted apart in the report, so
       the rule's effect is visible.
     - **Two speakers in one sentence (R8-3).** A model sentence that holds
       turns by two different speakers (`— Да? — Нет.`) has no single right
       id. The owner marks it **two speakers**, it scores neutral, and it is
       counted apart from the mixed sentences.
     - **Both at once (R9-4).** A sentence that is mixed **and** holds two
       speakers' turns (`Антон обернулся. — Да? — Нет.`) is **two
       speakers**: the mixed rule names the turn's speaker, and here there
       is no single one. It scores neutral and is counted with the
       two-speaker sentences only.
     - **Which sentences.** `n` is the sentences whose post-crossExamine
       speaker differs, on vs off, across the picked chapters (three, or
       fewer if the swap cap was reached). A swapped-out chapter's changed
       sentences are not in `n` (R9-3).
       - If `n ≤ 30`, every one is judged (a **census**).
       - If `n > 30`, 30 are drawn uniformly without replacement, with a
         fixed seed that the report records.
       - Each is scored an **improvement** (on's id is the judged speaker
         and off's is not), a **regression** (the reverse) or **neutral**
         (neither is, can't tell, or two speakers). The two ids differ on
         every changed sentence, so both cannot be right.

**Verdict (R7-1, R7-2, owner decision 11).** 1A records **one** verdict,
about **this capture** of the picked chapters: its changed sentences.
Stage 2 carries the previous chunk's last speaker and two paragraphs across every
chunk seam (`stage2-chunk.ts:465-473`). So a capture's sentences are not
independent draws of the model's behaviour, and nothing below claims to
describe recovery beyond this take. The population is therefore finite.
The test below is exact for a finite population drawn without replacement,
and does not assume independent draws from an unlimited one (AC6 S1).

- **1A**, from its hand-check. Let `I`, `R` and `U` be the improvements,
  regressions and neutrals judged. The rule, in order:
  - any chapter's control void → **void** (R7-7);
  - no captured chapter clears the floor → **not computed** (owner
    decision 19);
  - `n = 0` → *recovery changes no speaker*;
  - **census** (`n ≤ 30`): the counts are the answer, apart from the judge,
    so there is no test (R7-1).
    - *Recovery improves the speakers* when `I − R ≥ 3`.
    - *Recovery makes them worse* when `R − I ≥ 1`.
    - Otherwise *no clear direction*.

    AC6's census of 18 improvements and 8 regressions reads *improves*; its
    census of 1 and 6 reads *makes them worse*.
  - **sample** (`n > 30`): the same two claims are read about all `n`
    changed sentences, as `I_n − R_n ≥ 3` and `R_n − I_n ≥ 1`. Each is
    tested exactly against the sample of 30 (R7-2).
    - *Improves* when its null, `I_n − R_n ≤ 2`, gives one-sided
      p < **0.025**.
    - *Makes them worse* when its null, `R_n ≤ I_n`, gives one-sided
      p < **0.10**.
    - Otherwise *no clear direction*.

    The p-value is the largest probability, over every split of the `n`
    sentences into improvements, regressions and neutrals that the null
    allows, of a sample `I − R` at least as far out as the one observed.
    The probability comes from the multivariate hypergeometric distribution
    of a 30-sentence draw without replacement. The neutral share is unknown,
    so the test takes its worst case. The two claims cannot both be
    accepted.

  **The bars, and why they differ.**
  - Missing a regression leaves recovery's evidence rule unexamined. Missing
    an improvement costs a downgrade that the owner already named as the
    alternative. So harm gets the smaller margin and the looser level.
  - In a census, *improves* needs a margin of 3 so that it survives any one
    misjudged sentence: a flip from improvement to regression moves `I − R`
    by 2.
  - *Makes them worse* needs only a net regression. One misjudged sentence
    can therefore produce it from a take with no net effect. That is by
    design.
  - The sample test keeps the census margins, which keeps it continuous
    with the census at `n = 31`.

  **Reach** (`hypergeo-margin.mjs`). The sample decides at these sample
  differences:

  | `n` | *improves* needs `I − R ≥` | *makes them worse* needs `R − I ≥` |
  |---|---|---|
  | 31 | 4 | 2 |
  | 40 | 8 | 5 |
  | 100 | 11 | 7 |
  | 500 to 10,000 | 11 | 8 |
  | 19,000 and above | 11 | 9 |

  Past 10,000 the *makes them worse* bar rises to 9 somewhere below
  19,000 (`hg-large.mjs`, AC7 M-3), and it stays 9 at every larger `n`: in
  the binomial limit P(Bin(30, ½) ≤ 11) = 0.1002 > 0.10 (AC8). Three
  chapters' changed sentences are expected to be far fewer.

  The table below takes a true share `s` of the non-neutral changed
  sentences going recovery's way, and a neutral share `q`:

  | `n` | `q` | P(*improves*) at `s` = 0.6 / 0.7 / 0.8 / 0.9 | P(*makes them worse*) when regressions are 0.6 / 0.7 / 0.8 of the non-neutral |
  |---|---|---|---|
  | 40 | 0 | 0.35 / 0.98 / 1.00 / 1.00 | 0.64 / 1.00 / 1.00 |
  | 40 | 0.25 | 0.10 / 0.74 / 1.00 / 1.00 | 0.50 / 0.98 / 1.00 |
  | 40 | 0.5 | 0.01 / 0.21 / 0.80 / 1.00 | 0.22 / 0.79 / 1.00 |
  | 100 | 0 | 0.13 / 0.60 / 0.97 / 1.00 | 0.41 / 0.88 / 1.00 |
  | 100 | 0.25 | 0.06 / 0.38 / 0.81 / 1.00 | 0.31 / 0.72 / 0.98 |
  | 100 | 0.5 | 0.01 / 0.07 / 0.31 / 0.71 | 0.14 / 0.44 / 0.80 |
  | 500 | 0 | 0.17 / 0.59 / 0.94 / 1.00 | 0.43 / 0.85 / 0.99 |
  | 500 | 0.25 | 0.09 / 0.38 / 0.78 / 0.98 | 0.26 / 0.64 / 0.93 |
  | 500 | 0.5 | 0.02 / 0.10 / 0.33 / 0.69 | 0.11 / 0.34 / 0.67 |

  - **With no effect** (`s` = 0.5, `q` = 0), a sample reads *improves*
    1.8% of the time and *makes them worse* 9.3% at `n = 500`. Both rise
    with `n`: at `n` = 2,000–5,000 they are 2.1% and 9.9–10.0%. The exact
    test keeps each at or under its level at any finite `n`, which is why
    the *worse* bar steps up to 9 by `n = 19,000`. Reach at `n` = 2,000 and
    5,000 matches the `n = 500` rows above to within 0.01. At 19,000 the
    *makes them worse* column drops (0.29 / 0.73 / 0.97 at `q = 0`),
    because its bar is 9.
  - **Said plainly:** once `n` is in the hundreds and half the judgements
    are neutral, a recovery that is right four times for every regression
    reads *improves* only about a third of the time. 30 judgements cannot do
    better, and the only lever is more judgements, which this design does
    not buy.
  - The report prints `n`, `I`, `R` and `U` beside the verdict. A *no clear
    direction* at a lopsided split is then visible as low reach, not as no
    effect.

  **How the statistics combine:** the exact counts do not enter the
  verdict, because they say how many sentences changed, not which way. They
  scale it. In a census the report gives `I` and `R` themselves. In a
  sample it gives `n × I / 30` and `n × R / 30` as the estimated numbers of
  improved and regressed sentences. Either way they sit beside the exact
  counts by class and the narrator share on vs off.
**How blocker 1 closes (R6-3, as amended by R7-7).** 1A answers the owner's
2026-08-13 question ("confirm it is fixing a user-facing problem (or
downgrade the ticket's effect claim to a metric/acceptance improvement)"):
- *recovery improves the speakers* → the issue's effect claim stands, with
  its size (exact in a census, estimated in a sample);
- *recovery changes no speaker* or *no clear direction* → the effect claim
  is downgraded to a metric/acceptance improvement;
- *recovery makes them worse* → the claim is downgraded, and a design item
  on recovery's evidence rule is filed then, not designed here;
- **void**: **any** chapter's control failed (AC6 M-7). A control mismatch
  is a defect in the seam, so the row does not discharge, and the verdict is
  not computed on the chapters that passed.
  - If the replay is at fault, it is fixed, and every captured chapter is
    re-measured from the saved captures, with no model time.
  - If the capture is at fault (what `onStages` recorded), it is fixed, and
    the chapters it affects are captured again.

  The verdict is computed only once every captured chapter's control
  passes, swapped-out chapters included. So it never rests on fewer
  chapters than the pick holds. A capture-defect re-capture settles the
  pick afresh, with the swap cap reset (R9-2).
- **not computed**: no captured chapter cleared the floor (owner decision
  19). It is recorded, the row does not discharge, the capture defect is
  fixed, and the chapters are captured again, with the pick settled afresh
  and the two-swap cap reset. The row stays open until 1A is computed.

**On-box cost (AC4 M-j, re-based for AC5 S3, re-derived for AC6 M-1).**
- **The rate's source.** The rate comes from the **2026-09-05** run on
  `qwen38-cw-iq3-80k`, the operator's named replacement for the earlier
  model, which is no longer on the box
  (`night-watch-reanalysis-onbox-acceptance.md:671-673`). Its phase 1 did
  the work the harness does (stage 2, the engine and escalation, with the
  coverage guard's retries and re-splits) for all 9 chapters of Ночной
  дозор in **≈ 3 h 18 m** (~10:07–13:25,
  `onbox-wave11-group-c-results/step-2-c2c3c4-run.md:29-31`). Ch8 alone took
  **52 m 49 s** for 11,317 words (`:136`).
- **Production dispatched two chapters at once.** `analyzerPoolWidth()`
  dispatches up to `analyzer.ollama.concurrency` chapters in parallel
  (`analysis.ts:2142-2145`, `:7288-7292`), and the default is 2
  (`registry.ts:1013-1019`). The 2026-09-05 log does not record the
  setting. The "Running 9 chapters with up to 2 in parallel" line
  (`step-3-c1-cloud.md:137`) is from the **2026-09-07 cloud run**
  (`gemma-4-31b-it`), not the 09-05 Ollama run (AC7 M-7). On 09-05, ch8
  finished at 13:22:18 after 52 m 49 s, with ch9 at 13:24:58
  (`step-2-c2c3c4-run.md:18`, `:134-136`), so the two chapters overlapped.
  Whether that Ollama instance served them in two slots
  (`OLLAMA_NUM_PARALLEL`) or queued one behind the other is unrecorded.
- **The harness runs one chapter at a time** (R7-9). Stage 2's chunks run
  one after another within a chapter (`stage2-chunk.ts:465-473`).
- **The likely pick.** On the EPUB as parsed (`density.mts`), the three
  chapters with the most hidden turns, excluding ch3, are ch5, ch8 and ch6
  (484, 345 and 330 openers). They hold 35,947 of the book's 103,751 words
  (34.6%).
- **Not used.** The 2026-08-12/13 run's 12 h 27 m is **not** used: its 16 GB
  model spilled about 5 GB over PCIe for the whole run, which the sheet
  calls the dominant cause of its slowness (`:607-613`).

| Step | Work | Wall-clock | Measured or estimated |
|---|---|---|---|
| 1 · library scan | parse only | none (no model) | — |
| 2 · Ночной дозор capture | 3 chapters, one live capture each, one at a time; the 1A replays and the measurement need no model | **≈ 1.1–2.8 h**; ≈ 3 h 18 m is an **inferred** ceiling for these three only | **Estimated.** See the bullets below |
| 2 · first swap (likely) | ch7, ≈ 14,051 words (owner decision 18) | ≈ 1.1 h at ch8's rate | **Estimated** |
| 2 · second swap | ch1, ≈ 17,860 words | ≈ 1.4 h at ch8's rate | **Estimated** |
| 2 · total | with the likely first swap; worst case with both | **≈ 1.6–3.9 h**; worst case **≈ 5.3 h**, which no ceiling covers | **Estimated** |
| 2 · hand-check | up to 30 owner judgements | owner time, no GPU | — |

- **Low end, ≈ 1.1 h.** This is the pick's word share of the two-slot whole
  book (34.6% × 3 h 18 m). It assumes the second slot bought nothing.
- **High end, ≈ 2.8 h.** This is the pick at ch8's measured per-word rate
  (35,947 words at 52 m 49 s per 11,317).
  - Ch8 was retry-heavy: six dialogue-collapse retries plus re-splits
    (`step-2-c2c3c4-run.md:128-131`). Ch5, also in the pick, had a
    "Dialogue markers lost" retry (`:76-81`). So the rate is not
    optimistic.
  - Ch8's time was measured while ch9 ran beside it, whether in a second
    slot or queued. Alone it is unlikely to be slower, and if the box
    served one slot, the high end is generous.
- **The 3 h 18 m ceiling is inferred, not measured.** Two slots can at most
  double throughput. So three chapters run one at a time take no longer
  than the whole book did if they carry at most half its phase-1 work. They
  carry 34.6% of its words, but two of them are the run's retry-heavy
  chapters, and their share of the work was never measured.
- **The swaps are bounded** (owner decisions 16 and 18, R8-2). On
  2026-09-05 ch6 aligned at **65%**, below the floor
  (`step-2-c2c3c4-run.md:64`, `:69`), so the first swap is likely; ch7
  aligned at 97% (`:65`), so a second is not. Each swap costs one more
  chapter capture and nothing else:
  - the swapped-out chapter's capture is already saved, and its replays
    and measurement need no model;
  - below the floor escalation is skipped (`analysis.ts:3736`), so a
    swapped-out chapter spends none of the shared escalation budget the
    picked chapters use;
  - at most two swaps are made, so at most five chapters are captured.

  The swaps take the next candidates by hidden-turn count, which are the
  book's two largest chapters (`density-ch.mts`, AC8 M-3), not a mean one.
  At ch8's rate (4.667 min per 1,000 words):
  - **ch7**, ≈ 14,051 words, costs **≈ 1.1 h**;
  - **ch1**, ≈ 17,860 words, costs **≈ 1.4 h**.

  So the **expected** run, with the likely first swap, is **≈ 1.6–3.9 h**
  (the low end adds ch7's word share of the two-slot whole book, the high
  end its cost at ch8's rate), and the **worst case**, with both swaps, is
  **≈ 5.3 h**.
- **No ceiling covers a five-chapter run.** The inferred 3 h 18 m ceiling
  needs the captured chapters to carry at most half the book's phase-1
  work. Five chapters (ch5, ch8, ch6, ch7, ch1) carry **65.4%** of its
  words, so the ceiling does not hold once both swaps are made. With one
  swap the four chapters carry 48.2% of the words, at the edge of it; the
  runner's own estimate after the first chapter is what counts.
- **What the figures are.** They are **wall-clock** time, not GPU time.
- **What they hold for.** They hold only for `qwen38-cw-iq3-80k` on the
  5070 Ti. If the owner's model has changed, they do not carry over. Either
  way, the runner prints each chapter's wall-clock and, after the first
  chapter, an estimate for the rest, and that estimate replaces this
  table's.
- **Earlier figures.** Revision 5 stated ≈ 2–12 h for this step and
  ≈ 16–48 h with the twin. Revision 6 stated ≈ 1–2 h with a "measured"
  ceiling (AC6 M-1).

**Recorded outcomes:**
- **1A:**
  - the verdict: *recovery improves the speakers* / *recovery makes them
    worse* / *no clear direction* / *recovery changes no speaker*, or
    **void** or **not computed** (R8-2, owner decision 19), neither of
    which discharges;
  - whether it came from a census or a sample, with `n`, `I`, `R` and
    `U`, plus the p-values for a sample;
  - the exact counts by class;
  - the improved and regressed sentences, exact or estimated;
  - the narrator share on vs off;
  - the mixed and two-speaker sentence counts;
  - each swapped-out chapter's 1A counts, in their own table and outside
    the verdict (R9-3).
- **The pick:** each captured chapter's alignment and `flagOnly`, which
  chapters were swapped out, and, if the swap cap was reached with fewer
  than three chapters clear of the floor, how many 1A rests on; every
  re-capture, its cause, and the pick it settled (R9-2).
- **The scan's unparsed files**, with each error's first line (R9-1).
- **The class report:** the confident counts by class and reason, with no
  verdict (owner decision 14).

**Every outcome except a void or not-computed 1A discharges the row.** The
verdict goes onto #2254 and closes blocker 1 as above. A not-computed 1A
leads to a re-capture, and the row stays open until 1A is computed (owner
decision 19).

### 4.5 Committed-fixture limits

- The Castwright-owned dash text (13 turns) is far too small for an on-box
  verdict. It feeds the committed 1A arms (§4.2) and the tools' unit tests.
- `the-coalfall-commission.ru.md` uses «» quotes for most of its dialogue,
  which recovery and legibility ignore. Its short dash-dialogue section
  (`ru.md:63-69`, 4 dash-opening paragraphs) is the only part either
  reads. The scanner's 6 dash-opening paragraphs for the file also count
  its two `---` Markdown rules, which `dialogueOpen` matches (§4.4 step 1).
- If step 1 scans no clean, dialogue-dense ru dash book (R7-5), the
  authored fixtures stay the **only** clean calibration of the threshold.
  The regression plan states this limit, and the threshold stays
  provisional (§2), whatever else the scan finds. The fixtures cannot
  stand in for that book: at 14 dash turns they are far below its
  1,000-turn floor.
- What is committed: the 1A arms and the characterisation test,
  `runStructureEngine` and the `onStages` additions, `captureChapterStages`,
  the legibility exports, the scanner and the runner, all with unit tests.
- What is never committed: the real books, their text dumps, their rosters,
  the saved captures, and the runner's and scanner's reports. Only the
  verdict tables and the scan summary go on #2254 and into the run sheet.

### 4.6 Register row: draft text

ID: a new Group B register row, ID allocated at implementation (Phase 8).
Phase 8 is **main-thread work** (owner decision 3, 2026-11-15). The row ships
with:
- the run sheet `docs/testing/paragraph-degradation-onbox-acceptance.md`;
- the live-view HTML edit;
- `npm run register:build` and `npm run check:onbox-register`;
- `--against-published`, then a publish to the register's recorded URL, per
  the register's own four-step procedure.

> ### B1xx · Does recovery fix merged paragraphing on a real book? ([#2254](https://github.com/dudarenok-maker/Castwright/issues/2254))
>
> **Prerequisite:** local Ollama analyzer (model recorded), structure engine
> on, escalation at default, no TTS, the owner's library on the box. No
> re-imports; the tools write only their reports, captures and text dumps,
> outside the workspace, and read it without the scan's self-heal.
>
> **Observe:** (1) the library legibility scan over every format, on the
> **imported** text: per-book maxima, the worst imported paragraph of each
> flagged chapter judged merged or clean, any clean-judged chapter ≥ 10 (a
> breach of the provisional threshold), chapters labelled extractor-merged
> (#4217) listed as true positives, line-wrapped books (any format) listed
> with the arm that flagged them, their stray-break check and their
> breaches counted, files that could not be parsed listed, each book's
> dash-turn density, the clean dialogue-dense ru dash books by title (the
> provisional label needs at least one), and non-ru Cyrillic books listed
> separately; (2) Ночной дозор, the 3 chapters with the most hidden turns
> that clear the 80% alignment floor, one live capture each, one at a time,
> a chapter below the floor swapped for the next by hidden-turn count (at
> most two swaps): each chapter's alignment and `flagOnly`, the replay
> control, post-crossExamine speakers changed by recovery on vs off per
> model sentence (1A), a swapped-out chapter's 1A counts apart and outside
> the verdict, confident decisions on turn sentences by class and reason,
> including the engine's `narration-demote` overrides (a report, no
> verdict), and one blind hand-check of up to 30. Wall-clock: none for
> (1); for (2) about 1.1–2.8 h with no swap, about 1.6–3.9 h with the
> likely first swap (ch7), about 5.3 h at worst (ch7 and ch1), estimated,
> on the 2026-09-05 model.
>
> **Outcome (not a pass bar):** 1A *improves the speakers* / *makes them
> worse* / *no clear direction* / *changes no speaker*, decided by the
> counts when 30 or fewer sentences changed (*improves* at `I − R ≥ 3`,
> *worse* at `R − I ≥ 1`), otherwise by an exact finite-population test of
> the same claims (one-sided 0.025 for *improves*, 0.10 for *worse*). A
> void 1A (any captured chapter's control failed), or one not computed (no
> chapter cleared the floor), does not discharge. A not-computed 1A is
> recorded, the capture defect fixed and the chapters captured again, with
> the pick settled afresh and the swap cap reset; the row stays open until
> 1A is computed.
> Every other outcome discharges: record the tables, the verdict, the
> class report, the scan, who/when, and post them on #2254.
>
> **Criteria:** `docs/testing/paragraph-degradation-onbox-acceptance.md`.

## 5 · Phased rollout (each phase ≈ one agent commit)

**Branching.** Every phase except 3, 6, 8 and 9 touches `server/` (see the
Scope column), and all of 0–7 run as **one serial chain** in one worktree:
0 → 1 → 2 → 3 → 4 → 5 → 7 (Phase 6 is withdrawn, R6-9). Phase 3 is
frontend-only, but it sits in the chain rather than in a parallel lane: it
consumes Phase 2's wire field, and Phase 4 edits the same `src/lib/types.ts`
and `src/lib/api.ts`. Integration follows CLAUDE.md: one PR for the round,
with a `docs/features/` regression plan and an `INDEX.md` row added in
Phase 1.

| # | Phase | Scope | Tier | Paired tests | Ships |
|---|---|---|---|---|---|
| 0 | F3 deletion (Decision 5). F1 (#4165) is merged and F2 discharged with it (R5-13); F4 is **#4217** (filed) | server | Cheap | test removal paired with the deletion | — |
| 1 | `MERGED_TURNS_DEGRADED` (provisional), `isParagraphDegraded`, `NOTICE_LANGUAGES`, `TURN_IN_PARAGRAPH` factory, `countTurnOpeners`; regression plan + INDEX | server, docs | Cheap | unit: 9/10 edge; `undefined` for null, out-of-scope and no-convention languages; `countTurnOpeners` sum vs `measureChapterLegibility` max on one fixture; the factory returns a fresh regex | — |
| 2 | Import `paragraphsMerged` + openapi + `openapi:types` + **hand-edit `src/lib/types.ts` `ImportCandidate`** + route test | server, frontend types | Default | route test | — |
| 3 | Confirm Heads-up + client `NOTICE_LANGUAGES` mirror + mock mirror + `e2e/responsive/` spec with its 375 px chromium case | frontend, e2e | Default | component + e2e | both release-notes files |
| 4 | `GET /state` `paragraphsMergedChapters` + `WeakMap` memo (unfiltered ids, per-request exclusion, R4-7/R5-7 omission via `assertHintsPairWithState` with `parseTitles`, called per request in a `try`/`catch` of `HintsOutOfSyncError`, R6-8) + openapi + `src/lib/types.ts:455` + mock `/state` + `chapters-slice` + manuscript caption + e2e case | server, frontend, e2e | Default | route (incl. compute-once, toggle-after-cache, count mismatch, same-count title mismatch, title state changed under a cached record), slice, component, e2e | both release-notes files |
| 5 | Characterisation test first, then extract `runStructureEngine` (`:3714-3727`; `:3728` stays in the caller; zero behaviour change) + `structureOptions` seam + `onStages` `stage1`/`paras`/`alignment`/`flags` (`flags` cloned at `:3729`, before escalation) + 1A arms 1 and 2 | server | Default | characterisation (5 inputs, one in which escalation fills a line, `toEqual` on the pre-existing fields, committed before the additions) + a separate new-fields assertion (on the escalation-fill input, `onStages.flags` still holds the filled line's index); `analysis.structure-fixture.test.ts`; existing `attributeChapterStage2` tests green | none (say so) |
| 6 | **Withdrawn** (owner decision 10, R6-9): the `recoverMidParagraphTurns` switch and `emitSpans` on `computeAttributionMeasurement` served only the twin | — | — | — | — |
| 7 | Extract `captureChapterStages` from `evalFixture` (+ capacity, shared budget, chunk counters, `flags`) + extract `buildManuscriptRecord` from `hydrateFromDisk` (`store/manuscripts.ts`, called by it unchanged, R7-10) + library scanner (each file parsed in its own child process with a time limit, unparsed files reported as a scan outcome (R9-1); formats, sums, line-wrap test on every format's imported text at ≥ 2% or ≥ 10 continuation lines (R7-6), the flagging arm, and for a count-arm-only book the stray-break check of isolation and neighbour window (owner decision 17, R9-5), dash-turn density and the clean dialogue-dense flag (R7-5), EPUB rewritten-copy #4217 what-if, worst paragraph, byte-for-byte read-only `--dump`) + `paragraph-degradation-ab.mts` runner (one chapter at a time, captures saved first with the budget left, per-chapter alignment and `flagOnly`, the pick settled after capture with at most two swaps in hidden-turn order (R8-2, owner decision 18), *not computed* and the re-settle after a re-capture (owner decision 19, R9-2), a swapped-out chapter's 1A counts apart (R9-3), `--from-captures`, `--resume`, replay control, confident rule over the five reasons with `flags`, classes (a)–(d) by precedence with lines defined by first-span start (R7-8), the class report, the blind 1A sheet on the recovery-off parse with the sentence marker and long-line window, and `--score` with its roster check (R7-11, R8-3, R9-4), the 1A census and finite-population sample rules (R7-1, R7-2), wall-clock and estimate) | server, scripts | Default | `run-eval.test.ts` green; existing `manuscripts` hydrate tests green; scanner (multi-format fixtures; the clean ru-dash fixture **not** line-wrapped, and the same text one paragraph per line **not** line-wrapped; that fixture hard-wrapped at 80 and at **200** columns flagged, as `.txt` and as `.md`; an EPUB whose `<p>` text is hard-wrapped flagged; a book-length unwrapped text with exactly 10 continuation lines (under 2%) flagged and with 9 not; a count-arm-only book with isolated stray breaks whose largest neighbour window holds 9 is a calibration candidate and one at 10 is not; a window where the break falls before the dash (`. —` / `— Да`) counts the restored match; a count-arm book with two continuation lines within two lines of each other is not a candidate; a share-arm book (≥ 2%) never is, whatever its counts, and a PDF never is; a file whose parse throws from an async callback (an injected parser that throws from `setImmediate`, standing in for epub2's empty-`href` crash) is reported unparsed while every other file in the directory is still scanned; a breach in a line-wrapped book counts against the label; dash-turn density and the dialogue-dense flag at 25 per 1,000 words and at 1,000 turns, either side of each bar; a `<div>`-paragraphed EPUB fixture labelled extractor-merged; a MOBI reported not computed; a dump leaves the book's `state.json` byte for byte unchanged where the scan's self-heal would have written it); runner (fixture capture with a mock analyzer, captures written before measurement, a replay-control mismatch in one chapter of three reported void and blocking the verdict; a below-floor capture swapped for the next candidate by hidden-turn count (not by density), reported with its alignment and its 1A counts apart, and kept out of the verdict, `n`, the blind sheet and the totals; the swap cap stopping at five captures; the cap reached with one chapter clear computing 1A on it and recording how many; no chapter clear recording *not computed*; a re-capture after that re-settling the pick from the head of the list with the cap reset; the §4.3 class, precedence and reason fixtures, an unknown confident reason fails the measurement and `--from-captures` re-runs it without the analyzer, `--resume` after a chapter fails mid-capture keeps the saved chapters, restores `remainingWindows` and re-captures only that chapter, a blind sheet carrying no speaker id and showing the recovery-off line with the sentence marked, and a window with its offset on a line over 1,200 characters; a two-speaker sentence scored neutral, and one that is also mixed counted as two-speaker only; `--score` failing, naming the item and writing no score, on a judged id not in the pinned roster; the census bars at `I − R` = 2 and 3 and `R − I` = 0 and 1, and the sample test's critical values at `n` = 31 and 40 against the table in §4.4) | none (say so) |
| 8 | Register row + run sheet + live view + `--against-published` + publish | docs | **Main thread** | `check:onbox-register`, `register:build` | — |
| 9 | **Owner, on-box:** the new register row → verdicts on #2254 → discharge | — | — | — | Closes #2254 with 3, 4 and 9 done |

**Dependencies:**
- 0 → 1 → 2 → 3 → 4 → 5 → 7 → 8 → 9, all serial.
- 7 needed #4165 merged (§1.5 F1); that is met since `1e295990`.
- **No UI phase waits on the false-positive scan.** It is the register row's
  step 1 (§2).

**Out of scope:**
- **a merge-cost number for clean books** (owner decision 10). Revision 5's
  clean/merged twin is withdrawn. If that number is ever wanted, it is a
  separate future design that starts behind a pilot: capture C1 and C2
  first, project the detectable effect from their measured noise, and only
  then spend M and M2;
- better-source acquisition;
- changes to the recovery gate;
- #4217's extractor change (its own design pass; the scanner's what-if is
  diagnostic only);
- recovering bare third-person tags, or re-anchoring tags in dash-open
  paragraphs (file either only if the register row's 1A points at that
  lever);
- escalation's compensation for recovery-off flags (§4.1 limits);
- script review's use of recovered evidence (§4.1);
- es/fr calibration (Decision 4);
- English.
