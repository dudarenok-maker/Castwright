---
status: draft
issue: 2254
refs: [2253, 2267, 2275, 2306, 2320, 4165, 4217]
date: 2026-11-13
revision: 5 (owner decisions on the PR #4184 assumption-checker pass 4, 2026-11-15)
decisions: owner decisions 1–9 of 2026-11-15 are binding and are written in below (1–3 drove revision 3, 4–6 revision 4, 7–9 revision 5); the items under "Decisions made in revision 5" (and the surviving ones from revisions 3 and 4) are owed owner confirmation
gate: assumption-checker pass 4 on revision 4 did not clear it; revision 5 needs a fresh pass before decomposition
verified-at: 1e295990 (origin/main, 2026-11-15)
---

# Paragraph-degradation signal: surfacing it, and proving what it costs (#2254)

Filename when committed:
`docs/superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md`.
Design thread only. No code is written here. Verified against `main` @
`1e295990` (revision 4 was verified @ `c16da893`, revision 3 @ `a9918640`,
revision 2 @ `3792b84b`). Between `c16da893` and `1e295990` the only anchored
file that changed is `dialogue-structure/paragraph-recovery.ts` (#4165 merged,
which also removed the stale "opt-in / Default OFF" comments, see §1.5); its
anchors below are updated, and every other anchor reads the same at
`1e295990`. Paths under
`attribution-eval/` mean `server/src/analyzer/attribution-eval/`; paths under
`dialogue-structure/` mean `server/src/analyzer/dialogue-structure/`.

**Scope authority.** CLAUDE.md lists "New features" as out of scope until told
otherwise. #2254's close-blocker 2 (owner comment, 2026-08-13: "wire the signal
into the import/analysis surfacing so a degraded book is flagged") is that
instruction. It covers the user-facing surface designed here and nothing
beyond it.

## Revision 5 changelog

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

## Decisions made in revision 5 (owner to confirm)

These are choices owner decisions 7–9 did not settle. Each one is the option
most consistent with them.

- **R5-1 · The bootstrap is not stratified by chapter.** It resamples clean
  chunks from the whole book's pool. A short chapter can have one or two
  chunks (the simulation gives 2–5 for a 17k-char chapter), and a
  one-cluster stratum adds no variance, so stratifying would make the CI too
  narrow (AC4's point). Pooling loses only the chapter-to-chapter variance
  that stratification would have removed, so it errs wide, not narrow.
- **R5-2 · The cluster floor is ≥ 20 clean chunks for the book.** In the
  simulation, books with 6–12 chunks have a bootstrap SE 14–27% below the
  estimator's true spread at zero effect, and read *degrading* on a true
  zero effect 5–9% of the time, where the nominal rate is ≤ 2.5%. With 18 or
  more chunks the SE is within about 15% at zero effect and the false
  *degrading* rate is 1–5% (within the simulation's ±1–3 pp noise of
  nominal). 20 is the round number above the smallest book that behaved. The
  floor depends only on the clean body and the budget, so it is checked
  before any model time is spent.
- **R5-3 · The confident filter is structural.** It is "confidence ≥ 0.9 and
  not flagged", not a reason list, so a reason added to `crossExamine` later
  cannot silently escape it. The runner asserts that every decision passing
  the filter carries one of the five known reasons, and fails loudly on any
  other, so a new reason gets a class decision, not a default.
- **R5-4 · A multi-sentence span counts only if every sentence passes.** A
  non-split span can carry several aligned sentences that agree on the id.
  It counts as a confident disagreement only when each of them passes the
  reason, confidence, flag and escalation conjuncts. One flagged sentence
  means the user sees a flag on that span, so it is not a confident
  disagreement. The class is the lowest-index sentence's; a span whose
  sentences fall in different classes is also counted as **mixed**.
- **R5-5 · `emitSpans` covers speech spans only.** 1B and 1C pair on speech
  spans (§4.4 step 6), and nothing compares tag spans. Emitting them would
  need value logic the module does not have today (AC4 M-c). A split value
  carries `hasOrphan`, which is what the R-9C5 overlap needs.
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
- **R5-10 · R4-3 never folds a run across a scene separator.** Folding into
  `* * *` would delete a scene break and a forced chunk boundary in M only.
- **R5-11 · The runner reports the verbless-tag downgrade.** For each
  degraded dash-open paragraph in M's structure, it reports whether the
  parser reduced it to one unanchored speech span. It also gives the class (c)
  sample size before the hand-check draws from it.
- **R5-12 · The achieved detectable effect accounts for the 5 pp
  conjunct.** It is reported as `max(2.8 × SE, 5 pp + 0.84 × SE)`. At ≥ 20
  chunks it sits 0.3–1.5 pp **below** the simulation's 80%-power points, so
  the report reads it as "about", and the runner prints the SE beside it
  (§4.4 "Power").
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
| S6 | B110 step 1 can't tell a false positive from an extractor-made merge | **Owner decision 6.** "Clean" is judged on the **imported** text. A #4217 (F4) merge counts as a true positive. The scanner shows the owner the worst imported paragraph and reports each book's #4217 exposure (§4.4 step 1) |
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

## Decisions made in revision 4 (owner to confirm; R4-3, R4-4, R4-5 and R4-7 amended by revision 5)

These are choices owner decisions 4–6 did not settle. Each one is the option
most consistent with them. Revision 5 amends four of them without reopening
them: R4-3 gains its predicate, its run base and its separator rule (R5-6,
R5-10) and a corrected rationale (owner decision 8); R4-4 uses
`dialogueOpen` (R5-6); R4-5's floor is now in chunks as well as turns
(R5-2); R4-7 adds the title test (R5-7). The text below is as revision 4
wrote it; §3–§4 hold the amended rules.

- **R4-1 · 1A is two replays, with a control.** Revision 3 compared a live
  snapshot with a replay. Now both arms are replays over one captured `raw`
  and the deduplicated roster the engine used. A third, recovery-on replay
  must equal the live `deterministic` snapshot exactly. If it doesn't, that
  chapter's 1A is reported void, not computed. This replaces R3-1's
  live-vs-replay comparison and keeps its "no model" property.
- **R4-2 · The twin's pairing space is the clean body's span set, parsed
  with production defaults (recovery on).** Recovery should find nothing to
  split in clean text. A gate checks that the clean body's recovery-on and
  recovery-off parses give the same span set; any difference is reported.
  The merged arm's own post-recovery structure is used to **classify** its
  confident disagreements, not to pair them.
- **R4-3 · The degrade script builds both merge shapes.** Each run of
  consecutive dash-opening paragraphs, counted from the start of the
  chapter, is folded in one of two ways. Runs whose index `i` gives
  `i mod 3 = 2`, and any run with no paragraph before it, are joined into a
  **dash-open** paragraph. Every other run is folded into the narration
  paragraph before it. That gives about one third dash-open and two thirds
  narration-open. Ночной дозор's real mix is 5 to 34, so the twin
  over-represents dash-open on purpose, to give class (c) a sample. The
  rule stays deterministic and length-preserving.
- **R4-4 · A "turn sentence" is defined from the text.** A model sentence is
  a turn sentence when its text opens with a dialogue dash or contains a
  mid-paragraph turn opener, by legibility's own `DASH` and
  `TURN_IN_PARAGRAPH` (exported in Phase 1, so there is still one
  predicate). This is how the Ночной дозор measures see hidden turns that no
  speech span covers.
- **R4-5 · The reference run takes chapters up to 1500 turns.** It takes the
  book's qualifying chapters densest first, until it reaches ≥ 1500
  dash-opening turns or 8 chapters. The 300-turn floor still applies to any
  verdict. The report states the achieved minimum detectable effect, so a
  smaller book still yields an honest result.
- **R4-6 · A second merged capture confirms a non-inconclusive verdict.**
  When 1B or 1C reads *degrading* or *not degrading*, the owner captures
  **M2** (merged again) and the runner recomputes with M2. The verdict stands
  only if M2 gives the same one; otherwise it is *inconclusive*. One run per
  arm cannot show M's own run-to-run variance, and this is the cheapest check
  that does.
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
| 6 | Phase 2 (26-book false-positive check) is not agent work | AC1, AC2 | **Owner decision 3.** It is now step 1 of the owner-run register row B110. Agents build only the scanner (Phase 7). The threshold ships as **provisional** and no UI phase waits on the check (§2, §4.4, §5) |
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

## Decisions made in revision 3 (owner to confirm; R3-1, R3-2 and R3-6 superseded by revision 4)

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
  (§4.4).
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
> measured and how B110 step 1 judges "clean"; owner decisions 7–9
> (revision 5) settle the bootstrap unit, the confident count and the notice
> wording. They are written into §3–§4 and listed at the end of this section.
> (The numbered list below is the 2026-11-13 set, cited as "Decision N";
> "owner decision N" means the 2026-11-15 set, 1–9.)

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
     2026-11-15) until register row B110 step 1 records the library scan, and
     §2 states the limit.
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
     provisional label. The B110 scan reports detected and declared language
     per book, so a non-ru breach shows up and is the first calibration
     evidence for it.
5. **`assessParagraphStructure`** (no production caller).
   - Options: delete it with its test · keep it as an offline-study export.
   - *Delete*, through report-fix-record. It is a pre-existing dead-code
     finding either way.
6. **Register group: B** (local Ollama analyzer, no TTS). The ID is the
   **next free Group B id at merge time** (`B110` at `c16da893`). AC1 asked
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
- **6 · In B110 step 1, "clean" is judged on the imported text.** An EPUB
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

## 1 · What actually shipped (verified @ `c16da893`)

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
  type in `workspace/scan.ts:327`).
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
   - **(a)** Does recovery change post-crossExamine speakers?
   - **(b)** Does merged paragraphing degrade the *model's raw* attribution?
   - **(c)** Does merging change the final answer, and where do the engine's
     confident disagreements sit? (Revision 3 from AC1; restated by owner
     decision 4.)
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
   never compares span-based figures across structures: the twin pairs on the
   clean body's span set, where recovery has nothing to split (a gate checks
   it, R4-2), and Ночной дозор's 1A pairs per model sentence (R4-4).
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
  them true positives in B110.

## 2 · Measure and threshold

- **Phase 1** adds to `legibility.ts`:
  - `MERGED_TURNS_DEGRADED = 10`, with a comment marking it **provisional**
    and naming register row B110 as the calibration that will confirm it;
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
  or more** places where a sentence ends and a dash plus a capital letter
  follows. The notices claim exactly that count, as "ten or more places where
  a line of dialogue begins mid-paragraph" (owner decision 9, §3.1, §3.2),
  and nothing about speakers, lines or who merged it. They count **places**,
  not lines: a resumption after a tag (`— А, — сказал он. — Б.`) is one
  speaker's line but two places, and the wording stays true for it. "A line
  of dialogue" names the mid-paragraph dash by its ru convention (it opens
  direct speech, or resumes it). By **calibration**, not
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
  B110 (§4.4). It is **not** a merge gate for any UI phase: per CLAUDE.md,
  owed acceptance converts into a row. A breach on a book the owner judges
  clean **on its imported text** (owner decision 6) is recorded on the row,
  and the threshold decision it forces goes to the owner. If no clean,
  dialogue-dense ru dash book exists, the threshold stays provisional
  indefinitely, and the regression plan says so in those words.
- **Formats the measure under-reads.** The measure splits on `\n`. In a PDF,
  or a hard-wrapped TXT, every visual line is its own paragraph, so a merge
  reads low. That costs false negatives (a silent notice), never false
  positives. It also means a scan of those books cannot confirm the
  threshold (§4.4 step 1).
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
"usually", and must not turn places into lines):

> **Heads-up:** in 5 chapters (Chapter 4, Chapter 5, Chapter 6 and 2 more),
> the imported text has a paragraph with ten or more places where a line of
> dialogue begins mid-paragraph. Each of those lines would usually start its
> own paragraph. This often happens when a book is converted between formats.
> A different copy or format of this book may give a better result.

"Ten or more places where a line of dialogue begins mid-paragraph" is the
plain-words reading of "ten or more sentence-end + dash + capital openers in
one paragraph", the one thing the measure counts (§2). It counts places, not
lines, so a same-speaker resumption keeps it true. The wording asserts no
share of the chapter, no speaker change and no cause. That keeps it true when
Castwright's own extractor did the merge (F4, #4217).

**Mobile/touch:**
- Static text, nothing interactive, so no 44 px obligations.
- At 375 px the box (`-mt-2 px-4 py-2.5 text-xs` padding, three titles) runs
  to about **10–11 lines** (revision 5's wording is one short sentence
  longer). That is acceptable inside the scrolling confirm
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
   `getOrHydrateManuscript(state.manuscriptId)` (`:845`).
   - Language comes from `bookStateLanguageOrNull(state)`
     (`workspace/scan.ts:402`). The display variant must not be used,
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
   - **Memoised per hydrated record:** a module-level
     `WeakMap<ManuscriptRecord, { language: string; ids: number[] }>`. The
     cached `ids` are **unfiltered** (every chapter the record holds).
     Exclusion is applied per request from the current state, so the memo's
     correctness does not depend on the exclude toggle replacing the record
     (it does today, `book-state.ts:2394-2401`). `getOrHydrateManuscript`
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

**Mobile/touch:** a wrapping, non-interactive caption. There is no
hover-only content (touch-equivalence rule).

**Tests:**
- route test: merged ru → id listed; English, null language and missing
  record → key absent; excluded chapters omitted, **including after an
  exclude toggle on the same cached record** (the filter is per request);
  `parse`-hinted chapter-count mismatch → key absent; `parse`-hinted
  same-count record whose parse titles don't pair → key absent; **two requests on one
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
| **1A** | With the model's raw take held fixed, does recovery change **post-crossExamine** speakers? | No (two engine replays over one live raw take, R4-1) | committed test (§4.2) + Ночной дозор (§4.4 step 2) + twin (step 6) |
| **1B** | Does merged paragraphing degrade the model's **raw** attribution? | Yes | clean/merged twin, live (§4.4 steps 3–7), on `onStages.raw` |
| **1C** | **Does merging change the final answer?** Merged twin's `final` vs clean twin's `final`, paired per span, against a clean-vs-clean noise term (owner decision 4); plus the engine's confident disagreements, by where they sit (owner decision 5) | Yes | twin (§4.4 steps 6–7) + Ночной дозор hand-check (step 2) |

1C is the owner's direct question and the #2253 harm class. It measures
whether the user gets a **different** answer from a merged copy than from a
clean one. It is **not** an accuracy measure: where the clean twin is itself
wrong, a change can be an improvement. The confident-disagreement counts and
the Ночной дозор hand-check are where direction is judged.

**Stated limits:**
- **1A stops at crossExamine** (AC3 M6). Escalation needs a model, and only
  a live run escalates. How much escalation compensates for recovery-off
  flags is therefore not measured. Escalation's own effect within each live
  arm (`final` vs `deterministic`) is reported.
- **Script review** (channel 3 in §1.2) is out of 1A–1C scope. It is an
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
    a narration-open paragraph**, which is class (b) of the 1C confident
    count (§4.3). (Revision 3 said this while the count only looked at
    dash-open paragraphs; owner decision 5 removes that contradiction.)
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
- **`onStages` gains three fields** (additive; only the harness passes
  `onStages`): `stage1`, the deduplicated roster the engine used; and, in the
  engine branch only, `paras` and `alignment`, cloned when crossExamine
  returns. That is what §4.3's replay and classification need without
  re-deriving anything.
- **Zero-behaviour-change proof.** Before the extraction, and before the
  `onStages` additions, the Phase-5 agent commits a characterisation test
  that records `attributeChapterStage2`'s `sentences`, `structureReport` and
  the **pre-existing** `onStages` fields (`raw`, `deterministic`, `reasons`)
  for four inputs: engine on; `flagOnly` (alignment below the 80% floor);
  knob off; and a language with no conventions. The comparison is deep
  equality (`toEqual`), not byte identity. It keeps comparing only those
  fields after the three new fields land, so the additions cannot fail it. A
  separate assertion in the same file pins the new fields: `stage1` in all
  four inputs, equal to the deduplicated roster; `paras` and `alignment` for
  engine-on and `flagOnly` (both run the engine branch), absent for knob-off
  and no-conventions. The existing tests stay green.

### 4.3 The measuring instruments

**Raw source: live capture through plan 265's harness** (owner decision 1,
2026-11-15). There is no cache read anywhere in this design.

- `evalFixture` (`attribution-eval/run-eval.ts:168`) already calls
  `attributeChapterStage2` live with `onStages` (`:196-205`), and `onStages`
  delivers:
  - `raw`, cloned before the engine runs (`analysis.ts:3698`);
  - `deterministic`, after crossExamine and before escalation (`:3729`);
  - `reasons`, aligned 1:1 to `deterministic`;
  - and, after Phase 5, `stage1`, `paras` and `alignment`.

  The return value is the final, post-escalation take. Escalation changes ids
  on flagged lines in place and never the sentence count, so `final[i]`,
  `deterministic[i]` and `reasons[i]` describe the same sentence.
- **Phase 7 extracts, it does not copy.** It pulls the body of `evalFixture`
  up to and including the `attributeChapterStage2` call into an exported
  `captureChapterStages(opts) → { raw, deterministic, final, reasons, stage1,
  paras, alignment, structureReport, chunks }`. `evalFixture` calls it, and
  its scoring stays byte-identical (`run-eval.test.ts` stays green).
  `captureChapterStages` takes a plain `chapterText` and roster, so no
  `LabelledChapter` truth is needed. It also takes an optional
  `structureOptions`, an explicit `capacity`, and an optional shared
  `structureBudget` (below).
- **Roster:** pinned per book, built with `buildRosterSnapshot`
  (`attribution-eval/capture.ts:63`) from the library book's `cast.json`.
  This is plan 265's own roster-pinning, which prevents id drift between
  arms. For the twin, every arm uses the **same** pinned roster file, built
  once from the reference book's cast.

**Harness vs production** (AC3 M3). Each difference is matched or stated:

| Aspect | Production (`analysis.ts:7633-7646`) | Harness today | This design |
|---|---|---|---|
| Chunk capacity | `resolveCapacity({ engine, model })` of the active analyzer | Gemini's unless `engine === 'qwen'` (`run-eval.ts:191-194`) | **Matched.** The runner resolves `capacity` from the owner's actual engine and model and passes it in |
| Model | the owner's configured analyzer | `qwen3.5:9b` unless `EVAL_QWEN_MODEL` is set (`run-eval-cli.ts:91`) | **Matched.** The runner takes a required `--model` with no default, and the run sheet records it |
| Escalation budget | one `structureBudget` per **book**, shared across chapters (`:7645`, `maxWindowsPerBook`) | none, so each chapter gets a fresh per-book default (`:3744-3746`) | **Matched.** The runner passes one shared budget object per **arm**, across that arm's chapters |
| Dedup constraints | plan 291's `planConstraints` for a plan-applied roster; `undefined` for a first analysis's rolling roster (`:7642`) | none | **Stated.** The harness has no plan, so it passes none, which is production's first-analysis shape. Every arm is the same |
| Roster roles | `cast.json` roles | `rosterToStage1` sets every role to `'character'` (`run-eval.ts:85-97`) | **Stated.** Kept, because changing it would change `evalFixture` scoring. Every arm is the same |
| Eval-rate wrapper | `attributeChapterStage2WithEval` (`:3904-3918`) | direct call | **Stated.** It only folds sub-calls into one eval-rate record; no attribution effect |
| Coverage guard | on | on | Same. The `STAGE2_COVERAGE_RETRIES=0` fixture trick is for body-blind mocks and is **not** used here |
| Escalation mode | owner default `'local'` (`registry.ts:1323-1331`) | config | Same; the prerequisites pin it |

Absolute shares are therefore the harness's. Every cross-arm comparison is
between arms that share all of the above.

- **Chunking (the 9000-char note).** Stage 2 splits a chapter over
  `analyzer.stage2.chunkCharBudget` (default 9000, lower for local engines:
  `max(1000, min(0.3 × num_ctx × 2, 9000))`, `registry.ts:123-140`) at
  blank-line boundaries only (`stage2-chunk.ts:142` `splitBodyIntoChunks`,
  which is lossless). A merged paragraph is never split and becomes its own
  chunk, and the sentence-split fallback applies if it truncates
  (`stage2-chunk.ts:196` `splitParagraphIntoSentences`). The merged twin is
  therefore chunked differently from the clean twin. That is part of what a
  merged book costs in production, so it is **measured, not removed**:
  - `captureChapterStages` threads counters through `attributeChapterStage2`'s
    `onChunk`, `onCoverageRetry`, `onCoverageExhausted` and
    `onDeterministicSplit` callbacks (`analysis.ts:3584-3594`) and returns
    them as `chunks`;
  - every arm's report states chunk count, coverage retries and
    deterministic splits per chapter;
  - the **clean** arm's chunk boundaries also define the bootstrap's
    clusters (§4.4, owner decision 7).

**1A engine replay (R4-1):** for each captured chapter, the runner calls
`runStructureEngine` three times over the **same** captured `raw`, with the
captured deduplicated `stage1` and the chapter's conventions:
1. **control**, recovery on. It must deep-equal the live `deterministic`
   snapshot. If not, that chapter's 1A is reported **void**, with the first
   differing sentence, and is left out of every 1A total;
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

**Measurement (Phase 6, a server change):**
- `computeAttributionMeasurement` (`store/attribution-health.ts:139`) already
  takes explicit `bodies` and `sentences` (input type `:86-108`). It gains
  two optional inputs. Both defaults keep library behaviour unchanged:
  - `recoverMidParagraphTurns?: boolean` (default `true`), passed to its
    `parseChapterStructure` call (`:171`);
  - `emitSpans?: boolean` (default `false`). When true, the result carries
    `spans: SpanRecord[]`, one per **`speech`** span, in body order (R5-5;
    tag spans get no record, because nothing here compares them and the
    module classifies them only for `tagNarratorSpan`, `:202-209`):

    ```
    SpanRecord = {
      chapterId, start, end,
      dashOpenedPara: boolean,
      value: { kind: 'id', id }
           | { kind: 'split', hasOrphan: boolean }
           | { kind: 'unattributed' }
           | { kind: 'orphan', id },
      narrator: boolean,           // value is an id in NARRATOR_CHARACTER_IDS
      sentenceIndices: number[],   // into the input `sentences` array, ascending
    }
    ```

    The values come from the classification the function already performs
    (`:227-253`: `unattributedSpeech`, `splitSpeech`, `orphanSpoken`, the
    resolved id). `hasOrphan` is the existing `sawOrphan` flag, so a split
    span that also counts in `orphanSpoken` (the R-9C5 overlap) is visible in
    one record. It adds **no** new predicate, which honours the module header
    (`:21-24`). The aggregate fields are unchanged.
- **How a span is compared across arms:** two arms agree on a span when
  their `value`s are equal (same kind and, where present, same id). A split,
  an unattributed or an orphan span therefore disagrees with a resolved id,
  and two unattributed spans agree. Each arm's report also states its
  `split`, `unattributed` and `orphan` counts, so a disagreement driven by
  alignment shape is visible.
- The runner calls it in-process with:
  - the **reference** body: the clean body for the twin, or Ночной дозор's
    own hydrated body;
  - the arm's sentences (`raw` or `final`);
  - the captured deduplicated `stage1` as the roster, never `roster: []` as
    `attribution-health-io.ts:220` does for the library;
  - as `cast`, the reference book's `cast.json` characters, the same file the
    pinned roster was built from (§4.3 "Roster"). The resolver uses it to
    tell `id` from `orphan` and to set `narrator`, so every arm resolves
    against one cast. `history` is omitted (no id is retired inside a run),
    and `cacheHasOriginField` is `true` (the sentences are live, D18-aware
    output);
  - `recoverMidParagraphTurns` left at its default (on), plus `emitSpans`.

  **Why the merged arm's sentences land on the clean spans** (AC4 M-d). The
  aligner does not map offsets; it searches the body for each sentence's
  **normalised** text, collapsing whitespace runs to one space
  (`aligner.ts:126`, `:584`). The twin differs from the clean body only in
  whitespace (each removed separator becomes the same number of spaces, §4.4
  step 4), so a merged-arm sentence normalises to text that also occurs in
  the clean body, and aligns there. Equal body lengths are a gate on the
  degrade script, not the alignment mechanism. A merged-arm sentence that
  does not align leaves its span `unattributed`, which counts as a
  disagreement and shows in that arm's counts. Recovery is length-preserving
  (§1.2), so it moves no span.
- Server unit tests in `attribution-health.test.ts`: the same body and
  sentences with the switch off yield the pre-#2320 span count (no recovered
  spans); `emitSpans` records reproduce every aggregate field exactly:
  `unattributed` = `unattributedSpeech`, `split` = `splitSpeech`,
  `orphan` + (`split` with `hasOrphan`) = `orphanSpoken`, `narrator` = the
  narrator-id total, and the record count = `spokenTotal`; and with
  `emitSpans` off, the output is unchanged.

**Comparing model quality (1B):** compare `raw` with `raw` across arms, never
post-engine output. Post-engine output mixes in the engine's corrections, and
those differ by structure by design. 1C reports post-engine output
explicitly.

**1C confident disagreements (owner decisions 4, 5 and 8).** The merged
arm's `SpanRecord`s come from measuring M's `final` sentences against the
clean body; `final[i]`, `deterministic[i]` and `reasons[i]` describe the same
sentence `i`. A merged-arm span counts when all of these hold:
- its `value` disagrees with the clean twin's `final` (C1) on the reference
  span set. A `split` span disagrees but is counted under "split", never
  here;
- **every** sentence `i` in its `sentenceIndices` passes the next three
  conjuncts (R5-4). One flagged sentence means the user sees a flag on that
  span, so it is not a confident disagreement;
- sentence `i`'s `deterministic` confidence is ≥ 0.9 and it is **not
  flagged** (R5-3). At `1e295990` that is exactly five reasons, all
  unflagged: `tag-confirm:<id>` (0.95, `cross-examine.ts:130`),
  `tag-correct:<id>` (0.9, `:144`), `tag-span-narrator` (0.9, `:261`),
  `narration-confirm` (0.95, `:274`) and `narration-demote` (0.9, `:286`).
  The last two differ in a way that matters: `narration-confirm` is the
  **model** saying narrator, while `narration-demote` is the **engine**
  overriding the model to narrator, the #2253 rewrite itself. It still
  happens in merged text wherever #2253's rescue (`isConventionRescue`,
  `:236-239`) does not fire: a model sentence that merged narration with a
  turn (`Антон обернулся. — Ты кто?`), or a dash line the model gave to
  `unknown-male`/`unknown-female`. From the second sentence of such a run
  on, the result is `narration-demote` at 0.9, unflagged (`:276-286`; the
  run's first sentence is `narration-demote:first`, flagged at ≤ 0.5). The
  runner checks every passing decision's reason against these five
  (prefix match for the two `:<id>` forms, exact for the rest) and **fails
  the run** on any other, so a reason added later gets a class decision
  instead of a silent default;
- sentence `i`'s `final` id equals its `deterministic` id, so escalation
  left the engine's decision standing. For these five reasons the conjunct
  is vacuous today, because escalation rewrites only flagged lines
  (`escalation.ts:277-296`, AC4 M-b). It stays as a guard against that
  changing.

Each counted span is then **classified** by where its lowest-index sentence
sits in the merged arm's own post-recovery structure (`paras`, `alignment`
from `onStages`). A span whose sentences fall in different classes is
counted in that class **and** in a separate **mixed** tally:
- **(a) recovery-split line:** the sentence aligns into a line whose start
  offset is not a line start in the recovery-off parse of the same body
  (exact, because recovery is length-preserving). This is tag anchoring
  across a split-out line (`parser.ts:74-78`), scored
  `tag-correct`/`tag-confirm`;
- **(b) unsplit dash turn:** a turn sentence aligned only to `narration`
  spans in a narration-open paragraph, which recovery left unsplit
  (`parser.ts:717-729`), scored `narration-confirm` (the model said
  narrator) or `narration-demote` (the engine overrode the model);
- **(c) degraded dash-open paragraph:** the sentence's paragraph matches
  `dialogueOpen` **and** holds ≥ `MERGED_TURNS_DEGRADED`
  `TURN_IN_PARAGRAPH` matches (owner decision 8). Tags anchor across the
  merged speech there (`parser.ts:171`). The threshold is what keeps an
  ordinary dash paragraph out: `— Привет, — сказал Антон. — Как дела?` has
  one match (`. — Как`), a same-speaker resumption that is standard Russian
  typography (`parser.ts:47-48`), and is (d) now;
- **(d) other:** anything else, reported so nothing is dropped.
  `tag-span-narrator` (a sentence aligned only to tag spans) lands in (a),
  (c) or (d) by where it sits; it is never (b), which needs narration spans.

Every class is reported **by reason** as well as in total, so
`narration-demote` and `narration-confirm` in class (b) are never summed out
of sight.

The **clean-noise count** applies the identical rule to **C2** against C1
(C2's sentences, C2's reasons, C2's own post-recovery structure). C1 is never
counted against itself (AC3 C(c)).

**The verbless-tag downgrade (R5-11).** In a dash-open paragraph, a single
tag span with no speech or beat verb stem downgrades the **whole** paragraph
to one unanchored speech span (`parser.ts:163-168`). Its sentences then go
to `decideUnanchoredSpeech`, which flags them (`cross-examine.ts:100-116`),
or, where alternation fills the window, to an `alt-*` decision at ≤ 0.8.
Either way they never reach the confident count. A long merged dash-open paragraph has many tag spans, so it
is likelier to hit one. The runner therefore reports, per arm, how many
degraded dash-open paragraphs the parser reduced to a single unanchored
speech span, and how many class (c) spans the rest yielded. A thin class (c)
is then a measured fact about merged text, not a gap in the sample.

The runner's unit tests include one fixture per class (a), (b) and (c), with a
mock analyzer and a tag that anchors following speech to the wrong speaker,
and the counter must place each in its class. Further fixtures check: a
`tag-correct:<id>` reason is matched by prefix; a `narration-demote` run in
an unrescued narration-open paragraph is counted in (b); an ordinary
dash paragraph with one resumption is **not** (c); a downgraded degraded
dash-open paragraph is reported as downgraded; a two-sentence span with one
flagged sentence is not counted; and an unknown confident reason fails the
run.

- **The #2254 runner** (Phase 7): a committed, read-only server-side script,
  `server/scripts/paragraph-degradation-ab.mts`. It reads a manifest of
  `{ arm, chapterId, chapterTextPath, rosterPath }`, calls
  `captureChapterStages` per chapter, runs the 1A replays, calls the
  measurement, computes the §4.4 statistics and writes one JSON report plus a
  Markdown table. Like plan 265's runner it never runs in `test:all`, and its
  inputs (real books) are never committed.

### 4.4 On-box procedure (register row B110, Group B, owner-run)

**Prerequisites:**
- local Ollama on the owner's default analysis model, passed to the runner
  as `--model` and recorded;
- `analyzer.structure.enabled = true`, `allowCloudFallback: false`,
  escalation at the owner's default;
- the owner's library (Calibre and the workspace) on the box;
- no re-imports of library books: the scanner and the runner read text and a
  pinned roster and write only their reports and text dumps, to a scratch
  directory outside the workspace.

**Gate before step 2:** #4165 has merged (met: closed 2026-11-15, on `main`
at `1e295990`). The run notes the build it ran on.

1. **Library legibility scan (the false-positive check, and the reference
   pick).**
   - Run the Phase-7 scanner over the owner's library directory. It parses
     every file with `parseManuscript`, the import path, so what it measures
     is the **imported text** (owner decision 6). Formats: EPUB, MOBI, PDF,
     Markdown and plain text (`parsers/index.ts`).
   - Per book it reports: format; detected and declared language; per
     chapter, legibility (the maximum), `countTurnOpeners` (the sum) and
     dash-opening paragraph counts (paragraphs matching `dialogueOpen`,
     R5-6); the book maximum; and two flags:
     - **line-wrapped** (R5-9): a PDF, or a TXT in which ≥ 20% of non-blank
       lines directly follow another non-blank line (a single `\n`, no blank
       line between) **and** start with a lowercase letter (`\p{Ll}`). A hard
       wrap breaks lines mid-sentence, so its continuation lines mostly start
       lowercase; a one-paragraph-per-line file starts each line with a
       capital or a dash. (Revision 4's "median line under 100 characters"
       misfired: the clean committed fixture
       `the-coalfall-commission.ru-dash.md` has a median of 50, and scores
       0% on this test, because none of its lines directly follows another
       non-blank line.) The scanner prints each TXT's share, so the
       owner sees the margin. The measure under-reads line-wrapped books
       (§2), so they are reported but **do not count toward "no breach"**;
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
     and the threshold decision goes to the owner. An **extractor-merged
     (#4217)** chapter is a **true positive**, not a breach (owner
     decision 6), and is listed as such on the row.
   - No breach among books that are not line-wrapped →
     `MERGED_TURNS_DEGRADED` loses its provisional label, in a follow-up
     commit that cites this row. A non-ru Cyrillic book is reported
     separately (Decision 4).
2. **1A and 1C on real data: Ночной дозор.** No fresh whole-book analysis and
   no cache: the 2026-09-05 cache is gone, and nothing reads one.
   - **Text source (AC3 M7):** the **hydrated record's** chapter bodies
     (`getOrHydrateManuscript`, `store/manuscripts.ts:140`), the strings
     analysis and `GET /state` read, including any restructure held in
     `manuscript-hints.json`. The scanner dumps them once
     (`--dump <bookDir> --chapters <ids>`) to `.txt` in the scratch
     directory. The runner and the measurement both read that one file per
     chapter.
   - **Chapter pick (AC3 S4):** its 3 chapters with the highest
     `countTurnOpeners` (hidden turns), excluding ch3 (the one clean
     chapter). Record each chapter's hidden-turn count and dash-opening
     paragraph count.
   - Run the runner live on those chapters with its pinned roster.
   - Per chapter, record:
     - **1A (per model sentence, R4-1/R4-4):** the control result (pass or
       void); sentences whose post-crossExamine speaker differs, on vs off,
       over all sentences and over turn sentences; narrator share over turn
       sentences, on vs off; confirmed/corrected/flagged/unresolved each
       way. Every changed sentence is tagged with its class from the
       recovery-on structure ((a)–(d) as in §4.3). 1A has no model noise,
       because both arms replay one `raw`, so these are exact counts, not
       estimates. They describe one raw take;
     - **1C:** the live run's confident decisions (the §4.3 confidence,
       flag and escalation rule, all five reasons) on turn sentences,
       counted by class and by reason, with the downgrade count (R5-11).
       There is no clean twin, so there is no disagreement test here;
     - chunk shape and escalation's share (`final` vs `deterministic`).
   - **Hand-check (owner):** 30 random 1A-changed lines judged improvement,
     regression or neutral; and 30 confident 1C decisions, **10 from each of
     classes (a), (b) and (c)** where that many exist (otherwise all of them,
     with the remainder drawn from the largest class), each judged right or
     wrong against the text. These judgements are Ночной дозор's 1C
     evidence.
3. **Choose the clean reference by rule, not by name**, from step 1's scan.
   - Take the book with the most dash-opening turns across its densest
     chapters with legibility < 10, judged clean on its imported text in
     step 1, and not line-wrapped. Take its qualifying chapters densest
     first until they hold **≥ 1500 dash-opening turns, or 8 chapters**
     (R4-5). The book qualifies only with **≥ 300** turns **and ≥ 20 clean
     chunks** (R5-2, counted as in step 4) across what was taken. Fewer than
     20 chunks at 1500 turns means the book is dense enough that its chunks
     are large (the simulation's densest case, ≈ 90 chars per turn at a
     9000-char budget, gives 23 at 1500 and 18 at 1000), so the pick keeps
     adding chapters past 1500 turns until it reaches 20 chunks or 8
     chapters.
   - Record the choice, its chapters and its counts. *Юный дрессировщик* is
     clean but nearly dialogue-free, which is why revision 1's pick is
     withdrawn.
   - **No qualifying book** → skip steps 4–7. 1B and the twin half of 1C
     record **inconclusive: no qualifying reference** (R3-4), and the
     threshold stays provisional (§2).
4. **Build the pair, in one format.**
   - Export the chosen chapters once to plain `.txt`, with blank-line
     paragraphs.
   - Create the merged twin with `scripts/degrade-paragraphs.mjs` (Phase 7).
     **The rule (R4-3 as amended by R5-6 and R5-10), per chapter:**
     - a paragraph is a blank-line-separated block; it is **dash-opening**
       when it matches the language's `dialogueOpen`; a **run** is a maximal
       sequence of consecutive dash-opening paragraphs;
     - runs are numbered `i = 0, 1, 2, …` from the start of the chapter;
     - a run is joined into one **dash-open** paragraph (its internal
       separators removed, the separator before it kept) when `i mod 3 = 2`,
       when no paragraph precedes it, or when the paragraph before it is a
       **scene separator** (no attributable words, the
       `isSceneSeparatorUnit` test of `stage2-chunk.ts:152-153`). The last
       case keeps every scene break, and the chunk boundary it forces, in M;
     - every other run is folded into the **narration** paragraph before it
       (the separator before the run and its internal separators removed);
     - each removed separator is replaced by the same number of spaces, so
       the body length is unchanged.

     So about a third of runs become dash-open, more where scenes open on
     dialogue. Ночной дозор's real mix is 5 dash-open to 34 narration-open,
     so the twin over-represents dash-open on purpose. The reason is
     corrected in revision 5 (owner decision 8): the dash-open third is
     there to measure what that shape **costs**, and part of that cost is
     the verbless-tag downgrade (`parser.ts:163-168`), which turns a whole
     merged dash-open paragraph into one flagged, unanchored span. So class
     (c) may be thin even with a third of runs dash-open, and the runner
     reports the downgrade rate that explains it (R5-11, §4.3).
   - **Gates before spending model time:**
     - equal body lengths per chapter across the two arms;
     - clean legibility < 10 and merged ≥ 10 on every chapter;
     - both merge shapes present in the merged twin, with their turn counts
       recorded;
     - the clean body's recovery-on and recovery-off parses give the same
       span set (R4-2). Any difference is recorded with its count;
     - **the cluster floor (R5-2):** the clean chunks, computed as
       `splitBodyIntoChunks(body, resolveStage2ChunkCharBudget(capacity,
       body))` (`stage2-chunk.ts:142`, `:71-85`) with the `capacity` the
       runner resolves for the owner's engine and model, number **≥ 20**
       across the book. The budget takes the body as well as the capacity,
       because a request-cap capacity derives it from the body. This needs no
       model, so a book that fails it records **inconclusive: too few
       clusters** for 1B and the twin half of 1C, and no capture is run.
   - Mixed formats would break the whitespace-only difference between the
     arms that alignment and the clean-chunk clusters rely on (§4.3;
     `html-utils.ts` whitespace handling, `text.ts` normalisation, #938's
     front-matter split). The runner reads the `.txt` text directly, with no
     import.
5. **Three live captures** through the runner, one shared pinned roster, one
   shared escalation budget per arm:
   - **C1** clean;
   - **C2** clean again (noise);
   - **M** merged.
6. **Measure.** Every figure is on C1's reference span set: the `speech`
   spans of the clean body (R4-2), from `emitSpans`.
   - **1B (model, `raw`):** per span, `dM = [M.raw ≠ C1.raw]` and
     `dN = [C2.raw ≠ C1.raw]`. Narrator share, paired: per span,
     `nM − nC1` against `nC2 − nC1`, where `nX = [X.raw is narrator]`.
   - **1C (`final`, owner decision 4):** per span,
     `hM = [M.final ≠ C1.final]` and `hN = [C2.final ≠ C1.final]`. Both terms
     are on the same span set, so the difference is genuinely paired.
   - **1C confident disagreements:** M's count by class (a)–(d) and reason,
     with the mixed-class tally, against the clean-noise count, C2's count
     against C1 by the same rule (§4.3). The paired per-span
     indicator (`cM − cN`) is bootstrapped like the others. The per-class
     counts are reported but get no per-class verdict, because they are too
     small for one.
   - **1A on the twin:** M's on vs off replays, as in step 2.
7. **Confirm (R4-6).** If 1B or 1C reads *degrading* or *not degrading*,
   capture **M2** (merged again), recompute that verdict with M2 in place of
   M, and record both. The verdict stands only if M2 gives the same one;
   otherwise it is *inconclusive: unstable across merged runs*.

**Verdicts (pooled, paired, clustered).** Pool the spans of all chapters.
For each comparison the statistic is the mean paired difference
(`dM − dN`, `(nM − nC1) − (nC2 − nC1)`, `hM − hN`, `cM − cN`).

- **Clusters (owner decision 7).** Errors cluster by chunk (stage 2
  attributes each chunk in one call, a coverage retry re-attributes a whole
  section, and alternation fills whole windows), so spans are not resampled
  one by one. A **cluster** is one of the **clean** body's stage-2 chunks,
  recomputed as `splitBodyIntoChunks(body, resolveStage2ChunkCharBudget(
  capacity, body))` (lossless, so the offsets are exact). C1 and C2 are one
  body at one budget, so they share these chunks exactly. Every reference
  span belongs to the chunk containing its start offset, and M's values on
  that span go with it. M's own chunks play no part in the clustering.
  Revision 4's union of all three arms' chunks chained into 1.5–7 clusters
  per chapter (AC4 C1), because once one clean boundary falls inside a
  merged run the two packers never realign.
- **Bootstrap:** resample whole clean chunks, with replacement, from the
  book's pool (not stratified by chapter, R5-1); 2000 resamples; fixed seed;
  in the runner. The statistic is span-weighted: the resampled sum of
  per-span differences over the resampled span count.
- **Degrading:** 95% CI lower bound > 0 **and** point estimate ≥ 5 pp.
- **Not degrading:** 95% CI upper bound < 5 pp.
- **Inconclusive:** anything else; fewer than 300 pooled dash-opening turns;
  fewer than **20 clean chunks for the book** (R5-2, checked in step 4
  before any capture); or an R4-6 disagreement.

**Power, stated honestly (owner decision 7).** These figures come from a
simulation, not a formula: AC4's `cluster-sim.mjs`, extended as
`cluster-sim-r5.mjs` (same packer, degrade rule, generator and seed; not
committed). Its model:
- ru-like chapters of about 41k chars, a scene break about every 15k chars,
  at two densities: AC4's mix (≈ 176 chars per dash turn) and a
  Ночной-дозор-like one (≈ 90);
- two budgets, 9000 (the default) and 4915 (local `num_ctx` 8k);
- each arm wrong on 8% of spans, so C2 disagrees with C1 on about 15%; a
  wrong answer is one of 4 others; M wrong on 8% plus the effect;
- per-chunk error rates drawn from a Beta with intra-chunk correlation
  ρ = 0.1 or 0.2. C1's and C2's errors cluster on the clean chunks; **M's
  cluster on M's own chunks**, which straddle the clean ones. So the
  simulation tests the bootstrap against clustering it does not resample;
- 200 replicates × 800 bootstrap resamples per cell, so each probability
  carries about ±3 pp of Monte-Carlo noise (±1 pp near 0% or 100%).

ρ and the error rate are **assumptions**, not measurements; the runner
reports the achieved SE, which absorbs whatever ρ really is.

**Cluster sizes.** A clean chunk holds **20–97 dash turns**: 20–27 at the
4915 budget and 29–48 at 9000 for AC4's density, 39–54 and 65–97 at the
Ночной-дозор-like density. That is below AC4's 30–410 per union cluster,
because a clean chunk is one chunk, not a chain. A 17k-char chapter has 2–5
clean chunks, a 41k one 5–11, a 116k one 14–30.

**Power.** Ranges are across the four density × budget settings and both ρ.
"Degrading" includes the ≥ 5 pp point-estimate conjunct:

| Pooled dash turns | Clean chunks (book) | Bootstrap SE | Effect *degrading* catches with 80% power | P(*degrading*) at a 4–5 pp effect | P(*not degrading*) when the true effect is 0 |
|---|---|---|---|---|---|
| 300 | 6–22 (only one setting reaches the floor of 20) | 3.3–6.5 pp | ≈ 12 pp at best; > 15 pp in most settings | 20–34% | 32–44% |
| 1000 | 18–53 (the densest setting at 9000 misses the floor) | 2.0–4.3 pp | ≈ 7–16 pp | 19–41% | 31–72% |
| 1500 | 23–72 | 1.6–3.7 pp | **≈ 7–14 pp** | 24–41% | **31–89%** |

The bootstrap is honest enough at the floor and not below it. With 18 or
more clean chunks, at zero effect its SE is within about 15% of the
estimator's true spread (up to about 20% low once an effect is present), and
a true zero effect reads *degrading* 1–5% of the time. With 6–12 chunks the
SE is 14–27% low at zero effect, and a zero effect reads *degrading* 5–9% of
the time. That is why the floor is 20 (R5-2). Because the SE runs a little
low even above the floor, the achieved detectable effect below is a slight
underestimate.

**What the twin can and cannot conclude.** Plainly:
- At 1500 turns it can reach *degrading* when merging changes the answer on
  about **7–14 more spans in 100** than a clean re-run does. Revision 4's
  table said 4.5–6 pp; that figure ignored both the 5 pp conjunct and the
  real cluster size.
- An effect of about 5 pp, the size of the conjunct itself, is caught less
  than half the time (24–41%) at any size this run can afford.
- *Not degrading* is the hard verdict. With no effect at all, the twin says
  so in only 31–89% of runs, and in the rest it reads *inconclusive*. An
  *inconclusive* twin is therefore the **expected** outcome whenever the
  true effect is small, and it means "no effect larger than the achieved
  detectable effect was seen", never "no effect".
- Below 1000 turns, or at a 9000 budget on a very dialogue-dense book, the
  book may not reach 20 chunks. The twin then returns *inconclusive: too few
  clusters* before any model time is spent.
- An effect of the size Ночной дозор showed before #2253 (ch5 69.7% narrator
  after the engine against 11.4% from the model, §1.4) is far above every
  detectable effect here. The twin would see a regression of that kind.

The runner reports the **achieved** detectable effect next to every verdict
as `max(2.8 × SE, 5 pp + 0.84 × SE)` (R5-12), which accounts for the
conjunct and sits 0.3–1.5 pp below the simulation's 80%-power points. The
cluster bootstrap captures within-run clustering. It does not capture M's
own run-to-run variance, which only the C2 term (for clean) and R4-6's M2
(for merged) estimate. With the floor now a book total, R4-6 can fire
whenever a verdict is not *inconclusive* (AC4 noted that under revision 4
it never could).

**On-box cost (AC4 M-j).** The only rate on record is the 2026-09-05 Group C
run: ≈ 121 s of GPU per 1,000 chars, 35–233 min per chapter, 12 h 27 m for
the whole of Ночной дозор on `qwen36-cw-iq4-32k`
(`night-watch-reanalysis-onbox-acceptance.md:608-609`). That is a
**whole-analysis** rate (stage 1, stage 2 and escalation). The harness runs
stage 2 and escalation from a pinned roster, so it should be faster, but by
an unmeasured amount. The figures below are therefore **upper bounds**:

| Step | Work | GPU time (upper bound) |
|---|---|---|
| 1 · library scan | parse only | none |
| 2 · Ночной дозор | 3 chapters, one live capture each; the 1A replays need no model | ≈ 2–12 h (3 × 35–233 min; the chapters with the most hidden turns are the long ones, so expect the upper half) |
| 4 · gates | parse and chunk only | none |
| 5 · twin C1, C2, M | 3 captures of ≈ 1500 turns, ≈ 135k–264k chars each (≈ 90–176 chars per turn) | ≈ **14–27 h** (4.5–8.9 h per capture) |
| 7 · M2, only after a non-inconclusive verdict | one more capture | + 4.5–8.9 h, so ≈ **18–36 h** for the twin in all |
| **Total** | | **≈ 16–48 h**, in sittings |

The runner prints each capture's wall-clock and, after its first chapter, an
estimate for the rest, so the owner can stop a capture that is running far
over. Every step is resumable per chapter, because the runner writes one
report entry per captured chapter. AC4 estimated 12–34 h from the
per-capture figures alone; this table also costs the Ночной дозор step.

**Recorded outcomes:**
- **1B:** *model-degrading* / *not model-degrading* / *inconclusive*.
- **1C:** *merging changes the final answer* / *no measurable change* /
  *inconclusive*, with the confident-disagreement counts by class and
  reason, the mixed-class tally, the downgrade count, the clean-noise count,
  the clean-chunk count and the achieved detectable effect stated either
  way.

**Every outcome discharges the row** (R3-4). The verdicts go onto #2254 and
close blocker 1. They decide whether the issue's "Effect" claim stands, is
downgraded, or stands only on the Ночной дозор evidence with the missing twin
named as the limit. If 1C finds a change concentrated in one class, a fix to
that lever (tag anchoring in dash-open paragraphs, or recovery's evidence
rule) is new design work. It is filed then, not designed here.

### 4.5 Committed-fixture limits

- The Castwright-owned dash text (13 turns) is far below the 300-turn power
  floor. It feeds the committed 1A arms (§4.2) and the tools' unit tests,
  and gives no 1B/1C verdict.
- `the-coalfall-commission.ru.md` uses «» quotes, which recovery and
  legibility ignore.
- If no clean reference exists (§4.4 step 3), the authored fixtures are the
  **only** calibration of the threshold. The regression plan states this
  limit, and the threshold stays provisional.
- What is committed: the 1A arms and the characterisation test,
  `runStructureEngine` and the `onStages` additions, `captureChapterStages`,
  the recovery-off switch and `emitSpans`, the legibility exports, the
  degrade script, the scanner and the runner, all with unit tests.
- What is never committed: the real books, their text dumps, their rosters,
  and the runner's and scanner's reports. Only the verdict tables and the
  scan summary go on #2254 and into the run sheet.

### 4.6 Register row: draft text

ID: **next free Group B id at merge time** (`B110` at `c16da893`). Phase 8 is
**main-thread work** (owner decision 3, 2026-11-15). The row ships with:
- the run sheet `docs/testing/paragraph-degradation-onbox-acceptance.md`;
- the live-view HTML edit;
- `npm run register:build` and `npm run check:onbox-register`;
- `--against-published`, then a publish to the register's recorded URL, per
  the register's own four-step procedure.

> ### B1xx · Does merged paragraphing change who speaks? ([#2254](https://github.com/dudarenok-maker/Castwright/issues/2254))
>
> **Prerequisite:** local Ollama analyzer (model recorded), structure engine
> on, escalation at default, no TTS, the owner's library on the box. No
> re-imports; the tools write only their reports and text dumps, outside the
> workspace.
>
> **Observe:** (1) the library legibility scan over every format, on the
> **imported** text: per-book maxima, the worst imported paragraph of each
> flagged chapter judged merged or clean, any clean-judged chapter ≥ 10 (a
> breach of the provisional threshold), chapters labelled extractor-merged
> (#4217) listed as true positives, line-wrapped books listed but not
> counted, and non-ru Cyrillic books listed separately; (2) Ночной дозор,
> the 3 chapters with the most hidden turns, live capture: the replay
> control, post-crossExamine speakers changed by recovery on vs off per model
> sentence (1A), confident decisions on turn sentences by class and reason,
> including the engine's `narration-demote` overrides (1C), and two
> 30-line hand-checks; (3) if a clean ru dash book with ≥ 300 turns exists,
> up to 1500 turns of it and its same-format two-shape
> `degrade-paragraphs.mjs` twin (equal lengths; clean < 10, merged ≥ 10),
> captured live as clean ×2 and merged ×1 (×2 to confirm a verdict), with raw
> (1B) and final (1C) compared by a paired bootstrap over the clean twin's
> stage-2 chunks. GPU time, upper bound: ≈ 2–12 h for (2), ≈ 14–36 h for (3).
>
> **Outcome (not a pass bar):** 1B *model-degrading* / *not* /
> *inconclusive*; 1C *changes the final answer* / *no measurable change* /
> *inconclusive* (CI lower bound > 0 and ≥ 5 pp; CI upper bound < 5 pp;
> otherwise, < 300 turns, < 20 clean chunks, or M2 disagreeing), each with
> its achieved detectable effect. *Inconclusive* is the expected twin outcome
> for a small true effect. Every outcome discharges: record the tables, the
> verdicts, the scan, who/when, and post them on #2254.
>
> **Criteria:** `docs/testing/paragraph-degradation-onbox-acceptance.md`.

## 5 · Phased rollout (each phase ≈ one agent commit)

**Branching.** Every phase except 3, 8 and 9 touches `server/` (see the Scope
column), and all of 0–7 run as **one serial chain** in one worktree:
0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Phase 3 is frontend-only, but it sits in the
chain rather than in a parallel lane: it consumes Phase 2's wire field, and
Phase 4 edits the same `src/lib/types.ts` and `src/lib/api.ts`. Integration
follows CLAUDE.md: one PR for the round, with a `docs/features/` regression
plan and an `INDEX.md` row added in Phase 1.

| # | Phase | Scope | Tier | Paired tests | Ships |
|---|---|---|---|---|---|
| 0 | F3 deletion (Decision 5). F1 (#4165) is merged and F2 discharged with it (R5-13); F4 is **#4217** (filed) | server | Cheap | test removal paired with the deletion | — |
| 1 | `MERGED_TURNS_DEGRADED` (provisional), `isParagraphDegraded`, `NOTICE_LANGUAGES`, `TURN_IN_PARAGRAPH` factory, `countTurnOpeners`; regression plan + INDEX | server, docs | Cheap | unit: 9/10 edge; `undefined` for null, out-of-scope and no-convention languages; `countTurnOpeners` sum vs `measureChapterLegibility` max on one fixture; the factory returns a fresh regex | — |
| 2 | Import `paragraphsMerged` + openapi + `openapi:types` + **hand-edit `src/lib/types.ts` `ImportCandidate`** + route test | server, frontend types | Default | route test | — |
| 3 | Confirm Heads-up + client `NOTICE_LANGUAGES` mirror + mock mirror + `e2e/responsive/` spec with its 375 px chromium case | frontend, e2e | Default | component + e2e | both release-notes files |
| 4 | `GET /state` `paragraphsMergedChapters` + `WeakMap` memo (unfiltered ids, per-request exclusion, R4-7/R5-7 omission via `assertHintsPairWithState` with `parseTitles`) + openapi + `src/lib/types.ts:455` + mock `/state` + `chapters-slice` + manuscript caption + e2e case | server, frontend, e2e | Default | route (incl. compute-once, toggle-after-cache, count mismatch, same-count title mismatch), slice, component, e2e | both release-notes files |
| 5 | Characterisation test first, then extract `runStructureEngine` (`:3714-3727`; `:3728` stays in the caller; zero behaviour change) + `structureOptions` seam + `onStages` `stage1`/`paras`/`alignment` + 1A arms 1 and 2 | server | Default | characterisation (4 inputs, `toEqual` on the pre-existing fields, committed before the additions) + a separate new-fields assertion; `analysis.structure-fixture.test.ts`; existing `attributeChapterStage2` tests green | none (say so) |
| 6 | `recoverMidParagraphTurns` switch + `emitSpans` (speech spans only, `split.hasOrphan`) on `computeAttributionMeasurement` | server | Default | `attribution-health.test.ts`: switch-off span count; span records reproduce every aggregate, including `orphanSpoken` through `hasOrphan`; off = unchanged | none (say so) |
| 7 | Extract `captureChapterStages` from `evalFixture` (+ capacity, shared budget, chunk counters) + `degrade-paragraphs.mjs` (two shapes, `dialogueOpen`, 0-based runs, separator rule) + library scanner (formats, sums, continuation line-wrap test, EPUB rewritten-copy #4217 what-if, worst paragraph, `--dump`) + `paragraph-degradation-ab.mts` runner (replay control, `emitSpans` pairing, all-sentences confident rule over the five reasons, classes (a)–(d) + mixed, downgrade count, clean-chunk floor and pooled bootstrap, achieved detectable effect, wall-clock and estimate, M2 recompute) | server, scripts | Default | `run-eval.test.ts` green; degrade (length equality, determinism, threshold crossing, both shapes, run numbering from 0, a run after `* * *` stays dash-open and the separator survives); scanner (multi-format fixtures, the clean ru-dash fixture **not** line-wrapped and a hard-wrapped TXT fixture flagged, a `<div>`-paragraphed EPUB fixture labelled extractor-merged, a MOBI reported not computed); runner (fixture capture with a mock analyzer, a replay-control mismatch reported void, the §4.3 class and reason fixtures, an unknown confident reason fails the run, clusters equal the clean chunks, a < 20-chunk book is inconclusive before capture, bootstrap on a seeded synthetic set with a known effect) | none (say so) |
| 8 | Register row + run sheet + live view + `--against-published` + publish | docs | **Main thread** | `check:onbox-register`, `register:build` | — |
| 9 | **Owner, on-box:** row B110 → verdicts on #2254 → discharge | — | — | — | Closes #2254 with 3, 4 and 9 done |

**Dependencies:**
- 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9, all serial.
- 7 needed #4165 merged (§1.5 F1); that is met at `1e295990`.
- **No UI phase waits on the false-positive scan.** It is row B110 step 1
  (§2).

**Out of scope:**
- better-source acquisition;
- changes to the recovery gate;
- #4217's extractor change (its own design pass; the scanner's what-if is
  diagnostic only);
- recovering bare third-person tags, or re-anchoring tags in dash-open
  paragraphs (file either only if B110 shows a change *and* points at that
  lever);
- escalation's compensation for recovery-off flags (§4.1 limits);
- script review's use of recovered evidence (§4.1);
- es/fr calibration (Decision 4);
- English.
