---
status: draft
issue: 2254
refs: [2253, 2267, 2275, 2306, 2320, 4165]
date: 2026-11-13
revision: 2 (adversarial manual check folded, 2026-11-13)
decisions: accepted by the owner 2026-11-13 (all seven recommendations below)
gate: the mandatory assumption-checker pass is still owed (the skill is not installed in the cloud session that wrote this); run it on the owner's box before decomposition
---

# Paragraph-degradation signal: surfacing it, and proving what it costs (#2254)

Filename when committed:
`docs/superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md`.
Design thread only. No code is written here. Verified against `main` @ `3792b84b`.

**Scope authority.** CLAUDE.md lists "New features" as out of scope until told
otherwise. #2254's close-blocker 2 (owner comment, 2026-08-13: "wire the signal
into the import/analysis surfacing so a degraded book is flagged") is that
instruction. It covers the user-facing surface designed here and nothing
beyond it.

## Owner decisions

> **Accepted 2026-11-13:** the owner accepted every recommendation in this section as written. The assumption-checker gate is still owed before any implementation chain is filed.

1. **Surfaces.**
   - Options: **A** a notice on the confirm view at import · **B** a
     per-chapter caption in the manuscript view, worked out each time the book
     is read · **C** the analysis log only.
   - *Recommend A + B, with A first.* A alone misses books already in the
     library, *Ночной дозор* among them. B alone appears only after hours of
     analysis.
2. **What each notice claims.** This decision is new in revision 2. The
   revision-1 wording ("less sure who's speaking") is **false by
   construction** for recovered turns:
   - `analysis.structure-fixture.test.ts:294-324` asserts confirmed=3, every
     confidence ≥ 0.75 and flagged=0 on a merged chapter.
   - #2267 §1.1–1.2 shows the share of low-confidence lines does not track
     structure.

   Only turns that stay unrecovered keep low confidence (untagged, or a bare
   pronoun tag: `cross-examine.ts:223-249`, `:315-318`).

   Options:
   - **(i)** Both surfaces make only the *source* claim. The chapter's dialogue
     is run together in the file, and a cleaner copy helps. This is true by
     construction of the measure (§2).
   - **(ii)** A makes the source claim. B measures
     `measureChapterLegibility(splitEvidencedInteriorTurns(body, index))`,
     which counts the merged turns **left after recovery**. That makes B's
     "harder to tell who's speaking here" claim true by construction: those
     turns are invisible to the engine.

   *Recommend (ii).* It is the only wording that tells the user something
   actionable about *this* chapter after the fix that already shipped. It
   costs one extra helper call: B needs a roster for the name index, so it uses
   `cast.json`, and with no cast B falls back to the source claim (§3.2).
3. **Measure.**
   - Options: `measureChapterLegibility` ≥ 10 (#2267, calibrated) ·
     `assessParagraphStructure().hiddenFraction` (#2320, uncalibrated).
   - *Recommend legibility.* `hiddenFraction` counts every dash glyph,
     including ASCII hyphens inside words such as `где-то`
     (`structure-report.ts:14` `DASH = /(?:&mdash;|&ndash;|[-–—])/`, not
     whitespace-bounded). It reads 0.54–0.93 on 14 Russian EPUBs where
     recovery restored about 0 turns.
4. **Languages.**
   - Options: ru only · ru/es/fr.
   - *Recommend ru only for the user notice.* es and fr are **uncalibrated**:
     - the #2267 calibration covered only authored-clean es/fr Coalfall text;
     - no real es/fr dash-dialogue source was measured;
     - `legibility.ts:8` requires `\s+` after the dash, so standard Spanish
       typography (`—Hola —dijo—.`, with the dash glued to the word) can never
       match.

     es/fr stay operator-log only until a separate calibration lands. That is
     out of scope here, and the exclusion is recorded in the regression plan.
5. **`assessParagraphStructure`** (no production caller).
   - Options: delete it with its test · keep it as an offline-study export.
   - *Recommend delete*, through report-fix-record. It is a pre-existing
     dead-code finding either way.
6. **Register group.** *Group B* (local Ollama analyzer, no TTS), which is
   exactly this row's prerequisite. The ID is the **next free Group B id at
   merge time** (`B110` at base `3792b84b`).
7. **Dismiss control.** *Recommend none in v1.* The notice is static text. A
   dismiss button would add a touch target, persistence and another test.

## 1 · What actually shipped (verified @ `3792b84b`)

### 1.1 The intake signal: computed nowhere in production

`assessParagraphStructure` (`server/src/analyzer/dialogue-structure/structure-report.ts:34`)
has exactly one reference outside itself: its own test
(`structure-report.test.ts:3`). It is not called, persisted, logged, put in
openapi, or used by the client. The close-blocker's "not wired anywhere a
human sees it" understates this: nothing runs it at all.

### 1.2 Recovery: on by default, with no off switch

- `parseChapterStructure` runs `splitEvidencedInteriorTurns` unless the caller
  passes `{ recoverMidParagraphTurns: false }`.
  - The options are documented at `parser.ts:89-96`.
  - The default is applied at `parser.ts:105`.
- No production caller passes the flag:
  - `routes/analysis.ts:3713`
  - `analyzer/dialogue-structure/evidence.ts:90`
  - `store/attribution-health.ts:171`

  There is no setting or env var. Only tests turn it off.
- At `analysis.ts:3711` the whole structure engine, and with it recovery,
  runs only when `analyzer.structure.enabled` is true **and** the language has
  conventions. With the knob off, recovery never runs and neither does
  anything this document measures at the engine level.
- **The model never sees recovered text.** Recovery lives inside the
  deterministic engine. The stage-2 prompt gets the raw chapter body. Recovery
  can change final output only through `crossExamine` and escalation.

### 1.3 A calibrated degradation measure already exists, but only the operator sees it

- `measureChapterLegibility` (`legibility.ts:28`, #2267) returns the largest
  number of mid-paragraph turn openers in one paragraph:
  `[.!?…:]\s+DASH\s+(?=\p{Lu})` (`:8`).
- The threshold is **≥ 10**. It exists **only** in
  `2026-08-12-merged-turn-legibility-design.md` §2.2, not in code.
- It is computed at analysis start (`analysis.ts:7207-7231`; subset route
  `:9993-10003`) and printed to stdout as
  `[analysis:structure] ch=N scope=book merged=K`.
- Only the book-level maximum is persisted:
  - `state.json` → `analysisProvenance.maxMergedTurnsInParagraph`
    (`analysis.ts:8640`, `:10771`)
  - type at `workspace/scan.ts:283-327`
- It reaches the client only inside the permissive `state` blob
  (`openapi.yaml:10221-10228`). The hand-written client
  `BookStateJson`/`BookStateResponse` (`src/lib/types.ts:361`, `:455`) has no
  such field, and nothing reads it.
- #2267 §5: "No UI surface … a user-facing warning is a separate decision."
  This document is that decision.

### 1.4 Stale or wrong in the issue thread

1. **Blocker 1's premise is stale.** The 2026-08-11 *Correction* comment
   already refuted the −0.073 "attribution survives" claim on the engine path:
   ch5 was 69.7% narrator after the engine, against 11.4% from the model. #2253
   stopped that rewrite.

   The 2026-09-05 Group C run, after #2253 and #2320, recorded ch5 at
   **10.8%** narrator on dash-opening lines, but **that run refused to
   persist**: its drift guard declined to write `cast.json`/`state.json`
   (`night-watch-reanalysis-onbox-acceptance.md` §4). The figure is a log-time
   reading, not a persisted outcome.

   What is still open:
   - **(a)** Does recovery change final speakers?
   - **(b)** Does merged paragraphing degrade the *model's raw* attribution?
2. **The measure is wrong** (Decision 3).
3. **Stale "opt-in / Default OFF" comments:** `paragraph-recovery.ts:5`,
   `:45`; suite title `paragraph-recovery.test.ts:13`; PR #2320's title.
4. **The denominator moved across #2320.** `spokenTotal` for *Ночной дозор*
   went 1928 → 2122 (+194, exactly #2320's recovered spans). That is because
   `attribution-health.ts:171` parses with recovery on. Narrator-share
   comparisons that cross #2320 compare different span sets.
5. Already corrected in the thread, repeated so nobody re-opens them:
   - the parser splits on `\n`, not `\n\n`;
   - the ru-dash fixture is not derived from this book;
   - the extraction branch is dead;
   - **ch1 is itself degraded.** Its paragraph count equals its source `<p>`
     count, but the Calibre source merged turns there too: legibility is
     58–133 on every chapter except ch3, and ch1 hides +208 turns. Revision 1
     wrongly treated ch1 as a clean control.

### 1.5 Incidental findings

- **F1 (#4165, filed and in flight as a separate chain):** UTF-16 vs
  code-point index mismatch at `paragraph-recovery.ts:124`. **Not** part of
  this rollout. Phase 6's harness must merge after #4165 or tolerate either.
- **F2 (chore):** the stale comments in §1.4 item 3. Phase 0.
- **F3 (dead code):** `assessParagraphStructure`. Phase 0, per Decision 5.

## 2 · Measure and threshold

- **Phase 1** adds to `legibility.ts`:
  - `MERGED_TURNS_DEGRADED = 10`;
  - `isParagraphDegraded(body, conventions): boolean | undefined`
    (`undefined` = not measured, never `false`; #2267 "absent ≠ clean");
  - `NOTICE_LANGUAGES = ['ru']` (Decision 4).

  Every surface calls these. The client never re-derives the threshold except
  in the mock mirror (§3.1, M6).
- **The source claim is true by construction.** Ten sentence-final turn
  openers in one paragraph cannot occur in correctly paragraphed dash-dialogue
  text (#2267 §2.1). The "after recovery" claim (Decision 2 (ii)) is true by
  construction too: what remains is exactly what the paragraph-start engine
  cannot see.
- **False positives are verified before any UI ships** (Phase 2, §5). Run
  `measureChapterLegibility` offline over the 26-book corpus from the #2254
  corpus comment, and record per-book maxima and any chapter at ≥ 10 in the
  regression plan. The UI phases are gated on that record: any breach on a
  book the owner judges clean blocks them pending a threshold decision.
- **Excluded chapters** are never counted or named.

## 3 · Surfacing options (blocker 2)

### 3.1 Option A: import-time notice on the confirm view (source claim)

**Data path:**

1. `server/src/routes/import.ts`: language detection at `:119`, candidate
   builder `:142-180`. When `detected.language` is in `NOTICE_LANGUAGES`, add
   two optional fields to each `candidate.chapters[]` item:
   - `mergedTurns?: number`
   - `paragraphsMerged?: true`
2. `openapi.yaml` `ImportCandidate.chapters.items` (`:7280-7297`). Then run
   `npm run openapi:types`. The client already holds `candidate`, so no new
   slice.
3. `src/views/confirm-metadata.tsx`: reuse the amber **"Heads-up:"** box
   markup of `duplicatePositionBook` (`:275-282`).
   - Shown when at least one non-excluded chapter has `paragraphsMerged`.
   - **Not hidden on a language override.** The finding is a fact about the
     file's paragraphing, not about the language the user picks. The flag is
     only *computed* when detection says ru.
   - Names up to three chapter titles, then "and N more".
4. **Mock mirror:** `mockImportManuscript` (`src/lib/api.ts:890`). The
   precedent is explicit: that function already mirrors server heuristics
   (Cyrillic ratio ≥ 30% → `ru`, and the series-from-title parenthetical). The
   mirror sets `paragraphsMerged` when a ru-detected chapter's single paragraph
   holds ≥ 10 `[.!?…:] — Upper` openers. It carries a comment naming
   `MERGED_TURNS_DEGRADED` as its source of truth, the same way the language
   mirror names the server heuristic.

**Wording (source claim; final pass through `castwright-voice`):**

> **Heads-up:** in 5 chapters (Chapter 4, Chapter 5, Chapter 6 and 2 more),
> many lines of dialogue are run together inside long paragraphs in this file —
> usually a sign it was converted from plain text. If you have a cleaner copy
> of this book, importing that instead will give the best result.

**Mobile/touch:**
- Static text, nothing interactive, so no 44 px obligations.
- At 375 px, the box (with its `-mt-2 px-4 py-2.5 text-xs` padding and three
  titles) runs to about **9–10 lines**. Acceptable, because it sits in the
  scrolling confirm form. The three-title cap is what keeps it there, and a
  test pins the cap.

**Tests:**
- route test: merged ru → flag; clean ru → `mergedTurns` < 10, no flag; es and
  en → neither field;
- `confirm-metadata.test.tsx`: shown; still shown after a language override;
  hidden when only excluded chapters are affected; the "and N more" cap;
- **e2e `e2e/responsive/paragraph-structure-notice.spec.ts`.** It must live
  under `responsive/` so the `mobile-chrome` and `tablet-chrome` projects
  (`playwright.config.ts:122-132`) pick it up. Add a case to
  `e2e/responsive/coverage.spec.ts` only if that file's convention requires
  one per new surface (it is per new *view*; this is not one).

**Blast radius:**
- A regex pass per chapter over text already in memory.
- Additive optional wire fields.
- No persistence, no lock.

### 3.2 Option B: per-chapter caption in the manuscript view (post-recovery claim)

**Data path:**

1. `server/src/routes/book-state.ts` `GET /state`. It already calls
   `getOrHydrateManuscript(state.manuscriptId)` (`:845`).
   - Language comes from `bookStateLanguageOrNull(state)`
     (`workspace/scan.ts:402`). The display variant must not be used, because
     an unset language has to mean "not measured".
   - For each non-excluded chapter in a `NOTICE_LANGUAGES` book, compute:
     - `residual = measureChapterLegibility(splitEvidencedInteriorTurns(body, buildNameIndex(cast.characters, conv)), conv)`,
       when a cast exists (Decision 2 (ii));
     - otherwise the raw-source measure, with the claim downgraded to the
       source wording.
   - Emit:
     - `paragraphsMergedChapters?: Array<{ id: number; claim: 'speakers' | 'source' }>`
     - `chapterMergedTurns?: Record<number, number>`
   - **Omit both keys** when the hydrated record is missing, the language is
     null, or the language is out of scope.
   - Derived read only: nothing is written, so there is no `state.json`
     schema bump and no lock involvement.
2. `openapi.yaml` `BookStateResponse` (`:10214`), plus
   `npm run openapi:types`. **Also hand-edit** `src/lib/types.ts:455`
   `BookStateResponse`, which is hand-written and not generated, and the
   **mock `/state`** builder in `src/lib/api.ts`, so e2e can seed a flagged
   chapter.
3. Hydrate in `src/store/chapters-slice.ts`, beside `chapterCharacters`.
4. `src/views/manuscript.tsx` chapter header (`:1154-1161`): one
   `basis-full text-xs text-ink/60` line, the markup of
   `manuscript-restructuring-banner`.

**Wording:**
- `speakers` claim:
  > Some dialogue in this chapter is run together in long paragraphs, so
  > Castwright couldn't check who says those lines — worth a closer listen.
- `source` claim (no cast yet):
  > Dialogue in this chapter is run together in long paragraphs in the source
  > file.

**Mobile/touch:** a wrapping, non-interactive caption. No hover-only content
(touch-equivalence rule).

**Tests:**
- route test: merged ru with a cast → `speakers`; without a cast → `source`;
  English, null language and missing record → keys absent; excluded chapters
  omitted; a recovered-turn-only chapter is **not** flagged (residual < 10
  while raw ≥ 10);
- slice test;
- `manuscript.test.tsx`;
- e2e case in the same `responsive/` spec: navigate ch1 → ch2 → ch1 against
  the mock `/state`.

**Blast radius:** one extra computation on the hottest read route. That is
recovery plus a regex per chapter, a few ms on a 1.5 MB book. The route test
pins one computation per request.

### 3.3 Option C: log only

Promote the stdout `merged=` line to the phase log. It is transient and shows
mid-run. **Not recommended** as the deliverable.

## 4 · Blocker 1: what degradation costs the final output

### 4.1 Split the question

| Part | Question | Model? | Settled by |
|---|---|---|---|
| **1A** | With model output held fixed, does recovery change final speakers? | No | committed test (§4.2) + *Ночной дозор* replay (§4.4 step 1) |
| **1B** | Does merged paragraphing degrade the model's **raw** attribution? | Yes | on-box A/B (§4.4 steps 2–5), compared on raw output |

### 4.2 1A as a committed regression test

Add a new arm to `analysis.structure-fixture.test.ts`. Its merged body is
`MERGED_NARRATION_BODY` (`:281`), derived in the test from the committed ru-dash
scene, so no new fixture file is needed.

- **Mock:** the model is wrong on a recovered, name-tagged turn.
- **Recovery on:** `corrected` to the tag speaker at `TAG_CORRECT`.
- **Recovery off:** the wrong id is kept and flagged below 0.75 (#2253).

Seam: an optional `structureOptions?: ParseChapterOptions` on
`attributeChapterStage2`'s opts, threaded to `analysis.ts:3713`. This is an
internal parameter, not a setting.

### 4.3 Replay inputs and the measuring instrument

**Replay inputs** (§2A.1 of the Night Watch run sheet; not the outbox):
- raw stage-2 sentences from the **analysis cache**
  (`server/handoff/cache/<manuscriptId>.json`, pre-edit);
- the roster from `stage1.characters` in the same cache;
- chapter bodies from a deterministic re-parse of the book's source file.

The outbox `*-stage2-ch*.json` files are forensic prompt/response captures
(`handoff/protocol.ts:47-58`), not the replay input.

**Replay harness: new, Phase 7.**
- What it is: a committed, read-only server-side script, for example
  `server/scripts/replay-structure-ab.mts`.
- What it does:
  - loads the cache plus the re-parsed bodies;
  - runs `attributeChapterStage2` with a stub analyzer that returns the cached
    raw sentences;
  - sets `structureOptions.recoverMidParagraphTurns` to true or false, with
    escalation forced `off` in **both** arms;
  - captures `onStages` (`analysis.ts:3613-3617`) and writes a JSON report.
- Unit tests: argument parsing, and a fixture cache built from the ru-dash
  scene.

**Measurement (Phase 8, a server change, not a script option).**
- Add a reference-body mode to `computeAttributionMeasurement` /
  `resolveAttributionState` (`store/attribution-health.ts` and `-io.ts`): an
  explicit body plus sentence list, measured against a *reference* body's
  spans. Server unit test in `attribution-health.test.ts`.
- `scripts/measure-attribution.mjs` gains a thin flag that passes a reference
  book and an input JSON (a replay report) through. This is required because
  the script otherwise walks only the library and **cannot measure M-off**,
  which never becomes a library book.

**Comparing model quality (1B):** compare `onStages.raw` with `onStages.raw`
across arms, never post-engine output. Post-engine output mixes in the engine's
corrections, and those differ by structure by design.

### 4.4 On-box procedure (Group B)

**Prerequisites:**
- local Ollama on the owner's default analysis model;
- `analyzer.structure.enabled = true`, `allowCloudFallback: false`;
- throwaway re-imports only;
- **analysis caches preserved** before any teardown.

0. **Precondition: confirm sources.** Check that each replay input exists and
   is post-#2253:
   - the cache file is present;
   - `stage1.characters` is non-empty;
   - its build or date postdates #2253.

   The 2026-09-05 run (`mns_a_x7EBUule`) refused to persist `cast.json` and
   `state.json`. Whether its **analysis cache** survived is unverified. If it
   did not, run one fresh *Ночной дозор* throwaway analysis first (about 4 h).
1. **1A on real data.**
   - Run the harness on the *Ночной дозор* cache: recovery on vs off,
     escalation off in both.
   - Per chapter, record:
     - dash-opening spans whose final speaker differs;
     - narrator share each way, over the recovery-off span set;
     - confirmed/corrected/flagged/unresolved each way.
   - Hand-check a 30-line random sample of changed lines as improvement,
     regression or neutral.
2. **Choose the clean reference by rule, not by name.**
   - Measure every Russian dash-dialogue book in the owner's library.
   - Take the book with the **most dash-opening paragraphs across its 3
     densest chapters**, with legibility < 10 on those chapters. Require at
     least 300 dash-opening turns across them.
   - Record the choice and its counts. (*Юный дрессировщик* is clean but
     nearly dialogue-free, which is why revision 1's pick is withdrawn.)
3. **Build the pair, same format.**
   - Export the 3 chapters once to **one** format (plain `.txt`, blank-line
     paragraphs).
   - Create the merged twin with `scripts/degrade-paragraphs.mjs` (Phase 7).
     It is seeded and length-preserving: `\n\n` becomes two spaces.
   - Import **both** from that same format. Mixed formats break offset
     identity:
     - EPUB/HTML whitespace handling (`html-utils.ts:94-97`);
     - text normalisation (`text.ts:294-297`);
     - #938's front-matter split.
   - **Gates before spending model time:**
     - the imported chapter bodies of the two arms have **equal lengths** per
       chapter;
     - clean legibility < 10 and merged ≥ 10 on all 3 chapters.
4. **Three live analyses** (throwaway imports, caches preserved):
   - **C1** clean;
   - **C2** clean again (noise floor);
   - **M** merged.
5. **Replay and measure.**
   - Harness over M's cache: recovery on vs off, escalation off in both
     (**M-on** vs **M-off**). Also replay C1 with escalation off (**C1-r**) so
     every engine-level comparison holds escalation constant.
   - **1B (model):** using `onStages.raw`, compare C1, C2 and M per chapter:
     - narrator share on the reference spans (C1's body);
     - per-span speaker disagreement against C1.
   - **Recovery's contribution:** the same two figures for M-on vs M-off
     against C1-r.

**Verdict for 1B.** Let noise = |C2 − C1| on the raw figures. The model is
degraded by merging when, on at least 2 of 3 chapters:
- M's raw narrator share − C1's ≥ max(5 pp, 2 × noise), **or**
- raw disagreement M-vs-C1 ≥ max(5%, 2 × C2-vs-C1).

Otherwise it is **source/metric only**.

**Either verdict discharges the row.** The verdict goes onto #2254 (closing
blocker 1) and decides whether the issue's "Effect" claim stands or is
downgraded.

### 4.5 Committed-fixture limits

- The Castwright-owned dash text (13 turns) is too small for 1B.
- `the-coalfall-commission.ru.md` uses «» quotes, which recovery and
  legibility ignore.
- What is committed: the deterministic arm (§4.2), the degrade script, the
  harness and the reference-body measurement, all with unit tests.
- What is never committed: the real books.

### 4.6 Register row: draft text

ID: **next free Group B id at merge time** (`B110` at base). The row ships
with:
- the run sheet `docs/testing/paragraph-degradation-onbox-acceptance.md`;
- the live-view HTML edit;
- `npm run register:build` and `npm run check:onbox-register`;
- `--against-published`, then a publish to the register's recorded URL.

> ### B1xx · Does merged paragraphing change who speaks? ([#2254](https://github.com/dudarenok-maker/Castwright/issues/2254))
>
> **Prerequisite:** local Ollama analyzer, structure engine on, no TTS, the
> owner's library. Throwaway re-imports only; preserve analysis caches.
>
> **Observe:** (0) the replay inputs exist and post-date #2253, else run one
> fresh *Ночной дозор* throwaway; (1) *Ночной дозор* cache replay, recovery on
> vs off, escalation off both — changed dash-opening speakers per chapter,
> narrator share each way, 30-line hand-check; (2) a clean ru dash-dialogue
> book chosen by the dash-count rule, plus its same-format
> `degrade-paragraphs.mjs` twin (equal body lengths; clean <10, merged ≥10).
> Analyse clean ×2 and merged ×1, replay with escalation off, and compare
> **raw** stage-2 attribution against the clean reference spans.
>
> **Outcome (not a pass bar):** *model-degrading* if, on ≥2 of 3 chapters,
> merged raw narrator share exceeds clean by ≥ max(5 pp, 2× clean-vs-clean
> noise) or raw disagreement ≥ max(5%, 2× clean-vs-clean); else *source/metric
> only*. Either discharges: record the tables, the verdict, who/when, and post
> it on #2254.
>
> **Criteria:** `docs/testing/paragraph-degradation-onbox-acceptance.md`.

## 5 · Phased rollout (each phase ≈ one agent commit)

**Branching.** Server-scope phases **0, 1 and 6 share `server/`** and run
serially: 0 → 1 → 6. The remaining phases follow the dependency order below.
Integration follows CLAUDE.md "Parallel agents": one PR per round, with a
`docs/features/` regression plan and an `INDEX.md` row added in Phase 1.

| # | Phase | Tier | Paired tests | Ships |
|---|---|---|---|---|
| 0 | F2 stale comments; F3 disposition (Decision 5). F1 is **#4165**, not here. | Cheap | — / test removal paired with the deletion | — |
| 1 | `MERGED_TURNS_DEGRADED`, `isParagraphDegraded`, `NOTICE_LANGUAGES`; regression plan + INDEX | Cheap | unit: 9/10 edge, `undefined` out of scope | — |
| 2 | **Offline false-positive check:** legibility over the 26-book corpus, results recorded in the regression plan; **gates 3–5** | Default | (measurement; script output committed as a table) | — |
| 3 | Import fields + openapi/types + route test | Default | route test | — |
| 4 | Confirm Heads-up + mock mirror + `e2e/responsive/` spec | Default | component + e2e (chromium/mobile/tablet) | both release-notes files |
| 5 | `GET /state` residual/source flags + openapi + `src/lib/types.ts:455` + mock `/state` + `chapters-slice` + manuscript caption + e2e case | Default | route, slice, component, e2e | both release-notes files |
| 6 | `structureOptions` seam + 1A wrong-guess arm | Default | `analysis.structure-fixture.test.ts` | none (say so) |
| 7 | `degrade-paragraphs.mjs` + replay harness (`onStages` capture, escalation off) | Default | script unit tests (length equality, determinism, threshold crossing; harness on a fixture cache) | — |
| 8 | Reference-body mode in `store/attribution-health(-io).ts` + `measure-attribution.mjs` pass-through | Default | `attribution-health.test.ts` + script test | — |
| 9 | Register row + run sheet + live view + publish | Cheap | `check:onbox-register` | — |
| 10 | **Owner, on-box:** §4.4 → verdict on #2254 → discharge | — | — | Closes #2254 with 4, 5 and 10 done |

**Dependencies:**
- 0 → 1 → 2 → 3 → 4, and 1 → 2 → 5. Phase 5 can also follow 3, since it is
  frontend after the server half.
- 1 → 6 → 7 → 8 → 9 → 10.

**Out of scope:**
- better-source acquisition;
- changes to the recovery gate;
- recovering bare third-person tags (file it only if 1B says the model is
  degraded *and* 1A shows recovery is the lever);
- es/fr calibration (Decision 4);
- English.
