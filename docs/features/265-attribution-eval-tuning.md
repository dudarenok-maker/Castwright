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
    (capture CLI, via `tsx`).
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
  id/name/gender/aliases with name→id fallback.
- Vitest server (`server/src/analyzer/attribution-eval/capture-cli.test.ts`)
  — `captureCorpus` end-to-end against a temp workspace: writes the labelled
  fixture(s) + roster snapshot, reproduces the upstream boilerplate strip.
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
