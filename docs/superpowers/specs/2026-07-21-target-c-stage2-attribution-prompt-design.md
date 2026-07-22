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
sensitivity on the iq4 quant; the eval loop is the guard against it.

**Chunking (corrected after assumption-check).** The stage-2 chunker splits a
chapter when its body exceeds the char budget from `resolveStage2ChunkCharBudget`
(default **9000 chars**, `registry.ts`). In the harness the `engine` arg is not
threaded, so *both* qwen and gemma resolve to the same 9000-char cloud budget —
the local model does **not** chunk "via its 32k context" in the eval; the budget
is identical either way. Across the corpus only **ch44** (~18.4k chars) exceeds
9000 → it is the **only** fixture that exercises `buildStage2ChunkInbox`; ch43
(8.85k), ch45 (3.1k), ch46 (4.6k) and Coalfall (3.4k) are single-call through
`buildStage2ChapterInbox`. The block still belongs in **both** builders — any
production chapter over the budget chunks — but the eval's chunk-path coverage
is **ch44-only and thin**, and the headline-win fixtures (ch45/ch46) are
measured entirely through the chapter builder. (See Measurement for the option
to lower the eval budget so ch43/ch44 both chunk if chunk-path coverage needs
strengthening.)

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

Apply these when assigning each sentence's speaker. They hold whatever
quotation marks the text uses — `"…"`, `«…»`, `„…"`, `“…”` — and in any
language:

1. A dialogue tag is decisive. When a quote carries an explicit speech tag —
   `"…," said X` / `"…," X asked` / `"…," whispered X` — the speaker is X,
   whatever the surrounding lines suggest.
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

### Language scope — acceptance is English-only (assumption-check CRITICAL)

The block ships to **every** language (the builders are language-agnostic), but
the entire eval corpus is English (`playing-with-fire-ch43–46.en`,
`coalfall-ch1.en`). The project has **known** non-English attribution fragility
— Russian first-person «я» misattribution and a German `„…"` quote-collision
bug — that an English-only gate cannot catch. Two mitigations, both taken:

1. **Make the block language-safe by construction** — the rules-block opens
   with the explicit "whatever quotation marks / any language" line, so it does
   not hard-code the ASCII-quote assumption that would misfire on `«…»` / `„…"`.
2. **Scope the acceptance claim to English** and file a **tracked follow-up** to
   hand-label a Russian and a German attribution fixture (the existing
   `the-coalfall-commission.ru.md` is a starting point for the RU one) and
   re-run the gate on them. Target C ships on the English gate; the non-English
   measurement is a fast-follow, not a blocker.

This is the one scope call flagged for user sign-off: ship English-gated with a
language-safe block + RU/DE follow-up (recommended), vs. hand-label RU/DE
fixtures now and gate on them before shipping (higher effort, delays Target C).

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
(user: RPD quota is fine). **The rate limits set wall-clock, not feasibility,
and the two Cloud models are bound by different limits:** `gemma-4-31b-it` is
**RPM 30 / TPM 16k** — TPM-bound, so the `rate-limit.ts` limiter throttles it to
stay under 16k tokens/min (roughly one chunked call per minute); it is the slow
one. `gemini-3.1-flash-lite` is **RPM 15 / TPM 250k** — RPM-bound (max 15
chunked calls/min) but with a huge token bucket, so it runs comfortably. Both
complete at `--runs 3`; Gemma just takes longer.

### Harness changes (two small, both serve the gate)

1. **Model-label honesty.** The eval CLI (`run-eval-cli.ts`) exposes two engine
   slots: `qwen` (`EVAL_QWEN_MODEL`) and `gemma` (`GeminiAnalyzer`, model via
   `GEMINI_MODEL`, default `gemma-4-31b-it`) — there is genuinely **no** third
   slot (`parseEngines`). Both Cloud models run through the same `gemma` slot, so
   `gemini-3.1-flash-lite` would print under the label "gemma" — misleading in
   the durable record. Tweak the scorecard to label the actual model id (print
   `gemma:<model>` / accept a cloud-model flag).
2. **Raw per-family breakdown.** Today `run-eval.ts` scores `raw` **without**
   `reasons`, so `raw.byFamily = {}` and `printScorecard` prints family splits
   from `final` only. That means a rule that *redistributes* errors between
   evidence families (rule #4 "narration is the narrator" could lift untagged
   lines while over-attributing tagged dialogue to `narrator`) nets flat raw
   recall and **passes the gate invisibly**. Wire the evidence-family `reasons`
   (already computed for det/final) into the `raw` `scoreStage` call and print
   raw's per-family accuracy, so a family-level backfire is visible in the
   deciding metric. **Fallback** (if the families aren't cleanly available at
   raw-scoring time — a plan-phase determination): keep raw aggregate-only and
   make a **manual per-family eyeball** of the ch45/ch46 raw output part of the
   acceptance instead. Either way the family signal is checked, not skipped.

These two harness changes plus the prompt constant + its unit test are the whole
code delta.

### Metric and acceptance gate

Deciding metric: **`raw`** recall (pre-crossExamine) — the ceiling Target C is
about. `det`/`final` reported too, to confirm the block doesn't destabilize the
deterministic passes tuned in #1752.

The gate is defined **numerically** against the observed per-run band (each
fixture reports `mean [min–max]` across the runs), so "within noise" is not
hand-wavy:

- **Regression (blocks ship):** treatment **mean `raw` < baseline `raw` min**
  on any fixture on any of the three targets — i.e. the treatment falls below
  the *worst* baseline run, outside the noise band. The committed **Coalfall**
  guardrail is held to this on every target.
- **Win:** treatment **mean `raw` ≥ baseline `raw` max** on the dialogue-heavy
  weak fixtures — ch46 and ch45 on local Qwen are the headline targets (they
  clear the *best* baseline run, not just the mean).
- **Neutral:** overlapping bands (treatment mean between baseline min and max) —
  acceptable, counts as no-regression.
- **Per-family check (not just aggregate):** with raw's family split now printed
  (Harness change 2), no single evidence family may regress below its baseline
  min while aggregate raw stays flat — that is the rule-#4-backfire signature.
- **Secondary:** `det`/`final` do not regress (same band rule) vs. the
  post-#1752 baseline.
- **Runs:** `--runs 3` as agreed; if a fixture's baseline band is too wide to
  call (min–max spread > ~3 pts), bump that target's runs (local Qwen is cheap)
  before judging rather than guessing.
- **Ship logic:** no-regression across all three → ship. Regresses *one* target
  only → per-lever bisect or (last resort) per-engine prompt branch. Regresses
  everywhere → discard/redesign the block.

### How to run — three separate invocations per prompt version

The three targets **cannot** be produced in one run: both Cloud models share the
single `gemma` slot keyed by one `GEMINI_MODEL`, so `--engine both` fixes the
cloud model for the whole process. Run each target as its own invocation, at
`--runs 3`, once on the baseline (current `main`) prompt and once on the
treatment (rules-block) branch — six runs total — from this worktree (corpus
present):

1. **Local:** `EVAL_QWEN_MODEL=qwen36-cw-iq4-32k … --engine qwen --runs 3`
2. **Cloud Gemma:** `GEMINI_MODEL=gemma-4-31b-it … --engine gemma --runs 3`
3. **Cloud Flash-lite:** `GEMINI_MODEL=gemini-3.1-flash-lite … --engine gemma --runs 3`

`GEMINI_API_KEY` must be exported (it lives in the main checkout's `server/.env`,
not the worktree). Note `runEval` returns `skipped` on the **first** unavailable
engine and aborts the whole run, so run the engines separately anyway. Only ch44
hits the chunk builder (see Chunking above); the other four fixtures — including
the ch45/ch46 headline wins — exercise the chapter builder.

## Testing

- **Paired automated test** (CLAUDE.md testing discipline): a unit test
  asserting `STAGE2_ATTRIBUTION_RULES` renders in **both**
  `buildStage2ChapterInbox` and `buildStage2ChunkInbox`, in the correct order
  (after the roster, before first-person/body), and that the first-person block
  still renders when a first-person id is present. Lives beside the existing
  analysis-route tests.
- **Harness-tweak tests:** a unit test pinning the model-label output
  (`gemma:<model>` / cloud-model flag), and a unit test asserting `raw.byFamily`
  is now populated (reasons wired into the raw `scoreStage` call) so the
  per-family gate has data.
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
- **Language axis (CRITICAL, see Language scope)** — the block ships to all
  languages; the corpus is English-only. Mitigated by the language-safe block
  wording + English-scoped acceptance + tracked RU/DE follow-up.
- **Chunk token cost** — the block is repeated per chunk on large chapters.
  Negligible (~15 lines × chunk count) relative to chapter body + output.
- **Cloud rate limits** — RPD is within the free buckets at 3×5×2. Binding limit
  differs per model: `gemma-4-31b-it` (RPM 30 / **TPM 16k**) is TPM-bound —
  each call is ~3k tokens (9000-char body ≈ 2250 + roster/rules/system), so 16k
  TPM allows **~5 calls/min**, the slow target but far from failing;
  `gemini-3.1-flash-lite` (**RPM 15** / TPM 250k) is RPM-bound but comfortable.
  `rate-limit.ts` also has a hard `RequestExceedsTpmError` if a single request's
  estimate exceeds the TPM ceiling, but the 9000-char budget (+`maxInputTokens
  PerRequest` default 12000) keeps per-request tokens well under 16k, so it will
  not fire on this corpus. The rules-block adds ~150 input tokens/chunk —
  negligible, though it does eat marginally into Gemma's ~4k headroom.

## Rollout

Single `feat/server-stage2-attribution-prompt` branch off latest `main` (already
cut), SDD implementation (prompt constant + injection into both builders + unit
test; two harness changes — model-label honesty + raw per-family breakdown —
each with a test), on-box three-engine eval as acceptance, PR with `Closes #<new
issue>`, mandatory code-review gate, merge. Update
`docs/features/265-attribution-eval-tuning.md` with the Target C cycle and
captured numbers; release-notes entry gated on a measurable user-visible delta
(a raw-attribution lift qualifies).

**Tracked follow-up (filed in the same round):** hand-label a Russian and a
German attribution eval fixture (RU seed: `the-coalfall-commission.ru.md`) and
re-run the gate on them, closing the language-axis gap the English-only corpus
leaves open.
