---
status: stable
shipped: null
owner: dudarenok-maker
---

# Per-phase analyzer split — wiring fix + chip honesty

> Status: stable
> Key files: `server/src/routes/analysis.ts` (main + subset routes, `runMainAnalyzerJob`, `runSubsetAnalyzerJob`, `createWatermarkForJob`), `src/views/analysing.tsx` (request-model gating), `src/store/account-slice.ts` (`selectAnalyzerSplitIsActive` + nullable phase selectors), `src/components/analysing/phase-model-chip.tsx`, `src/components/analysing/phase-card.tsx`, `src/views/account.tsx` (discoverability)
> URL surface: indirect — `#/books/<id>/analysing`, `#/account`; SSE from `POST /api/manuscripts/:id/analysis`
> OpenAPI ops: none — driven by user-settings + the per-request `model` field

## Context / why

Follow-up to [plan 88](archive/88-analyzer-per-phase-model.md). The pipelining *mechanics* (concurrent Phase 0 + Phase 1 pools, watermark back-pressure) shipped and work — but the per-phase **model selection** was never actually reachable, and the analysing-view chips lied about which model was running:

- The main route resolved Phase 0 via `selectAnalyzer({ model: requestedModel })` — it **never called `selectAnalyzerForPhase({ phase: 'phase0' })`**, so the saved `analyzerPhase0Model` was ignored for the actual cast-detection model.
- Phase 1 reused the per-request model whenever one was present (`opts.requestedModel ? selection : …`).
- The frontend **always** sent a per-request `model` (`ui.selectedModel`, seeded from `defaultAnalysisModel`, never empty), which sits at precedence priority 2 and shadowed the per-phase user-settings (priority 3) for both phases.

Net: turning on the Account per-phase pickers flipped the watermark to *pipelined* (you got concurrency) but **both phases still ran the single default model**. Meanwhile the Phase 0 chip showed a fabricated hardcoded default ("Gemma 4 31B") while cast detection really ran on the single default model (Gemini 3.1 Flash Lite — confirmed by the user's AI Studio dashboard showing zero Gemma traffic), and the Phase 1 chip showed "warms up after ch. 10" even with the split off (no handoff ever happens then).

This plan makes the opt-in split actually function and makes the UI honest. The split stays **OFF by default**; single-model behaviour is unchanged.

## Benefit / Rationale

- **User:** the two-model split now does what the Account card advertises — set Phase 0 = Gemma 4 31B (1,500/day bucket) + Phase 1 = Gemini 3.1 Flash Lite (500/day bucket) and cast detection genuinely runs on Gemma while attribution runs on Flash Lite ~10 chapters behind, spreading load across two free-tier buckets. The chips now name the model that's actually running, and "warms up after ch. N" only appears when a split is engaged.
- **Technical:** one coherent precedence chain for both phases (env > per-request `model` > saved per-phase model > default). The frontend only sends `model` when it should, so the per-phase settings are reachable without a server-side default-resolver change (avoids the `GEMINI_MODEL`-vs-`defaultAnalysisModel` precedence question).
- **Architectural:** removes a stale "still runs serially" comment fossil; both routes resolve per-phase analyzers uniformly through `selectAnalyzerForPhase`.

## What changed

### Server (`server/src/routes/analysis.ts`)
- Main handler resolves Phase 0 via `selectAnalyzerForPhase({ phase: 'phase0', model: requestedModel, userSettings })` (was `selectAnalyzer`). Reads a read-once `userSettings` snapshot and threads it into `MainAnalyzerJobOpts` (optional field; falls back to `getCachedUserSettings()`), `createWatermarkForJob(userSettings)`, `isPerPhaseModelSelectionActive(userSettings)`, and `resolvePhase1MinLagChapters(userSettings)`.
- `runMainAnalyzerJob` resolves Phase 1 uniformly: `selectAnalyzerForPhase({ phase: 'phase1', model: opts.requestedModel, userSettings })` (dropped the `requestedModel ? selection : …` shortcut). When a per-request model is present, priority 2 collapses both phases to it; env still trumps (ops triage).
- Subset re-analyze route resolves both a Phase 0 (cast) and Phase 1 (attribution) selection the same way; attribution log/throttle use the Phase 1 label/model. The subset path stays **sequential** (no watermark) — the split only changes which model each pass uses.
- Replaced the stale "current route still runs serially … seam for a follow-up" comment with an accurate description.

### Frontend
- `src/views/analysing.tsx`: send `model` only when it should reach the server — `requestModel = splitActive && !selectedModelExplicit ? undefined : model`, applied to both `api.analyseManuscript` and `api.runAnalysisForChapters`. The `isLocalAnalyzer`/engine derivation keeps reading the always-populated `ui.selectedModel` (sending `undefined` must not flip the readiness gate to local).
- `src/store/account-slice.ts`: `selectAnalyzerSplitIsActive` (user-settings mirror of the server's signal); `selectAnalyzerPhase{0,1}Model` now return the raw nullable value (dropped the fabricated `PHASE0_MODEL_DEFAULT`/`PHASE1_MODEL_DEFAULT`); `PHASE1_MIN_LAG_DEFAULT` kept.
- `src/components/analysing/phase-model-chip.tsx`: shows the truly-effective model — split OFF → `ui.selectedModel || defaultAnalysisModel`; split ON → the per-phase value, or an honest "Server default" when blank. Warm-up span gated on `splitActive`.
- `src/components/analysing/phase-card.tsx`: `'warming'` chip state only when `splitActive`.
- `src/views/account.tsx`: retitled card to "Two-model analyzer split (advanced)", plain-language hint, live "Currently OFF/ON" status line (`data-testid="analyzer-split-status"`).

## Invariants to preserve

- **Single-model behaviour unchanged.** No per-phase models + no explicit per-run pick → frontend sends `defaultAnalysisModel`; both phases resolve to it (priority 2); sequential watermark. Locked by `analysing.test.tsx` ("sends the selected model when the split is OFF") + `analysis-pipelining.test.ts` regression cases.
- **Env is the ops trump.** `ANALYZER_PHASE{0,1}_MODEL` beats the per-request model (priority 1) — unchanged in `selectAnalyzerForPhase`.
- **Subset route is sequential** — do not add the watermark there.

## Test plan

### Automated coverage
- Vitest (`src/components/analysing/phase-model-chip.test.tsx`) — split OFF → both chips show `ui.selectedModel`, not a fabricated default; split ON → per-phase model or "Server default"; warm-up hint only when split active.
- Vitest (`src/store/account-slice.test.ts`) — `selectAnalyzerSplitIsActive`; nullable phase selectors; min-lag default 10.
- Vitest (`src/views/analysing.test.tsx`) — request-model gating: sends model when split OFF; omits when split ON + not explicit; sends when explicit per-run pick.
- Vitest server (`server/src/routes/analysis-pipelining.test.ts`) — Phase 1 resolves via `selectAnalyzerForPhase` even with a per-request model set (no shortcut back onto the Phase 0 selection). Existing 5 pipelining cases still green.
- Vitest server (`server/src/analyzer/select-analyzer.test.ts`) — pre-existing precedence coverage (phase 0 honours `analyzerPhase0Model`; per-request beats user-settings; env beats per-request) — the contract the routes now rely on.
- Playwright e2e (`e2e/analysing-multi-model.spec.ts`) — single-model: both chips name the same model, Phase 1 shows no warm-up hint. (`e2e/account-analyzer-knobs.spec.ts`) — status line reads OFF at sentinel, flips to ON naming both models + lag.

### Manual acceptance walkthrough (mock + real)
1. **Single-model (default config):** start analysis → both chips show your `defaultAnalysisModel`, no warm-up hint, Phase 1 starts only after Phase 0 completes; server log shows that model for both phases. No regression.
2. **Split ON** (Account → Phase 0 = Gemma 4 31B, Phase 1 = Gemini 3.1 Flash Lite, lag 10): chip 0 = Gemma, chip 1 = Gemini + "warms up after ch. 10"; server logs `pipelined phase0=… phase1=… lag=10`; Phase 1 ch. 0 dispatches once Phase 0 reaches ch. 10; both AI-Studio buckets show traffic.
3. **Explicit per-run pick:** both phases use the picked model; no pipelining.

## Out of scope
- A server `getResolvedAnalysisModel()` so a split-ON-but-one-phase-blank config falls back to `defaultAnalysisModel` instead of `GEMINI_MODEL` — deferred; the "Server default" chip label is honest in the meantime. Reopens the env-precedence question, so left for a follow-up.

## Ship notes
(Filled on merge: shipped date + commit SHA.)
