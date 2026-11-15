---
status: draft
issue: 2254
refs: [2253, 2267, 2275, 2306, 2320, 4165, 4217]
date: 2026-11-13
revision: 4 (owner decisions on the PR #4184 assumption-checker pass 3, 2026-11-15)
decisions: owner decisions 1–6 of 2026-11-15 are binding and are written in below (1–3 drove revision 3, 4–6 drive revision 4); the items under "Decisions made in revision 4" (and the surviving ones from revision 3) are owed owner confirmation
gate: assumption-checker pass 3 on revision 3 did not clear it; revision 4 needs a fresh pass before decomposition
---

# Paragraph-degradation signal: surfacing it, and proving what it costs (#2254)

Filename when committed:
`docs/superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md`.
Design thread only. No code is written here. Verified against `main` @
`c16da893` (revision 3 was verified @ `a9918640`, revision 2 @ `3792b84b`;
every anchor below was re-read at `c16da893`). Paths under
`attribution-eval/` mean `server/src/analyzer/attribution-eval/`; paths under
`dialogue-structure/` mean `server/src/analyzer/dialogue-structure/`.

**Scope authority.** CLAUDE.md lists "New features" as out of scope until told
otherwise. #2254's close-blocker 2 (owner comment, 2026-08-13: "wire the signal
into the import/analysis surfacing so a degraded book is flagged") is that
instruction. It covers the user-facing surface designed here and nothing
beyond it.

## Revision 4 changelog

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
| S1 | Spans aren't independent; 5 pp is a coin flip at 300 turns; narrator share has no noise term | Cluster bootstrap over **chunk clusters** (§4.4 "Verdicts"). Realistic power stated: at 300 turns the minimum detectable effect is about 10–14 pp, not 5. The reference run adds chapters up to 1500 turns (about 5 pp) (R4-5). The narrator-share comparison is now paired against C2. A non-inconclusive verdict is re-checked on a second merged capture (R4-6) |
| S2 | `computeAttributionMeasurement` returns totals only; no instrument produces per-span vectors | Phase 6 adds an opt-in `emitSpans` output: one record per source span with its value (resolved id, split, unattributed, orphan) and its sentence indices, from the module's own parse and alignment (§4.3 "Measurement"). The split/unattributed rule is defined |
| S3 | The replay lacks the deduplicated roster; live-vs-replay mixes two code paths | `onStages` gains the deduplicated `stage1` the engine used, and the post-recovery `paras` and `alignment`. 1A now compares **two replays** (recovery on vs off), and the recovery-on replay must reproduce live `deterministic` exactly, or that chapter's 1A is void (§4.3 "1A engine replay") |
| S4 | Ночной дозор's 1A/1C measures miss hidden turns; the chapter pick favours the least-merged chapters | 1A on Ночной дозор is **per model sentence** (one raw, so both arms share one sentence list), over **turn sentences** defined from the text, not from spans (§4.3). Chapters are picked by **hidden-turn count** (sum of mid-paragraph turn openers), not dash-opening turns (§4.4 step 2) |
| S5 | "Much of the dialogue … for each speaker" is not implied by a max-in-one-paragraph measure; "cannot occur in clean text" is a calibration property | Both wordings now claim only what the measure counts: one paragraph with ten or more dialogue dashes mid-paragraph, where each line would **usually** start its own paragraph (§3.1, §3.2). §2 and Decision 4 state "cannot occur in clean text" and the uk/bg extension as **calibration results** (#2267 §2.1), not constructions |
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

## Decisions made in revision 4 (owner to confirm)

These are choices owner decisions 4–6 did not settle. Each one is the option
most consistent with them.

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
  guess an id mapping (`store/manuscripts.ts:213`, the `hintsFromParse`
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
> measured and how B110 step 1 judges "clean"; they are written into §4 and
> listed at the end of this section.

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
     text** of a chapter has a paragraph with ten or more dialogue dashes in
     the middle of it, where each line would usually start its own paragraph,
     and that a different copy or format may help. The count and the single
     paragraph are true by construction of the measure. That such a paragraph
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
     - Dash-open paragraphs skip recovery (`paragraph-recovery.ts:99`), yet
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
  (`paragraph-recovery.ts:118-127`). So a recovered line is exactly a line
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
3. **Stale "opt-in / Default OFF" comments:** `paragraph-recovery.ts` header
   (line 5, "Opt-in, conservative recovery") and `:45` ("Default OFF"); suite
   title `paragraph-recovery.test.ts:13`; PR #2320's title.
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

- **F1 (#4165, open, separate chain):** UTF-16 vs code-point index mismatch
  in `paragraph-recovery.ts`. **Not** part of this rollout. Phase 7's tools
  must merge after #4165, or tolerate either behaviour.
- **F2 (chore):** the stale comments in §1.4 item 3. Phase 0.
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
  - exports of the existing `DASH` and `TURN_IN_PARAGRAPH` patterns (as
    fresh-`RegExp` factories, so no caller shares `lastIndex` on a `g`
    regex), plus `countTurnOpeners(body): number`, the **sum** of matches
    over the chapter. The scanner and the runner use these (R4-4, §4.4
    step 2). `measureChapterLegibility` keeps its own behaviour.

  Every server surface calls these. The client mirrors only
  `NOTICE_LANGUAGES` (§3.1) and the mock's threshold (§3.1 M), each with a
  comment naming its source of truth.
- **What is true by construction, and what is calibration.** By construction:
  the flag means that **one** paragraph of the imported text contains **ten
  or more** places where a sentence ends and a dash plus a capital letter
  follows. The notices claim exactly that, in plain words (§3.1, §3.2), and
  nothing about speakers or about who merged it. By **calibration**, not
  construction: that such a paragraph is merged dialogue. The legibility
  design says so itself ("false positives are sparse and merges are dense …
  the property the whole design now rests on", #2267 §2.1). Russian
  typography does allow several speakers' replies with no author's words to
  share one paragraph, so the wording says each line would **usually** start
  its own paragraph.
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

**Wording** (claims only what the measure counts, S5; final pass through
`castwright-voice`, which may rephrase but must keep "a paragraph", "ten or
more", "imported text" and "usually"):

> **Heads-up:** in 5 chapters (Chapter 4, Chapter 5, Chapter 6 and 2 more),
> the imported text has a paragraph with ten or more lines of dialogue run
> together, where each line would usually start its own paragraph. This often
> happens when a book is converted between formats. A different copy or
> format of this book may give a better result.

"Lines of dialogue run together" is the plain-words reading of "ten or more
sentence-end + dash + capital openers in one paragraph", the one thing the
measure counts. The wording asserts no share of the chapter, no speaker
change and no cause. That keeps it true when Castwright's own extractor did
the merge (F4, #4217).

**Mobile/touch:**
- Static text, nothing interactive, so no 44 px obligations.
- At 375 px the box (`-mt-2 px-4 py-2.5 text-xs` padding, three titles) runs
  to about **9–10 lines**. That is acceptable inside the scrolling confirm
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
     `hintsSource: 'parse'` with a chapter count different from
     `state.json`'s (R4-7).
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

**Wording** (same claim as A; final pass through `castwright-voice` under the
same constraints):

> In the imported text, this chapter has a paragraph with ten or more lines
> of dialogue run together.

**Mobile/touch:** a wrapping, non-interactive caption. There is no
hover-only content (touch-equivalence rule).

**Tests:**
- route test: merged ru → id listed; English, null language and missing
  record → key absent; excluded chapters omitted, **including after an
  exclude toggle on the same cached record** (the filter is per request);
  `parse`-hinted chapter-count mismatch → key absent; **two requests on one
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
engine branch (`analysis.ts:3714-3728`: `buildNameIndex` →
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
  `analyzer.structure.enabled && conventions` gate (`:3712-3713`), the
  `detSnapshot` clone right after crossExamine (`:3729`), escalation
  (`:3735-3767`, which consumes `examined.sentences`, `examined.flags`,
  `paras` and `rosterIds`), `structureReport` (`:3769`, which reads
  `conventions.language`), the log line, the `applyNarratorDefault`
  else-branch (`:3783-3792`) and `annotateSceneBreaks` (`:3799`).
- **`onStages` gains three fields** (additive; only the harness passes
  `onStages`): `stage1`, the deduplicated roster the engine used; and, in the
  engine branch only, `paras` and `alignment`, cloned when crossExamine
  returns. That is what §4.3's replay and classification need without
  re-deriving anything.
- **Zero-behaviour-change proof.** Before the extraction, the Phase-5 agent
  commits a characterisation test that records `attributeChapterStage2`'s
  `sentences`, `structureReport` and `onStages` payload for four inputs:
  engine on; `flagOnly` (alignment below the 80% floor); knob off; and a
  language with no conventions. The extraction must leave all four
  byte-identical (deep-equal), and the existing tests stay green.

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
  - the chunk boundaries also define the bootstrap's clusters (§4.4).

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

**Turn sentences (R4-4).** A model sentence is a **turn sentence** when its
text opens with a dialogue dash (`DASH` then whitespace) or contains a
`TURN_IN_PARAGRAPH` match. This is decided from the text, so it includes the
hidden turns that sit inside a narration span and add no speech span to any
span set (AC3 S4).

**Measurement (Phase 6, a server change):**
- `computeAttributionMeasurement` (`store/attribution-health.ts:139`) already
  takes explicit `bodies` and `sentences` (input type `:86-108`). It gains
  two optional inputs. Both defaults keep library behaviour unchanged:
  - `recoverMidParagraphTurns?: boolean` (default `true`), passed to its
    `parseChapterStructure` call (`:171`);
  - `emitSpans?: boolean` (default `false`). When true, the result carries
    `spans: SpanRecord[]`, one per `speech` and `tag` span, in body order:

    ```
    SpanRecord = {
      chapterId, start, end, kind: 'speech' | 'tag',
      dashOpenedPara: boolean,
      value: { kind: 'id', id } | { kind: 'split' } | { kind: 'unattributed' } | { kind: 'orphan', id },
      narrator: boolean,           // value is an id in NARRATOR_CHARACTER_IDS
      sentenceIndices: number[],   // into the input `sentences` array
    }
    ```

    The values come from the classification the function already performs
    (`unattributedSpeech`, `splitSpeech`, `orphanSpoken`, the resolved id).
    It adds **no** new predicate, which honours the module header
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
  - `recoverMidParagraphTurns` left at its default (on), plus `emitSpans`.

  Equal per-chapter body lengths (§4.4 gate) give offset identity, so the
  merged arm's sentences align against the clean body's spans. Recovery is
  length-preserving (§1.2), so it never breaks that identity.
- Server unit tests in `attribution-health.test.ts`: the same body and
  sentences with the switch off yield the pre-#2320 span count (no recovered
  spans); `emitSpans` records reproduce every aggregate field exactly
  (counts of each `value` kind and of `narrator` equal the totals); and with
  `emitSpans` off, the output is unchanged.

**Comparing model quality (1B):** compare `raw` with `raw` across arms, never
post-engine output. Post-engine output mixes in the engine's corrections, and
those differ by structure by design. 1C reports post-engine output
explicitly.

**1C confident disagreements (owner decisions 4 and 5).** A merged-arm span
counts when all of these hold:
- the span disagrees with the clean twin's `final` (C1) on the reference span
  set;
- the merged arm's deciding sentence (the one sentence in
  `sentenceIndices`; a split span is counted under "split", not here) has a
  `deterministic` reason matching, **by prefix**, `tag-correct:`,
  `tag-confirm:` or `narration-confirm` (`cross-examine.ts:130`, `:144`,
  `:274`);
- its `deterministic` confidence is ≥ 0.9 and it is not flagged;
- its `final` id equals its `deterministic` id, so escalation left the
  engine's confident decision standing.

Each counted span is then **classified** by where its sentence sits in the
merged arm's own post-recovery structure (`paras`, `alignment` from
`onStages`):
- **(a) recovery-split line:** the sentence aligns into a line whose start
  offset is not a line start in the recovery-off parse of the same body
  (exact, because recovery is length-preserving). This is tag anchoring
  across a split-out line (`parser.ts:74-78`), scored
  `tag-correct`/`tag-confirm`;
- **(b) unsplit dash turn:** a turn sentence aligned only to `narration`
  spans in a narration-open paragraph, which recovery left unsplit
  (`parser.ts:717-729`), scored `narration-confirm`;
- **(c) dash-open merged paragraph:** the sentence's paragraph opens with a
  dash and has ≥ 1 `TURN_IN_PARAGRAPH` match. Tags anchor across the merged
  speech there (`parser.ts:171`);
- **(d) other:** anything else, reported so nothing is dropped.

The **clean-noise count** applies the identical rule to **C2** against C1
(C2's deciding sentence, C2's reasons, C2's own post-recovery structure).
C1 is never counted against itself (AC3 C(c)).

The runner's unit tests include one fixture per class (a), (b) and (c), with a
mock analyzer and a tag that anchors following speech to the wrong speaker,
and the counter must place each in its class. A fourth fixture checks that a
`tag-correct:<id>` reason is matched by prefix.

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

**Gate before step 2:** #4165 has merged, or the run notes which build it ran
on.

1. **Library legibility scan (the false-positive check, and the reference
   pick).**
   - Run the Phase-7 scanner over the owner's library directory. It parses
     every file with `parseManuscript`, the import path, so what it measures
     is the **imported text** (owner decision 6). Formats: EPUB, MOBI, PDF,
     Markdown and plain text (`parsers/index.ts`).
   - Per book it reports: format; detected and declared language; per
     chapter, legibility (the maximum), `countTurnOpeners` (the sum) and
     dash-opening paragraph counts; the book maximum; and two flags:
     - **line-wrapped:** a PDF, or a TXT whose median non-blank line is
       shorter than 100 characters. The measure under-reads these (§2), so
       they are reported but **do not count toward "no breach"**;
     - **#4217 exposure** (EPUB and MOBI, R4-8): the number of block
       closers `stripHtml` drops in each chapter's HTML, and the legibility
       that chapter would have if they were breaks. A flagged chapter that
       falls below 10 under that what-if is labelled **extractor-merged
       (#4217)**. The book list shows these first, so the owner can see
       which books #4217 affects.
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
     - **1C:** the live run's confident decisions (the §4.3 reason,
       confidence and escalation rule) on turn sentences, counted by class.
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
     (R4-5). The book qualifies only with **≥ 300** across what was taken.
   - Record the choice, its chapters and its counts. *Юный дрессировщик* is
     clean but nearly dialogue-free, which is why revision 1's pick is
     withdrawn.
   - **No qualifying book** → skip steps 4–7. 1B and the twin half of 1C
     record **inconclusive: no qualifying reference** (R3-4), and the
     threshold stays provisional (§2).
4. **Build the pair, in one format.**
   - Export the chosen chapters once to plain `.txt`, with blank-line
     paragraphs.
   - Create the merged twin with `scripts/degrade-paragraphs.mjs` (Phase 7,
     R4-3). It folds each run of dash-opening paragraphs into a
     **narration-open** or a **dash-open** merged paragraph by the R4-3
     rule, and replaces each removed separator with an equal number of
     spaces.
   - **Gates before spending model time:**
     - equal body lengths per chapter across the two arms;
     - clean legibility < 10 and merged ≥ 10 on every chapter;
     - both merge shapes present in the merged twin, with their turn counts
       recorded;
     - the clean body's recovery-on and recovery-off parses give the same
       span set (R4-2). Any difference is recorded with its count.
   - Mixed formats would break offset identity (`html-utils.ts` whitespace
     handling, `text.ts` normalisation, #938's front-matter split). The
     runner reads the `.txt` text directly, with no import.
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
   - **1C confident disagreements:** M's count by class (a)–(d), against the
     clean-noise count, C2's count against C1 (§4.3). The paired per-span
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

- **Clusters (AC3 S1).** Errors cluster by chunk (stage 2 attributes each
  chunk in one call, a coverage retry re-attributes a whole section, and
  alternation fills whole windows), so spans are not resampled one by one.
  A **cluster** is a connected run of body offsets formed by the union of
  the arms' stage-2 chunk intervals: each arm's chunks are recomputed with
  `splitBodyIntoChunks(body, capacity)` (lossless, so the offsets are
  exact), and overlapping chunks across C1, C2 and M are merged into one
  cluster. Every span belongs to the cluster containing its start.
- **Bootstrap:** resample whole clusters, with replacement, within each
  chapter (chapter-stratified); 2000 resamples; fixed seed; in the runner.
- **Degrading:** 95% CI lower bound > 0 **and** point estimate ≥ 5 pp.
- **Not degrading:** 95% CI upper bound < 5 pp.
- **Inconclusive:** anything else, fewer than 300 pooled dash-opening turns,
  fewer than 10 clusters per chapter on average, or an R4-6 disagreement.

**Power, stated honestly.** Planning figures, assuming each arm disagrees
with C1 on 10–20% of spans, within-cluster correlation about 0.1 and about
10 turns per cluster (design effect about 1.9). The minimum effect detectable
with 80% power is about 2.8 × the clustered standard error:

| Pooled dash-opening turns | Clustered SE of the paired difference | Detectable effect (80% power) |
|---|---|---|
| 300 | 3.6–5.0 pp | **about 10–14 pp** |
| 1000 | 2.0–2.8 pp | about 5.5–8 pp |
| 1500 | 1.6–2.2 pp | **about 4.5–6 pp** |

So revision 3's "a 5 pp effect is detectable at 300 turns" was wrong: at
300 turns only an effect of 10 pp or more is reliably seen, and "not
degrading" is rarely reachable. That is why R4-5 takes chapters up to 1500
turns. The runner reports the **achieved** detectable effect (2.8 × its
bootstrap SE) next to every verdict, so a book that stops short of 1500
yields "no effect larger than N pp could be seen", not a false "not
degrading". The cluster bootstrap captures within-run clustering. It does not
capture M's own run-to-run variance, which only the C2 term (for clean) and
R4-6's M2 (for merged) estimate.

**Recorded outcomes:**
- **1B:** *model-degrading* / *not model-degrading* / *inconclusive*.
- **1C:** *merging changes the final answer* / *no measurable change* /
  *inconclusive*, with the confident-disagreement counts by class, the
  clean-noise count and the achieved detectable effect stated either way.

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
> sentence (1A), confident decisions on turn sentences by class (1C), and two
> 30-line hand-checks; (3) if a clean ru dash book with ≥ 300 turns exists,
> up to 1500 turns of it and its same-format two-shape
> `degrade-paragraphs.mjs` twin (equal lengths; clean < 10, merged ≥ 10),
> captured live as clean ×2 and merged ×1 (×2 to confirm a verdict), with raw
> (1B) and final (1C) compared by paired, chunk-clustered bootstrap.
>
> **Outcome (not a pass bar):** 1B *model-degrading* / *not* /
> *inconclusive*; 1C *changes the final answer* / *no measurable change* /
> *inconclusive* (CI lower bound > 0 and ≥ 5 pp; CI upper bound < 5 pp;
> otherwise, < 300 turns, or M2 disagreeing), each with its achieved
> detectable effect. Every outcome discharges: record the tables, the
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
| 0 | F2 stale comments; F3 deletion (Decision 5). F1 is **#4165**; F4 is **#4217** (filed) | server | Cheap | test removal paired with the deletion | — |
| 1 | `MERGED_TURNS_DEGRADED` (provisional), `isParagraphDegraded`, `NOTICE_LANGUAGES`, `DASH`/`TURN_IN_PARAGRAPH` factories, `countTurnOpeners`; regression plan + INDEX | server, docs | Cheap | unit: 9/10 edge; `undefined` for null, out-of-scope and no-convention languages; `countTurnOpeners` sum vs `measureChapterLegibility` max on one fixture; factories return fresh regexes | — |
| 2 | Import `paragraphsMerged` + openapi + `openapi:types` + **hand-edit `src/lib/types.ts` `ImportCandidate`** + route test | server, frontend types | Default | route test | — |
| 3 | Confirm Heads-up + client `NOTICE_LANGUAGES` mirror + mock mirror + `e2e/responsive/` spec with its 375 px chromium case | frontend, e2e | Default | component + e2e | both release-notes files |
| 4 | `GET /state` `paragraphsMergedChapters` + `WeakMap` memo (unfiltered ids, per-request exclusion, R4-7 omission) + openapi + `src/lib/types.ts:455` + mock `/state` + `chapters-slice` + manuscript caption + e2e case | server, frontend, e2e | Default | route (incl. compute-once, toggle-after-cache, count mismatch), slice, component, e2e | both release-notes files |
| 5 | Characterisation test first, then extract `runStructureEngine` (zero behaviour change) + `structureOptions` seam + `onStages` `stage1`/`paras`/`alignment` + 1A arms 1 and 2 | server | Default | characterisation (4 inputs, deep-equal); `analysis.structure-fixture.test.ts`; existing `attributeChapterStage2` tests green | none (say so) |
| 6 | `recoverMidParagraphTurns` switch + `emitSpans` on `computeAttributionMeasurement` | server | Default | `attribution-health.test.ts`: switch-off span count; span records reproduce every aggregate; off = unchanged | none (say so) |
| 7 | Extract `captureChapterStages` from `evalFixture` (+ capacity, shared budget, chunk counters) + `degrade-paragraphs.mjs` (two shapes) + library scanner (formats, sums, line-wrap flag, #4217 what-if, worst paragraph, `--dump`) + `paragraph-degradation-ab.mts` runner (replay control, `emitSpans` pairing, confident-disagreement classes, chunk-cluster bootstrap, achieved detectable effect, M2 recompute) | server, scripts | Default | `run-eval.test.ts` green; degrade (length equality, determinism, threshold crossing, both shapes by the R4-3 rule); scanner (multi-format fixtures, line-wrap flag, a `<div>`-paragraphed EPUB fixture labelled extractor-merged); runner (fixture capture with a mock analyzer, a replay-control mismatch reported void, one fixture per class (a)–(c), prefix match, clusters from chunk unions, bootstrap on a seeded synthetic set with a known effect) | none (say so) |
| 8 | Register row + run sheet + live view + `--against-published` + publish | docs | **Main thread** | `check:onbox-register`, `register:build` | — |
| 9 | **Owner, on-box:** row B110 → verdicts on #2254 → discharge | — | — | — | Closes #2254 with 3, 4 and 9 done |

**Dependencies:**
- 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9, all serial.
- 7 needs #4165 merged, or must tolerate either recovery behaviour (§1.5 F1).
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
