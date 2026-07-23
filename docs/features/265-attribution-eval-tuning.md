---
status: active
shipped: null
owner: null
---

# 265 — Attribution eval + tuning loop

> Status: active
> Key files: `server/src/analyzer/attribution-eval/{schema,scorer,roster-schema,capture,capture-cli,buckets,run-eval,run-eval-cli,diff-runs}.ts`, `server/src/analyzer/attribution-eval/__fixtures__/{coalfall-ch1.en.labelled.json,coalfall.roster.json}`, `scripts/run-attribution-eval.mjs`, `server/src/routes/analysis.ts` (`onStages` seam), `server/src/analyzer/dialogue-structure/{cross-examine.ts,types.ts}` (`reasons`/`DecisionBucket`)
> URL surface: none (dev tooling — no route/UI surface)
> OpenAPI ops: none
> Design spec: [docs/superpowers/specs/2026-07-20-attribution-eval-tuning-design.md](../superpowers/specs/2026-07-20-attribution-eval-tuning-design.md)
> Implementation plan: [docs/superpowers/plans/2026-07-20-attribution-eval-tuning.md](../superpowers/plans/2026-07-20-attribution-eval-tuning.md)

## Benefit / Rationale

- **User:** n/a directly (dev tooling) — but it's the mechanism that turns the
  user's own hand-corrected chapters (Playing with Fire ch. 43–46) into a
  repeatable way to raise attribution quality, which the listener experiences
  as fewer wrong-voice lines.
- **Technical:** answers "did that prompt/heuristic change make attribution
  better or worse on Qwen local and Gemma cloud?" with a number instead of an
  eyeball re-analysis. Separates *where* a fix landed (raw LLM output vs. the
  deterministic `cross-examine` layer vs. the escalation pass) so tuning
  targets the right layer — durable wins for Qwen come from
  `cross-examine.ts`, not prompt calibration (plan 221 / srv-59 already proved
  prompt-level calibration is a dead end on small local models).
- **Architectural:** establishes an opt-in, triple-gated "eval" tier parallel
  to `golden-audio` (185) — runs the *real* pipeline against fixtures, never
  rides `test:all`/`verify`. Adds one small, additive eval-return seam to
  production attribution code (`onStages` on `attributeChapterStage2`,
  `reasons` on `CrossExamineResult`) so the harness can see intermediate
  stages the route otherwise discards, without changing default runtime
  output.

## Architectural impact

- **New seams / extension points:**
  - `attributeChapterStage2`'s optional `onStages` callback
    (`server/src/routes/analysis.ts:1735`) — when supplied, receives
    `{ raw, deterministic, final }` sentence snapshots plus the deterministic
    stage's per-sentence reasons. Omitted (default), the function's return
    shape and behaviour are unchanged.
  - `CrossExamineResult.reasons` (`cross-examine.ts:46`) — an
    `Array<{ index, reason, bucket }>` alongside the existing
    `sentences`/`flags`/`report`. Additive field; existing destructuring
    (`const { sentences, flags } = crossExamine(...)`) is unaffected.
  - `DecisionBucket` type now exported from
    `server/src/analyzer/dialogue-structure/types.ts:36` (`'confirmed' |
    'corrected' | 'flagged' | 'lumped'`) for reuse by the eval bucket
    coarsening.
  - Two new npm scripts: `eval:attribution` (runner, via
    `scripts/run-attribution-eval.mjs`) and `eval:attribution:capture`
    (capture CLI, via `tsx`). Silver capture (Task 8) rides the same
    `eval:attribution:capture` script with an extra `--silver` flag
    (`capture-cli.ts`'s `parseArgs`) rather than a third npm entry — the
    existing script already forwards argv through `tsx`, so a flag was
    sufficient.
- **Invariants preserved:** the opt-in/gated-tooling posture established by
  `golden-audio` (185) — no model-touching command in `test:all`/`verify`;
  SKIP + exit 0 when a gate is missing. No production runtime behaviour
  changes when `onStages` is unused (the common case).
- **Migration story:** none — no persisted-state shape changes. The corpus
  dir is new, git-ignored, and starts empty on every checkout.
- **Reversibility:** delete `server/src/analyzer/attribution-eval/`, the two
  npm scripts, the `.gitignore` corpus line, and the two additive fields
  (`onStages`, `reasons`) — nothing else in the codebase reads them.

## Invariants to preserve

1. **Opt-in + triple-gated.** The runner (`run-eval-cli.ts` /
   `npm run eval:attribution`) and the capture CLI
   (`npm run eval:attribution:capture`) are never wired into `test:all` or
   `verify`. `runEval()` returns `{ skipped: <reason>, results: [] }` (never
   throws) when the corpus dir has no fixtures, Ollama is unreachable, or
   `GEMINI_API_KEY` is unset for the Gemma engine — the CLI prints a `[SKIP]`
   banner and exits 0. Same posture as `golden-audio` (185).
2. **Corpus is local-only.** `server/src/analyzer/attribution-eval/corpus/`
   is git-ignored (`.gitignore:170`) — labelled chapter fixtures and per-book
   roster snapshots captured from copyrighted books never land in git. Only
   the Castwright-owned Coalfall fixtures
   (`__fixtures__/coalfall-ch1.en.labelled.json` +
   `__fixtures__/coalfall.roster.json`) are committed.
3. **Roster-pinning prevents ID drift.** The runner pins the captured roster
   snapshot as a fixed `stage1` (`rosterToStage1`, `run-eval.ts`) before
   attributing, so stage-1 cast re-discovery can never mint IDs that diverge
   from the truth fixture's `speakerId`s. `scoreAttribution` joins truth to
   predicted by ID; without pinning, every correctly-attributed line would
   score as a false positive against a freshly-discovered ID space.
4. **Three-point metric, not one.** Every fixture × engine run scores three
   stages — **raw** (LLM stage-2 output before any deterministic pass),
   **deterministic** (post-`crossExamine`, or post-`applyNarratorDefault`
   only when the `analyzer.structure.enabled` knob is off), and **final**
   (post-`escalateFlaggedWindows` when escalation is active — true
   production output). `recall = TP / (TP + FN)`; `segMismatch`
   (segmentation drift) is reported separately and never folded into the
   recall denominator. Deterministic/final stages are additionally bucketed
   by evidence family (`buckets.ts`: `tag`, `pronoun`, `alternation`,
   `unanchored`, `narration`, `lumped`, `unaligned`, `other`) derived from
   the real `cross-examine.ts` `Decision.reason` taxonomy.
5. **Coalfall guardrail runs on every eval.** `runEval()` always scores the
   committed Coalfall fixture + roster alongside whatever corpus fixtures are
   present (`run-eval-cli.ts`'s `loadDir(COMMITTED)` merge) — the anti-
   overfit check against the thin, single-author, single-language PwF seed.
6. **Production seam is strictly additive.** `onStages` and `reasons` are
   both optional/extra outputs; omitted, `attributeChapterStage2` and
   `crossExamine` behave exactly as before this plan. Locked by
   `server/src/routes/analysis.ts` and
   `server/src/analyzer/dialogue-structure/cross-examine-reasons.test.ts`.

## Test plan

### Automated coverage

- Vitest server (`server/src/analyzer/attribution-eval/roster-schema.test.ts`)
  — `RosterSnapshot` Zod validation (accepts a well-formed roster, rejects a
  character missing `id`).
- Vitest server (`server/src/analyzer/attribution-eval/capture.test.ts`) —
  pure transforms: `buildLabelledChapter` filters to chapter/orders by
  id/maps `characterId`→`speakerId`; `buildRosterSnapshot` keeps
  id/name/gender/aliases with name→id fallback; `buildSilverSkeleton` (Task
  8) schema-parses, seeds `lines` from current attribution, and attaches
  `priorExchange` only when the supplied prior-chapter sentences resolve to
  a two-speaker exchange (reusing `priorChapterBoundaryExchange`).
- Vitest server (`server/src/analyzer/attribution-eval/capture-cli.test.ts`)
  — `captureCorpus` end-to-end against a temp workspace: writes the labelled
  fixture(s) + roster snapshot, reproduces the upstream boilerplate strip.
  `captureSilverCorpus` (Task 8) — writes the `.silver.labelled.json`
  skeleton with the prior chapter's captured boundary exchange attached, and
  omits it for a chapter with no preceding chapter.
- Vitest server (`server/src/analyzer/attribution-eval/buckets.test.ts`) —
  `evidenceFamily` reason→bucket coarsening for every prefix
  (`tag-*`, `pronoun-*`, `alt-*`, `unanchored*`, `narration*`, `lumped`,
  `unaligned`, fallthrough `other`).
- Vitest server
  (`server/src/analyzer/dialogue-structure/cross-examine-reasons.test.ts`) —
  asserts `CrossExamineResult.reasons` is populated 1:1 with sentences
  (confirmed/corrected/flagged all carry a reason+bucket) without altering
  `sentences`/`flags`/`report`.
- Vitest server (`server/src/routes/attribute-chapter-stages.test.ts`) —
  asserts the `onStages` callback fires with `{ raw, deterministic, final }`
  snapshots + deterministic reasons, and that omitting it changes nothing
  about the default return.
- Vitest server (`server/src/analyzer/attribution-eval/run-eval.test.ts`) —
  `evalFixture` orchestration: scores all three stages via mocked analyzer +
  a pinned roster, asserts `byFamily` rollup and the recall/segMismatch
  split.
- Vitest server
  (`server/src/analyzer/attribution-eval/run-eval-cli.test.ts`) — the gating
  contract: `runEval` returns `{ skipped: 'no corpus fixtures found', ... }`
  (never throws) against an empty corpus dir; `loadCorpus` pairs
  `*.labelled.json` with the matching `*.roster.json`.
- Vitest server (`server/src/analyzer/attribution-eval/diff-runs.test.ts`) —
  `diffRuns` low-confidence delta + changed-attribution list between a
  baseline and tuned full-book result set.
- Vitest server (`server/src/analyzer/attribution-eval/schema.test.ts`,
  `scorer.test.ts`) — pre-existing `LabelledChapter` schema +
  `scoreAttribution` precision/recall/segMismatch/perLine maths (unchanged
  by this plan; re-run as part of the same suite for regression coverage).
- Live model calls (the real `npm run eval:attribution` /
  `eval:attribution:capture` runs against Ollama/Gemini) are intentionally
  **not** part of the gated suite — they're the opt-in runner itself, same
  posture as `golden-audio`'s Suite A.

### Manual acceptance walkthrough

Requires an on-disk book with hand-corrected chapters (the reference case:
Playing with Fire, ch. 43–46) and, for the live run, a reachable local Ollama
and/or a `GEMINI_API_KEY`.

1. **Capture the corpus:**
   `npm run eval:attribution:capture -- --book <PwF-bookId> --chapters 43,44,45,46`
   → writes git-ignored fixtures
   (`server/src/analyzer/attribution-eval/corpus/<slug>-ch43.en.labelled.json`
   … `ch46`) plus one roster snapshot
   (`server/src/analyzer/attribution-eval/corpus/<slug>.roster.json`). No
   model calls; pure file transform. `git status` shows nothing new tracked
   (corpus dir is git-ignored).
1a. **Capture a silver skeleton (Task 8):**
    `npm run eval:attribution:capture -- --book <bookId> --chapters <N> --silver`
    → writes `<slug>-ch<NN>.<lang>.silver.labelled.json`, `lines` seeded from
    that chapter's current attribution and, when a preceding chapter exists,
    a `priorExchange` captured from its final two-speaker exchange. No model
    calls; the corrected `speakerId`s are authored afterward by a human
    labelling pass over this skeleton, not by the CLI.
2. **Run the eval against Qwen local:**
   `npm run eval:attribution -- --engine qwen` → prints a per-fixture,
   per-stage scorecard (`raw → det → final` recall %, `n=`, `seg-drift`) plus
   the per-evidence-family breakdown, for every captured PwF chapter **and**
   the committed Coalfall guardrail fixture.
3. **SKIP path, no corpus:** on a fresh checkout (corpus dir empty/absent),
   `npm run eval:attribution` prints `[SKIP] attribution eval: no corpus
   fixtures found` and exits 0 — does not error, does not block anything
   else.
4. **SKIP path, engine unavailable:** with Ollama stopped, `npm run
   eval:attribution -- --engine qwen` (corpus present) prints a `[SKIP]`
   banner naming the engine and exits 0 rather than throwing a connection
   error.
5. **Cloud engine:** with `GEMINI_API_KEY` set, `npm run eval:attribution --
   --engine gemma` runs the same scorecard against `gemma-4-31b-it`.
   `ATTRIBUTION_ESCALATION=off` skips the second cloud (escalation) pass
   while iterating quickly.

## Out of scope

- **Tuning the LLM script-review pass** (`audiobook-script-review.md`) — the
  sequenced follow-up phase, layered on top of the attribution baseline this
  plan improves. Not tasked here; see design spec §2 "Non-goals".
- Dynamic per-book few-shot injection — rejected in the design spec (burns
  Gemma's free-tier token budget for marginal gain on small models).
- Model *selection*, fine-tuning, or any change to end-user analyzer
  behaviour — this plan only adds measurement + an additive eval seam.
- A CI job that runs the live eval in the cloud — like `golden-audio`, this
  is a dev-box, on-demand tool; the corpus is local-only by design (§4 of
  the spec) so there is nothing for CI to run against.

## Ship notes

(Fill in when status flips to `stable`.)

### Follow-up: first deterministic-first tuning cycle (2026-07-21)

The harness this plan built was used to run its first real tuning cycle against local
Qwen (`qwen36-cw-iq4-32k`), delivered on branch `fix/server-attribution-deterministic-tuning`
under its own spec/plan
(`docs/superpowers/{specs,plans}/2026-07-21-attribution-deterministic-tuning*`). Two harness
extensions landed here as part of it:

- **Per-family accuracy excludes segmentation drift** — `familyBreakdown` reports each evidence
  family as `correct / attributed / drift` (a `truth === null` drift line is a segmentation split,
  not a mis-attribution, so it no longer deflates the family's accuracy denominator).
- **`--runs N` multi-run averaging** (`aggStage`/`aggregateFixture`, env `EVAL_RUNS`) — averages
  per-run ratios with mean±range, so sub-noise (±2–3%) single-run deltas can't be read as signal.
  Acceptance uses N≥3.

The tuning itself (E-core escalation fill-gate, E1 neighbour-grounded re-ask, A1/A2 weak-tag
strength) lives in plan [247](247-dialogue-structure-attribution.md) (invariant #2, updated
2026-07-21). On-box averaged result (3 runs): ch46 +11.1, Coalfall +4.6 vs prior baseline, ch45
escalation gain preserved, no fixture regressed. Remaining ch44 gap (raw→det crossExamine on
*strong* tags) is the deferred deterministic-first phase-2 / Target C lever.

### Target C: stage-2 attribution prompt enrichment — chapter-builder-only (2026-07-22)

The harness's third cycle enriched the stage-2 line→speaker prompt itself (the LLM's first,
full-context "raw" pass) with a shared, language-safe `STAGE2_ATTRIBUTION_RULES` block, on branch
`feat/server-stage2-attribution-prompt` under its own spec/plan
(`docs/superpowers/{specs,plans}/2026-07-21-target-c-stage2-attribution-prompt*`). Two more harness
tweaks landed to make the acceptance gate trustworthy: the scorecard labels the resolved model id
(`slotLabel`) not the bare engine slot, and the **`raw` stage now carries its per-evidence-family
breakdown** (it was scored without `reasons`, so `raw.byFamily` was empty — a rule that shuffles
errors between families could otherwise pass a flat-aggregate gate invisibly).

**On-box eval (English-scoped, `--runs 3`) drove a scope narrowing.** Injecting the block into
BOTH stage-2 builders lifted the single-call chapters (Qwen raw: ch45 +3.5, ch46 +0.8) but
**regressed ch44 −2.5** — the *only* chunked fixture — because the untagged-continuation /
two-hander rules misfire across chunk boundaries on a multi-speaker chapter (the drop was broad
across every speaker-inference family; narration held). A chapter-**builder-only** variant (rules
in `buildStage2ChapterInbox`, omitted from `buildStage2ChunkInbox`) recovered ch44 to baseline
(82.6 vs 82.5) while keeping the wins (ch45 +4.7 with a pinned floor, ch46 +0.8) — no fixture below
its baseline min on Qwen, and flat-or-better on cloud Flash-lite/Gemma (ch44 was already flat there).

**Shipped as chapter-builder-only.** Measured targets: local `qwen36-cw-iq4-32k`, cloud
`gemma-4-31b-it` + `gemini-3.1-flash-lite`. English-only acceptance. Tracked follow-ups: a
chunk-safe rules variant (to get the block into the chunk path without the boundary misfire), RU/DE
eval fixtures, and pinning the cloud decoding temperature (the unpinned ~1.0 default drove the wide
ch45 raw band on cloud vs the tight band on temp-0.2 Qwen).

### Chunk-safe rules variant — hybrid-C (#1758 / srv-63, 2026-07-22)

The chunk-safe follow-up above. Branch `feat/server-chunk-safe-attribution-rules` under its own
spec/plan (`docs/superpowers/{specs,plans}/2026-07-22-chunk-safe-attribution-rules*`). Adds a
second rules constant `STAGE2_ATTRIBUTION_RULES_CHUNK` (rules 1/2/4/5 byte-identical to the chapter
block — a drift-guard test pins that — with only rule #3 rewritten to scope continuation/alternation
*within the section*), rendered in `buildStage2ChunkInbox` alongside a deterministic "last-speaker
seed" threaded through the sequential chunk driver (last non-`narrator` id of each chunk's raw
returned attributions, carried across all-narration chunks). The chapter builder is byte-identical.

**On-box eval (English, `--runs 3`, `qwen36-cw-iq4-32k`) — floor-only, no lift.** The baseline was
**reused** from the 2026-07-21 capture (not re-run): the chunk path — `stage2-chunk.ts`, stage-1,
and `buildStage2ChunkInbox` — is unchanged from that baseline commit (`36f127ae`, an ancestor of
`main`) through current `main` (#1761 touched only the *chapter* builder), so the ch44 baseline is
byte-identical, on the same corpus (ch44 n=328). ch44 raw: **hybrid-C 81.8% [81.4–82.0]** vs
**baseline 82.5% [80.5–83.5]** vs the rejected both-builders **80.0%**. So hybrid-C clears the
no-regression floor (≥ baseline min 80.5) and beats both-builders by **+1.8** — the cross-boundary
misfire is gone — but sits −0.7 below the baseline mean (inside the baseline's own band): a **flat,
floor-only** result, not a lift. Family split explains the wash: rules 1/2 lifted `tag` (+1.1) and
`pronoun` (+3.2), but `unanchored` (−4.6) and `unaligned` (−19.5, wide-CI/seg-drift-heavy) fell —
i.e. the seed + rule-#3 rewrite did **not** pay off on the continuation cases they targeted. Every
other fixture flat (chapter path untouched: ch43 80.3=80.3 exact, ch45/46/Coalfall within noise);
`det`/`final` ticked down ~1pt.

**Shipped as floor-only** (user decision, 2026-07-22): no regression, strictly better than
both-builders, and it closes the "chunk path carries zero attribution rules" gap — but with **no
measured quality benefit**, so **no release-notes entry** (no user-visible delta). The seed/rule-#3
machinery earned no lift here; whether to keep or drop it is folded into the deferred
deterministic-first phase-2 / ch44-residual work, not re-litigated now.

### Addressee-name tag fix — deterministic-first phase-2 (2026-07-22, #1763)

The ch44 residual (#1758's floor-only result left the `unanchored`/continuation families
un-lifted) was diagnosed to a real parser bug, not a policy problem: `findRosterName` resolved
a speech tag's speaker as the *first* roster name in the clause — subject/object-blind — so an
**addressee** or **bystander** name (`"…," he said to Valkyrie.`, `сказал он Валери`) was minted
as a **strong `tag-name`** and force-corrected the line to the wrong voice. Fix = a new pure
`findSubjectName` that resolves the tag's **subject by verb position** (nearest name before the
speech/beat verb; inverted `said X` after it, **rejected** when an addressee preposition, a
bystander conjunction, or a subject pronoun intervenes — the pronoun clause is language-general
and handles Russian's caseless dative). `applyTag` uses it when the language opts in
(`addresseePrepositions`, populated en/de/es/fr/ru; zh/ja stay on the legacy path). Rule #2 (247
invariant #2) is preserved — a genuine subject-name tag still anchors strong. Built via SDD on
`fix/server-attribution-addressee-tag` (Tasks 1–3: `findSubjectName` + 5 lang tables; the
`applyTag` gate; a `canonicalId` scorer-alias seam de-duping `the_torment ≡ unknown-male`).

**Measurement = frozen-raw A/B (English, `--runs 3`, `qwen36-cw-iq4-32k`).** To separate the
engine lift from model-sampling noise, the raw model attribution was captured ONCE per fixture per
run, then the deterministic pass (`buildNameIndex → parseChapterStructure → resolveWindows →
alignSentences → crossExamine`) was replayed TWICE over that identical frozen raw — **baseline**
(`{...en, addresseePrepositions: undefined}` → legacy `findRosterName`) vs **treatment** (real
`en` → `findSubjectName`). Because both replays share one frozen raw, the treatment−baseline
recall delta (③) carries zero sampling noise. A self-validation asserted the manual treatment
replay reproduced the real pipeline's deterministic snapshot exactly — **mismatch = 0 on every
fixture, including the chunked ch44** — so the replay is faithful.

| Fixture | raw | base-det | treat-det | ③ engine lift (treat−base) | changed lines |
|---|---|---|---|---|---|
| **ch44** (target) | 84.9% | 82.6% | **84.6%** | **+1.93pp** [1.8, 1.8, 2.1] | 14 — all target bug cases |
| ch43 | 80.3% | 79.8% | 80.3% | +0.55pp [0.5×3] | 1 (`[180]` china→Valkyrie) |
| ch45 | 60.7% | 60.7% | 60.7% | 0.00pp | **none** |
| ch46 | 63.2% | 63.2% | 63.2% | 0.00pp | **none** |
| **coalfall-ch1** (guardrail) | — | 77.0% | 77.0% | **0.00pp** | **NONE** |

On ch44 the deterministic pass no longer throws away correct raw attribution: baseline-det sat
2.3pp **below** raw (82.6 vs 84.9), treatment-det sits only 0.3pp below (84.6 vs 84.9) — the fix
recovers essentially all of the residual. The ch44 changed lines are exactly the target cases:
`"Fireball,"` (the `he said to Valkyrie` case) → **skulduggery-pleasant**; `"I overestimated
you,"` → **the_torment** (scored TP via the `canonicalId` alias); `"Hey,"` reassigned
melissa→stephanie (Residual-D item — resolved by the subject-position rule, inside the
net-positive lift). Per-run ③ is uniformly positive (never a per-run regression).

**No-regression gate PASS.** The Opus whole-branch review named the frozen-raw no-regression
numbers as the actual merge gate for the one residual risk (compound multi-clause tags could
return `null` → pronoun fallthrough where legacy anchored). That risk **did not materialize**:
ch45, ch46, and the committed **coalfall-ch1 guardrail all show 0.00pp and ZERO changed lines** —
the specific assertion that must not move (Coalfall guardrail recall 77.0% baseline == treatment,
no line reassigned) holds.

**Measurement scope — English only.** The quantified lift is English (the sole eval corpus).
ru/de/es/fr ship the same fix + per-language `findSubjectName` unit tests with the full
dialogue-structure suite green (RU dash fixture + DE #1598 + ja cases), but their *quantified*
real-book acceptance is deferred to `#1759`'s fixtures — this is not "measured across all
languages." zh/ja are deliberately excluded from the fix (not CJK-aware).

Corpus hygiene applied for this measurement (git-ignored corpus, not shipped): `the_torment`
gained `"canonicalId": "unknown-male"` (entry kept, not deleted); nine ch44 continuation-as-
`narrator` lines inside uninterrupted single-speaker quoted runs were relabelled to their speaker
(5 diagnostic-confirmed from the plan table + 4 same-run siblings — `[309]`, `[317]`, `[318]`,
`[319]` — added under the plan's own uninterrupted-run rule; label changes shift baseline and
treatment scores equally and cannot distort the ③ delta).

### Script-review eval (char-level), silver capture + prior-exchange (2026-07-22)

This closes out the harness's own build (spec §3, Tasks 1–8): the `reviewed` stage measures the
**net effect of the LLM script-review pass** (`--review`) on attribution quality — did the pass that
runs *after* stage-2 + deterministic attribution make the transcript more or less correct, char for
char. It reuses the char-level, **segmentation-invariant** projection (`char-project.ts`'s
`CharProjection`, built for exactly this reason: scoring by chapter-text character position rather
than by matching normalised line text means a `reviewed`-stage split/extract/reattribute op registers
as an honest recall change instead of looking like a truth line "vanished"). `char-score.ts`'s
`diffHelpedHarmed` compares the pre-review (`final`) and post-review (`reviewed`) char-by-char
correctness against truth and buckets every truth-attributed character into **helped** (was wrong,
review fixed it), **harmed** (was right, review broke it), or **churn** (still wrong, but changed) —
reported per fixture via `formatReviewLine` (`run-eval-cli.ts`) alongside the reviewed stage's
per-op-class volumes and an illustrative op-dump of un-scored/off-roster ops.

**Gold-only gate.** Only the gold tier — the four hand-corrected PwF fixtures (ch43–46) plus the
committed Coalfall guardrail — gates anything. Silver fixtures (the `.silver.labelled.json` tag,
`FIXTURE_RE` in `run-eval-cli.ts`) are reported in their own `--- silver (directional, not gating)
---` block and never factor into a pass/fail decision (`partitionByTier`). This is deliberate: silver
skeletons are seeded from the book's *current* (possibly still-wrong) attribution rather than a full
independent human labelling pass, so they're directional signal for spotting a class of review
mistake early, not a number to hold a merge gate on.

**Prior-exchange v1 limitation.** The `reviewed` stage's first chunk of a chapter is fed the prior
chapter's final two-speaker exchange (`priorExchange`, fs-64's `priorChapterBoundaryExchange`) in
production, so it can resolve a tagless chapter-opening line via turn-taking — exactly the same
context the real route gives it. The v1 gold fixtures (ch43–46) were captured **before** this field
existed and carry no `priorExchange`, so a chunk-0 review run over them under-measures any
opening-line correction that depends on that context — the eval sees a harder, context-starved
version of chunk 0 than production ever runs. This task's silver capture path
(`buildSilverSkeleton`, `capture.ts` / `captureSilverCorpus`, `capture-cli.ts`) captures
`priorExchange` from the start, by reusing (not reimplementing) the route's own
`priorChapterBoundaryExchange`; re-capturing the gold fixtures with it is a tracked follow-up, not
done here — until then, treat any gold `reviewed`-stage opening-line result as a conservative
(harder-than-production) floor.

**Fidelity note — roster has no per-character `role`.** The `reviewed` stage's roster
(`reviewRoster`, `run-eval.ts`) carries `gender`/`aliases` but, like production's stringified
cast, no per-character `role` — `RosterSnapshot` has no such field, and `runReviewOverChapter`'s
roster param types it optional — so the gemini chunk budget's `JSON.stringify(roster).length`
approximates, rather than exactly matches, production's chunk boundaries. The internal
`final`→`reviewed` comparison is unaffected either way, since both sides of that comparison share
the same roster within a run.

**The char metric is a regression guard, not a lift target.** On an attribution baseline that's
already good (post the deterministic-first tuning cycles above), the *expected* good outcome on the
`reviewed` stage is **helped ≈ harmed ≈ 0** — there's little left for review to correctly fix, and a
well-behaved review pass shouldn't be breaking correct lines either. A large **positive** Δ
(reviewed noticeably better than final) is not a signal that script-review is earning its keep; it's
a signal to go check whether attribution *upstream* of review regressed — a bug that pushed more
lines wrong right before the review stage would show up as a big charitable "helped" swing here, as
review happens to patch over some of the damage. Read this stage as "did review avoid making a good
baseline worse", not "how much did review improve things."

### Captured baseline (2026-07-23, on-box)

First on-box `--review` baseline, **qwen `qwen36-cw-iq4-32k`**, book *Playing with Fire*
(`derek-landy__skulduggery-pleasant__playing-with-fire`, 42 chapters). Gold = ch43–46 + the committed
Coalfall guardrail (`--runs 3`); silver = 8 untuned chapters seeded from current attribution
(`--runs 1`, directional). This is the number the sequenced script-review **tuning** follow-up gates
against.

**Gold (`--runs 3`) — the regression guard reads clean.** char-recall `final → reviewed`:

| Fixture | final(char) → reviewed(char) | Δ | helped / harmed / churn |
|---|---|---|---|
| ch43 | 83.1 → 83.1 | +0.0pp | 0 / **0** / 0 |
| ch44 | 94.5 → 94.5 | +0.0pp | 0 / **0** / 0 |
| ch45 | 70.1 → 70.1 | +0.0pp | 0 / **0** / 0 |
| ch46 | 78.1 → 78.1 | +0.0pp | 0 / **0** / 0 |
| Coalfall | 93.4 → 97.0 | +3.6pp | 122 [0–209] / **0** / 0 |

**`harmed = 0` in every run of every fixture** — the pass never degraded attribution. On the four
tuned PwF chapters it's char-neutral (helped = harmed = 0), exactly the designed shape; its real work
shows in the op-dump (strip_tag 23–35/chapter pulling `he said`/beats + leaked `[emphatic]` /
`[structure:…]` artifacts out of spoken text; plus reattribute/split/merge). Coalfall shows the pass
*can* lift attribution (+3.6pp) with high run-variance and zero harm.

**Silver (`--runs 1`, directional, seed truth — NOT gating).**

| Fixture | final → reviewed (char) | Δ | helped / harmed / churn | notable ops |
|---|---|---|---|---|
| ch07 | 99.5 → 99.5 | +0.0pp | 0 / **0** / 0 | merge 3 |
| ch10 | 88.4 → 88.8 | +0.4pp | 66 / **0** / 124 | **reattribute 73** |
| ch13 | 88.1 → 89.4 | +1.3pp | **234** / **0** / 0 | strip_tag 17 |
| ch19 | 72.2 → 72.2 | +0.0pp | 0 / **0** / 170 | reattribute 10, merge 3 |
| ch25 (narration) | 100 → 100 | +0.0pp | 0 / 0 / 0 | validate_instruct 11 |
| ch30 | 99.4 → 99.4 | +0.0pp | 0 / **0** / 0 | validate_instruct 8 |
| ch33 | 75.7 → 75.7 | +0.0pp | 0 / **0** / 0 | merge/strip/validate |
| ch41 | 93.6 → **92.6** | **−1.0pp** | 0 / **86** / 22 | **reattribute 42** |

**The tuning leads this baseline surfaces:**

1. **Reattribution is the high-variance behavior on untuned text.** Tuned chapters trigger ~5
   reattributes; untuned **ch10 = 73, ch41 = 42**, with swinging outcomes (ch13 +234 helped, ch41 −86
   harmed, ch10 churn 124). Stabilizing reattribution — keep ch13-style help, kill ch41-style harm —
   is the #1 tuning target. **ch41 is the sole harm case** and the first thing to read op-by-op.
2. **`flag_nonstory` catches real import artifacts** (a truncated `alkyrie`→`Valkyrie`, header
   residue) — QA value beyond attribution.
3. **Silver harm/churn is correlated-error-ambiguous** (truth = the book's *unverified* current
   attribution): ch41's "harm" may be the review *correcting* a bad seed, counted as disagreement.
   Disambiguating needs the op-dump vs the actual text — a tuning-phase task, hence silver is
   directional, never a gate.

**Coverage caveat (surfaced by the `truthDropped` warning) — projection refinement shipped
(#1771).** The `truthDropped` count comes from truth lines whose text isn't a verbatim substring of
`chapterText`. Diagnosis corrected the original read here: the inline `[emphatic]`/`[hesitant]`/
`[structure:…]` tags live **in** the raw hydrated `chapterText`, not in the corrected/re-segmented
truth lines — so a truth line differing only by a tag failed to locate. `projectToChars` now takes an
opt-in `stripTags`, wired on the **truth** projection only (finalSentences derive from `chapterText`
and match verbatim, so `finalProj` is untouched): it removes inline `[...]` tags from both the
`chapterText` basis and each truth unit before matching and maps spans back to original positions,
with tag positions left `null` (invisible to the metric, which scores only truth-attributed chars).
Measured on the 12-fixture corpus: **truthDropped 231 → 162 (69 recovered, 30%)**. The residual ~162
are genuine `chapterText`↔label **content divergence** — OCR/import artifacts the labels corrected
(`tentor`→`Stentor`, `"26"` header residue) and re-segmentation — which a matcher must **not**
force-align (design spec O-4: no silent mis-assignment); that residual is a fixture-capture concern,
overlapping #1769. The change touches **only the truth projection** — `finalProj`,
`pairSpansToSentences`, and `applyOpsToCharArray` are untouched — so it is purely additive to the
recall denominator: no prior helped/harmed count is invalidated, and the newly-located tag-adjacent
chars are simply measured too. Interior tag positions are excluded from BOTH `charRecall` and (after
the review-folded fix) `lineRecall`, so a perfectly-attributed recovered line scores 1.0 rather than
deflating. Verified by the `char-project` + `char-score` unit tests + full `test:server`; the
231→162 delta is deterministic and GPU-free. An end-to-end gold re-confirmation that `harmed` stays 0
under the wider denominator is a cheap follow-up, deferred here only by Ollama single-slot contention
with concurrent eval work.
