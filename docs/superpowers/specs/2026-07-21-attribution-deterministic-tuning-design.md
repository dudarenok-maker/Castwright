# Attribution accuracy tuning — design

**Status:** design (v3, after two assumption-check passes 2026-07-21)
**Author:** design thread, session 8e874d56
**Corpus / measurement:** attribution-eval harness (shipped PR #1750), engine
`qwen36-cw-iq4-32k:latest`, fixtures = Playing with Fire ch.43–46 (645
hand-attributed sentences) + committed Coalfall guardrail.
**Follow-up (out of scope here):** Target C — main stage-2 prompt exploration
(sequenced after this lands; see §8).

> **History.** v1 wrongly assumed the escalation LLM re-ask was inactive; an
> assumption-check proved it runs (`analyzer.structure.escalation` default
> `'local'`, registry.ts:1121; local mode = main analyzer, analysis.ts:1835).
> v2 re-scoped around escalation. A focused re-check of v2 confirmed that
> diagnosis and tightened E1/E2/acceptance — folded into this v3.

---

## 1. Problem — corrected & empirically confirmed

Two eval runs (escalation ON default, and OFF via `ATTRIBUTION_ESCALATION=off`)
isolate each stage. The three-point scorecard separates them: `raw` =
pre-crossExamine LLM, `det` = post-crossExamine / **pre**-escalation, `final` =
post-escalation (esc-OFF makes `det == final`, confirmed).

| Fixture | raw | det=final (esc-OFF) | crossExamine (raw→det) | escalation (det→final, esc-ON) |
|---|---|---|---|---|
| ch43 | 80.3 | 79.8 | −0.5 † | −1.1 † |
| ch44 | 83.2 | 80.2 | **−3.0** | −0.3 † |
| ch45 | 58.9 | 60.7 | **+1.8** | +1.8 (helped) |
| ch46 | 64.1 | 64.1 | 0 | **−12.8** |
| Coalfall | 75.9 | 75.9 | 0 | **−3.5** |

**Signal vs noise.** Given the ±2–3% run-to-run LLM variance (below), only
**ch46 (−12.8) and Coalfall (−3.5)** are unambiguous escalation signal, and
**ch44 (−3.0)** is the crossExamine signal. Rows marked † are at/under the noise
floor and are directional at best — not load-bearing.

**Escalation is the dominant regressor.** Root cause (escalation.ts):
`escalateFlaggedWindows` re-queries each flagged window with a **more
context-starved** view than the original full-chapter pass (≤1500-char window +
≤2 short-narration paras, minimal prompt — escalation.ts:83-166), then **applies
the re-ask answer with no quality gate** (escalation.ts:223-239: any roster id,
non-`tag-name` line → overwrite at `confidence 0.8`). On `unanchored-named`
lines — where the full-context model already committed to a plausible named
speaker — it replaces a good answer with a worse small-window guess.

**crossExamine (secondary, ch44).** `tag-correct` false positives: a
beat-verb-bearing narration gap is reclassified `narration→tag`
(parseQuoteParagraph, parser.ts:239-244) and `findRosterName` (first roster stem
left-to-right) stamps an authoritative `tag-name` speaker onto the adjacent
quote. The same path exists in the dash branch (parseDialogueSpans, same
speech-**or-beat** verb set, parser.ts:146) and is amplified by phase-2
multi-span anchoring (parser.ts:70-74).

**⚠️ Measurement caveat — run-to-run LLM variance.** raw stage-2 is
non-deterministic: ch46 raw 61.5→64.1 across two runs; ch44 seg-drift 50→47;
pronoun 24→22. **Acceptance must average ≥3 runs**; sub-noise single-run deltas
are not evidence.

## 2. Goal

The full pipeline must not degrade attribution vs. the raw LLM on the strong
model — measured across averaged runs — and must **not silently lose** a place
where a layer currently *helps* (ch45). Coalfall must not regress.

## 3. Non-goals

- Main stage-2 prompt-tuning (Target C — §8). The escalation re-ask
  prompt/context IS in scope (distinct, smaller LLM call); the primary stage-2
  prompt is not.
- Cast discovery (stage-1); stage-2 attribution only.
- Fixing segmentation drift: the harness *measures* it (§5.1); fixing it is a
  separate follow-up.

## 4. Thesis

Trust the *first, full-context* model pass; make the deterministic and
escalation layers **resolve, not override.** Escalation may fill genuinely
unresolved lines but must never overwrite a **named** answer with a
worse-grounded re-ask; the deterministic layer must not mint false tag evidence.

## 5. Design — waves (each independently shippable)

### 5.1 Wave 1 — harness honesty + variance (prerequisite)

*Files: `server/src/analyzer/attribution-eval/run-eval.ts`, `run-eval-cli.ts`,
`scripts/run-attribution-eval.mjs` (+ tests). `scoreAttribution` already excludes
`segMismatch` from recall and marks a drift line as `perLine[i].truth === null`
(scorer.ts) — no scorer change.*

- **Per-family honesty:** `scoreStage.byFamily` currently counts a drift line as
  family `total` but never `correct`. Report each family as
  **`correct / attributed / drift`**, drift (`truth === null`) excluded from the
  accuracy denominator. This is a real rewrite of `byFamily` + `printScorecard`,
  not a flag.
- **Multi-run averaging:** add `--runs N` (`EVAL_RUNS`); each fixture runs N
  times per engine. Average **per-run ratios** (not pooled counts — denominators
  shift run-to-run under drift), and define the missing-family case (a family
  absent in a run contributes no sample, not a zero). Report **mean and range**
  per stage and per family. Default N=1; acceptance uses N≥3.

*Acceptance:* drift no longer counts as an attribution miss; `--runs 3` prints
mean±range averaging per-run ratios. Unit tests: a synthetic fixture with a known
drift line; the averaging reducer incl. the missing-family case.

### 5.2 Wave 2 — escalation redesign (primary)

*Files: `server/src/analyzer/dialogue-structure/escalation.ts` (+ test); read
context from `windows.ts`/`aligner.ts`.*

**The flag classes that actually reach escalation** (from `flags[].reason`,
already available in `escalateFlaggedWindows` — escalation.ts:29 — plus the
original `sentences[idx].characterId`; **no new plumbing**):
- `unanchored-named:<id>` — model committed to a named roster character. **Named.**
- `unanchored-narrator` — placeholder / genuinely unresolved.
- `pronoun-keep-flag:*` / `alt-keep-flag:*` — **named but structurally
  contested** (model kept a name that pronoun/alternation disputed).

**E-core — resolve, not override (this alone should recover ch46/Coalfall).**
Escalation may **fill** a line only when it is *not already a named answer* —
i.e. `unanchored-narrator`/placeholder. It must **never overwrite a named
answer** — `unanchored-named` **or** the contested `*-keep-flag` classes — with a
bare re-ask. (The existing `tag-name`-never-override invariant, escalation.ts:230,
stays.) This is the primary change and the acceptance target.

**E1 — better-grounded, non-circular context.** When building the re-ask window,
surface the **high-confidence deterministic** anchors of neighbouring lines
(tag-name / pronoun-confirm / alt-confirm — confidence ≈0.85–0.95 per the
`CONFIDENCE` table, cross-examine.ts) and **suppress** low-confidence unanchored/
alternation *guesses* (≈0.5–0.65), so the re-ask is not primed with the model's
own possibly-wrong answers. "Confidently resolved" = a concrete confidence
threshold (starting value pinned by TDD), not an adjective. Circularity risk is
explicit and this gate is the mitigation.

**E2 — window-consistency override: DEFERRED (optional, later).** Overriding a
*named* answer only when the re-ask is "consistent across the window" is **not**
built here: `runAttributionEscalation` returns assignments only (no score,
schemas.ts:347-360), window-consistency is well-defined only for clean 2-party
windows (windows.ts:70-101) which are rarely the unresolved ones, and it needs a
two-phase evaluate-then-apply restructure of the apply loop. Ship E-core + E1
first; revisit override only if E-core leaves a measured gap.

*Acceptance:* ch46 + Coalfall mean `final` recover to within noise of their
`det`; **ch45's escalation gain is not lost** (see §6); existing
`escalation.test.ts` invariants (tag-name never overridden, budget, dedup) green.

### 5.3 Wave 3 — crossExamine tag strength (secondary)

*Files: `server/src/analyzer/dialogue-structure/parser.ts`, `cross-examine.ts`,
`types.ts`, `escalation.ts` (+ tests).*

- **A1 (parser.ts):** add an optional `strength` to `SpanEvidence.speaker`
  (types.ts:9 — an **optional field**, NOT a new `EvidenceSource` member, so the
  cross-examine.ts exhaustiveness tripwire is untouched). A `tag-name` minted
  from a **top-level quote-paragraph narration-gap** reclassified on a **beat**
  verb only (parser.ts:242) is **weak**; a speech-verb tag, and the
  dash/quote-interior beat tag the Russian/German cases rely on
  (`— Да, — кивнул Антон`, a different code path via `parseDialogueSpans`), stay
  **strong**. Cover the dash path and phase-2 anchoring.
  **Caution:** not every quote-gap beat tag is wrong — English
  `"Stop." Anton frowned.` is a legitimate beat attribution. Weak ≠ delete; weak
  means "flag on model disagreement" (A2), and the acceptance MUST pin that
  currently-correct English beat-gap corrections are not forfeited (§6 guard).
- **A2 (cross-examine.ts + escalation.ts):** a **weak**-tag disagreement with the
  model **keeps the model id and flags** (bucket `flagged`, mirroring
  `pronoun-keep-flag`/`alt-keep-flag`). Thread strength through
  `escalation.ts:230`'s `hasTagName` guard as a one-line
  `&& strength !== 'weak'`, so a weak tag is overridable there too and the two
  enforcers agree.

*Acceptance:* ch44 `tag-correct` false-positive paragraphs (parser unit tests) no
longer mint a strong `tag-name` for the wrong speaker; **a guard fixture pins
that a correct English quote-gap beat correction still resolves right**; all
existing `parser.test.ts`/`cross-examine.test.ts` cases green (esp.
Russian/German dash beat tags); ch44 mean `final` improves toward raw.

## 6. Acceptance criteria (verifiable, variance-aware, regression-detecting)

Measured via `npm run eval:attribution -- --engine qwen --runs 3`
(`EVAL_QWEN_MODEL=qwen36-cw-iq4-32k:latest`), mean over ≥3 runs:

- **Primary recovery:** ch46 and Coalfall mean `final` within noise of their
  esc-OFF `det` (i.e. the −12.8 / −3.5 escalation losses removed).
- **No silent regression (per fixture):** **every** fixture's mean `final` ≥ its
  recorded **esc-ON** baseline − noise. This is the check that catches losing
  ch45's +1.8 or a correct beat-gap fix — the ≥raw−noise and ≥esc-off-det bars do
  **not** catch those.
- **Guard fixtures (unit level):** (a) ch45's escalation-helped line stays
  resolved; (b) a currently-correct English quote-gap beat-tag correction stays
  resolved after A1/A2.
- **Coalfall guardrail:** mean `final ≥ raw` (75.9%).
- **Every code change ships a paired unit test** (fails before / passes after).
  The averaged eval scorecard is the integration measure, not a substitute.

## 7. Risks

- **E1 circularity:** feeding neighbour answers back can amplify errors —
  mitigated by the high-confidence-deterministic-anchor gate (§5.2 E1); if the
  threshold can't be tuned to a net gain, ship E-core without neighbour context.
- **Contested-named class:** `pronoun-keep-flag`/`alt-keep-flag` are named but
  disputed; E-core protects them from bare-re-ask overwrite (treats them as
  named). If that loses a real escalation win, it surfaces via the per-fixture
  §6 check — not silently.
- **A1 shared-code / true-positive tension:** weak-tagging quote-gap beats risks
  forfeiting correct English beat corrections — pinned by the §6 guard fixture
  and by keeping multilingual dash tests green.
- **Escalation blast radius:** runs on every book/language in `'local'` mode —
  Coalfall guardrail + `escalation.test.ts` bound it.

## 8. Follow-up — Target C (main-prompt exploration), sequenced

The "prompt-tuning is a dead end on small local models" conclusion (plan
221/srv-59) predates the ~3× larger current model. Re-test empirically on the
now-honest, variance-averaged harness: A/B a **main stage-2** prompt change and
read the **raw** delta, targeting `unanchored` and `pronoun` — not tags
(deterministic, fixed here). The stage-2 prompt is shared across languages, so
any change needs multilingual fixtures (or an explicit en-only caveat) before
shipping. Own branch/experiment. The Wave-2 escalation re-ask prompt work is a
smaller, adjacent early read on the same "does better prompting help the bigger
model?" question.
