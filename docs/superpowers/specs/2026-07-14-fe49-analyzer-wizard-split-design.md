# fe-49 — First-run wizard: split analyzer/voice, and close the local-Ollama analyzer loop

**Issue:** [#1610](https://github.com/dudarenok-maker/Castwright/issues/1610) (`fe-49`, `area:fe`, `moscow:must`, `type:chore`, `feedback`)
**Date:** 2026-07-14
**Status:** draft
**Pairs with:** ops-28 (#1609) and the other 1.14 startup-wizard changes.

## Problem

Two overlapping complaints from beta-user setup feedback (2026-07-14):

1. **The local-analyzer path dead-ends.** In the setup wizard, Ollama can be
   installed and detected, but there's nowhere to pull an analyzer model or make
   it the analyzer — `OllamaInstall` shows "Ollama is installed" and stops. Users
   either give up or wrongly conclude they still need a Gemini key. Local-only
   setup is not a real guided path.

2. **Voice and analyzer setup are mushed together.** Today's single **Models**
   step stacks the voice/TTS-sidecar section and the analyzer section in one long
   scroll, and inside the analyzer section the Gemini key is presented as the
   headline while the local option is buried in a collapsible *"Use a local
   analyzer instead"*. This reads as confusing and Gemini-first, contrary to the
   product's local-first stance.

A third, latent gap surfaced during design (Section 4): the Defaults step's
analysis-model picker saves the model string but never the analyzer **engine**,
so picking a local model there is a silent no-op — the engine stays whatever it
was. This must close for the local flow to work end-to-end.

## Goals

- Present analyzer setup and voice setup as **two distinct wizard steps**, with
  analysis **first** (it precedes voice generation in the app flow).
- In the analysis step, show **two peer options** — **Local via Ollama** (first,
  primary) and **Online via Gemini** (second) — no buried "instead" link.
- Close the Ollama dead-end: once the daemon is detected, **list pulled models**
  and let the user **pull the recommended model** with progress, reusing existing
  Model Manager machinery.
- Make choosing a local analysis model in the **Defaults** step actually switch
  the engine, so `readiness.blockers.analyzer` can go green via the local path.

## Non-goals

- **Setting the analyzer default in the analysis step.** Choosing the default
  analyzer is owned by the later **Defaults** step. The analysis step only makes
  an analyzer *available* on the machine.
- **Reworking the Gemini section.** It is re-framed as the second peer card;
  its behavior (`GeminiKeyField` → `saveGeminiApiKey`) is unchanged.
- **Server changes.** `readiness.blockers.analyzer` already passes for
  engine=local + reachable daemon + pulled model (verify-only).
- **Admin-screen disentanglement.** The same voice/analyzer split in
  `model-settings-form.tsx` / `model-manager.tsx` is a **follow-up** (see §5).

## Design decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Voice vs analyzer | **Two separate wizard steps**, not one step with two sections. |
| Step order | **Analysis first, then Voice** — matches app flow. |
| Analyzer options | Two peer options; **Ollama first** (local-first), Gemini second. |
| Who sets the default | The **Defaults step**, not the analysis step. |
| How Defaults sets the engine | **Auto-derive from the picked model** (`':'`-shaped tag → `local`, otherwise `gemini`). |
| Admin screens | **Follow-up** issue to mirror this design (not shared control). |

## Section 1 — Wizard structure

Split the combined **Models** step (`step-models.tsx`, current stepIndex 2) into
two steps and reorder:

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
  (content moves into the two new files; the shared local `BlockerBadge` /
  `SectionHeading` presentational helpers move to whichever file needs them, or a
  tiny shared module if both do).

**`setup-wizard.tsx`**
- Extend the `StepId` union and `STEPS` array: replace `models` with `analysis`
  then `voice`.
- Add `renderStep` cases for `analysis` (props `{ readiness, onRefetch }`) and
  `voice` (props `{ readiness, onRefetch }`).
- `buildSummaryRows`: the **Analyzer** row moves to `stepIndex: 2` and is ordered
  **before** the **Voice engines** row (`stepIndex: 3`); `defaults` → `4`,
  `lanCert` → `5`. Progress dots + "Step N of 7" derive from `STEPS.length`,
  so no manual count edits.

**Voice step is a pure lift** — no behavior change. It carries over
`VenvBootstrap`, `KokoroInstall`, and the "More voice engines" `<details>`
(`QwenInstall` + `CoquiInstall`), plus the `blockers.sidecar` / `blockers.tts`
badges.

## Section 2 — The analysis step

Two peer, bordered-card sections so they read as distinct first-class choices.

**① Local via Ollama** (first, primary)
- `OllamaInstall` (unchanged) installs/detects the daemon.
- Once detected, render `ModelPullStatus` (reused as-is from Model Manager):
  lists pulled tags ∪ curated `pullable[]`, marks the default/present, and offers
  **Pull** with the existing progress-bar + 1 s poll of `GET /api/ollama/pull/:id`.
  This is what closes the dead-end.
- Wiring mirrors admin's `ModelsCardBody` (`model-settings-form.tsx`): fetch
  `api.getOllamaHealth()` for the health envelope and read `account.pullableModels`
  (populated by `fetchAnalyzerModels`). On a terminal pull, `onPulled` →
  `onRefetch` (re-probe readiness) **and** re-dispatch `fetchAnalyzerModels` so the
  new tag is available to the Defaults picker.
- **No set-as-default action here.** When the daemon + ≥1 analyzer-capable model
  are present, show a confirmation line:
  *"✓ Local analyzer available — pick it as your default in the Defaults step."*
  This bridges the badge seam (below).

**② Online via Gemini** (second, first-class)
- `GeminiKeyField` → `saveGeminiApiKey` + `onRefetch` (unchanged), re-framed as
  the second card rather than the headline.

**Badge / status.** The step keeps the analyzer `BlockerBadge` at the top as
honest live status of the *active* analyzer.

**Known seam (accepted).** The active engine defaults to `gemini`
(`DEFAULT_USER_SETTINGS.analysisEngine = 'gemini'`,
`defaultAnalysisModel = 'gemini-3.1-flash-lite'`), so provisioning Ollama here
does **not** turn the badge green until the Defaults step sets engine=local. The
bridging line makes that explicit ("pick it as your default in the Defaults
step"). This is a deliberate consequence of keeping default-selection in the
Defaults step; the alternative (auto-activate local when nothing else is
configured) was considered and set aside to keep one clear owner of the default.

## Section 3 — Reused components (no new picker)

Per the issue, reuse rather than build fresh:

- `ModelPullStatus` (`src/components/model-pull-status.tsx`) — pure UI, no redux;
  drop-in given `{ health, pullableModels, onPulled }`. Owns the pull button +
  progress + "Refresh available models".
- `OllamaInstall` (`src/components/ollama-install.tsx`) — daemon install/detect
  state machine, unchanged.
- `api.getOllamaHealth()` (`src/lib/api.ts`) → `GET /api/ollama/health`
  (`models[]`, `pullable[]`, `expectedModel`, `modelPulled`).
- `fetchAnalyzerModels` (`account-slice.ts`) populates `localAnalyzerModels` +
  `pullableModels`.

We do **not** lift admin's `ModelsCardBody` into a shared component; the analysis
step composes the leaf controls directly. (If a shared wrapper emerges naturally
later, the admin follow-up can adopt it.)

## Section 4 — Defaults step: engine auto-derive (required)

`step-defaults.tsx`'s `handleAnalysisModelChange` currently dispatches
`saveAccountSettings({ defaultAnalysisModel: next })` only. `analysisEngine` is a
**separate** persisted field, and `getResolvedAnalysisEngine()`
(`server/src/workspace/user-settings.ts:573`) reads it directly — it is **not**
derived from the model. So selecting a local tag today leaves the engine on
`gemini` and the local analyzer never activates.

**Change:** derive the engine from the selected model and save both:

```
const engine = next.includes(':') ? 'local' : 'gemini';
dispatch(saveAccountSettings({ defaultAnalysisModel: next, analysisEngine: engine }));
```

The `':'` test matches the exact heuristic `getResolvedOllamaModel()` already
uses (Ollama tags carry a `:`, Gemini ids do not). This single change is what
flips `readiness.blockers.analyzer` green via the local path.

## Section 5 — Admin screens (follow-up)

`model-settings-form.tsx` / `model-manager.tsx` carry the same voice/analyzer
entanglement, but they are **distinct components** from the wizard and only share
the leaf controls (`OllamaInstall`, `ModelPullStatus`) — which we reuse
unchanged. This is **not shared control**, so per the working rule the admin
disentanglement is a separate follow-up issue to mirror this design once fe-49
lands. File it during shipping and add the thin `docs/BACKLOG.md` row.

## Section 6 — Readiness (verify-only)

No server change. `diagnoseAnalyzer` (`server/src/routes/setup-diagnosis.ts:226-258`)
already returns `pass` for engine=local + `ollamaReachable` + `modelPulled`, with
`ollama-install` / `ollama-pull` fix actions on the failing branches; wiring in
`setup-readiness.ts:194-212`. The acceptance criterion "verify it already passes"
is a test assertion, not a code change.

## Testing

- **`step-analysis.test.tsx`** — daemon-detected → `ModelPullStatus` lists +
  pulls (mock health/pull); Gemini key saves; the bridging confirmation appears
  when daemon + a pulled model are present.
- **`step-voice.test.tsx`** — voice-engine controls render (lift regression).
- **`setup-wizard.test.tsx`** — 7 steps; "Step N of 7"; summary rows: Analyzer
  before Voice, correct `stepIndex` mapping (analyzer 2, voice 3, defaults 4,
  lanCert 5).
- **`step-defaults.test.tsx`** — selecting a `':'` tag saves
  `analysisEngine:'local'` + model; selecting a Gemini id saves
  `analysisEngine:'gemini'` + model.
- **Server** — assert `diagnoseAnalyzer` passes for engine=local + reachable +
  pulled (extend `setup-diagnosis.test.ts` if not already covered).
- **e2e** — update `e2e/setup-wizard.spec.ts` for the new step order/count and
  drive the Ollama pull path with mocked `GET /api/ollama/health` +
  `POST /api/ollama/pull` + `GET /api/ollama/pull/:id`.

## Acceptance criteria

- [ ] Wizard has separate **Analysis** (step 2) and **Voice** (step 3) steps;
      Analysis first; "Step N of 7"; summary board rows reordered accordingly.
- [ ] Analysis step shows **Local via Ollama** first and **Online via Gemini**
      second as peer cards (no buried "use a local analyzer instead").
- [ ] Ollama installed + ≥1 analyzer-capable model pulled → wizard lists it and
      shows the "available — set as default in Defaults" bridge; no dead-end.
- [ ] Ollama installed + no suitable model → wizard offers to pull the
      recommended model, shows progress, and the pulled tag then appears in the
      Defaults analysis-model picker.
- [ ] In the Defaults step, picking a `':'`-shaped Ollama tag sets
      `analysisEngine:'local'`; picking a Gemini id sets `'gemini'` — and
      `readiness.blockers.analyzer` flips to "Analyzer ready" for the local path.
- [ ] Voice step is behavior-identical to today's voice section.
- [ ] Paired tests for the list / pull / defaults-engine paths; e2e updated.
- [ ] Admin follow-up issue filed + `docs/BACKLOG.md` row added.

## Key files

- `src/components/setup/setup-wizard.tsx` (steps, renderStep, summary rows)
- `src/components/setup/step-analysis.tsx` (new), `step-voice.tsx` (new),
  `step-models.tsx` (delete)
- `src/components/setup/step-defaults.tsx` (engine auto-derive)
- Reuse: `src/components/ollama-install.tsx`, `src/components/model-pull-status.tsx`,
  `src/store/account-slice.ts` (`fetchAnalyzerModels`, `saveAccountSettings`),
  `src/lib/api.ts` (`getOllamaHealth`)
- Verify-only: `server/src/routes/setup-readiness.ts`, `setup-diagnosis.ts`

## Ship notes

_(filled at ship time)_
