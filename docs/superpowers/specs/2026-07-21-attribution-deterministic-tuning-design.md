# Attribution accuracy tuning — design

**Status:** design (v2, re-scoped after assumption-check 2026-07-21)
**Author:** design thread, session 8e874d56
**Corpus / measurement:** attribution-eval harness (shipped PR #1750), engine
`qwen36-cw-iq4-32k:latest`, fixtures = Playing with Fire ch.43–46 (645
hand-attributed sentences) + committed Coalfall guardrail.
**Follow-up (out of scope here):** Target C — main stage-2 prompt exploration
(sequenced after this lands; see §8).

> **v2 note:** v1 of this spec asserted the escalation LLM re-ask was inactive in
> the eval and blamed the `final`-stage regression on deterministic
> post-processing. An adversarial assumption-check proved that wrong:
> `analyzer.structure.escalation` defaults to `'local'` (registry.ts:1121) and in
> local mode uses the main analyzer (analysis.ts:1835), so escalation **runs** in
> every eval. This rewrite re-scopes around the corrected, empirically-confirmed
> diagnosis below.

---

## 1. Problem — corrected & empirically confirmed

Two eval runs against `qwen36-cw-iq4-32k`, escalation ON (default) and OFF
(`ATTRIBUTION_ESCALATION=off`), isolate each stage's effect. The three-point
scorecard already separates them: `raw` = pre-crossExamine LLM, `det` =
post-crossExamine / **pre**-escalation, `final` = post-escalation.

| Fixture | raw | det=final (esc-OFF) | crossExamine (raw→det) | escalation cost (det→final, esc-ON) |
|---|---|---|---|---|
| ch43 | 80.3 | 79.8 | −0.5 | −1.1 |
| ch44 | 83.2 | 80.2 | **−3.0** | −0.3 |
| ch45 | 58.9 | 60.7 | **+1.8** | +1.8 (helped) |
| ch46 | 64.1 | 64.1 | 0 | **−12.8** |
| Coalfall | 75.9 | 75.9 | 0 | **−3.5** |

**Escalation is the dominant regressor.** It wrecks ch46 (−12.8) and Coalfall
(−3.5), mildly hurts ch43/ch44, and helps only ch45. **crossExamine** is a
smaller, mixed lever — worst ch44 −3.0, helps ch45 +1.8, ~0 elsewhere.

**Escalation root cause (escalation.ts).** `escalateFlaggedWindows` re-queries
each flagged conversation window with a **more context-starved** view than the
original full-chapter pass (≤1500-char window + ≤2 short-narration paras,
minimal prompt — buildWindowText/buildPrompt, escalation.ts:83-166), then
**applies the re-ask answer with no quality gate** (escalation.ts:223-239: any
roster id, non-`tag-name` line → overwrite at `confidence 0.8`). So on
`unanchored-named` lines — where the full-context model already committed to a
plausible named speaker — escalation replaces a good answer with a worse
small-window guess. That is the ch46/Coalfall collapse (ch46 `unanchored`
21/40 esc-off vs 12/48 esc-on).

**crossExamine root cause (parser.ts).** ch44's `tag-correct` false positives
come from a beat-verb-bearing narration gap being reclassified `narration→tag`
(parseQuoteParagraph, parser.ts:239-244) and `findRosterName` (name-matcher.ts,
first roster stem left-to-right) stamping an authoritative `tag-name` speaker
onto the adjacent quote. `crossExamine`'s `tag-name` branch (correctly, per its
own invariant) then forces the quote onto that name over a correct LLM answer.
The **same** path exists in the dash branch (parseDialogueSpans validates tags
on the same speech-**or-beat** verb set, parser.ts:146) and is **amplified** by
phase-2 multi-span anchoring (parser.ts:70-74).

**⚠️ Measurement caveat — run-to-run LLM variance.** The raw stage-2 is
non-deterministic: ch46 raw was 61.5 (run 1) → 64.1 (run 2); ch44 seg-drift
50→47; pronoun 24→22. Single-run deltas under ~2–3% are noise. **Any acceptance
judgement must average multiple runs** (or credit only deltas above the noise
floor) — this is a first-class harness requirement, not an afterthought.

## 2. Goal

The full pipeline must not degrade attribution vs. the raw LLM on the strong
model — measured across averaged runs against the corpus — while keeping the
Coalfall guardrail from regressing.

## 3. Non-goals

- Main stage-2 prompt-tuning (Target C — sequenced follow-up, §8). The
  escalation re-ask *prompt/context* IS in scope here (it's a distinct, smaller
  LLM call), but the primary stage-2 attribution prompt is not.
- Cast discovery (stage-1); this is stage-2 attribution only.
- Segmentation drift: the harness will *measure* it (§5.1) but fixing
  segmentation is a separate follow-up.

## 4. Thesis

Trust the *first, full-context* model pass; make the deterministic and
escalation layers **resolve, not override**. Escalation may fill in genuinely
unresolved lines but must not overwrite a committed named answer with a
worse-grounded re-ask; the deterministic layer must not mint false tag evidence.

## 5. Design — waves (each independently shippable)

### 5.1 Wave 1 — harness honesty + variance (prerequisite)

*Files: `server/src/analyzer/attribution-eval/run-eval.ts`, `run-eval-cli.ts`,
`scripts/run-attribution-eval.mjs` (+ tests). `scoreAttribution` already excludes
`segMismatch` from recall (scorer.ts) — no scorer change expected.*

- **Per-family honesty:** `scoreStage`'s `byFamily` currently counts a
  seg-drift line as a family `total` but never `correct`. Report each family as
  **`correct / attributed / drift`**, drift excluded from the accuracy
  denominator. Update `printScorecard`.
- **Multi-run averaging:** add an `--runs N` (or `EVAL_RUNS`) option; each
  fixture runs N times per engine and the scorecard reports **mean and range**
  per stage and per family. Default N=1 (fast); acceptance uses N≥3.

*Acceptance:* drift no longer counts as an attribution miss; a family's number
is drift-excluded; `--runs 3` prints mean±range. Unit tests on a synthetic
fixture (known drift line) + the averaging reducer.

### 5.2 Wave 2 — escalation redesign (primary)

*Files: `server/src/analyzer/dialogue-structure/escalation.ts` (+ test); read
context from `windows.ts`/`aligner.ts`; a new registry knob if a gate threshold
is introduced.*

Two coupled changes:

- **E1 — better-grounded re-ask context.** Give the re-ask the confidently
  **resolved** speakers of the surrounding lines (the alternation picture),
  not just raw narration paras — so the model can infer a flagged line from its
  neighbours instead of guessing from a starved window. Exact context shape
  (resolved-neighbour annotation, window size) pinned by TDD against the ch46
  two-hander.
- **E2 — accept-only-if-better gate.** Escalation may **fill in** a genuinely
  unresolved line (original id is `narrator`/unknown-placeholder) as today, but
  may **override a committed named roster character** only when the re-ask meets
  a stronger bar (starting hypothesis: the re-ask is *consistent across the
  whole window* — e.g. yields a coherent alternation — rather than a lone
  contradicting guess). The precise "better" predicate is a design sub-task
  resolved by TDD against ch46 + Coalfall; the invariant is: **a bare re-ask
  never overwrites a committed named answer.**

*Acceptance:* ch46 + Coalfall `final` no longer collapse vs. their `det`
(averaged runs); ch45's escalation gain is preserved or not worsened; existing
`escalation.test.ts` invariants (tag-name never overridden, budget accounting,
dedup) stay green.

### 5.3 Wave 3 — crossExamine tag strength (secondary)

*Files: `server/src/analyzer/dialogue-structure/parser.ts`, `cross-examine.ts`,
`types.ts`, `escalation.ts` (+ tests).*

Introduce tag **strength** and gate silent correction on it:
- **A1 (parser.ts):** a `tag-name` minted from a **quote-paragraph
  narration-gap** reclassified on a **beat** verb only (no speech verb) is
  **weak**; a genuine inline speech-verb tag adjacent to its quote is **strong**.
  This must distinguish the weak quote-gap case from the **legitimately strong
  dash-interior beat tag** the Russian/German cases rely on (e.g.
  `— Да, — кивнул Антон`) — so the rule keys off *path + verb class + adjacency*,
  not "beat verb" alone. Cover the dash path and phase-2 anchoring, not just
  `parseQuoteParagraph`.
- **A2 (cross-examine.ts + escalation.ts):** a **weak**-tag disagreement with
  the model **keeps the model id and flags** (bucket `flagged`, mirroring the
  existing `pronoun-keep-flag`/`alt-keep-flag` rows) instead of silently
  overriding. Strength threads through `SpanEvidence.speaker` in `types.ts`, and
  **escalation.ts:230's `hasTagName` guard must honor the same strong/weak
  distinction** so the two enforcers agree (a weak tag must be overridable by
  the escalation pass too).

*Acceptance:* ch44 `tag-correct` false-positive paragraphs (reproduced as parser
unit tests) no longer mint a strong `tag-name` for the wrong speaker; all
existing `parser.test.ts` / `cross-examine.test.ts` cases stay green (esp.
Russian/German dash beat-verb tags); ch44 `final` improves toward raw.

## 6. Acceptance criteria (verifiable, variance-aware)

Measured via `npm run eval:attribution -- --engine qwen --runs 3`
(`EVAL_QWEN_MODEL=qwen36-cw-iq4-32k:latest`), mean over ≥3 runs:

- **Primary:** every fixture's mean `final ≥ raw − noise` (no net degradation
  from the deterministic+escalation layers), and the two large regressors
  recovered: **ch46 and Coalfall `final` within noise of their `det`**.
- **Coalfall guardrail:** mean `final ≥ raw` (75.9%) — anti-overfit tripwire.
- **No fixture's mean `final` drops** vs. the recorded esc-off `det` baseline.
- **Every code change ships a paired unit test** reproducing its specific case
  (fails before / passes after). The averaged eval scorecard is the integration
  measure, not a substitute for unit tests.

## 7. Risks

- **Escalation redesign blast radius:** escalation runs on every book/language
  in `'local'` mode. Mitigated by the tag-name invariant staying intact, the
  Coalfall guardrail, and `escalation.test.ts`.
- **E2 "better" predicate is genuinely hard** (no runtime ground truth). Start
  conservative (fill-unresolved-only; override only on window-consistency) and
  let the averaged eval arbitrate; do not over-engineer a confidence model that
  the schema can't feed (per-line `confidence` is optional/absent).
- **A1 shared-code tension:** the same `anchorSpansFromTags` serves the
  desired-strong dash beat tags and the desired-weak quote-gap tags. The rule
  must not regress the multilingual dash cases — pinned by keeping their tests
  green.
- **Variance masking small wins:** ch45's +1.8 and ch43's −0.5 are near the
  noise floor; do not chase or over-credit them. Averaged runs are the arbiter.

## 8. Follow-up — Target C (main-prompt exploration), sequenced

The "prompt-tuning is a dead end on small local models" conclusion (plan
221/srv-59) predates the current model (~3× larger). Re-test empirically on the
now-honest, variance-averaged harness: A/B a **main stage-2** prompt change and
read the **raw** delta, targeting `unanchored` (pure model reasoning) and
`pronoun` disambiguation — not tags (deterministic, fixed here). Constraint: the
stage-2 prompt is shared across languages, so any change needs multilingual
fixtures captured (or an explicit en-only caveat) before shipping. Own
branch/experiment. Note the Wave-2 escalation re-ask prompt work is a smaller,
adjacent instance of the same "does better prompting help the bigger model?"
question and will be an early read on it.
