# Target C — Stage-2 attribution prompt enrichment — Design

**Status:** draft (awaiting user approval → writing-plans → SDD)
**Date:** 2026-07-21
**Author:** design thread (follow-up to PR #1752 deterministic-tuning)
**Related:** [[project_attribution_eval_qwen_baseline]], plan
`docs/superpowers/plans/2026-07-21-attribution-deterministic-tuning.md`,
regression plan `docs/features/265-attribution-eval-tuning.md`

## Goal

Raise the **raw** stage-2 line→speaker attribution score — the model's first
full-context pass, before any deterministic cross-examination — by giving that
pass the explicit attribution rules it currently lacks. The raw score is the
ceiling every downstream deterministic pass (crossExamine, escalation) builds
on; lifting it lifts the whole pipeline.

## Background — the raw pass is under-instructed

The rich attribution guidance in the analyzer today lives in the **stage-1
cast-detection** prompt (`server/src/routes/analysis.ts:1438–1519`): dialogue
tags are binding, first-person handling, name fidelity, "don't dump quotes on
the narrator." The **stage-2** prompt that actually assigns each *sentence* a
speaker — `buildStage2ChapterInbox` (`analysis.ts:1522–1576`) and its chunked
sibling `buildStage2ChunkInbox` (`1584–1649`) — carries almost none of it. It
says, in effect: "for every sentence return the speaking character (or
`narrator`); here is the roster (id/name/role only); here is the chapter." It
was deliberately kept lean "to keep the call fast."

The first attribution-eval baseline (2026-07-21, PR #1752 diagnosis) shows the
cost: explicit speech-tag lines score far below where they should
(~42–69% scored, part of which is segmentation-drift confound but the residual
is real under-attribution), and sustained two-hander exchanges collapse (ch46
Valkyrie↔Dusk). These are precisely the cases a handful of explicit rules
address.

Target C is the lever the deterministic-tuning plan explicitly deferred: it
attacks the raw pass itself rather than cleaning up after it.

## Model context

The production local analyzer `qwen36-cw-iq4-32k` is a **stock Qwen3** tagged
and quantized via an Ollama `Modelfile` — not a fine-tune — so it responds to
prompt rules like any instruct model. The only real risk is prompt-length
sensitivity on the iq4 quant; the eval loop is the guard against it. Its
context window is **32k** (`ANALYZER_NUM_CTX=32768`), so large chapters are
split into sections through `buildStage2ChunkInbox`. The Cloud models chunk
large chapters **too** — the stage-2 chunker keeps each call's expected *output*
under the free-tier ~8192-token ceiling (`gemini.ts` `DEFAULT_MAX_OUTPUT_TOKENS`),
so a 328-sentence chapter like ch44 splits on every target, not just local.
`buildStage2ChunkInbox` is therefore the dominant path on the big fixtures
across all three engines — which is exactly why the rules-block must be
**identical** in both builders.

## Non-goals

- **Deterministic-first phase-2** (softening crossExamine's over-aggressive
  *strong*-tag corrections — the ch44 raw→det loss). That is the separately
  queued follow-up ("1 next"), not this work.
- **No few-shot examples.** They would bloat the block on the quant and risk
  locking the model to an example's exact format.
- **No change to the JSON output contract.** No per-line "reason/evidence"
  field. That is a larger swing to revisit only if the rules-block alone
  underperforms.
- **No per-engine prompt branching** unless the measurement forces it (see
  Ship logic).

## Design

### The rules-block

A single shared constant `STAGE2_ATTRIBUTION_RULES` (module-level in
`analysis.ts`), injected into **both** stage-2 inbox builders. Deliberately
short — every rule earns its tokens. Proposed text:

```
## Attribution rules

Apply these when assigning each sentence's speaker:

1. A dialogue tag is decisive. When a quote carries an explicit speech tag —
   "…," said X / "…," X asked / "…," whispered X — the speaker is X, whatever
   the surrounding lines suggest.
2. An action beat names the speaker. A quote sharing a paragraph with a
   character's action belongs to that character: `X folded her arms. "Get
   out."` and `"Get out." X turned away.` are both spoken by X.
3. Untagged quotes continue, and two-handers alternate. An untagged quote keeps
   the last established speaker. In a sustained back-and-forth between exactly
   two characters, untagged quotes alternate between them.
4. Narration is the narrator. Non-dialogue prose — description, action,
   scene-setting — is `narrator`, even between two characters' lines. Only words
   inside quote marks belong to a character (unless the whole chapter is a
   first-person document).
5. The addressee is not the speaker. A name spoken to someone ("Careful,
   Anton.") marks who is addressed, not who speaks — never attribute the line to
   the person being addressed.
```

### Placement

Injected after the `## Characters (from stage 1)` roster block and **before**
the existing first-person block and chapter body, in both builders. The
first-person block is left byte-for-byte as-is (already tuned). In the chunk
builder the order becomes: Characters → **Attribution rules** →
`precedingContext` → first-person → section body.

### Chunk-boundary compatibility

Rule #3 ("an untagged quote keeps the last established speaker") must not fight
the chunk path's existing `precedingContext` block, which supplies the prior
section's tail precisely so an untagged quote carries its speaker across the
seam. It does not: within a section, "last established speaker" is well-defined,
and for the first line of a section the `precedingContext` block is what
establishes that speaker. The two mechanisms compose.

### Structure

- Factor the block once as `STAGE2_ATTRIBUTION_RULES`; inject the same constant
  into `buildStage2ChapterInbox` and `buildStage2ChunkInbox`. No behavioural
  code changes — this is a prompt-content change to two template builders.

## Measurement plan

Prompt tuning is empirical: each variant must be *run* through the model on the
fixtures to score. Approach chosen (user, 2026-07-21): **one consolidated
rules-block, measured once** against baseline, per engine — bisect to per-lever
only if the block regresses.

### Engines / models — three targets, one shared prompt

| Engine slot | Model id | Baseline |
|---|---|---|
| `qwen` (Ollama) | `qwen36-cw-iq4-32k` | re-baseline fresh in-session (seed/quant drift) |
| `gemma` (Gemini API) | `gemma-4-31b-it` | new — never run (no key in prior session) |
| `gemma` (Gemini API) | `gemini-3.1-flash-lite` | new — via `GEMINI_MODEL` override |

`gemma-4-31b-it` and `gemini-3.1-flash-lite` both serve through the Gemini free
API and have the most generous free daily buckets. `--runs 3` on all three
(user: RPD quota is fine). **TPM differs sharply and sets wall-clock, not
feasibility:** `gemma-4-31b-it` is **16k TPM** — tight, so the `rate-limit.ts`
per-model limiter throttles it to roughly one chunked call per minute and the
Gemma pass is the slow one; `gemini-3.1-flash-lite` is **250k TPM** and runs
comfortably. Both complete at `--runs 3`; Gemma just takes longer.

### Harness reality + a small honesty tweak

The eval CLI (`run-eval-cli.ts`) exposes two engine slots: `qwen`
(`EVAL_QWEN_MODEL`) and `gemma` (`GeminiAnalyzer`, model via `GEMINI_MODEL`,
default `gemma-4-31b-it`). Both Cloud models run through the **same** `gemma`
slot, so `gemini-3.1-flash-lite` would print its scorecard under the label
"gemma" — misleading in the durable acceptance record. The plan includes a
minimal tweak so the scorecard labels the actual model id (e.g. print
`gemma:<model>` / accept a cloud-model flag), keeping captured numbers honest.
This is the only code change beyond the prompt + its unit test.

### Metric and acceptance gate

Deciding metric: **`raw`** recall (pre-crossExamine) — the ceiling Target C is
about. `det`/`final` reported too, to confirm the block doesn't destabilize the
deterministic passes tuned in #1752.

- **Must (no-regression):** mean `raw` with the rules-block ≥ baseline `raw`
  within run-to-run noise on **every** fixture on **every** of the three
  engine/model targets. The committed **Coalfall** guardrail must not drop.
- **Win:** meaningful `raw` lift on the dialogue-heavy weak fixtures — ch46 and
  ch45 on local Qwen are the headline targets.
- **Secondary:** `det`/`final` do not regress vs. the post-#1752 baseline.
- **Ship logic:** positive-or-neutral raw across all three → ship. Regresses
  *one* engine only → decide between per-lever bisect or (last resort)
  branching the builder per-engine. Regresses everywhere → discard/redesign the
  block.

### How to run (both paths exercised automatically)

From this worktree (corpus present: `attribution-eval/corpus/` +
committed Coalfall), with `GEMINI_API_KEY` and `EVAL_QWEN_MODEL` /
`GEMINI_MODEL` set per target, run the eval CLI at `--runs 3` for baseline
(current `main` prompt) then treatment (rules-block branch), and diff the
scorecards. All three targets chunk large chapters (local via the 32k context,
Cloud via the free-tier output-token ceiling), so both builders' rules-blocks —
the chunk path especially — are exercised by the same run.

## Testing

- **Paired automated test** (CLAUDE.md testing discipline): a unit test
  asserting `STAGE2_ATTRIBUTION_RULES` renders in **both**
  `buildStage2ChapterInbox` and `buildStage2ChunkInbox`, in the correct order
  (after the roster, before first-person/body), and that the first-person block
  still renders when a first-person id is present. Lives beside the existing
  analysis-route tests.
- **Harness-tweak test:** if the label-honesty tweak touches parsing/printing,
  a unit test pins the new label/flag behaviour.
- **On-box acceptance (not CI):** the three-engine eval above — needs live
  models, so it is a manual/on-box gate, recorded in the plan's acceptance
  section and `docs/features/265-attribution-eval-tuning.md`.

## Risks

- **Prompt-length on the iq4 quant** — a longer prompt can degrade
  instruction-following on a quantized model. Mitigation: the block is ~15
  lines; the eval's no-regression gate on local Qwen catches a net loss.
- **Shared prompt, three engines** — the block lands for every engine but is
  only measured on these three model targets. A good attribution block should
  help all; the gate makes "no regression anywhere we measure" a ship
  precondition.
- **Chunk token cost** — the block is repeated per chunk on large chapters.
  Negligible (~15 lines × chunk count) relative to chapter body + output.
- **Cloud rate limits** — RPD is within the free buckets at 3×5×2. The binding
  limit is **TPM**: `gemma-4-31b-it` at **16k TPM** throttles hard (≈1 chunked
  call/min via `rate-limit.ts`), making the Gemma pass wall-clock-bound but not
  failure-prone; `gemini-3.1-flash-lite` at **250k TPM** is comfortable. The
  rules-block adds ~150 input tokens/chunk — negligible against these ceilings.

## Rollout

Single `fix/server-…` branch off latest `main`, SDD implementation (prompt
constant + injection + unit test + harness label tweak + its test), on-box
three-engine eval as acceptance, PR with `Closes #<new issue>`, mandatory
code-review gate, merge. Update `docs/features/265-attribution-eval-tuning.md`
with the Target C cycle and captured numbers; release-notes entry gated on a
measurable user-visible delta (a raw-attribution lift qualifies).
