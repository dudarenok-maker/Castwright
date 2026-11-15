---
status: draft
issue: 2254
refs: [2253, 2267, 2275, 2306, 2320, 4165]
date: 2026-11-13
revision: 3 (owner decisions on the PR #4184 assumption-checker passes, 2026-11-15)
decisions: owner decisions 1–3 of 2026-11-15 are binding and are written in below; the items under "Decisions made in revision 3" are owed owner confirmation
gate: the assumption-checker passes on revision 2 (two, on PR #4184) did not clear it; revision 3 needs a fresh pass before decomposition
---

# Paragraph-degradation signal: surfacing it, and proving what it costs (#2254)

Filename when committed:
`docs/superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md`.
Design thread only. No code is written here. Verified against `main` @
`a9918640` (revision 2 was verified @ `3792b84b`; every anchor below was
re-read at `a9918640`).

**Scope authority.** CLAUDE.md lists "New features" as out of scope until told
otherwise. #2254's close-blocker 2 (owner comment, 2026-08-13: "wire the signal
into the import/analysis surfacing so a degraded book is flagged") is that
instruction. It covers the user-facing surface designed here and nothing
beyond it.

## Revision 3 changelog

Revision 2 had two assumption-checker passes on PR #4184. "AC1" is the pass
headed "Assumption-checker pass 1 (head 50f5659e)"; "AC2" is the one headed
"assumption-checker pass: revision 2 does not clear the gate". Each finding
and where it is resolved:

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

## Decisions made in revision 3 (owner to confirm)

These are choices the binding owner decisions did not settle. Each one is the
option most consistent with them.

- **R3-1 · 1A replays the engine from a live raw take, not a second live run.**
  Each chapter gets one live capture (recovery on, production defaults). 1A
  then re-runs only the deterministic engine over that same captured `raw`,
  with recovery off. There is no analyzer stub and no coverage guard, because
  only `crossExamine` re-runs. Two live runs (recovery on and off) would mix
  model noise into a question that is about the engine alone. Escalation needs
  a model, so 1A compares the post-crossExamine (`deterministic`) snapshots.
  Escalation's share is reported separately from the live run (§4.3).
- **R3-2 · The post-engine reference for the twin is a C1∩C2 agreement set,
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
- **R3-6 · The degrade script merges dialogue runs only.** It folds each run
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
   - Both surfaces claim only that *the imported text of this chapter runs
     dialogue together inside long paragraphs*, and that a different copy or
     format may help. The claim is true by construction of the measure (§2).
     It holds whoever caused the merge, whether that was the source file or
     Castwright's own extractor (F4).
   - Revision 2's option (ii), a "harder to tell who's speaking" claim from a
     post-recovery residual, is **withdrawn**. It cannot be made true by
     construction:
     - The engine's name index comes from the deduped stage-1 roster
       (`analysis.ts:3630-3636`, `:3712`), but B could only rebuild one from
       `cast.json`.
     - `analyzer.structure.enabled` is a live toggle (`registry.ts:1313-1320`)
       and so is recovery's history (default-on only since #2320), while
       provenance's `structureEngineVersion: 1` cannot tell those cases apart.
     - Dash-open paragraphs skip recovery (`paragraph-recovery.ts:99`), yet
       tags anchor across merged speech inside them (`parser.ts:145-172`).
       The result is a *confident*, unflagged `tag-correct` (0.9) or
       `narration-confirm` (0.95) (`cross-examine.ts:23-37`, `:274`), so even
       residual merged turns are not reliably "unchecked".
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
     - `legibility.ts` `TURN_IN_PARAGRAPH` requires `\s+` after the dash, so
       standard Spanish typography (`—Hola —dijo—.`, with the dash glued to
       the word) can never match.

     es/fr stay operator-log only until a separate calibration lands. That is
     out of scope here, and the exclusion is recorded in the regression plan.
   - **"ru" here means a book whose language is ru,** and detection assigns
     `ru` to any sample that is ≥ 30% Cyrillic (`detect-language.ts`
     `detectManuscriptLanguage`, the `SCRIPT_THRESHOLD` pre-pass).
     Ukrainian, Bulgarian and other Cyrillic books therefore get the notice
     unless the user changes the language. That is accepted. Those languages
     also give every turn its own dash-opened paragraph, so ten sentence-final
     turn openers in one paragraph are just as impossible in clean text, and
     the source claim stays true. Their false-positive rate is uncalibrated
     and sits under Decision 3's provisional label. The B110 scan reports
     detected and declared language per book, so a non-ru breach shows up.
5. **`assessParagraphStructure`** (no production caller).
   - Options: delete it with its test · keep it as an offline-study export.
   - *Delete*, through report-fix-record. It is a pre-existing dead-code
     finding either way.
6. **Register group: B** (local Ollama analyzer, no TTS). The ID is the
   **next free Group B id at merge time** (`B110` at `a9918640`). AC1 asked
   whether this belongs in Group C ("one *Ночной дозор* re-analysis session").
   It does not. The procedure runs chapters live through the attribution-eval
   harness from a pinned roster, and never re-analyses a whole book.
7. **Dismiss control.** *None in v1.* The notice is static text. A dismiss
   button would add a touch target, persistence and another test.

## 1 · What actually shipped (verified @ `a9918640`)

### 1.1 The intake signal: computed nowhere in production

`assessParagraphStructure` (`server/src/analyzer/dialogue-structure/structure-report.ts`)
has exactly one reference outside itself: its own test
(`structure-report.test.ts`). It is not called, persisted, logged, put in
openapi, or used by the client. Nothing runs it at all.

### 1.2 Recovery: on by default, with no off switch, reaching output through three channels

- `parseChapterStructure` runs `splitEvidencedInteriorTurns` unless the caller
  passes `{ recoverMidParagraphTurns: false }` (option at `parser.ts:96`,
  default applied at `:105`).
- No production caller passes the flag:
  - `routes/analysis.ts:3713` (the engine);
  - `analyzer/dialogue-structure/evidence.ts:90` (script-review evidence);
  - `store/attribution-health.ts:171` (the measurement).

  There is no setting or env var. Only tests turn it off.
- At `analysis.ts:3711` the whole structure engine runs only when
  `analyzer.structure.enabled` is true **and** the language has conventions.
- **The model never sees recovered text.** The stage-2 prompt gets the raw
  chapter body. Recovery reaches final output through **three** channels:
  1. `crossExamine` (`analysis.ts:3719-3726`);
  2. escalation, which re-queries windows over the same recovered `paras`
     (`:3745-3757`);
  3. **script review**: `buildStructureEvidence` (`routes/script-review.ts:919`
     → `evidence.ts:90`) parses with recovery on, and its hints go into the
     review prompt.

### 1.3 A calibrated degradation measure already exists, but only the operator sees it

- `measureChapterLegibility` (`legibility.ts`, #2267) returns the largest
  number of mid-paragraph turn openers in one paragraph:
  `[.!?…:]\s+DASH\s+(?=\p{Lu})`. It counts every paragraph, including one that
  opens with a dash, by design (its header comment).
- The threshold of **10** exists **only** in
  `2026-08-12-merged-turn-legibility-design.md` §2.2, not in code.
- It is computed at analysis start and printed to stdout as
  `[analysis:structure] ch=N scope=book merged=K`. Only the book-level maximum
  is persisted (`state.json` → `analysisProvenance.maxMergedTurnsInParagraph`;
  type in `workspace/scan.ts`).
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
   narrated-speech share (`stage2-coverage.ts` `narratedSpeechShare`), so it
   is not an engine-level reading. The same run also **refused to persist**:
   its drift guard declined to write `cast.json`/`state.json`
   (`night-watch-reanalysis-onbox-acceptance.md` §4).

   What is still open:
   - **(a)** Does recovery change final speakers?
   - **(b)** Does merged paragraphing degrade the *model's raw* attribution?
   - **(c)** How much confident, unflagged mis-correction does a merged book
     carry after the engine? (New in revision 3, from AC1.)
2. **The measure is wrong** (Decision 3).
3. **Stale "opt-in / Default OFF" comments:** `paragraph-recovery.ts` header
   (line 5, "Opt-in, conservative recovery") and `:45`; suite title
   `paragraph-recovery.test.ts:13`; PR #2320's title.
4. **The denominator moved across #2320.** `spokenTotal` for *Ночной дозор*
   went 1928 → 2122 (+194, exactly #2320's recovered spans). That is because
   `attribution-health.ts:171` parses with recovery on. Narrator-share
   comparisons that cross #2320 compare different span sets. §4 uses a
   recovery-off span set for every cross-arm figure for this reason.
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
- **F4 (new in revision 3; needs a design pass):** `stripHtml`
  (`parsers/html-utils.ts`) converts only `</p>`, `<br>` and `<hr>` to line
  breaks. Every other block closer (`</div>`, `</li>`, `</blockquote>`,
  `</h*>`) is stripped silently, which merges paragraphs in EPUB/MOBI sources
  whose paragraphs are `<div>`s. It is not fixed here because the fix changes
  the chapter bodies of books already in the library. `hydrateFromDisk`
  re-parses the source file (`store/manuscripts.ts`), so persisted sentence
  offsets would shift under existing books. **The decision owed:** which block
  closers become paragraph breaks, and how existing books are migrated or
  pinned to the old extraction. Until then, Decision 2's wording keeps the
  notices true for these merges. File it as a `bug` issue naming that
  decision, in the same round as this spec's merge.

## 2 · Measure and threshold

- **Phase 1** adds to `legibility.ts`:
  - `MERGED_TURNS_DEGRADED = 10`, with a comment marking it **provisional**
    and naming register row B110 as the calibration that will confirm it;
  - `isParagraphDegraded(body, language): boolean | undefined`.
    It returns `undefined` when the language is null, not in
    `NOTICE_LANGUAGES`, or has no conventions: not measured, never `false`
    (#2267 "absent ≠ clean");
  - `NOTICE_LANGUAGES = ['ru']` (Decision 4).

  Every server surface calls these. The client mirrors only
  `NOTICE_LANGUAGES` (§3.1) and the mock's threshold (§3.1 M), each with a
  comment naming its source of truth.
- **The source claim is true by construction.** In a language that gives
  every turn its own dash-opened paragraph, ten sentence-final turn openers in
  one paragraph cannot occur in correctly paragraphed text (#2267 §2.1). The
  claim says only that the imported text is run together. It says nothing
  about speakers and nothing about who merged it.
- **The threshold is provisional** (owner decision 3, 2026-11-15). It is
  calibrated on one real clean ru book plus the authored fixtures. The
  library-wide false-positive scan is step 1 of the owner-run register row
  B110 (§4.4). It is **not** a merge gate for any UI phase: per CLAUDE.md,
  owed acceptance converts into a row. A breach on a book the owner judges
  clean is recorded on the row, and the threshold decision it forces goes to
  the owner. If no clean, dialogue-dense ru dash book exists, the threshold
  stays provisional indefinitely, and the regression plan says so in those
  words.
- **What a false positive costs:** a Heads-up box suggesting a cleaner copy
  of a book that did not need one. There is no blocking, no data change and
  no analysis change. That is why shipping a provisional threshold is
  acceptable.
- **Excluded chapters** are never counted or named.

## 3 · Surfacing options (blocker 2)

### 3.1 Option A: import-time notice on the confirm view

**Data path:**

1. `server/src/routes/import.ts`: language detection at `:119`, candidate
   builder from `:145`. When `detected.language` is in `NOTICE_LANGUAGES`, add
   **one** optional field to each `candidate.chapters[]` item:
   `paragraphsMerged?: true`. It is omitted otherwise, and there is no count
   field (finding 22).
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
   the three-title cap. The component test pins it (finding 23).

**Wording** (source claim; final pass through `castwright-voice`):

> **Heads-up:** in 5 chapters (Chapter 4, Chapter 5, Chapter 6 and 2 more),
> much of the dialogue in the imported text is run together inside long
> paragraphs instead of starting a new line for each speaker. This often
> happens when a book is converted between formats. A different copy or
> format of this book may give a better result.

The wording names no cause the measure cannot prove. That keeps it true when
Castwright's own extractor did the merge (F4).

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
  375 × 812 viewport. That case is the PR-time phone-width check (finding 19).
  No `coverage.spec.ts` case is added, because that file is one case per new
  *view* and this is not one.

**Blast radius:**
- One regex pass per chapter over text already in memory.
- One additive optional wire field.
- No persistence, no lock.

### 3.2 Option B: per-chapter caption in the manuscript view (source claim)

**Data path:**

1. `server/src/routes/book-state.ts` `GET /state`. It already calls
   `getOrHydrateManuscript(state.manuscriptId)` (`:845`).
   - Language comes from `bookStateLanguageOrNull(state)` (`workspace/scan.ts`).
     The display variant must not be used, because an unset language has to
     mean "not measured".
   - For each non-excluded chapter of a `NOTICE_LANGUAGES` book, compute
     `isParagraphDegraded(body, language)` on the hydrated body. There is no
     recovery, no name index and no cast (Decision 2).
   - Emit `paragraphsMergedChapters?: number[]` (chapter ids). **Omit the
     key** when the hydrated record is missing, the language is null or out of
     scope, or no chapter is flagged.
   - **Memoised per hydrated record:** a module-level
     `WeakMap<ManuscriptRecord, number[]>`. `getOrHydrateManuscript` returns
     the same object until a put or remove replaces it
     (`store/manuscripts.ts`), so a replaced record recomputes and the old
     entry is garbage-collected. The cost is one regex pass over the book per
     hydration, not per request. That answers the 14-call-site concern
     (finding 20). The cached value is `{ language, ids }`. A request whose
     language differs from the cached one recomputes, so a language change
     takes effect without a re-hydrate.
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

**Wording** (one claim; final pass through `castwright-voice`):

> Much of the dialogue in this chapter is run together inside long
> paragraphs in the imported text.

**Mobile/touch:** a wrapping, non-interactive caption. There is no
hover-only content (touch-equivalence rule).

**Tests:**
- route test: merged ru → id listed; English, null language and missing
  record → key absent; excluded chapters omitted; **two requests on one
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
| **1A** | With the model's raw take held fixed, does recovery change post-engine speakers? | No (engine replay from a live raw take, R3-1) | committed test (§4.2) + Ночной дозор live capture (§4.4 step 2) |
| **1B** | Does merged paragraphing degrade the model's **raw** attribution? | Yes | clean/merged twin, live (§4.4 steps 3–6), on `onStages.raw` |
| **1C** | How much **post-engine** harm does a merged book carry, including confident, unflagged mis-correction (`tag-correct` 0.9 / `narration-confirm` 0.95) in dash-open paragraphs? | Yes | twin (final vs the R3-2 reference) + Ночной дозор hand-check (§4.4) |

1C is the owner's direct question (decision 1, 2026-11-15) and the #2253 harm
class. It measures what the user actually gets.

**Out of 1A–1C scope:** script review (channel 3 in §1.2). It is an opt-in,
later pass with its own model call, and attributing its effect to recovery
would need a second A/B run. The harness's `review` option exists if a later
round wants that.

### 4.2 1A as a committed regression test

Add arms to `analysis.structure-fixture.test.ts`. The merged body is
`MERGED_NARRATION_BODY`, derived in the test from the committed ru-dash scene,
so no new fixture file is needed. The file already sets
`STAGE2_COVERAGE_RETRIES=0` for its body-blind mocks (`:134-160`), and the new
arms inherit that.

- **Arm 1, wrong in-roster speaker.** The mock returns an **in-roster,
  non-narrator** wrong id on a recovered, name-tagged turn. The
  "kept and flagged" path exists only for that shape (`cross-examine.ts`
  roster check).
  - recovery on: `corrected` to the tag speaker at `TAG_CORRECT` (0.9);
  - recovery off: the wrong id is kept and flagged below 0.75 (#2253).
- **Arm 2, wrong `narrator`.** The mock returns `narrator` on the same turn.
  - recovery on: `corrected` to the tag speaker;
  - recovery off: **expected** `narration-confirm` at 0.95, unflagged
    (`cross-examine.ts:274`). Off, the turn sits inside a narration-open
    paragraph, so this is the confident-wrong class 1C counts.
  - The implementer runs the arm first and pins what it observes. If the
    off outcome is not confident-wrong, that is reported back to the design
    thread before the test is committed, not edited to pass.

Seam: Phase 5 extracts the engine block of `attributeChapterStage2`
(`analysis.ts:3710-3790`, from `conventionsFor` through the
`applyNarratorDefault` else-branch) into an exported
`runStructureEngine(sentences, body, stage1, stageCall, opts)`, with **zero
behaviour change**. `attributeChapterStage2` calls it, and its existing tests
stay green. Its `opts.structureOptions?: ParseChapterOptions` reaches the
`parseChapterStructure` call. That internal parameter is not a setting, and it
is also threaded through `attributeChapterStage2`'s own opts for the arms
above. Escalation stays inside `attributeChapterStage2`: `runStructureEngine`
returns `{ examined, paras }` and escalation consumes them, so §4.3 can replay
the engine without a model.

### 4.3 The measuring instruments

**Raw source: live capture through plan 265's harness** (owner decision 1,
2026-11-15). There is no cache read anywhere in this design.

- `evalFixture` (`attribution-eval/run-eval.ts`) already calls
  `attributeChapterStage2` live with `onStages` (`:196-205`), and `onStages`
  delivers:
  - `raw`, cloned before the engine runs (`analysis.ts:3696`);
  - `deterministic`, after crossExamine and before escalation (`:3727`);
  - `reasons`.

  The return value is the final, post-escalation take.
- **Phase 7 extracts, it does not copy.** It pulls the body of `evalFixture`
  up to and including the `attributeChapterStage2` call into an exported
  `captureChapterStages(opts) → { raw, deterministic, final, reasons,
  structureReport, chunks }`. `evalFixture` calls it, and its scoring stays
  byte-identical (`run-eval.test.ts` stays green).
  `captureChapterStages` takes a plain `chapterText` and roster, so no
  `LabelledChapter` truth is needed. It also takes an optional
  `structureOptions`.
- **Roster:** pinned per book, built with `buildRosterSnapshot`
  (`attribution-eval/capture.ts`) from the library book's `cast.json`. This
  is plan 265's own roster-pinning, which prevents id drift between arms.
  `attributeChapterStage2` dedupes it exactly as production dedupes stage-1
  (`analysis.ts:3632`). For the twin, both arms use the **same** pinned
  roster file, built once from C1's cast.
- **Chunking (the 9000-char note).** Stage 2 splits a chapter over
  `analyzer.stage2.chunkCharBudget` (default 9000, lower for local engines:
  `max(1000, min(0.3 × num_ctx × 2, 9000))`, `registry.ts:123-140`) at
  blank-line boundaries only. A merged paragraph is never split and becomes
  its own chunk, and the sentence-split fallback applies if it truncates
  (`stage2-chunk.ts` `splitBodyIntoChunks`, `splitParagraphIntoSentences`).
  The merged twin is therefore chunked differently from the clean twin. That
  is part of what a merged book costs in production, so it is **measured, not
  removed**:
  - `captureChapterStages` threads counters through the existing `onChunk`,
    `onRetry`, `onExhausted` and `onDeterministicSplit` callbacks and returns
    them as `chunks`;
  - every arm's report states chunk count, coverage retries and
    deterministic splits per chapter;
  - the degrade script merges only dialogue runs (R3-6), so narration breaks
    and most chunk boundaries survive;
  - live runs keep the coverage guard on (production behaviour). The
    `STAGE2_COVERAGE_RETRIES=0` trick in the fixture test exists only for
    body-blind mocks and is **not** used here.
- **1A engine replay (R3-1):** for each captured chapter, run
  `runStructureEngine(raw, body, stage1, stageCall, { structureOptions:
  { recoverMidParagraphTurns: false } })` over the **same** `raw` the live run
  produced. Compare its output with the live `deterministic` snapshot
  (recovery on). No analyzer and no coverage guard are involved.
- **Escalation:** the live run uses the owner's default (`'local'`,
  `registry.ts:1323-1331`), because 1C measures what users get. Escalation's
  own effect is `final` vs `deterministic` within each arm, and it is
  reported as such.
- **The #2254 runner** (Phase 7): a committed, read-only server-side script,
  `server/scripts/paragraph-degradation-ab.mts`. It reads a manifest of
  `{ arm, chapterText, rosterPath }`, calls `captureChapterStages` per
  chapter, runs the 1A replay, calls the measurement below, computes the §4.4
  statistics and writes one JSON report plus a Markdown table. Like plan
  265's runner it never runs in `test:all`, and its inputs (real books) are
  never committed.

**Measurement (Phase 6, a server change):**
- `computeAttributionMeasurement` (`store/attribution-health.ts:139`) already
  takes explicit `bodies` and `sentences` (`:86-108`). It gains one optional
  input, `recoverMidParagraphTurns?: boolean` (default `true`, so library
  behaviour is unchanged), passed to its `parseChapterStructure` call
  (`:171`).
- The runner calls it in-process with:
  - the **reference** body (C1's, or Ночной дозор's own);
  - the arm's sentences;
  - the **pinned roster**, never `roster: []` as `attribution-health-io.ts:220`
    does for the library;
  - `recoverMidParagraphTurns: false`. Every cross-arm figure is then on the
    recovery-off span set (§1.4 item 4).

  Equal per-chapter body lengths (§4.4 gate) mean the merged arm's sentences
  align against the clean body's spans.
- Revision 2's `measure-attribution.mjs` pass-through is dropped, because
  nothing outside the runner needs it.
- Server unit test in `attribution-health.test.ts`: the same body and
  sentences with the switch off yield the pre-#2320 span count (no recovered
  spans).

**Comparing model quality (1B):** compare `raw` with `raw` across arms, never
post-engine output. Post-engine output mixes in the engine's corrections, and
those differ by structure by design. 1C exists to report post-engine output
explicitly.

**The 1C confident-wrong count:** a span counts when all of these hold:
- its arm's `deterministic` reason is `tag-correct` or `narration-confirm`;
- its confidence is ≥ 0.9 and it is not flagged;
- its final speaker disagrees with the reference;
- it sits in a paragraph that, in that arm's body, opens with a dash and
  contains ≥ 1 mid-paragraph turn opener.

The runner's unit tests include a merged dash-open fixture where a tag
anchors following speech to the wrong speaker (`parser.ts:145-172`), and the
counter must count it.

### 4.4 On-box procedure (register row B110, Group B, owner-run)

**Prerequisites:**
- local Ollama on the owner's default analysis model;
- `analyzer.structure.enabled = true`, `allowCloudFallback: false`,
  escalation at the owner's default;
- the owner's library (Calibre and the workspace) on the box;
- no re-imports of library books: the harness reads text and a pinned roster
  and writes only its report.

**Gate before step 2:** #4165 has merged, or the run notes which build it ran
on.

1. **Library legibility scan (the false-positive check, and the reference
   pick).**
   - Run the Phase-7 scanner over the owner's library directory. It parses
     every file `parseManuscript` supports (EPUB, MOBI, PDF, TXT, …).
   - Per book it reports: format; detected and declared language; per-chapter
     legibility; the maximum; and dash-opening paragraph counts.
   - The run sheet lists the 26 books from the #2254 corpus comment by title,
     and the owner confirms each was scanned.
   - The owner marks each book clean or degraded by eye. Any book marked
     clean with a chapter at ≥ 10 is a **breach**. It is recorded with the
     chapter, its count and its format, and the threshold decision goes to
     the owner.
   - No breach → `MERGED_TURNS_DEGRADED` loses its provisional label, in a
     follow-up commit that cites this row. A non-ru Cyrillic book is reported
     separately (Decision 4).
2. **1A and 1C on real data: Ночной дозор.** No fresh whole-book analysis and
   no cache: the 2026-09-05 cache is gone, and nothing reads one.
   - Pick its 3 chapters with the most dash-opening turns, excluding ch3 (the
     one clean chapter).
   - Run the runner live on those chapters with its pinned roster.
   - Per chapter, record:
     - **1A:** dash-opening spans whose post-crossExamine speaker differs,
       recovery on (live) vs off (replay); narrator share each way, over the
       recovery-off span set; confirmed/corrected/flagged/unresolved each way;
     - **1C:** the confident-wrong candidates, i.e. dash-open-paragraph spans
       with a confident `tag-correct`/`narration-confirm` decision;
     - chunk shape.
   - **Hand-check (owner):** 30 random 1A-changed lines judged improvement,
     regression or neutral, and 30 random 1C candidates judged right or wrong
     against the text. This chapter has no clean twin, so these judgements are
     the 1C evidence for it.
3. **Choose the clean reference by rule, not by name**, from step 1's scan.
   - Take the book with the most dash-opening paragraphs across its 3 densest
     chapters, with legibility < 10 on those chapters and **≥ 300
     dash-opening turns** across them. The book must be judged clean in
     step 1.
   - Record the choice and its counts. *Юный дрессировщик* is clean but nearly
     dialogue-free, which is why revision 1's pick is withdrawn.
   - **No qualifying book** → skip steps 4–6. 1B and the twin half of 1C
     record **inconclusive: no qualifying reference** (R3-4), and the
     threshold stays provisional (§2).
4. **Build the pair, in one format.**
   - Export the 3 chapters once to plain `.txt`, with blank-line paragraphs.
   - Create the merged twin with `scripts/degrade-paragraphs.mjs` (Phase 7,
     R3-6). It folds each run of dash-opening paragraphs into the paragraph
     before it, and replaces each removed separator with an equal number of
     spaces.
   - **Gates before spending model time:**
     - equal body lengths per chapter across the two arms;
     - clean legibility < 10 and merged ≥ 10 on all 3 chapters.
   - Mixed formats would break offset identity (`html-utils.ts` whitespace
     handling, `text.ts` normalisation, #938's front-matter split). The
     runner reads the `.txt` text directly, with no import.
5. **Three live captures** through the runner, one shared pinned roster:
   - **C1** clean;
   - **C2** clean again (noise floor);
   - **M** merged.
6. **Measure.**
   - **1B (model, `raw`):** per span on C1's recovery-off reference spans,
     `dM = [M.raw ≠ C1.raw]` and `dN = [C2.raw ≠ C1.raw]`, plus each arm's
     narrator share.
   - **1C (post-engine, `final`):** the reference is the spans where
     `C1.final = C2.final` (R3-2). `hM = [M.final ≠ ref]` and
     `hN = [C1.final ≠ C2.final]` over all spans. The confident-wrong count
     is taken for M and for C1. Owner hand-check: 30 random M-vs-reference
     disagreements, judged as M wrong, reference wrong, or unclear.
   - **1A on the twin:** M's live `deterministic` vs its recovery-off replay,
     as in step 2.

**Verdicts (pooled, paired, with power).** Pool the spans of all 3 chapters.
For each comparison, take the mean paired difference: `dM − dN` for 1B
disagreement, M's narrator share minus C1's for 1B narrator share, and
`hM − hN` for 1C. Run a chapter-stratified bootstrap (2000 resamples, fixed
seed, in the runner).
- **Degrading:** 95% CI lower bound > 0 **and** point estimate ≥ 5 pp.
- **Not degrading:** 95% CI upper bound < 5 pp.
- **Inconclusive:** anything else, or < 300 pooled dash-opening turns.

At 300 turns the standard error of a paired difference near 20% is about
2–3 pp, so a 5 pp effect is detectable. With fewer turns it is not, which is
why the rule falls through to inconclusive. That replaces revision 2's
"≥ 2 of 3 chapters at 5 pp" rule, which was about 1 SE per chapter.

**Recorded outcomes:**
- **1B:** *model-degrading* / *not model-degrading* / *inconclusive*.
- **1C:** *post-engine harm* / *no measurable harm* / *inconclusive*, with the
  confident-wrong counts and the hand-check tallies stated either way.

**Every outcome discharges the row** (R3-4). The verdicts go onto #2254 and
close blocker 1. They decide whether the issue's "Effect" claim stands, is
downgraded, or stands only on the Ночной дозор evidence with the missing twin
named as the limit. If 1C finds harm, a fix to tag anchoring in dash-open
paragraphs is new design work. It is filed then, not designed here.

### 4.5 Committed-fixture limits

- The Castwright-owned dash text (13 turns) is far below the 300-turn power
  floor. It feeds the committed 1A arms (§4.2) and the tools' unit tests,
  and gives no 1B/1C verdict.
- `the-coalfall-commission.ru.md` uses «» quotes, which recovery and
  legibility ignore.
- If no clean reference exists (§4.4 step 3), the authored fixtures are the
  **only** calibration of the threshold. The regression plan states this
  limit, and the threshold stays provisional.
- What is committed: the 1A arms, `runStructureEngine`,
  `captureChapterStages`, the recovery-off switch, the degrade script, the
  scanner and the runner, all with unit tests.
- What is never committed: the real books, their rosters, and the runner's
  reports. Only the verdict tables go on #2254 and into the run sheet.

### 4.6 Register row: draft text

ID: **next free Group B id at merge time** (`B110` at `a9918640`). Phase 8 is
**main-thread work** (owner decision 3, 2026-11-15). The row ships with:
- the run sheet `docs/testing/paragraph-degradation-onbox-acceptance.md`;
- the live-view HTML edit;
- `npm run register:build` and `npm run check:onbox-register`;
- `--against-published`, then a publish to the register's recorded URL, per
  the register's own four-step procedure.

> ### B1xx · Does merged paragraphing change who speaks? ([#2254](https://github.com/dudarenok-maker/Castwright/issues/2254))
>
> **Prerequisite:** local Ollama analyzer, structure engine on, escalation at
> default, no TTS, the owner's library on the box. No re-imports; the harness
> writes only its report.
>
> **Observe:** (1) the library legibility scan over every format: per-book
> maxima, any chapter ≥ 10 on a book judged clean (a breach of the
> provisional threshold), and non-ru Cyrillic books listed separately;
> (2) Ночной дозор, 3 densest chapters, live capture: post-crossExamine
> speakers changed by recovery on vs off (1A), confident
> `tag-correct`/`narration-confirm` decisions in dash-open paragraphs (1C),
> and two 30-line hand-checks; (3) if a clean ru dash book with ≥ 300 turns
> exists, its same-format `degrade-paragraphs.mjs` twin (equal lengths;
> clean < 10, merged ≥ 10), captured live as clean ×2 and merged ×1, with raw
> (1B) and final (1C) compared by paired bootstrap.
>
> **Outcome (not a pass bar):** 1B *model-degrading* / *not* / *inconclusive*;
> 1C *post-engine harm* / *none measurable* / *inconclusive* (CI lower bound
> > 0 and ≥ 5 pp, CI upper bound < 5 pp, otherwise or < 300 turns). Every
> outcome discharges: record the tables, the verdicts, the scan, who/when, and
> post them on #2254.
>
> **Criteria:** `docs/testing/paragraph-degradation-onbox-acceptance.md`.

## 5 · Phased rollout (each phase ≈ one agent commit)

**Branching.** Every phase except 8 and 9 touches `server/` (see the Scope
column), so all of them run as **one serial chain** in one worktree:
0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Phase 3 is frontend-only, but it sits in the
chain rather than in a parallel lane: it consumes Phase 2's wire field, and
Phase 4 edits the same `src/lib/types.ts` and `src/lib/api.ts`. Integration follows CLAUDE.md: one PR
for the round, with a `docs/features/` regression plan and an `INDEX.md` row
added in Phase 1.

| # | Phase | Scope | Tier | Paired tests | Ships |
|---|---|---|---|---|---|
| 0 | F2 stale comments; F3 deletion (Decision 5). F1 is **#4165**; F4 is a filed design issue | server | Cheap | test removal paired with the deletion | — |
| 1 | `MERGED_TURNS_DEGRADED` (provisional), `isParagraphDegraded`, `NOTICE_LANGUAGES`; regression plan + INDEX | server, docs | Cheap | unit: 9/10 edge; `undefined` for null, out-of-scope and no-convention languages | — |
| 2 | Import `paragraphsMerged` + openapi + `openapi:types` + **hand-edit `src/lib/types.ts` `ImportCandidate`** + route test | server, frontend types | Default | route test | — |
| 3 | Confirm Heads-up + client `NOTICE_LANGUAGES` mirror + mock mirror + `e2e/responsive/` spec with its 375 px chromium case | frontend, e2e | Default | component + e2e | both release-notes files |
| 4 | `GET /state` `paragraphsMergedChapters` + `WeakMap` memo + openapi + `src/lib/types.ts:455` + mock `/state` + `chapters-slice` + manuscript caption + e2e case | server, frontend, e2e | Default | route (incl. compute-once), slice, component, e2e | both release-notes files |
| 5 | Extract `runStructureEngine` (zero behaviour change) + `structureOptions` seam + 1A arms 1 and 2 | server | Default | `analysis.structure-fixture.test.ts`; existing `attributeChapterStage2` tests green | none (say so) |
| 6 | `recoverMidParagraphTurns` switch on `computeAttributionMeasurement` | server | Cheap | `attribution-health.test.ts` | none (say so) |
| 7 | Extract `captureChapterStages` from `evalFixture` (+ chunk counters) + `degrade-paragraphs.mjs` + library legibility scanner + `paragraph-degradation-ab.mts` runner (1A replay, 1C counter, bootstrap) | server, scripts | Default | `run-eval.test.ts` green; degrade (length equality, determinism, threshold crossing, dialogue-runs-only); scanner (multi-format fixtures); runner (fixture capture with a mock analyzer, confident-wrong fixture, bootstrap on a seeded synthetic set) | none (say so) |
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
- F4's extractor change (a filed design issue);
- recovering bare third-person tags, or re-anchoring tags in dash-open
  paragraphs (file either only if B110 shows harm *and* points at that
  lever);
- script review's use of recovered evidence (§4.1);
- es/fr calibration (Decision 4);
- English.
