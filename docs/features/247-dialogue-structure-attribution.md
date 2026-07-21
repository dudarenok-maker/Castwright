---
status: active
shipped: null
owner: null
---

# 247 — Dialogue-structure attribution: deterministic evidence engine, derived confidence, targeted escalation (srv-59)

> Status: active (deterministic engine + escalation + provenance land first; script-review inbox
> annotations are sequenced after the concurrent script-review-persistence PR merges — see
> "Delivery sequencing" below; on-box acceptance owed post-merge)
> Key files: `server/src/analyzer/dialogue-structure/{types,parser,windows,aligner,cross-examine,escalation,name-matcher}.ts`,
> `server/src/analyzer/dialogue-structure/lang/{en,es,fr,de,ru,index}.ts`, `server/src/routes/analysis.ts`
> (`attributeChapterStage2`), `server/src/config/registry.ts` (`analyzer-structure` group),
> `server/src/workspace/scan.ts` (`analysisProvenance`), `server/src/routes/script-review.ts`
> (`buildScriptReviewChapterInbox` — evidence annotations, sequenced follow-up)
> URL surface: none (server/analyzer-only; no frontend change)
> OpenAPI ops: none (additive `state.json` field only, not part of the OpenAPI contract)

## Benefit / Rationale

- **User:** Full-book dialogue attribution — worst today on Russian, but shared across every
  supported language (en/es/fr/de/ru) — becomes fixable in one triage sitting instead of
  unreviewable. Tag-provable mistakes (the text names the speaker) are corrected before the user
  ever looks; what the evidence genuinely can't decide lands as an honestly-low-confidence flag
  in the existing manuscript low-confidence navigator, which today never fires at all (every one
  of 14,065 sentences on the measured book self-reported confidence ≥ 0.8).
- **Technical:** Model self-reported confidence is discarded and replaced with a derived value
  computed from observable structural evidence — the June 2026 plan-221 lesson generalized from
  one rule (`applyNarratorDefault`) to a full evidence engine. No per-model prompt tuning; the
  engine is model-independent by construction.
- **Architectural:** A new pure-code module family (`server/src/analyzer/dialogue-structure/`)
  slots into one existing seam (`attributeChapterStage2`, replacing the old
  `applyNarratorDefault` call) with zero schema changes downstream — sentence `characterId`/
  `confidence` are the only mutated fields, so fold/reconcile/persistence/OpenAPI shapes are
  untouched. Two small additive provenance fields on `state.json` close a forensics gap (nothing
  previously recorded which analyzer/model produced an analysis).

## Architectural impact

- **New seams / extension points:**
  - `LanguageConventions` table per language (`dialogue-structure/lang/{en,es,fr,de,ru}.ts`),
    keyed off the book's already-resolved `opts.stageCall.language` — no new opts field. An
    unsupported/unknown language resolves to an empty table, so the parser emits no evidence and
    the cross-examiner falls back to exactly current behaviour (narrator-default only, model
    confidence passed through) — **byte-identical to pre-engine output**.
  - Four new registry knobs under a new `analyzer-structure` group (`server/src/config/registry.ts`
    lines 1062-1103) — see "Registry knobs" below.
  - `state.json` gains an optional `analysisProvenance` block (`server/src/workspace/scan.ts`) —
    additive, no `CURRENT_STATE_SCHEMA` bump, no reader requires it.
- **Invariants preserved:** the Wave A narrator-default rule (plan 221) is absorbed into the
  cross-examiner as one rule among several — its behaviour is kept (tag/beat span → narrator,
  first-of-run clamp to ≤0.5) and its self-inflicted bug (demoting a dash-continuation sentence
  that has no leading dash of its own) is fixed by the continuation exemption (see "Invariants to
  preserve" below). Sentence schema (`SentenceOutput`) is unchanged.
- **Migration story:** none needed — every new field is additive/optional
  (`analysisProvenance`, `structureReport`). A book analysed before this engine shipped simply
  has no `analysisProvenance` block; the book-state GET route already tolerates that (pinned by
  a dedicated back-compat test, see Test plan).
- **Reversibility:** one registry kill-switch, `analyzer.structure.enabled` (env `STRUCTURE_ENGINE`,
  default `true`). Flipping it off restores exactly the pre-engine `applyNarratorDefault`-only
  behaviour. Escalation has its own independent off-switch
  (`analyzer.structure.escalation` = `'off'`).

## Invariants to preserve

Numbered rules a refactor must not break, each citing the enforcing file/line as of this plan
(commit `473b1a60`, task 12 — see the plan's ledger at `.superpowers/sdd/progress.md` for the
full commit history):

1. **§5.3 decision-matrix ORDERING is the contract, not the exact numbers.** The confidence
   constants live in exactly one block, `CONFIDENCE` in
   `server/src/analyzer/dialogue-structure/cross-examine.ts:20-36`:

   ```ts
   export const CONFIDENCE = {
     TAG_CONFIRM: 0.95,
     TAG_CORRECT: 0.9,
     TAG_SPAN: 0.9,
     PRONOUN_CONFIRM: 0.85,
     PRONOUN_CORRECT: 0.8,
     PRONOUN_KEEP_FLAG: 0.6,
     ALT_CONFIRM: 0.8,
     ALT_CORRECT_FLAG: 0.7,
     ALT_KEEP_FLAG: 0.6,
     UNANCH_NAMED_FLAG: 0.65,
     UNANCH_NARR_FLAG: 0.5,
     LUMPED_FLAG: 0.65,
     NARRATION_CONFIRM: 0.95,
     NARRATION_DEMOTE: 0.9,
     UNALIGNED_CAP: 0.74,
   } as const;
   ```

   The invariant future changes must preserve: `tag-name` evidence outranks `tag-pronoun`, which
   outranks `alternation`, which outranks `unanchored` — and every flag-worthy case (anything the
   evidence could not prove) lands strictly below the manuscript view's existing `< 0.75`
   low-confidence triage threshold. Tuning the exact numbers is fine; reordering the tiers is not.
2. **Strong tags outrank everything (hard invariant).** Nothing — not the model's own guess, not
   alternation, not escalation (§6) — may override a *strong* `tag-name` attribution. Enforced in
   `decideAnchoredSpeech`'s `tag-name` case (confirm-or-correct, never
   flag-and-keep-model) and independently re-asserted in the escalation acceptance rules
   (`escalation.ts` — a proposed id is rejected if it contradicts any `tag-name` evidence, per
   spec §6 "Acceptance rules").

   > **Updated 2026-07-21 (deterministic tuning — spec/plan
   > `docs/superpowers/{specs,plans}/2026-07-21-attribution-deterministic-tuning*`).** The
   > invariant now holds for *strong* tags only. A `tag-name` minted from a **beat-only
   > quote-paragraph narration gap** (e.g. `"Stop." Anton frowned.` — a beat verb, no speech
   > verb) is marked `speaker.strength: 'weak'` in the parser (A1). A weak tag the model
   > **disagrees** with now **keeps the model id and flags** (`tag-weak-keep-flag:<model>-vs-<tag>`,
   > bucket `flagged`) instead of force-correcting (A2); a weak tag the model agrees with still
   > confirms. Absence of `strength` = strong = the immutable behaviour above (a speech-verb tag
   > and the dash/quote-interior beat tag the Russian/German `кивнул`-style cases rely on stay
   > strong). Escalation's rejection rule was also **generalized** (E-core): escalation may now
   > only *fill* a genuinely-unresolved `unanchored-narrator` placeholder and never overwrites
   > **any** committed named answer (not just a `tag-name`), grounded with confident (≥0.8)
   > neighbour anchors (E1). On-box averaged eval (qwen36-cw-iq4-32k, 3 runs) recovered the
   > escalation regressors — ch46 +11.1, Coalfall +4.6 vs the prior baseline, no fixture regressed.
3. **Continuation exemption (hard invariant).** A sentence inside a speech span — e.g. the
   second sentence of a multi-sentence dash-utterance, which has no leading dash of its own — is
   classified as *speech*, not narration: it inherits the enclosing span's speaker/evidence and is
   exempt from the narrator-default demotion. This closes a bug in the shipped Wave A heuristic
   (`isSpokenLine`, which re-classified from the bare sentence text and could wrongly demote a
   continuation). Enforced structurally: `decideSentence` (`cross-examine.ts:225-258`) only ever
   reaches `decideNarrationOnly` (the demote path) when NO aligned span is `kind: 'speech'` or
   `kind: 'tag'` for that sentence — a continuation sentence aligns inside the same `speech` span
   as its opening sentence and therefore never falls through to the demote branch. Regression-
   pinned in `parser.test.ts` (multi-sentence utterance cases) and end-to-end in
   `analysis.structure-fixture.test.ts` (assertion 3, the multi-sentence utterance test — the
   continuation is explicitly asserted `!== 'narrator'`).
4. **Engine-OFF / unsupported-language → byte-identical; below-alignment-floor → flag-only
   (correction disabled).** Three independent fallback paths, all safe, but not all the same
   output:
   - `analyzer.structure.enabled = false` (env `STRUCTURE_ENGINE=0`): the engine does not run at
     all; `attributeChapterStage2` falls back to the pre-engine `applyNarratorDefault` call.
     Pinned by a dedicated `toEqual` test comparing the two code paths (task 8).
   - Unsupported/unknown book language: the language convention table resolves empty, so the
     parser (`parser.ts`) emits zero `StructuralEvidence`, and the cross-examiner's per-sentence
     decisions degrade to the same narrator-default-only shape.
   - Alignment rate for a chapter falls below the floor (`analyzer.structure.alignmentFloorPct`
     concept from spec §5.2, default 80%): `crossExamine`'s `flagOnly` branch
     (`cross-examine.ts:264, 77-85`) disables correction chapter-wide — every sentence passes
     through via `flagOnlyDecision`, keeping the model's own id and only capping confidence at
     `UNALIGNED_CAP` (0.74). This is a distinct third behaviour, not byte-identical to the other
     two (the model's id survives uncorrected instead of being demoted to `narrator`). Escalation
     (§6) is also skipped entirely below the floor — a misaligned engine must never rewrite
     attributions, and escalation is a rewrite (`attributeChapterStage2`,
     `server/src/routes/analysis.ts`, gates the escalation block on `!examined.report.flagOnly`).
5. **`lumped` entries are never auto-corrected.** When one model sentence spans both a speech
   span and a tag/beat span, the engine cannot un-lump it (retagging the whole entry to the
   speaker would voice the tag words too) — it keeps the model's id, flags it, and stamps
   `LUMPED_FLAG` (0.65). See `decideSentence`'s `as.lumped` branch (`cross-examine.ts:239-244`).

## Registry knobs (all under the new `analyzer-structure` group, `server/src/config/registry.ts:1062-1103`)

| Key | Env var | Type | Default | Help |
|---|---|---|---|---|
| `analyzer.structure.enabled` | `STRUCTURE_ENGINE` | boolean | `true` | Deterministic dialogue-structure pass that corrects tag-proven attributions and derives honest confidence. Off = pre-engine behaviour. |
| `analyzer.structure.escalation` | `ATTRIBUTION_ESCALATION` | enum (`off`\|`local`\|`cloud`) | `'local'` | Second-pass re-query of unresolved dialogue windows: `'local'` uses the configured analyzer, `'cloud'` the Gemini-API Gemma model, `'off'` disables. |
| `analyzer.structure.maxWindowsPerChapter` | `ESCALATION_MAX_WINDOWS_PER_CHAPTER` | integer, min 0 | `120` | Cap on re-queried conversation windows per chapter. |
| `analyzer.structure.maxWindowsPerBook` | `ESCALATION_MAX_WINDOWS_PER_BOOK` | integer, min 0 | `600` | Cap on re-queried conversation windows per full-book analysis. |

Escalation defaults to `'local'`, not `'off'` — the spec's §5.4 measurement (below) showed the
deterministic passes alone leave an unreviewably large residue on dialogue-dense prose, so the
targeted local re-query is part of the standard pipeline, not an opt-in extra. Escalation never
blocks analysis completion — on budget exhaustion the remaining flags simply stand.

**Wiki documentation is owed separately** — see the implementation report's "Wiki rows" section
for the four ready-to-paste Advanced-Settings rows; this repo's `docs/wiki/Advanced-Settings.md`
mirror was deliberately NOT edited in this PR (see that report for why).

## Delivery sequencing

This spec has two independent halves that ship in the same PR but are NOT built in the same
order:

1. **The deterministic engine + targeted escalation + provenance** (parser, aligner,
   cross-examiner, escalation selector/runner, registry knobs, `attributeChapterStage2` wiring,
   `analysisProvenance`/run-report persistence) is fully independent of any other in-flight work
   and lands first (tasks 1–9b, 11–12 in the implementation ledger).
2. **The script-review inbox evidence annotations** (`buildScriptReviewChapterInbox` gaining an
   optional `[structure: …]` per-sentence suffix, spec §7) reuse ① verbatim and add no new model
   passes, but `server/src/routes/script-review.ts` is a **shared file** with the concurrent
   `2026-07-09-script-review-persistence-design.md` thread. This half is deliberately sequenced
   AFTER that persistence PR merges to `main`, to avoid a rebase collision on the same call site
   (`runScriptReviewJob`'s `buildScriptReviewChapterInbox` invocation). Until that lands, a
   chapter's script-review inbox renders exactly as it does today — the annotation is additive
   and only appears where structure disagrees with the current attribution or the line is
   unanchored, so a chapter with no annotations stays byte-identical (same additive pattern as
   the existing fs-64 prior-exchange block).

**Known staleness interaction** (named here so it isn't rediscovered as a bug): this engine
changes sentence `characterId` at analysis time, so a persisted `reattribute` finding generated
*before* the engine ran can become redundant or unappliable when replayed against corrected
attributions. That is ordinary finding-staleness under the persistence spec's own invalidation
rules — expected behaviour, not data loss.

## Test plan

### Automated coverage

- Vitest server, per-unit, colocated under `server/src/analyzer/dialogue-structure/`:
  - `name-matcher.test.ts` — Russian case-form stemming (Антон/Антона/Антону/…), alias hits, no
    false-positive on substrings; identity matchers for en/es/fr/de.
  - `lang/index.test.ts` — convention-table wiring per language, empty table for unsupported.
  - `parser.test.ts` — dash-dialogue (tag before/after speech, interior-punctuation dashes that
    must NOT toggle, multi-sentence continuation, pronoun tags) and quote-pair paths (en/es/fr/de),
    incl. the German ASCII-closer pairing (#1598) and the mixed-closer invariant: `findQuoteRuns`
    groups closers by opener so a `„` run ends at the NEAREST closer of any glyph (`“`/`”`/`"`),
    keeping a mixed-glyph or stray-closer paragraph from over-merging narration into speech (#1601).
  - `windows.test.ts` — conversation-window grouping (narration-break threshold), alternation,
    pronoun resolution, the third-voice alternation-abort rule.
  - `aligner.test.ts` — glyph/whitespace drift, dash-variant/ellipsis normalization, duplicate-span
    tolerance, below-floor flag-only fallback.
  - `cross-examine.test.ts` — the full §5.3 matrix as table-driven cases, both hard invariants
    (continuation exemption; tag-name never overridden) as dedicated cases, derived-vs-model
    confidence replacement.
  - `escalation.test.ts` — selector windowing, acceptance rules, RECITATION-skip (empty-body
    detection, not exception-based), budget caps, tag-name-never-overridden re-asserted
    independently inside escalation's own acceptance path.
- Vitest server, integration:
  - `server/src/routes/analysis.structure-engine.test.ts` (tasks 8/9b) — `attributeChapterStage2`
    wiring: engine-off byte-identical to `applyNarratorDefault`, knobs threaded correctly,
    escalation mode routing.
  - `server/src/routes/analysis.structure-fixture.test.ts` (task 12) — end-to-end against a new,
    Castwright-owned, dash-dialogue-convention Russian fixture (see below), 8 assertions covering
    tag-proven correction, the continuation exemption, pronoun resolution, two-hander alternation,
    a three-party alternation-abort case, and the exact `structureReport` bucket tally
    (`confirmed: 5, corrected: 7, flagged: 2, lumped: 0, alignedPct: 100`).
  - `server/src/routes/analysis.test.ts` — `aggregateStructureReports` (empty→undefined, sums,
    sentence-count-weighted `alignedPct`) and `analysisProvenance` persistence at both call sites
    (main whole-book route + chapter-subset retry route), including the subset route's **rewrite**
    semantics (fresh `at`, not append).
  - `server/src/routes/book-state.reparse.test.ts` — back-compat: a legacy `state.json` with no
    `analysisProvenance` still 200s with the field `undefined`; a populated block surfaces at the
    correct nested path (`res.body.state.analysisProvenance`).
- **New dash-dialogue Russian fixture** (spec §9 explicit requirement): the repo's existing
  `the-coalfall-commission.ru.md` is guillemet/quote-style with multi-turn paragraphs — it
  exercises the quote path, not the paragraph-leading dash-dialogue convention the acceptance book
  (_Ночной дозор_) actually uses. `server/src/__fixtures__/the-coalfall-commission.ru-dash.md` is
  a new, original ~41-paragraph Castwright-owned scene (Майрин/Тобиас + a one-scene walk-on,
  Геррик) purpose-built to exercise dash-dialogue tag-before/tag-after, the interior-dash
  disambiguation rule, the continuation exemption, pronoun resolution, two-party alternation, and
  a three-party alternation-abort — never copyrighted text in the repo.

### Manual acceptance walkthrough (on-box, owed post-merge)

Re-analyze _Ночной дозор_ (9 chapters, 14,065 sentences) on the **default pipeline** (structure
engine on, `analyzer.structure.escalation = 'local'`) via `cd server && npm run dev` +
`npm run dev`, real analyzer, no mocks.

**Baseline, measured 2026-07-06 (pre-engine):**

| Metric | Baseline (today) |
|---|---|
| Flagged sentences (`confidence < 0.75`) | 0 |
| Structurally unanchored speech turns (sentence-level pilot, spec §5.4) | ~1,900 (68% of 2,861+366 dash turns) |
| Dash-speech-on-narrator (hard-error class) | ~859 sentences |
| Tag/pronoun-anchorable turns (spec §5.4 pilot) | 32% (863 of 2,700 dash turns: 78 in-sentence name, 407 adjacent-fragment name, 433 pronoun→first-person, ~53 clean two-party parity) |
| Measured escalation windows on this book (spec §5.4) | 553 |

**Targets:**

1. Flagged sentences land at triage scale — target **≤ ~500** (down from 0-that-should-have-been-
   thousands), concentrated on genuinely ambiguous lines.
2. The hard-error class (structure-says-speech attributed to narrator/unknown-bucket) drops to
   **near-zero** after correction + escalation, from the ~859-sentence baseline.
3. Named-character line counts rise / unknown-bucket (`unknown-male`/`unknown-female`) share
   falls, reversing the `foldMinorCast` under-count cascade described in spec §1.
4. Spot-check chapters 1 and 9 (the most hand-corrected in the original manual-fix session) —
   manual-fix rate per chapter should drop to triage-queue scale.
5. Wall-clock: expect roughly ~2–5 h added at the default `'local'` escalation setting
   (~550 windows × ~15–30 s local, per spec §6) — acceptable per the user's stated trade
   (analysis time vs. manual fixing time), and capped by the `maxWindowsPerBook`/
   `maxWindowsPerChapter` budgets. Acceptance never depends on `'cloud'` escalation — total
   RECITATION blockage on this famous in-copyright book degrades gracefully to `'local'`
   behaviour, not a design failure.

**Provenance check:** after the run, `state.json`'s `analysisProvenance.report` should show the
aggregated `{alignedPct, confirmed, corrected, flagged, escalated, escalationAccepted}` — this is
the before/after instrument for acceptance, replacing the "we could not determine which
analyzer/model produced this analysis" forensics gap this spec also closes.

## Appendix — §5.4 probe methodology (reproduce for acceptance re-runs)

The spec's §5.4 measurement ("what this does to the triage queue") was a sentence-level pilot run
against the real 2026-07-06 _Ночной дозор_ stage-2 output (14,065 sentences), reproduced here so
acceptance can re-run an equivalent probe against a fresh analysis and compare:

**Method:**

1. Load the analyzed book's per-chapter sentence output (raw stage-2 JSON, pre-fold).
2. For each chapter, walk paragraphs of `chapter.body` and classify each as dash-dialogue-open
   (starts with `—`/`–`/`-`) or narration.
3. Within each dash-dialogue paragraph, split on the interior dash toggle rule (comma/punctuation
   + lowercase word before an interior dash = tag boundary) to get `speech` vs `tag` sub-spans —
   count each `speech` sub-span as one **dash turn**. Separately count **dash tag-fragments**
   (the `tag` sub-spans) for reference (measured: 2,861 dash turns, 366 tag-fragments).
4. For each dash turn, attempt anchoring in this priority order and tally which rung resolved it:
   a. **in-sentence name** — the turn's own tag clause contains a roster name/alias match via the
      stem matcher (measured: 78).
   b. **adjacent-fragment name** — the immediately adjacent tag fragment (not the turn's own
      clause) contains a name match (measured: 407).
   c. **pronoun → first-person** — a first-person pronoun (`я`) tag resolves to the book's
      established first-person narrator-voice character, when the roster has exactly one
      (measured: 433 — the _Night Watch_ `я`→Антон case).
   d. **clean two-party parity** — the turn sits in a strict two-participant alternating run with
      no ambiguity (measured: ~53).
   Sum of a–d = **863 anchored (32%)**; everything else = **~1,900 unanchored (68%)**.
5. Report the anchored/unanchored split and the per-rung breakdown as the pilot's headline numbers.

**Reproducing for a fresh acceptance run:** after re-analyzing with the real engine (not the
pilot script), the equivalent instrument is the persisted `analysisProvenance.report` fields
(`confirmed`+`corrected` ≈ the pilot's "anchored" set at the *paragraph/window* granularity the
real parser uses, which the spec explicitly expects to beat the sentence-level pilot's floor —
see spec §5.4's closing note: "the paragraph-aware parser should beat the sentence-level pilot
... but the design must not depend on that improvement — it depends only on the measured floor").
Compare `report.flagged` against the ≤ ~500 target directly; there is no need to re-run the raw
pilot script itself once the real engine's run-report is available, but the pilot's per-rung
categories above remain the reference vocabulary for describing WHY a given sentence is still
flagged (unanchored vs. contested-alternation vs. lumped, etc.) during the chapter 1/9 spot-check.

## Out of scope

- No persistence or results-UI work — owned by the concurrent script-review-persistence spec.
- No frontend changes — the low-confidence UI, thresholds, and navigation stay as-is.
- No new cast-dedup logic (roster id canonicalization shipped separately, PR #962).
- No full multi-party dialogue disambiguation — an unanchored sentence is flagged, not guessed
  harder.
- No per-model prompt tuning — the June 2026 lesson (plan 221) is that verdicts tuned on one
  model don't transfer; the engine is deterministic code by design.
- No new analyzer model requirements — cloud escalation (`'cloud'`) is optional, off unless
  explicitly configured, and uses the already-configured Gemini-API Gemma model.

## Ship notes

(Filled in when status flips to `stable` — commit SHA, on-box acceptance results against the
targets above, any behaviour delta vs. this plan. Not yet shipped: on-box acceptance is owed
post-merge per the Test plan above.)
