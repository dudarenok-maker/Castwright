# fe-49 — First-run wizard: split analyzer/voice, close the local-Ollama loop, and make analyzer readiness primary/backup-aware

**Issue:** [#1610](https://github.com/dudarenok-maker/Castwright/issues/1610) (`fe-49`, `area:fe`, `moscow:must`, `type:chore`, `feedback`)
**Date:** 2026-07-14
**Status:** draft
**Pairs with:** ops-28 (#1609) and the other 1.14 startup-wizard changes.

## Problem

From beta-user setup feedback (2026-07-14):

1. **The local-analyzer path dead-ends.** Ollama can be installed and detected in
   the wizard, but there's nowhere to pull an analyzer model or make it usable —
   `OllamaInstall` shows "Ollama is installed" and stops (`ollama-install.tsx:138`).
   Users give up or wrongly conclude they still need a Gemini key. Local-only
   setup is not a real guided path.

2. **Voice and analyzer setup are mushed together.** Today's single **Models**
   step stacks the voice/TTS-sidecar section and the analyzer section in one long
   scroll (`step-models.tsx`), and inside the analyzer section the Gemini key is
   the headline while the local option is buried in a collapsible *"Use a local
   analyzer instead"*. Reads as confusing and Gemini-first, contrary to the
   product's local-first stance.

Two further gaps surfaced during design:

3. **Choosing a local model doesn't switch the engine.** The Defaults step's
   analysis-model picker saves `defaultAnalysisModel` only; `analysisEngine` is a
   separate field that `getResolvedAnalysisEngine()` reads directly
   (`user-settings.ts:573`). So picking a local tag there is a silent no-op for
   routing.

4. **Readiness follows only the active engine.** `diagnoseAnalyzer` checks the
   one resolved engine (`setup-readiness.ts:194-212`), so it can't express "you
   have a working analyzer AND a fallback." The product wants a primary/backup
   view: green when both a local model and a Gemini key are present, yellow (no
   backup, non-blocking) when only one is, red when neither.

## Goals

- Present analyzer setup and voice setup as **two distinct wizard steps**, with
  **Analysis first** (it precedes voice generation in the app flow).
- In the analysis step, present **two options** — **Local via Ollama** (first,
  primary) and **Online via Gemini** (second) — as distinct cards; no buried
  "instead" link. Close the Ollama dead-end by reusing the admin Model-Manager
  machinery to **list all pulled models and pull the suggested one**.
- Make the analyzer readiness **availability-based and primary/backup-aware**:
  green (both), yellow/non-blocking (one, "no backup"), red/blocking (none).
- Make choosing a local model in the **Defaults** step actually switch the
  engine, so generation routes to the chosen analyzer.

## Non-goals

- **Setting the analyzer default (active engine) in the analysis step.** Choosing
  which analyzer *runs* is owned by the **Defaults** step's model dropdown. The
  analysis step only makes analyzers *available*.
- **Forcing our recommended model.** Any one pulled Ollama model counts as
  "available" — the suggested tag is a convenience, not a requirement.
- **Reworking `saveGeminiApiKey`.** It stays key-only (`account-slice.ts:63`);
  Gemini "availability" is read from whether a key is set, independent of it.
- **Runtime analyzer fallback wiring** (e.g. gemini→local when the active engine
  is unusable). See *Resolve during planning*.
- **Admin-screen disentanglement** — a follow-up (see §7).

## Design decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Voice vs analyzer | **Two separate wizard steps.** |
| Step order | **Analysis first, then Voice.** |
| Analyzer options | Two cards; **Ollama first** (local-first), Gemini second. |
| Ollama section content | Render like admin `ModelsCardBody`: `OllamaInstall` + `ModelPullStatus` (list all pulled ∪ suggested-pull). |
| "Ollama available" | **≥1 pulled model + daemon reachable** — any model, not just the suggested one. |
| Who sets the active engine | The **Defaults step** dropdown (lists all pulled tags), via `':'` auto-derive. |
| Analyzer readiness | **Availability-based tri-state**: both → green; one → yellow/**non-blocking**; none → red/blocking. Adds a `warn` state to `BlockerDiagnosis`. |
| Admin screens | **Follow-up** issue to mirror this design (not shared control). |

## Section 1 — Wizard structure

Split the combined **Models** step (`step-models.tsx`, stepIndex 2) into two and
reorder:

| # | Step | Change |
|---|---|---|
| 0 | Environment | — |
| 1 | ffmpeg | — |
| **2** | **Analysis** | NEW — reworked analyzer half (§2) |
| **3** | **Voice** | NEW — voice-engines half, lifted verbatim |
| 4 | Defaults | engine auto-derive added (§4) |
| 5 | LAN access | — |
| 6 | Finish | — |

Step count 6 → 7.

**Files**
- New `src/components/setup/step-analysis.tsx` (+ `step-analysis.test.tsx`).
- New `src/components/setup/step-voice.tsx` (+ `step-voice.test.tsx`).
- Delete `src/components/setup/step-models.tsx` and `step-models.test.tsx`
  (content moves into the two new files; the local `BlockerBadge` /
  `SectionHeading` helpers move with them, or into a tiny shared module).

**`setup-wizard.tsx`**
- Extend `StepId` + `STEPS`: replace `models` with `analysis` then `voice`.
- Add `renderStep` cases for `analysis` and `voice` (both `{ readiness, onRefetch }`).
- `buildSummaryRows` (`setup-wizard.tsx:246-296`): the **Analyzer** row moves to
  `stepIndex: 2` and orders **before** the **Voice engines** row (`stepIndex: 3`);
  `defaults` → `4`, `lanCert` → `5`. Progress dots + "Step N of 7" derive from
  `STEPS.length`. The analyzer row must also render the new **yellow** state (§5),
  so `SummaryStatus` gains a `warn` (yellow dot) alongside `ok`/`attention`.

**Voice step is a pure lift** — no behavior change: `VenvBootstrap`,
`KokoroInstall`, and the "More voice engines" `<details>` (`QwenInstall` +
`CoquiInstall`), with the `blockers.sidecar` / `blockers.tts` badges.

## Section 2 — The analysis step

Two distinct bordered-card sections, local-first order.

**① Local via Ollama** (first)
- Render **unconditionally, like admin's `ModelsCardBody`** (`model-settings-form.tsx`):
  `OllamaInstall` (daemon install/detect, unchanged) followed by `ModelPullStatus`
  (`model-pull-status.tsx`, reused as-is). `ModelPullStatus` already lists pulled
  tags ∪ curated `pullable[]`, offers **Pull** with progress + poll, and shows its
  own amber "daemon unreachable" banner when the daemon isn't serving — so we do
  **not** gate its render on `OllamaInstall`'s detect state (which it doesn't
  expose anyway).
- Wiring: the step fetches `api.getOllamaHealth()` for the `health` prop and reads
  `account.pullableModels` (dispatch `fetchAnalyzerModels` on mount). On a terminal
  pull, `onPulled` → `onRefetch` (re-probe readiness) **and** re-dispatch
  `fetchAnalyzerModels` so the new tag reaches the Defaults dropdown.
- **No set-as-default action here.** Provisioning only. Once ≥1 model is pulled,
  the analyzer badge reflects it (§5) in-step.

**② Online via Gemini** (second)
- `GeminiKeyField` → `saveGeminiApiKey` + `onRefetch` (unchanged), as the second card.

**Badge.** The step shows the analyzer `BlockerBadge` at the top, now rendering
the availability tri-state (§5) — green/yellow/red. **On this step it renders
message-only, without `BlockerFixAction`**: the remedies are the two cards right
below, so the old fix action (which navigates to `#/advanced`, out of the
wizard — `setup-diagnosis.ts:233`) is suppressed here. (Out-of-wizard consumers
like the status-popover keep rendering the diagnosis's action.)

Because readiness is now availability-based rather than active-engine-based,
**pulling Ollama or saving a Gemini key moves the badge in-step** — the earlier
"still amber until the Defaults step" seam is gone.

## Section 3 — Reused components (no new picker)

- `ModelPullStatus` (`src/components/model-pull-status.tsx`) — pure UI, no redux;
  `{ health, pullableModels, onPulled }`. Owns pull + progress + "Refresh".
- `OllamaInstall` (`src/components/ollama-install.tsx`) — unchanged.
- `api.getOllamaHealth()` → `GET /api/ollama/health` (`models[]`, `pullable[]`,
  `expectedModel`, `modelPulled`).
- `fetchAnalyzerModels` (`account-slice.ts:74`) → `localAnalyzerModels` +
  `pullableModels`.

We do **not** lift `ModelsCardBody` into a shared component; the analysis step
composes the leaf controls directly (a shared wrapper can come with the admin
follow-up if warranted).

## Section 4 — Defaults step: engine auto-derive (routing)

`step-defaults.tsx`'s `handleAnalysisModelChange` saves `defaultAnalysisModel`
only. Change it to also save an auto-derived `analysisEngine`:

```
const engine = next.includes(':') ? 'local' : 'gemini';
dispatch(saveAccountSettings({ defaultAnalysisModel: next, analysisEngine: engine }));
```

`':'` matches the exact heuristic `getResolvedOllamaModel()` uses
(`user-settings.ts:566`); Ollama tags carry a `:`, Gemini ids do not. This is
what routes generation to the chosen analyzer.

**Availability ≠ active engine.** The badge (§5) reports what's *provisioned*; the
Defaults dropdown sets what actually *runs*. The one case where these can diverge
is *Ollama pulled, no Gemini key, user never opens Defaults* → badge is yellow but
the resolved engine stays `gemini` (unusable). The Ollama card's presence + the
Defaults dropdown are the intended path (pick the tag → engine=local); whether to
add a runtime fallback for this residual case is deferred (see *Resolve during
planning*). The engine derive only fires on a change event, so a pre-existing
mismatched `analysisEngine`/`defaultAnalysisModel` pair self-heals only when the
user re-selects — acceptable for v1.

## Section 5 — Availability-based analyzer readiness (server leg)

This reverses the earlier "verify-only" scope: readiness gains a real change.

**Tri-state.** Extend `BlockerDiagnosis.status` from `'pass' | 'fail'` to
`'pass' | 'warn' | 'fail'` (server type + the client mirror; if `BlockerDiagnosis`
is part of `openapi.yaml`, update it and run `npm run openapi:types`).

**`diagnoseAnalyzer` rewrite** (`setup-diagnosis.ts:226`). Take both signals and
branch on availability, independent of the active engine:
- `geminiAvailable` = Gemini key set.
- `ollamaAvailable` = daemon reachable **and ≥1 pulled model** (use
  `models.length > 0`, **not** the expected-model-specific `modelPulled` — any
  pulled model counts).
- both → `pass` "Analyzer ready."
- exactly one → `warn` "Analyzer ready — no backup analyzer configured." (message
  nudges setting up the other; carries a remedy action for out-of-wizard
  consumers, e.g. navigate to the Analysis step).
- neither → `fail` "No analyzer configured." (remedy: set up Ollama or add a
  Gemini key).

**`setup-readiness.ts:194-212` rewrite.** Probe **both** unconditionally: compute
`geminiKeySet` from `getResolvedGeminiApiKey()` and always `probeOllamaHealth()`,
then pass both into `diagnoseAnalyzer`. (Drop the current if-engine branch.)

**Boot gate.** `buildSetupReadiness` sets
`ready: Object.values(blockers).every(b => b.status === 'pass')`
(`setup-readiness.ts:104`). Change to treat `warn` as non-blocking:
`b.status === 'pass' || b.status === 'warn'`. This is what makes the yellow
one-analyzer state non-blocking.

**Front-end consumers of the tri-state** (all currently assume binary):
- `step-analysis.tsx` `BlockerBadge` — green/yellow/red + label.
- `buildSummaryRows` (`setup-wizard.tsx:277-278`) — analyzer row: `pass`→ok,
  `warn`→yellow, `fail`→attention; `SummaryStatus` gains `warn`.
- `status-popover.tsx` `DiagnosisBlock` (`status-popover.tsx:315`) — render `warn`.
- Audit any other `.status === 'pass'` / `=== 'fail'` analyzer checks.

## Section 6 — Ollama pull path (verify)

Unchanged and confirmed working: `POST /api/ollama/pull` is allowlist-gated
(`pull-bootstrap.ts:87`); the suggested `expectedModel` resolves to `qwen3.5:4b`,
which is in `DEFAULT_ALLOWED_MODELS` (`pull-bootstrap.ts:64`), so the suggested
pull is offered and permitted.

## Section 7 — Admin screens (follow-up)

`model-settings-form.tsx` / `model-manager.tsx` carry the same voice/analyzer
entanglement, but they are **distinct components** that only reuse the leaf
controls (`OllamaInstall`, `ModelPullStatus`) — **not shared control**. So the
admin disentanglement (and adopting the new tri-state badge there) is a separate
follow-up issue to mirror this design once fe-49 lands. File it during shipping +
add the thin `docs/BACKLOG.md` row.

## Testing

- **`step-analysis.test.tsx`** — renders `OllamaInstall` + `ModelPullStatus`;
  pull path lists/pulls (mock **both** `api.getOllamaHealth` and global `fetch`,
  since the leaf controls use raw `fetch`); Gemini key saves; badge shows the
  right tri-state for both/one/none.
- **`step-voice.test.tsx`** — voice-engine controls render (lift regression).
- **`setup-wizard.test.tsx`** — 7 steps; "Step N of 7"; summary rows: Analyzer
  before Voice; analyzer row renders the yellow `warn` state.
- **`step-defaults.test.tsx`** — `':'` tag → saves `analysisEngine:'local'`;
  Gemini id → `'gemini'` (both with the model).
- **`setup-diagnosis.test.ts`** — `diagnoseAnalyzer`: both→`pass`, gemini-only→
  `warn`, ollama-only(≥1 model)→`warn`, none→`fail`.
- **`setup-readiness` route test** — probes both engines; `ready` is `true` when
  the only non-pass blocker is analyzer `warn` (non-blocking); `false` on analyzer
  `fail`.
- **e2e** — update `e2e/setup-wizard.spec.ts` for the new order/count; drive the
  Ollama pull path with mocked `GET/POST /api/ollama/*`.

## Acceptance criteria

- [ ] Wizard has separate **Analysis** (step 2) and **Voice** (step 3) steps;
      Analysis first; "Step N of 7"; summary board reordered, analyzer row can
      render yellow.
- [ ] Analysis step shows **Local via Ollama** first and **Online via Gemini**
      second as distinct cards; Ollama section lists all pulled models and offers
      the suggested pull — no dead-end.
- [ ] Ollama + ≥1 pulled model (any) → analyzer badge is at least yellow **in the
      Analysis step** without visiting Defaults; badge is green when a Gemini key
      is also set.
- [ ] Exactly one analyzer configured → yellow "no backup", **non-blocking**
      (`ready` still true); neither → red, blocking (`ready` false).
- [ ] Defaults: picking a `':'` tag sets `analysisEngine:'local'`; a Gemini id
      sets `'gemini'`.
- [ ] Voice step is behavior-identical to today's voice section.
- [ ] Paired tests for list/pull, tri-state diagnosis, non-blocking gate, and
      defaults-engine paths; e2e updated.
- [ ] Admin follow-up issue filed + `docs/BACKLOG.md` row added.

## Resolve during planning

- **Runtime fallback for "Ollama pulled, no Gemini key, engine still gemini".**
  Decide whether generation should fall to the available analyzer, or whether the
  Defaults-dropdown path is sufficient (current assumption). If wiring is wanted,
  scope it — likely out of fe-49.
- **Exact `BlockerDiagnosis` type location(s)** and whether `warn` flows through
  `openapi.yaml` → `api-types.ts` or a hand-written mirror.
- **`warn` remedy action** for out-of-wizard consumers (status-popover): what it
  navigates to now that the diagnosis is engine-agnostic.

## Key files

- `src/components/setup/setup-wizard.tsx` (steps, renderStep, summary rows + `warn`)
- `src/components/setup/step-analysis.tsx` (new), `step-voice.tsx` (new),
  `step-models.tsx` (delete)
- `src/components/setup/step-defaults.tsx` (engine auto-derive)
- `src/components/status-popover.tsx` (tri-state render)
- `server/src/routes/setup-diagnosis.ts` (`diagnoseAnalyzer` rewrite + `warn`),
  `server/src/routes/setup-readiness.ts` (probe both + `ready` gate)
- Reuse: `src/components/ollama-install.tsx`, `src/components/model-pull-status.tsx`,
  `src/store/account-slice.ts`, `src/lib/api.ts`
- Type: `BlockerDiagnosis` status enum (+ `openapi.yaml` if generated)

## Ship notes

_(filled at ship time)_
