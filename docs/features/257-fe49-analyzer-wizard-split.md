---
status: active
shipped: null
owner: null
---

# fe-49 — First-run wizard: analyzer/voice split, local-Ollama loop, primary/backup analyzer signal

> Status: active
> Key files: `src/components/setup/step-analysis.tsx`, `src/components/setup/step-voice.tsx`, `src/components/setup/setup-wizard.tsx`, `src/components/setup/step-defaults.tsx`, `server/src/routes/setup-diagnosis.ts`, `server/src/routes/setup-readiness.ts`, `src/lib/api.ts`
> URL surface: `#/setup` (guided + re-entry summary)
> OpenAPI ops: none (the `BlockerDiagnosis`/`SetupReadiness` shapes are hand-written in `src/lib/api.ts` + `server/src/routes/setup-readiness.ts`, NOT generated)

Builds directly on [210 — fs-21 first-run wizard](archive/210-fs21-first-run-wizard.md) and
[240 — Setup checker defense-in-depth diagnosis](archive/240-setup-checker-defense-in-depth.md)
(which introduced the `BlockerDiagnosis` `{status,cause,message,remediation,action?}` shape this
plan extends).

## Benefit / Rationale

- **User:** The first-run wizard no longer dead-ends the local-analyzer path — the new **Analysis** step lists pulled Ollama models and pulls the suggested one in-app (previously "Ollama is installed" and nothing more). Analyzer and voice setup are now two clearly-separated steps (Analysis first, matching the app's flow), and readiness distinguishes **"ready"** (green) from **"ready, no backup"** (yellow, non-blocking) so a single-analyzer setup is honestly flagged without being blocked.
- **Technical:** A `warn` tri-state on `BlockerDiagnosis.status`, emitted only by `diagnoseAnalyzer`, layered over the *unchanged* pass/fail gate. Picking a local model in Defaults now actually routes generation (auto-derives `analysisEngine`).
- **Architectural:** Locks the invariant that green/yellow is a pure additive relabel of the former PASS set — the boot gate is never more lenient than before. Keeps the "one diagnosis engine feeds wizard + status-popover" seam from plan 240 intact.

## Architectural impact

- **New seams:** `step-analysis.tsx` + `step-voice.tsx` (replacing the combined `step-models.tsx`); `anyAnalyzerModelPulled(pulledTags, curated)` pure helper in `setup-diagnosis.ts`; the `warn` variant on the client + server `BlockerDiagnosis.status` unions.
- **Invariants preserved:**
  - The analyzer pass/fail **gate** (`diagnoseAnalyzer`, plan 240) is byte-identical — the three `fail` branches (no-gemini-key / ollama-unreachable / model-not-pulled) keep their exact cause/message/remediation/action. `warn` only splits the former terminal `pass`.
  - The boot gate stays server-owned: `layout.tsx` obeys `readiness.ready`; it does not re-derive.
  - Engine classification stays the single `':'` heuristic (`engineForModelId`, `src/lib/models.ts`).
- **Migration story:** none. No persisted shape changes; `analysisEngine` already existed on `UserSettingsPatch`. The Defaults auto-derive self-heals a stale engine only on the next re-select (accepted for v1).
- **Reversibility:** the feature is UI + a non-blocking readiness label; reverting the six commits restores the combined step and the binary diagnosis with no data cleanup.

## Invariants to preserve

- `BlockerDiagnosis.status` is exactly `'pass' | 'warn' | 'fail'` in BOTH hand-written locations: `src/lib/api.ts` (`export interface BlockerDiagnosis`) and `server/src/routes/setup-readiness.ts` (`export interface BlockerDiagnosis`). They must widen in lockstep — not openapi-generated.
- `buildSetupReadiness` (`setup-readiness.ts`) `ready` = `Object.values(blockers).every(b => b.status === 'pass' || b.status === 'warn')`. `warn` is non-blocking; `fail` blocks.
- `diagnoseAnalyzer` (`setup-diagnosis.ts`): green (`pass`) iff `geminiBackup && localBackup` where `geminiBackup = geminiKeySet` and `localBackup = ollamaReachable && (anyAnalyzerModelPulled || modelPulled)`; otherwise (activeUsable) `warn`. Both backup terms are computed AFTER the fail branches so they can never gate.
- `anyAnalyzerModelPulled` matches a pulled tag against the curated allowlist (`tag === m || tag.startsWith(m+'-') || same-root-with-colon`) and MUST exclude embedding-only installs (e.g. `nomic-embed-text`) — the allowlist (`DEFAULT_ALLOWED_MODELS`) contains no embedding model.
- Wizard step order (`STEPS` in `setup-wizard.tsx`): `environment, ffmpeg, analysis, voice, defaults, lanCert, finish`. Summary board renders the Analyzer row (`stepIndex 2`) before the Voice row (`stepIndex 3`).
- Analysis-step bridge line gates on an analyzer-capable match (`LOCAL_ANALYZER_ROOTS` from `MODEL_OPTIONS` local ∪ `pullableModels` roots), NEVER bare `localAnalyzerModels.length > 0`.

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/setup-diagnosis.test.ts`) — the tri-state matrix (gemini {no-key→fail, key-only→warn, key+local→pass}; local {not-pulled→fail, pulled-no-key→warn, pulled+key→pass}) plus the **regression guards**: gemini+no-key+Ollama-pulled → still `fail`; local+resolved-not-pulled+key → still `fail`; unreachable → `fail`+`ollama-install`; custom-local-primary+key → `pass` (the `|| modelPulled` deviation). Plus `anyAnalyzerModelPulled` unit cases incl. the `nomic-embed-text` exclusion.
- Vitest server (`server/src/routes/setup-readiness.test.ts`) — `ready=true` when the only non-pass blocker is analyzer `warn`; `ready=false` on analyzer `fail`.
- Vitest unit (`src/components/status-popover.test.tsx`) — `warn` renders a non-alarming note, no fix button.
- Vitest unit (`src/components/setup/step-analysis.test.tsx`) — Local-via-Ollama before Online-via-Gemini; `ModelPullStatus` present (dead-end closed); tri-state badge message-only; bridge line on a pulled analyzer model.
- Vitest unit (`src/components/setup/step-voice.test.tsx`) — voice-engine controls render (lift regression).
- Vitest unit (`src/components/setup/setup-wizard.test.tsx`) — 7 steps; "Step N of 7"; Analyzer row before Voice; yellow `warn` summary dot.
- Vitest unit (`src/components/setup/step-defaults.test.tsx`) — `':'` tag → `analysisEngine:'local'`; Gemini id → `'gemini'`.
- Playwright e2e (`e2e/setup-wizard.spec.ts`) — 7-step order/count; Analysis step (step 3) exposes the pull list + Gemini card + bridge line under the mock.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`) unless probing real Ollama.

1. **Cold boot at `#/?setup=notready`** → redirected to `#/setup`, guided wizard, "Step 1 of 7".
2. **Next → Next** → **Analysis** step (step 3): "Local via Ollama" card first (Ollama install + model list with Pull), then "Online via Gemini" card. Badge reflects the resolved engine's readiness.
3. **On a box with a Gemini key but no local model** → analyzer badge/summary reads **yellow** "ready — no backup" (non-blocking; Finish still reachable).
4. **Pull the suggested model (or with a key already set)** → bridge line "✓ Local analyzer available — pick it in the Defaults step to use it"; with both present the badge goes **green**.
5. **Defaults step → pick a `qwen3.5:*` (local) tag** → `analysisEngine` saves `local`; pick a Gemini id → `gemini`.

## Out of scope

- **Admin-screen disentanglement.** `model-settings-form.tsx` / `model-manager.tsx` carry the same voice/analyzer entanglement but are distinct components reusing the leaf controls (not shared control). Mirroring this design there is a follow-up chore issue (filed at ship time), not part of fe-49.
- Runtime analyzer fallback changes — the existing local→gemini fallback is unchanged; no gemini→local fallback is added.

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any behaviour delta vs. the original spec.)
