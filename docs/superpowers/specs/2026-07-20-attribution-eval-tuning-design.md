---
title: 'Attribution eval + tuning loop — hand-corrected chapters as a live, two-point accuracy harness for Qwen + Gemma'
status: draft
date: 2026-07-20
related:
  - 2026-07-09-dialogue-structure-attribution-design.md (the deterministic cross-examine engine this eval measures and helps tune; its "prompt calibration is a dead end on small local models" lesson is a load-bearing constraint here)
  - 2026-06-23-fs58-llm-script-review-design.md (the LLM script-review pass — tuning it is the sequenced follow-up phase, out of scope here)
  - ../plans/2026-06-16-russian-attribution-narrator-heuristic.md (plan 221 — the deterministic-over-prompt lesson this spec inherits)
---

# Attribution eval + tuning loop

## 1. Problem

Speaker attribution — assigning each sentence to the correct **already-known** cast member — is the
open quality gap. Cast *discovery* (finding who the characters are) has become reliable through the
Night Watch work; the remaining pain is line→speaker assignment. The user has now **hand-corrected
three chapters** (Playing with Fire, ch. 44–46) in the Manuscript view, producing high-quality
ground truth, and wants to turn that ground truth into a repeatable way to **measure and then improve**
attribution quality against the two engines that matter in practice:

- **Qwen local** (Ollama) — the local-default analyzer.
- **`gemma-4-31b-it` cloud** (Gemini free tier) — the cloud analyzer.

Today there is no way to answer "did that prompt/heuristic change make attribution better or worse on
these engines?" other than re-analyzing a book and eyeballing it. An accuracy harness exists in code
(`server/src/analyzer/attribution-eval/`: a labelled-chapter schema + a real scorer) but it is **not
wired to drive a live analyzer run** — it only scores a prediction set handed to it synthetically.

### 1.1 Inherited constraint (do not relitigate)

Plan 221 and the dialogue-structure spec (srv-59) established, on measured Russian data, that
**prompt-level calibration of small local models is a proven dead end** — the local model ignores
calibration rubrics wholesale. That is *why* the deterministic `cross-examine` engine exists: anything
that must be reliable is deterministic code, not a prompt instruction. This spec treats that as fact.
Consequence for tuning: on **Qwen local**, durable wins are expected to come from the deterministic
`cross-examine.ts` layer, not the attribution prompt; prompt/exemplar refinement is expected to matter
mainly for **Gemma cloud** and for calibration. The harness's job is to make *which lever moved the
number* empirically visible so we don't repeat the dead end.

## 2. Goals / non-goals

**Goals**
- Turn hand-corrected chapters into golden fixtures with one command.
- Run the **real** attribution pipeline (both engines) against those fixtures and score it.
- Measure at **two points** — raw LLM output and final post-`cross-examine` output — so prompt-wins
  and deterministic-wins are separable.
- Give a per-engine, per-evidence-bucket scorecard plus a mispredicted-line diff to drive tuning.
- Keep all copyrighted text out of the public repo.

**Non-goals (this spec)**
- Dynamic per-book few-shot injection (rejected: burns Gemma's free-tier token budget, marginal gain
  on small models).
- Tuning the **LLM script-review** pass (`audiobook-script-review.md`). That is the explicit **next
  phase**, layered on top of the *improved* attribution baseline — measuring it against un-improved
  attribution is not useful.
- Any change to model *selection*, fine-tuning, or the analyzer's runtime behaviour for end users. The
  runner is a dev tool; the only shipped runtime change would be tuning edits to the committed prompt /
  `cross-examine.ts` that the loop produces (each landed as its own reviewed diff, not by this spec).

## 3. Design

Three committed units + one git-ignored data dir. Every model-touching command is **opt-in**,
triple-gated (SKIP + exit 0 when a gate is absent), and never runs in `test:all` / `verify` — the same
posture as the `golden-audio` tier.

### 3.1 Capture tool (committed)

`npm run eval:attribution:capture -- --book <bookId> --chapters 44,45,46`

Reads the book's `.audiobook/manuscript-edits.json` (`{ sentences: SentenceOutput[] }` — the corrected
slice the user sees in the app) for the labels, and the book's **parsed chapter source** (the same
chapter input the analyzer originally received — from the manuscript store, *not* reconstructed from
the corrected sentences, so the runner re-attributes the true input) for `chapterText`. For each named
chapter it emits a `LabelledChapter` (`{ chapterText, lines: [{ text, speakerId }] }`, the *existing*
`attribution-eval/schema.ts` shape) into the corpus dir. (Confirm during planning that the parsed
chapter source is still on disk for an analyzed book; if only the cache survives, capture reconstructs
`chapterText` by joining sentence text in order and the fidelity note in §3.2 tightens accordingly.)

- `speakerId` = the sentence's `characterId`; `text` = the sentence `text`, verbatim, in order.
- **Chapters are named explicitly** because `manuscript-edits.json` is written whole-slice (all
  chapters), so there is no reliable on-disk "was this chapter hand-reviewed" flag to infer. The
  `--chapters` list *is* the reviewed-set of record — the user's assertion that these chapters are
  ground truth.
- Output filename encodes book + chapter + language, e.g. `pwf-ch44.en.labelled.json`. Language is
  read from book/chapter metadata.
- Pure transform (JSON in → JSON out); no model calls. This is the unit-testable core.

### 3.2 Live-eval runner (committed)

`npm run eval:attribution [-- --engine qwen|gemma|both] [--stage raw|final|both]`

For each corpus fixture × selected engine:
1. Run the **real** per-chapter attribution against `chapterText` → capture **raw** stage-2 sentences.
2. Run the real deterministic layer (`crossExamine`, or `applyNarratorDefault` where the structure
   engine is off for that language) → capture **final** sentences.
3. Score raw and final against the fixture with the existing `scoreAttribution(truth, predicted,
   aliasMap?)` → precision / recall / TP / FP / FN / segMismatch / perLine.
4. Also score the committed **Coalfall** fixture (`coalfall-ch1.en.labelled.json`) every run as the
   **anti-overfit guardrail** — a regression there flags that a change is bending toward one style.

Output: a scorecard table (per engine × {raw, final} × evidence bucket) printed to console, plus a
mispredicted-line diff. Optional `--snapshot` writes the scorecard to a git-ignored results file so
successive tuning iterations show deltas.

**Fidelity requirement:** the runner must attribute a chapter the *same way* the production route does.
Prefer extracting the "attribute one chapter (raw → cross-examine)" pipeline from
`server/src/routes/analysis.ts` into a shared function that both the route and the runner call, rather
than the runner re-implementing the wiring (which would silently drift from production). If extraction
is too invasive for this pass, the runner mirrors the exact `analysis.ts:1785–1860` wiring and a test
pins the two in sync. **This drift risk is called out as the primary implementation hazard.**

### 3.3 Metric

Headline: **per-line speaker accuracy** — `truePositive / (lines scored)` from the existing scorer,
which already holds **segmentation drift** (`segMismatch`) separate from attribution error and drops
(FN) separate again, and is alias-aware. Reported:

- **Per engine** (Qwen, Gemma) — a change that helps one and regresses the other is a net loss.
- **Per stage** (raw / final) — `final − raw` is the deterministic engine's contribution.
- **Per evidence bucket** — tag-name / tag-pronoun / alternation / unanchored / narration. Bucketing
  reuses the structure engine's own per-sentence classification (from the `crossExamine` decision
  matrix / report), *not* a reinvented classifier. Buckets apply cleanly to the **final** stage (raw
  has no evidence class yet; raw is reported overall). This breakdown is what makes "meaningfully
  improved" concrete: raise accuracy in the weak buckets on **both** engines with **no** bucket
  regressing on either.

**The improvement target is set after the baseline run, not before.** Inventing a target number ahead
of a measured baseline would be dishonest. The baseline scorecard defines the weak buckets; the target
is "move them up without regressing anything, on both engines, and no Coalfall regression."

### 3.4 The tuning loop (deterministic-first)

Run eval → read weak buckets and the raw-vs-final split → apply the fix at the right layer:

- If the error survives into **final** and is structural (orphaned tag, alternation, unanchored quote),
  it belongs in **`cross-examine.ts`** (a rule or a confidence-ladder adjustment) — the durable lever,
  especially for Qwen.
- If **raw** is wrong in a way the deterministic layer can't recover, and it's the *cloud* engine,
  refine the attribution prompt (`skills/audiobook-sentence-attribution.md`) rubric/exemplars. **Any
  new exemplar is paraphrased Castwright-owned prose — never Landy/Lukyanenko text.**

Re-run; confirm both engines moved and nothing (including Coalfall) regressed.

## 4. Corpus & copyright

- Location: `server/src/analyzer/attribution-eval/corpus/`, **git-ignored** (add to `.gitignore`), next
  to the schema/scorer it feeds. Same posture as `brand/` and `mockups/`.
- Seed: Playing with Fire ch. 44–46 (English). Thin, single-author — enough to surface the recurring
  **structural** failure modes (which dominate attribution error and generalize across books), not
  enough to certify a precise number. The Coalfall guardrail is the counterweight to style-overfit; the
  corpus hardens cheaply as more chapters (notably **Night Watch**, adding Russian + a second author)
  are hand-reviewed and captured.
- The committed public fixture set is unchanged (Coalfall stays the one public fixture).

## 5. Testing

- **Capture transform** — synthetic `manuscript-edits.json` → expected `LabelledChapter`; covers the
  characterId→speakerId mapping, chapter filtering, ordering, and language tagging. In-suite.
- **Runner orchestration/scoring** — a mock analyzer returning known sentences → asserted scorecard
  (raw vs final delta, bucket rollup, Coalfall guardrail inclusion). In-suite, no live models.
- **Fidelity pin** — if the per-chapter pipeline is *not* extracted into a shared function, a test
  asserts the runner's wiring matches the route's (guards the §3.2 drift hazard).
- Live model calls stay **out** of the gated suite (opt-in runner only), like `golden-audio`.
- Regression plan doc created under `docs/features/` when this is implemented.

## 6. Open risks

1. **Fidelity drift** (§3.2) — the runner scoring a different pipeline than production would make every
   number a lie. Mitigation: shared extracted function preferred; sync-pin test otherwise.
2. **Thin corpus / overfitting** — 3 chapters, one author, one language. Mitigation: Coalfall guardrail
   every run; deterministic-first tuning (structural fixes generalize); grow the corpus.
3. **Gemma free-tier limits** — repeated full-corpus runs against Gemini could hit RPD/TPM. Mitigation:
   reuse the existing per-model rate limiter (`server/src/analyzer/rate-limit.ts`); keep the corpus
   small enough to iterate; `--engine qwen` for fast local iteration, cloud runs when confirming.
4. **Prompt tuning may not move Qwen at all** (the inherited §1.1 lesson) — accepted and expected; the
   two-point metric surfaces it rather than hiding it, and steers the fix to `cross-examine.ts`.
