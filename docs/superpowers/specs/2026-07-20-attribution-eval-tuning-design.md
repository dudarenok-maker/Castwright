---
title: 'Attribution eval + tuning loop — hand-corrected chapters as a live, multi-point accuracy harness for Qwen + Gemma'
status: draft
date: 2026-07-20
related:
  - 2026-07-09-dialogue-structure-attribution-design.md (the deterministic cross-examine engine this eval measures and helps tune; its "prompt calibration is a dead end on small local models" lesson is a load-bearing constraint here)
  - 2026-06-23-fs58-llm-script-review-design.md (the LLM script-review pass — tuning it is the sequenced follow-up phase, out of scope here)
  - ../plans/2026-06-16-russian-attribution-narrator-heuristic.md (plan 221 — the deterministic-over-prompt lesson this spec inherits)
history:
  - 'v2 (2026-07-20): rewritten after the assumption-check pass. Added the roster-snapshot + roster-pinning requirement (fixtures alone are insufficient input; IDs must align), the three-point metric (raw / deterministic / post-escalation, since production `final` includes the escalation model pass), the additive production eval-seam (raw + per-sentence Decision.reason are discarded today), and the exact chapterText source (re-parse + boilerplate strip). Seed grown to ch.43-46. Added §3.7
    whole-book before/after (across-the-book proxy validation on unlabelled chapters).'
---

# Attribution eval + tuning loop

## 1. Problem

Speaker attribution — assigning each sentence to the correct **already-known** cast member — is the
open quality gap. Cast *discovery* (finding who the characters are) has become reliable through the
Night Watch work; the remaining pain is line→speaker assignment. The user has now **hand-corrected
four chapters** (Playing with Fire, ch. 43–46) in the Manuscript view, producing high-quality ground
truth, and wants to turn it into a repeatable way to **measure and then improve** attribution quality
against the two engines that matter in practice:

- **Qwen local** (Ollama) — the local-default analyzer.
- **`gemma-4-31b-it` cloud** (Gemini free tier) — the cloud analyzer.

Today there is no way to answer "did that prompt/heuristic change make attribution better or worse on
these engines?" except by re-analyzing a book and eyeballing it. An accuracy scorer exists in code
(`server/src/analyzer/attribution-eval/`: `schema.ts` = `LabelledChapter { chapterText, lines:[{text,
speakerId}] }`; `scorer.ts` = `scoreAttribution(truth, predicted, aliasMap?)` → precision / recall /
TP / FP / FN / segMismatch / perLine) but it is **not wired to drive a live analyzer run** — it only
scores a prediction set handed to it synthetically.

### 1.1 Inherited constraint (do not relitigate)

Plan 221 / srv-59 established, on measured Russian data, that **prompt-level calibration of small local
models is a proven dead end** — the local model ignores calibration rubrics wholesale. That is *why*
the deterministic `cross-examine` engine exists. Consequence for tuning: on **Qwen local**, durable
wins are expected from the deterministic `cross-examine.ts` layer, not the attribution prompt;
prompt/exemplar refinement is expected to matter mainly for **Gemma cloud** and for calibration. The
harness makes *which lever moved the number* empirically visible so we don't repeat the dead end.

## 2. Goals / non-goals

**Goals**
- Turn hand-corrected chapters into golden fixtures **plus a pinned roster snapshot** with one command.
- Run the **real** attribution pipeline (both engines) against those fixtures and score it.
- Measure at **three points** — raw LLM output, post-`cross-examine` (deterministic), and
  post-escalation (true production final) — so prompt-, deterministic-, and escalation-wins are
  separable.
- Give a per-engine, per-evidence-bucket scorecard plus a mispredicted-line diff to drive tuning.
- **Validate a change across the whole book** (baseline vs tuned) as a real-world before/after — the
  scored 43–46 + Coalfall are the quantitative gates; the remaining unlabelled chapters are a
  qualitative/proxy check (§3.7).
- Keep all copyrighted text out of the public repo.

**Non-goals (this spec)**
- Dynamic per-book few-shot injection (rejected: burns Gemma's free-tier token budget, marginal gain
  on small models).
- Tuning the **LLM script-review** pass (`audiobook-script-review.md`). Explicit **next phase**,
  layered on the *improved* attribution baseline.
- Model *selection*, fine-tuning, or changing end-user analyzer behaviour.

**Scope honesty — this is NOT purely a dev tool.** The runner needs data the production pipeline
currently discards (raw stage-2 sentences; per-sentence evidence class). So this work includes a
**small, additive, tested production change**: an eval-return path on the per-chapter attribution
function that surfaces those intermediate values (§3.5). It is behind an eval flag and does not change
default runtime output. The tuning edits the loop later produces (prompt / `cross-examine.ts`) each
land as their own reviewed diffs, not via this spec.

## 3. Design

Three committed units + one git-ignored data dir + one additive production seam. Every model-touching
command is **opt-in**, triple-gated (SKIP + exit 0 when a gate is absent), and never runs in
`test:all` / `verify` — same posture as `golden-audio`.

### 3.1 Capture tool (committed)

`npm run eval:attribution:capture -- --book <bookId> --chapters 43,44,45,46`

Emits, per named chapter, into the corpus dir:
- a `LabelledChapter` fixture (existing `schema.ts` shape): `speakerId` = the corrected sentence's
  `characterId`, `text` = sentence `text` verbatim in order, read from
  `.audiobook/manuscript-edits.json` (`{ sentences: SentenceOutput[] }` — the corrected slice the user
  sees). `chapterText` is **not** the joined sentences (lossy for the offset-based aligner); it is the
  **exact input the analyzer received**: re-parse the book's original manuscript file for that chapter
  and apply `stripFrontMatterBoilerplate` (the strip production runs upstream in the route,
  `analysis.ts:~2557`, before the pipeline). Capture must reproduce both steps or the runner measures
  the wrong input.
- once per book, a **roster snapshot** (`<book>.roster.json`, a new sibling schema) holding, per cast
  member, the fields the pipeline consumes: `id`, `name`, `gender`, `aliases` — mined from the book's
  `.audiobook/cast.json`. The fixture's `speakerId`s are keys into this roster.

Chapters are named explicitly because `manuscript-edits.json` is whole-slice (all chapters), so there
is no reliable on-disk "was this chapter reviewed" flag — the `--chapters` list *is* the reviewed-set
of record. Capture is a pure transform over on-disk JSON + a re-parse; no model calls; unit-testable.

### 3.2 Live-eval runner (committed)

`npm run eval:attribution [-- --engine qwen|gemma|both] [--escalation on|off|as-configured]`

For each corpus fixture × selected engine, the runner **pins the captured roster snapshot as a fixed
`stage1`** (so the stage-2 prompt's "reuse these ids verbatim" roster block is the ground-truth roster
and no cast re-discovery mints divergent IDs — see §3.3 ID-alignment), then:
1. Attribute the chapter → capture **raw** stage-2 sentences (via the §3.5 seam).
2. `crossExamine` (or `applyNarratorDefault` only when the `analyzer.structure.enabled` **knob** is
   off — NOT a language state; `ru` is supported so Night Watch takes the `crossExamine` branch) →
   capture **deterministic** sentences.
3. `escalateFlaggedWindows` when escalation is active → capture **final** sentences (= production
   output). `--escalation` controls this; default `as-configured` mirrors the `analyzer.structure.
   escalation` knob.
4. Score raw, deterministic, and final against the fixture with `scoreAttribution(truth, predicted,
   aliasMap?)`.
5. Also score the committed **Coalfall** fixture + its committed roster snapshot every run as the
   **anti-overfit guardrail**.

Output: a scorecard (per engine × {raw, deterministic, final} × evidence bucket) + a mispredicted-line
diff. Optional `--snapshot` writes to a git-ignored results file for cross-iteration deltas.

**Fidelity:** the per-chapter attribution logic is already a standalone, test-driven function
(`attributeChapterStage2` / `…WithEval`, `analysis.ts`), so extracting a shared "attribute one chapter"
unit the runner and route both call is realistic — **but** it must include the upstream boilerplate
strip (§3.1) and the roster pinning, or it silently diverges from production (the primary hazard).

### 3.3 ID alignment (why roster-pinning is mandatory)

`scoreAttribution` joins truth `speakerId` to predicted `characterId` by normalised text. That only
scores correctly if the fresh run's IDs **equal** the truth IDs. Pinning the captured roster as
`stage1` guarantees it (the prompt instructs id reuse). The scorer's optional `aliasMap` handles
residual alias drift but cannot rescue a from-scratch ID space. Without pinning, correct attributions
score as false-positives and every number is noise.

### 3.4 The metric (defined explicitly)

The scorer returns `precision`, `recall`, `segMismatch`, `perLine` — it does **not** return an
"accuracy" field, so we define the headline precisely: **attribution recall** = fraction of
ground-truth lines assigned the correct speaker = `TP / (TP + FN)` (FN includes both mis-attributions
and dropped lines; `segMismatch` — segmentation drift — is reported **separately**, never folded into
the denominator). Reported:

- **Per engine** (Qwen, Gemma) — a change helping one and regressing the other is a net loss.
- **Per stage** (raw / deterministic / final) — the deltas localise the winning lever.
- **Per evidence bucket** — using the per-sentence `Decision.reason` the §3.5 seam exposes (e.g.
  `tag-confirm`, `tag-correct`, `tag-span`, `pronoun-*`, `alt-*`, `unanchored-*`, `narration-*`,
  `lumped`, `unaligned`; the engine's *actual* taxonomy, `cross-examine.ts`, not a reinvented one).
  Buckets apply to the deterministic/final stages (raw has no evidence class). This breakdown makes
  "meaningfully improved" concrete: raise weak buckets on **both** engines with **no** bucket
  regressing on either, and no Coalfall regression.

**The improvement target is set after the baseline run, not before** — inventing a number ahead of a
measured baseline would be dishonest.

### 3.5 Production eval seam (additive)

Extend the existing `attributeChapterStage2WithEval` (or add a sibling eval-return) so, when an eval
flag is set, it returns the **raw stage-2 sentences** (currently a transient local, overwritten in
place) and the **per-sentence `Decision.reason`** (currently kept only for *flagged* sentences;
discarded for confirmed/corrected — the majority). Default runtime behaviour and return shape are
unchanged; the extra data is opt-in. This is the one production edit and it ships with its own tests.

### 3.6 The tuning loop (deterministic-first)

Run eval → read weak buckets and the raw→deterministic→final deltas → apply the fix at the right layer:
- Error survives into **deterministic** and is structural → `cross-examine.ts` rule / confidence
  ladder (the durable lever, especially Qwen).
- Error only fixed by **escalation** → consider whether a deterministic rule could catch it instead
  (escalation costs model calls).
- **raw** wrong in a way deterministic can't recover, on the *cloud* engine → refine
  `skills/audiobook-sentence-attribution.md` rubric/exemplars. **New exemplars are paraphrased
  Castwright-owned prose — never Landy/Lukyanenko text.**

Re-run; confirm both engines moved and nothing (incl. Coalfall) regressed.

### 3.7 Whole-book before/after validation (the "across the book" test)

The scored 43–46 set is thin and shares its data with tuning, so passing it is necessary but not
sufficient. After a change clears the scored gates (43–46 + Coalfall), validate it on the **whole
book**: re-analyze the full book under **baseline vs tuned** config and compare. Chapters outside
43–46 have **no ground truth**, so this is a **proxy/qualitative** check, not a scored accuracy number:

- per-chapter **low-confidence count** delta (read with care — fewer flags can mean better calibration
  *or* masked errors);
- an **attribution-change diff** (lines whose speaker changed baseline→tuned) for spot-checking known
  bad spots;
- the reviewed 43–46 chapters remain the scored anchor within the run.

This is the "tune on these four, then use it across the book and check how it improved" loop. It catches
regressions the 4-chapter set can't see and shows whether tuning helps the book the user actually cares
about; overfitting to 43–46 surfaces as a Coalfall regression (scored) and/or the across-book diff
making non-reviewed chapters worse on spot-check. Mechanically it reuses the normal full-book analysis
run plus a diff over the two result sets — no new attribution path.

## 4. Corpus & copyright

- Location: `server/src/analyzer/attribution-eval/corpus/`, **git-ignored** (add to `.gitignore`),
  beside the schema/scorer. Same posture as `brand/` / `mockups/`. Holds the labelled fixtures **and**
  per-book roster snapshots for the copyrighted books.
- Seed: Playing with Fire ch. 43–46 (English). Thin, single-author — enough to surface recurring
  **structural** failure modes (which dominate attribution error and generalize), not to certify a
  precise number. Coalfall is the overfit counterweight; the corpus hardens as more chapters (notably
  **Night Watch** — Russian + second author) are reviewed and captured.
- **Committed additions (Castwright-owned, public-safe):** a Coalfall **roster snapshot**
  (`coalfall-ch1.roster.json`) so the guardrail can run the *real* pipeline, not a stored prediction.
  The labelled Coalfall fixture already exists.

## 5. Testing

- **Capture transform** — synthetic `manuscript-edits.json` + `cast.json` + a manuscript file →
  expected `LabelledChapter` + roster snapshot; covers id→speakerId mapping, chapter filtering,
  ordering, roster field extraction, and the boilerplate-strip reproduction. In-suite.
- **Eval seam (§3.5)** — asserts the eval-return exposes raw sentences + per-sentence reason without
  altering the default return; a case with confirmed/corrected/flagged sentences all carrying a reason.
- **Runner orchestration/scoring** — mock analyzer + a pinned roster → asserted scorecard (raw vs
  deterministic vs final deltas, bucket rollup, roster-pinning prevents ID drift, Coalfall guardrail
  inclusion). No live models.
- **Fidelity pin** — if the shared per-chapter unit is not extracted, a test asserts runner wiring
  matches the route (incl. strip + roster pinning).
- Live model calls stay **out** of the gated suite (opt-in runner only), like `golden-audio`.
- Regression plan under `docs/features/` created at implementation.

## 6. Open risks

1. **Fidelity drift** (§3.2) — runner scoring a different pipeline than production makes every number a
   lie. Mitigation: shared extracted unit (incl. strip + roster pinning) preferred; sync-pin test
   otherwise.
2. **Roster staleness** — a captured roster snapshot can drift from a re-analysis's discovery. Accepted:
   pinning is the point (we measure attribution given a *fixed known* cast); the snapshot is versioned
   with the fixture.
3. **Thin corpus / overfitting** — 4 chapters, one author, one language. Mitigation: Coalfall guardrail
   every run; deterministic-first tuning; grow the corpus.
4. **Gemma free-tier limits** — repeated full-corpus runs (× escalation windows) could hit RPD/TPM.
   Mitigation: reuse `geminiRateLimiter` (inherited automatically via the real analyzer call path);
   `--engine qwen` for fast local iteration; `--escalation off` to skip the second cloud pass while
   iterating; small corpus.
5. **Prompt tuning may not move Qwen at all** (§1.1) — accepted/expected; the three-point metric
   surfaces it and steers the fix to `cross-examine.ts`.
