# Dynamic local analyzer models + measured keep-alive — design

- **Status:** draft (final scope after two adversarial passes)
- **Date:** 2026-06-16
- **Author:** brainstormed with the user; hardened against two adversarial
  review rounds + an infra-mapping pass
- **Scope:** frontend + server (analyzer model selection, Model Manager pull,
  keep-alive/eviction policy). **Measured GPU-semaphore weights are explicitly
  deferred** (see "Deferred").

## Problem

**(A) The local analyzer model list is hardcoded in 4+ drifting places**, so a
model pulled into Ollama isn't usable for analysis until code is edited:
`MODEL_OPTIONS` (pickers), `DEFAULT_ALLOWED_MODELS` (pull allowlist),
`PULLABLE_MODELS` (frontend mirror), `RESIDENT_MODELS` (keep-alive). The
Model-Manager inventory (`/api/models/inventory`) is already dynamic; the
pickers lag.

**(B) Residency uses a hardcoded set, not the model's real footprint.**
`RESIDENT_MODELS = {qwen3.5:4b, llama3.1:8b}` gets `keep_alive '5m'`; everything
else `0`. Disk size is a bad proxy: `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` is 9.6 GB
on disk but ~5 GB resident (~6.5 GB with KV) — fits an 8 GB card.

**Goal:** pull a model → it's selectable, no code change; and the keep-alive
decision is driven by **measured** VRAM, learned at runtime, with a safe
fallback to a simple time knob whenever a measurement is missing.

## Approach

1. **Selection: merge-on-top.** Keep curated `MODEL_OPTIONS` (decoration +
   hints + the frontend engine-classifier safety net); **union live
   `/api/tags`** so any pulled tag appears.
2. **Keep-alive: time knob + measured adaptive eviction.** A single
   `ANALYZER_KEEP_ALIVE` knob (default `'1m'`) replaces `RESIDENT_MODELS`.
   On top, an adaptive rule evicts immediately (`'0'`) when a model's
   **measured** footprint can't coexist with the fallback engine — using a
   clean single-process signal and a sampling site that actually runs.

## Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | Gemini list | Curated/static. Only the local list gains discovery. |
| 2 | Local list strategy | **Merge-on-top:** curated ∪ live `/api/tags`. |
| 3 | Install / pull | One canonical server-owned list = pull suggestions + pull-proxy allowlist; frontend fetches it. **Suggestions, not an execution boundary.** |
| 4 | Target model | `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` (Unsloth UD Q4_K_XL; ~5 GB resident). Added to the canonical install list. |
| 5 | Engine classification | **List-independent `:` heuristic** via `engineForModelId()`, replacing all `MODEL_OPTIONS.find(...).engine` sites. Required (safety). |
| 6 | keep-alive base | Single `ANALYZER_KEEP_ALIVE` knob, **default `'1m'`**. `RESIDENT_MODELS` deleted. |
| 7 | Adaptive eviction | `keepAliveFor()` returns `'0'` when the **measured** footprint can't coexist with the fallback engine; else the knob. Gated by `ANALYZER_KEEP_ALIVE_ADAPTIVE` (default on) **and** by having a real measurement + device-total; otherwise knob verbatim. Built with the fixes below. |
| 8 | Measured semaphore weights | **DEFERRED** to a separate gated experiment — see "Deferred". |

## Architecture

### Selection — merge-on-top (problem A)

`/api/tags` (name + size) drives the local list; already fetched by
`probeOllamaHealth()` and `probeOllamaModels()`. **`POST /refresh` re-implements
the probe inline** — refactor it to delegate to `probeOllamaHealth()` (kills the
duplication that bred the drift), then add `pullable: string[]` once.

Frontend (`src/lib/models.ts`):
- `engineForModelId(id)` — `:` heuristic, matches server `inferEngineFromModelId`.
- `buildLocalModelOptions(tags, curated)` — union: curated-matched tags keep
  label/hint; unmatched → `{id, label, hint:size}`.
- `analyzerModelLabel(id, localOptions)`; `buildModelOptionGroups(localOptions)`
  replacing the const.

**Classifier safety fix** (route through `engineForModelId`):
`use-local-analyzer-guard.tsx:78` (GPU-contention guard), `analysing.tsx:293`,
`generation.tsx:323/492`; labels (`analyzerModelLabel`): `account-forms.tsx:16`,
`phase-model-chip.tsx:61`, `phase-model-swap.tsx:70`,
`analyzer-model-override-badge.tsx:19`.

State: `fetchAnalyzerModels` thunk via the **mockable** `api.getOllamaHealth()`
caches `account.localAnalyzerModels` + `account.pullableModels`; re-fetch on
picker open (cheap probe; account isn't cross-tab broadcast) and after
pull/remove. `model-settings-form.tsx`: delete `PULLABLE_MODELS`; source rows
from `account.pullableModels`; reroute `ModelsCardBody`'s raw fetch through the
thunk so it renders under mocks/e2e. Endpoint: add `pullable` to the
`OllamaHealth` type (`api.ts`), `OllamaHealthEnvelope`
(`model-pull-status.tsx`), and `mockGetOllamaHealth` (add `models` +
`pullable`). Ollama routes are out of `openapi.yaml` → no api-types regen.

### keep-alive base (decision 6)

Register `ANALYZER_KEEP_ALIVE` (string, default `'1m'`, `apply: 'live'`,
`risk: 'medium'`) in `registry.ts` `analyzer-models`. Delete `RESIDENT_MODELS`.
This alone is the shippable win even if adaptive eviction is disabled.

### Adaptive eviction, done right (decision 7)

The earlier draft was inert (signal discarded, no poll, fabricated cache,
sidecar-down during analysis). Fixed with four concrete changes:

1. **Real sampling site on the hot path.** After `OllamaAnalyzer.chat()`
   finishes streaming (model is provably resident), do ONE `/api/ps` read and
   record the active model's `size_vram`. No new background poller; it runs on
   every analysis call, exactly the phase that matters.
2. **100%-on-GPU guard.** `size_vram` is only the GPU-resident portion — a
   partially-offloaded model under-counts. Record a sample ONLY when
   `size_vram` ≈ total `size` (model fully on GPU); skip CPU-split samples so a
   spill can't be learned as "small" (which would wrongly keep it resident).
3. **Boot-time device-total, not the sidecar.** Probe total GPU VRAM once at
   server start (`nvidia-smi --query-gpu=memory.total` / torch), cache it in a
   module. Independent of the TTS sidecar, which is typically down during
   analysis. `keepAliveFor()` reads this cache synchronously (it's called
   synchronously while building the request body at `ollama.ts:416`).
4. **Append-only JSONL store** at `<WORKSPACE>/.telemetry/model-vram-stats.jsonl`
   (mirrors `resource-telemetry.ts`'s append-only choice — RMW on a single JSON
   object loses concurrent updates). EMA computed at read time by folding the
   log. Store key canonicalised via the same bare-name⇄`:latest` `norm()` as
   `tagMatches` (`models-inventory.ts:117`), suffixed with the assumed
   `num_ctx` (best-effort — `/api/ps` doesn't report the resident ctx;
   documented as a known skew if a user warmed at a different ctx).

Decision logic:
```
base = resolve('analyzer.keepAlive')                 // '1m'
if !adaptive || deviceTotalMb == null: return base
ema = vramStats.emaFor(canonKey(model, numCtx))
if ema == null: return base                          // cold start → optimistic; learn on this load
fallbackReserveMb = HARDCODED_FALLBACK_RESERVE_MB    // Kokoro ~1 GB; NOT measured (see note)
headroom = deviceTotalMb * KEEPALIVE_HEADROOM        // e.g. 0.92
return (ema + fallbackReserveMb <= headroom) ? base : 0
```
Note: the fallback-engine reserve is **hardcoded** (Kokoro is onnxruntime,
invisible to any torch/Ollama VRAM number — a measured value would read ~0 and
defeat the rule). Only the analyzer's own footprint is measured; that's the one
clean, single-process signal.

## Deferred (separate, gated experiment — NOT this branch)

**Measured GPU-semaphore weights** (feeding `ENGINE_VRAM_COST` from measured
MB) and **TTS per-engine load-delta attribution** are cut. Adversarial review
found them unsound for now: torch `memory_reserved()` is a caching allocator
(delta ≠ model footprint); Kokoro (onnxruntime) is invisible to it; Ollama
`size_vram` (bytes, daemon) and sidecar torch-reserved (MB, sidecar) are
incommensurate; the semaphore clamps over-budget costs silently; and wrong
weights bias toward GPU **overcommit/OOM**, not graceful slowdown — in code the
registry tags "Footguns live here." If pursued later: derive budget AND weights
from the same `GPU_VRAM_TOKEN_MB` unit atomically, never let a measured value
lower the Kokoro/fallback floor, and use a sidecar-side per-engine probe — never
a Node-side reserved-delta.

## Allowlist semantics (reframed)

Canonical list = install suggestions + pull-proxy guard, not an execution
boundary. `selectAnalyzer`/analysis/`/load` already run whatever id they're
handed; dynamic selection just makes that visible. No new allowlist enforcement.

## Testing

- **Server**
  - `pull-bootstrap.test.ts`: `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` accepted;
    off-list rejected; exposed `pullable` == canonical list.
  - `model-vram-stats.test.ts`: EMA-at-read folding; canonical-key (`:latest`)
    matching; unknown key → null; append-only tolerance of corrupt lines.
  - `ollama.test.ts`: **rewrite** keep-alive block — cold start → knob; measured
    fits → knob; measured can't coexist with fallback → `'0'`; adaptive-off or
    device-total-null → knob; the post-stream sampler records only 100%-GPU
    samples (CPU-split skipped); default `'1m'`.
  - device-total boot probe: parses nvidia-smi/torch; absent GPU → null →
    adaptive disabled.
  - `ollama-health.test.ts`: `/health` and `/refresh` both carry `pullable`.
- **Frontend**
  - `models.test.ts`: `engineForModelId`; `buildLocalModelOptions` union;
    `analyzerModelLabel` fallback.
  - `use-local-analyzer-guard` test: guard fires for an **uncurated** local tag.
  - Picker render: curated ∪ live; unreachable still shows curated; dynamic tag
    dispatches right id+engine.
  - `model-settings-form`/`model-manager`: rows from fetched `pullableModels`;
    `ModelsCardBody` renders under mocks.
- **E2E**: mocked tag set → analysing/upload local optgroup reflects it.

## Migration / compatibility

- Shipped default is `gemini-3.1-flash-lite` / engine `gemini`
  (`account-defaults.ts:47,57`); server-env last-resort `local`/`qwen3.5:4b`
  (`registry.ts:643,663`). A saved local default not currently pulled still
  renders (curated). `selectAnalyzer` resolution unchanged.
- `ANALYZER_KEEP_ALIVE` unset → `'1m'`; `ANALYZER_KEEP_ALIVE_ADAPTIVE` on but
  inert until a 100%-GPU sample + boot device-total both exist → until then,
  behaves as a flat `'1m'` knob (safe). The stats file is created lazily.
- No GPU-semaphore change (decision 8 deferred) → arbitration behaves exactly
  as today.

## Docs

- `docs/local-llm.md`: picker reflects pulled tags (curated ∪ live); residency
  is `ANALYZER_KEEP_ALIVE` + adaptive measured eviction (document the sampling
  site, the boot device-total probe, the hardcoded fallback reserve, and the
  num_ctx best-effort key).
- New regression plan under `docs/features/` + a Backlog-item issue. File a
  separate Backlog issue for the deferred measured-semaphore-weights experiment.

## Open questions

None blocking. `KEEPALIVE_HEADROOM` (0.90 vs 0.92) and whether to surface
measured VRAM in the device panel are tuning/UX calls for the plan.
