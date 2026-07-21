# Attribution deterministic-first tuning — design

**Status:** design (approved for planning 2026-07-21)
**Author:** design thread, session 8e874d56
**Corpus / measurement:** attribution-eval harness (shipped PR #1750), engine
`qwen36-cw-iq4-32k:latest`, fixtures = Playing with Fire ch.43–46 (645
hand-attributed sentences) + committed Coalfall guardrail.
**Follow-up (out of scope here):** Target C — prompt-tuning exploration on the
now-stronger model (sequenced after this lands; see §7).

---

## 1. Problem

The first real attribution baseline (2026-07-21, `qwen36-cw-iq4-32k`) shows the
deterministic post-LLM passes **degrade** accuracy rather than help. Three-point
scorecard (raw LLM → deterministic → final):

| Fixture | n | raw | det | final | seg-drift |
|---|---|---|---|---|---|
| PwF ch43 | 183 | 80.3% | 79.8% | 78.7% | 8 |
| PwF ch44 | 328 | 83.2% | 80.5% | 79.9% | 50 |
| PwF ch45 | 56 | 58.9% | 60.7% | 62.5% | 0 |
| PwF ch46 | 78 | 61.5% | 61.5% | 51.3% | 34 |
| Coalfall ch1 | 58 | 75.9% | 75.9% | 72.4% | 35 |

`final < raw` on 4 of 5 fixtures — the pipeline ends **worse** than the raw LLM.

Per-line diagnosis (ch44 + ch46) isolated three distinct causes:

1. **seg-drift confounds the scorecard.** ~half of ch44's "tag" failures (17 of
   34) are segmentation splits — the pipeline splits an utterance differently
   from ground truth, so each sub-line (usually *correctly* attributed) fails to
   text-match a truth line and scores as a failure. True attribution is higher
   than the family percentages imply. `scoreAttribution` already tracks
   `segMismatch` separately; the eval's per-family breakdown does not.

2. **`crossExamine` corrupts correct answers (primary).** ch44 raw→det is
   **net −10** (12 correct→wrong, 2 wrong→correct). Culprit reason-codes, all
   `corrected`-bucket: `tag-correct:*`, `tag-span-narrator`, `pronoun-correct:*`.
   Root cause is upstream in `parser.ts`: `parseQuoteParagraph` reclassifies a
   narration gap `narration→tag` when it contains **any** speech-*or-beat* verb
   stem, then `anchorSpansFromTags` attaches it to the adjacent quote and
   `findRosterName` takes the first roster name as an authoritative `tag-name`
   speaker. So a narration beat that merely *mentions* a character and contains a
   beat verb ("smiled", "watched", "turned") mints an unoverridable speech tag —
   and `crossExamine`'s `tag-name` branch (correctly, per its own invariant)
   forces the quote onto that name over a correct LLM answer. The decision matrix
   is behaving to spec; it is being fed false tag evidence.

3. **Final flagged-line resolution breaks dialogue alternation (secondary).**
   ch46 det→final is **net −8, and every one** is
   `unanchored-named:stephanie-edgley|flagged` where the deterministic stage had
   Stephanie right and the post-cross-examine step flipped her short two-hander
   lines ("*I promise.*", "*How's your arm?*", "*Thanks.*") to `dusk` or
   `narrator`. The resolution mishandles a clean two-speaker Valkyrie↔Dusk
   exchange.

The escalation LLM re-ask was **not** active in the baseline
(`runEval` passes no `escalationAnalyzer`), so the det→final delta is purely
deterministic post-processing — not an LLM escalation problem.

## 2. Goal

The deterministic passes must stop degrading attribution and start helping, on
the strong model, measured against the corpus.

## 3. Non-goals

- Prompt-tuning the LLM stage (Target C — sequenced follow-up, §7).
- Cast discovery (stage-1); this is stage-2 attribution only.
- Escalation-model behavior (inactive in the baseline).
- Any behavior change on the default production path that the corpus does not
  measure (multilingual prompt effects are explicitly deferred with Target C).

## 4. Reframed thesis

The model is now capable enough that the balance should shift **toward the LLM
and away from aggressive deterministic correction**. Every fix points the same
way: stop the alignment fabricating false tag-evidence (A1), and make
deterministic corrections *defer* to the model unless the tag evidence is
genuinely strong (A2).

## 5. Design

### 5.0 Harness prerequisite — honest per-family scoring

*Files: `server/src/analyzer/attribution-eval/run-eval.ts` (+ its test); possibly
`scorer.ts` if a per-line drift flag must be surfaced.*

`scoreAttribution` already separates `segMismatch` (predicted line whose text
matches no remaining truth line) from mis-attribution. Change the `byFamily`
accounting in `scoreStage` so each family reports **`correct / attributed /
drift`** — drift lines excluded from the accuracy denominator, reported
alongside. Update `printScorecard` to render the three counts. This lands
**first**; A1/A2/B are measured through it.

*Acceptance:* a family's `correct/attributed` no longer counts a seg-drift line
as an attribution miss; drift is visible as its own count. Unit test on a
synthetic fixture with a known drift line.

### 5.1 Target A1 — tag strength in the parser

*Files: `server/src/analyzer/dialogue-structure/parser.ts` (+ `parser.test.ts`).*

Introduce a notion of tag **strength**:
- **strong** — a genuine inline speech-verb tag ("said X") adjacent to its quote.
- **weak** — a gap reclassified `narration→tag` only on a **beat** verb
  ("smiled", "watched"), or a standalone narration sentence that merely mentions
  a name.

Tighten `parseQuoteParagraph`'s `narration→tag` reclassification and/or the
`anchorSpansFromTags`/`findRosterName` path so a beat-only, name-mentioning
narration gap no longer mints a **strong** `tag-name` speaker. The exact rule
(e.g. speech-verb-required for strong; adjacency/length bound on the beat gap) is
pinned by TDD against the reproduced ch44 false-positive paragraphs.

*Acceptance:* the reproduced ch44 `tag-correct` false-positive paragraphs no
longer produce a strong `tag-name` span for the wrong speaker; **all existing
`parser.test.ts` cases stay green** (especially Russian/German dash-dialogue and
the legitimate inline-beat-attribution cases).

### 5.2 Target A2 — gate silent correction on tag strength

*Files: `server/src/analyzer/dialogue-structure/cross-examine.ts`
(+ `cross-examine.test.ts`); tag-strength consumed from A1.*

`decideAnchoredSpeech`'s `tag-name` branch keeps its "strong tag wins silently"
behavior **only for strong tags**. On a **weak**-tag disagreement with the model,
it **keeps the model's id and flags** (a surfaced review-stop) instead of
silently overwriting. No dependency on per-line `confidence` (which is optional
in the stage-2 schema and may be absent). Whether a weak tag is
*kept-and-flagged* vs *applied-and-flagged* is decided by TDD against the
reproduced cases; the invariant is: **a weak tag never silently overrides the
model.**

*Acceptance:* on the reproduced ch44 cases, a weak-tag disagreement no longer
silently flips a correct model answer; strong-tag corrections are unchanged;
`cross-examine.test.ts` strong-tag invariants stay green.

### 5.3 Target B — flagged-line alternation resolution

*Files: `server/src/routes/analysis.ts` (the post-cross-examine step —
`applyNarratorDefault` / scene-break annotation) + its test.*

Trace the exact post-cross-examine step that reassigns
`unanchored-named:*|flagged` lines, reproduce ch46's Stephanie→Dusk/narrator
flip as a test, and fix the resolution so a clean two-speaker alternation
preserves the correct deterministic assignment rather than defaulting it away.

*Acceptance:* the reproduced ch46 two-hander lines keep their correct speaker
through the final stage; no regression on existing analysis.ts tests.

## 6. Acceptance criteria (verifiable bar)

Measured via `npm run eval:attribution -- --engine qwen`
(`EVAL_QWEN_MODEL=qwen36-cw-iq4-32k:latest`) against the recorded baseline:

- **Primary:** `final ≥ raw` on **every** fixture.
- **Tags (drift-excluded):** explicit-tag family ≥ **95%** correct.
- **Coalfall guardrail:** no regression below its raw baseline (75.9%) —
  anti-overfit tripwire.
- **No net loss:** no fixture's `final` drops vs. the recorded baseline.
- **Every code fix ships a paired unit test** reproducing its specific failing
  case (fails before, passes after). The eval scorecard is the integration
  measure, not a substitute for unit tests.

## 7. Follow-up — Target C (prompt exploration), sequenced

The "prompt-tuning is a dead end on small local models" conclusion (plan
221/srv-59) predates the current model (~3× the size it was decided against).
Re-test it **empirically** using the now-honest harness: A/B a stage-2 prompt
change and read the **raw** delta, targeting the classes where the *model* is the
bottleneck — `unanchored` (25–40%, pure model reasoning) and `pronoun`
disambiguation (54% on ch44) — **not** tags (a deterministic problem, fixed
here). Constraint: the stage-2 prompt is shared across languages, so any prompt
change needs multilingual fixtures captured (or an explicit en-only caveat)
before it can ship. Filed as its own backlog item; own branch/experiment.

## 8. Risks

- **A1 blast radius:** the parser feeds every language and book. Mitigated by
  keeping all existing `parser.test.ts` green and by the Coalfall guardrail.
- **Over-flagging (A2):** making weak-tag disagreements flag could add review
  stops. Expected low once A1 removes the false weak tags; measured via the
  flagged-count in the structure log.
- **seg-drift is a separate lever:** honest scoring (5.0) reveals but does not
  fix segmentation. If a large residual remains after A1/A2/B, segmentation is a
  separate follow-up, not scope creep here.
