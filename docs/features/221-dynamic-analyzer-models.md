---
status: active
shipped: null
owner: null
---

# 221 — Dynamic analyzer model picker (curated ∪ live Ollama tags)

> Status: active
> Key files: `src/lib/models.ts`, `src/store/account-slice.ts`, `src/components/model-settings-form.tsx`, `src/components/model-pull-status.tsx`, `src/components/analysis-model-picker.tsx`, `src/components/analysing/phase-model-swap.tsx`, `src/views/analysing.tsx`, `src/views/model-manager.tsx`, `src/hooks/use-local-analyzer-guard.tsx`, `server/src/routes/ollama-health.ts`, `server/src/ollama/pull-bootstrap.ts`, `server/src/analyzer/ollama.ts`, `server/src/config/registry.ts`
> URL surface: analyzer-model pickers (upload, re-parse modal, Account → Defaults, analysing retry, setup wizard); Model Manager pull rows
> OpenAPI: none — the `/api/ollama/*` routes are deliberately out of `openapi.yaml` (like the sidecar/qwen routes)

## Benefit / Rationale

- **User:** pull any Ollama model (e.g. `ollama pull gemma-4-E4B-it-GGUF:UD-Q4_K_XL`) and it appears in every analyzer-model picker — no code change, no restart. Previously the selectable set was hardcoded in `MODEL_OPTIONS` and drifted from the pull allowlist.
- **Technical:** the picker is now the **union** of curated `MODEL_OPTIONS` and the live Ollama tag list (from `/api/ollama/health`'s `models`), so neither source has a veto and an Ollama-down box still shows curated options. The single canonical install list (`DEFAULT_ALLOWED_MODELS`) is surfaced to the frontend as `pullable`, replacing the duplicated frontend mirror.
- **Architectural (safety):** engine classification (local vs Gemini) moved from `MODEL_OPTIONS` membership to a list-independent `engineForModelId()` (`:`-heuristic, matching the server's `inferEngineFromModelId`), so a dynamically-pulled (uncurated) local tag is still correctly classified — the GPU-contention guard fires for it.

## Scope note (reconciliation with #840)

This is **Part A** of the original "dynamic analyzer models" work. The measured-VRAM adaptive-eviction half was **deferred to #845** (Wave 4 of plan 222) after two adversarial passes: a flat-reserve eviction reintroduced the 8 GB OOM that plan 222's `withGpuLoad`/`gpu.safeCoexistMb` already fixed, and the measured producer was inert on the headless path. The constraints the #845 follow-up must honor are in `docs/superpowers/specs/2026-06-16-reconcile-dynamic-models-with-gpu-residency-design.md`. Residency/eviction is owned by plan 222 (`withGpuLoad`); this plan does not touch it.

## Architectural impact

- **New seams:**
  - `pullable: string[]` on the `/api/ollama/health` (and `/refresh`) envelope — the curated install list (`DEFAULT_ALLOWED_MODELS` via `pullBootstrap.listAllowed()`). `/refresh` now delegates to `probeOllamaHealth()` (no more duplicated inline probe).
  - `engineForModelId(id)` / `buildLocalModelOptions(tags, curated)` / `buildModelOptionGroups(localOptions)` in `src/lib/models.ts`; `MODEL_OPTION_GROUPS` retained as a back-compat static (curated-only) export.
  - `fetchAnalyzerModels` thunk + `account.localAnalyzerModels` / `account.pullableModels` (populated from `api.getOllamaHealth()`).
  - `ANALYZER_KEEP_ALIVE` env knob (default `'5m'`) — makes the resident-model keep-alive window configurable; replaces the literal `'5m'` in `keepAliveFor`.

- **Invariants preserved:**
  - `keepAliveFor(model, accelerator)` keeps main's `RESIDENT_MODELS` + accelerator logic (9B unloads on CPU). The knob only parameterises the `'5m'` literal; cross-engine eviction stays owned by `withGpuLoad` (plan 222).
  - Cloud-no-probe: the analysing-view retry picker fetches the local tag list only after a failure (`error`-gated), so a healthy cloud run never *auto*-probes Ollama. The per-phase `PhaseModelSwap` picker additionally refreshes the live list **on `onFocus`** (explicit user interaction) — the invariant holds because the probe fires only when the user opens the dropdown, never on the passive healthy-run render.
  - Gemini fallback (`selectAnalyzer`) unchanged: `ANALYZER=local` + Ollama down + key set → silent Gemini fallback.

- **Deleted:** the frontend `PULLABLE_MODELS` mirror (now `account.pullableModels` from the server).

- **Migration:** no state.json / cast.json / openapi shape changes. New optional env knob only.

## Invariants to preserve

1. **Dynamic list = curated ∪ live.** Every analyzer picker MUST render `buildModelOptionGroups(buildLocalModelOptions(account.localAnalyzerModels))` — the union of curated `MODEL_OPTIONS` and live tags. Ollama down → curated still render (no blank picker); `buildLocalModelOptions([])` returns curated-only.
2. **Engine classification by tag shape.** Use `engineForModelId(id)` (`:` ⇒ local) for the GPU-contention guard and readiness gating — never `MODEL_OPTIONS.find(...).engine` (which mis-classifies an uncurated pulled tag as Gemini and silently skips the guard).
3. **Single canonical install list.** `DEFAULT_ALLOWED_MODELS` (server) is the only source of pull suggestions; it is both the Model Manager's Pull rows (via `pullable`) and the pull-proxy allowlist (`isAllowed`). It is suggestions + a pull guard, NOT an execution boundary (anything actually pulled is runnable).
4. **`/health` and `/refresh` stay identical.** `/refresh` delegates to `probeOllamaHealth()`; both carry `pullable`.
5. **Analysing-view picker refreshes on open.** `PhaseModelSwap` dispatches `fetchAnalyzerModels` on `onFocus`, so a just-pulled local tag becomes selectable on a healthy run without a reload — without auto-probing on the passive render (preserves invariant in §"Cloud-no-probe").
6. **`ModelPullStatus` rows = `health.pullable` ∪ installed tags.** The "Analyzer models" pull list derives its curated rows from the live health envelope's `pullable` (falling back to the redux `pullableModels` prop), so **"Refresh available models" is self-healing** — a refresh response repopulates an empty list (the redux prop alone could get stuck empty after a transient fetch failure). Installed-but-uncurated tags (e.g. a custom local `gemma4-e4b-8gb:latest`) are unioned in as read-only "Installed" on-disk rows, so the list is a complete picture of what the analyzer can run.
7. **Model Manager groups by kind.** Inventory rows render under explicit subheadings — TTS under *Standard* / *Optional add-ons*, analyzer (Ollama) under *Analyzer models (Ollama)*, ASR under *Speech recognition (ASR)* — so local analyzer models are never visually lumped under the TTS "Optional add-ons".
8. **Curated Gemma entry.** `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` is a curated `MODEL_OPTIONS` local entry (friendly label "Gemma 4 E4B (local)"), matching its long-standing membership in the server pull allowlist.

## Test plan

### Automated coverage
- `server/src/ollama/pull-bootstrap.test.ts` — `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` allowlisted; `listAllowed()` returns it; off-list tag rejected.
- `server/src/routes/ollama-health.test.ts` — `/health` and `/refresh` both carry `pullable` including the e4b tag.
- `server/src/config/registry.test.ts` — `ANALYZER_KEEP_ALIVE` registered, default `'5m'`, `apply: 'live'`.
- `server/src/analyzer/ollama.test.ts` (main's) — `keepAliveFor` returns `'5m'` for resident models (the knob default), `0` for non-resident / 9B-on-CPU.
- `src/lib/models.test.ts` — `engineForModelId`; `buildLocalModelOptions` union (curated kept, uncurated appended, dedup, offline=curated); `buildModelOptionGroups`; back-compat `MODEL_OPTION_GROUPS`.
- `src/store/account-slice.test.ts` — `fetchAnalyzerModels` populates `localAnalyzerModels` + `pullableModels`; unreachable → empty local, pullable still set.
- `src/hooks/use-local-analyzer-guard.test.tsx` — the guard fires for an uncurated local tag.
- `src/views/model-manager.test.tsx`, `src/components/analysing/phase-model-swap.test.tsx` — pull rows + picker render the dynamic union (incl. an uncurated tag in the Local optgroup); `phase-model-swap` also asserts the on-`focus` `fetchAnalyzerModels` refresh; `model-manager` asserts analyzer/ASR rows render under their own subheadings (not under Optional add-ons).
- `src/components/model-pull-status.test.tsx` — curated ∪ installed union (uncurated tag → read-only "Installed" row); curated rows drive off `health.pullable` even when the redux prop is empty (self-healing); "Refresh available models" recovers an empty list from the refresh response's `pullable`.
- `e2e/model-manager-models.spec.ts` — the e4b tag is offered in the pull list.

### Manual acceptance walkthrough
Run with `npm start` (or `cd server && npm run dev`) against a real Ollama daemon.

1. **Pull an uncurated model → it appears in the picker.** `ollama pull gemma-4-E4B-it-GGUF:UD-Q4_K_XL`. Open any analyzer-model picker (upload, Account → Defaults, re-parse). The tag appears alongside curated entries. With the Model Manager card open, completing the pull refreshes the list without a reload (post-pull `fetchAnalyzerModels`).
2. **Stop Ollama → curated options still render** (no blank picker); the health pill shows unreachable.
3. **Uncurated local tag is guarded.** With a generation streaming, trigger a local analysis using the pulled e4b tag → the GPU-contention confirm dialog appears (proves `engineForModelId` classifies it local).
4. **Keep-alive knob.** `ANALYZER_KEEP_ALIVE=0` → resident models unload immediately after each call; unset → `'5m'`. Cross-engine eviction before a TTS load is plan 222's `withGpuLoad` (unchanged).
5. **Gemini-fallback caveat.** `ANALYZER=local` + Ollama down + `GEMINI_API_KEY` set → analysis completes via Gemini even though the picker showed local options (pre-existing `selectAnalyzer` behavior; see the new Help topic `picked-local-but-ran-on-gemini`).

## Out of scope

- **Measured-VRAM adaptive eviction (#845, Wave 4 of plan 222)** — sampling real `size_vram` to drive `shouldEvictBeforeSidecarLoad` with a per-(engine,mode) cost table. Deferred; constraints in the reconciliation spec.
- **Measured GPU-semaphore weights** — backlog `srv-XX` (torch caching allocator / onnxruntime invisibility / OOM-bias).

## Ship notes

(Filled in when status flips to `stable`.)
