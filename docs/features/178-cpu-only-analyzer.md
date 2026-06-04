---
status: deferred
shipped: null
owner: null
---

# 178 — CPU-only analyzer device (large RAM-resident model, concurrent with GPU TTS)

> Status: deferred — design only, backlogged as `srv-30` ([#507](https://github.com/dudarenok-maker/AudioBook-Generator/issues/507)). No code yet.
> Key files: `server/src/analyzer/ollama.ts`, new `server/src/analyzer/model-device.ts`, `server/src/routes/ollama-health.ts`, `src/lib/models.ts`
> URL surface: none (analyzer engine + model-picker label)
> OpenAPI ops: none

## Benefit / Rationale

- **User:** run a much stronger local analyzer (12B-class, e.g. **Gemma 4 12B**) for better fiction attribution, while the 8 GB GPU stays **fully dedicated to TTS** — analysis and generation run at full speed concurrently.
- **Technical:** removes the analyzer↔TTS VRAM contention. Today the Ollama analyzer takes the whole `GPU_VRAM_BUDGET` (cost 4) and serialises against all TTS; a CPU model takes **zero** GPU budget.
- **Architectural:** a clean "smart-but-slow analysis on CPU / fast TTS on GPU" split that lifts the local analyzer model-size ceiling (no longer bounded by what fits VRAM *alongside* TTS).

## Context — why this exists

Evaluation (2026-06-04): **Gemma 4 12B** won't fit the 8 GB GPU (≈7–8 GB @ 4-bit + KV → spills to CPU/sysmem → single-digit tok/s, worse on Windows via the NVIDIA sysmem fallback). But Google ships it for "consumer laptops with 16 GB **RAM**", so the right deployment is **CPU-only**: load it into system RAM, never touch the GPU. The trade is slower analysis (CPU prefill + ~5–10 tok/s → ~minutes/chapter), acceptable as a GPU-free background step. (For online use the free Gemini API already serves an even larger Gemma — this is the **offline/local + GPU-dedicated-to-TTS** niche.)

## Design — per-model device

**Core:** a per-model `device` (`cpu` | `gpu`), NOT a global toggle, so Phase 0 can run a small GPU model (`qwen3.5:4b`) while Phase 1 runs the big CPU model concurrently without contention. Each phase already builds its own `OllamaAnalyzer` (`select-analyzer.ts`), so independent devices fall out for free.

1. **Device resolution (server-authoritative).** New `server/src/analyzer/model-device.ts` → `resolveAnalyzerDevice(model): 'cpu'|'gpu'`. Order: `ANALYZER_CPU_MODELS` env (comma list, ops trump card) → static `CPU_MODEL_TAGS` set (lockstep with the `device:'cpu'` rows, same discipline as `RESIDENT_MODELS`) → default `gpu`. A cosmetic `device?:'cpu'|'gpu'` on `ModelOption` (`src/lib/models.ts`) drives the picker label only — **the server never trusts frontend code** (a model can arrive via `ANALYZER_PHASE*_MODEL` env or a raw per-request override not in the allowlist). Resolve once in the `OllamaAnalyzer` constructor.

2. **The load-bearing branch (`ollama.ts` `chat()`).** For `device==='cpu'`: `body.options.num_gpu = 0` (override the `ANALYZER_NUM_GPU=999` default) **and skip the GPU semaphore** — `releaseGpu = device==='cpu' ? NOOP_RELEASE : await gpuSemaphore.acquire(costForEngine('analyzer'))`. The existing `finally { releaseGpu() }` calls the no-op on the CPU path (zero teardown special-casing). A CPU analyzer never enters the FIFO → cannot block or be blocked by a TTS acquire. `engine-vram-cost.ts` (`analyzer:4`) unchanged for the GPU path.

3. **keep_alive.** `keepAliveFor(model, device)`: CPU → `ANALYZER_CPU_KEEP_ALIVE` (default `30m` — RAM is abundant, an 8 GB GGUF disk reload is the dominant cost); GPU → existing `RESIDENT_MODELS ? '5m' : 0`. CPU models are deliberately NOT added to `RESIDENT_MODELS` (that set is about the VRAM budget).

4. **CPU knobs** (env / defaults): `ANALYZER_CPU_NUM_CTX=8192` (16K CPU prefill is too slow; 8K still covers a chapter + inlined schema); `ANALYZER_CPU_NUM_THREAD` (unset→Ollama auto; cap to leave cores for the concurrent ffmpeg encode, ~6 on an 8-core box); `ANALYZER_CPU_KEEP_ALIVE=30m`; `ANALYZER_CPU_MODELS` (unset); `ANALYZER_CPU_MIN_FREE_RAM_MB=10240`.

5. **Gemma 4 12B entry** (`src/lib/models.ts`, local group, `device:'cpu'`, labelled "CPU/RAM — frees the GPU; large + slow; ~7–8 GB download"). **Gate behind `ANALYZER_CPU_MODELS` env until validated** — Gemma 4 is brand-new: confirm the real Ollama tag, that `ollama pull` + `num_gpu:0` run + a schema-constrained `/api/chat` all work, before adding the picker row (so a broken pull can't strand a user mid-job).

6. **Concurrency correctness (CONFIRMED).** The GPU semaphore (cost 4 = full budget) is the ONLY analyzer↔TTS contention point (acquire sites: `ollama.ts` + `tts/sidecar.ts`). Skipping it for CPU truly enables parallelism. CPU-thread vs ffmpeg contention is OS-scheduler-level → `ANALYZER_CPU_NUM_THREAD` mitigates.

7. **REQUIRED wiring — Load/Unload + auto-evict device-awareness** (`server/src/routes/ollama-health.ts`). `/api/ollama/load` warms with `(num_ctx, num_gpu)`, which is Ollama's load cache key — it MUST match the device (num_gpu:0 + CPU num_ctx) or the first chat call triggers a silent mid-stream reload. **And the Generate-screen TTS-load auto-evict must SKIP CPU-resolved models** — else loading TTS needlessly unloads the ~8 GB RAM model (8 GB disk reload). Required for the concurrency story to hold, not polish.

8. **RAM-pressure guard (light) + FallbackAnalyzer.** One-time `console.warn` when a CPU analyzer is selected with `os.freemem()` below `ANALYZER_CPU_MIN_FREE_RAM_MB` (the sidecar's host-RAM history reached ~48–54 GB; resident 8 GB CPU model + sidecar can approach host limits on a 32 GB box). Do NOT throw. Optional `freeHostMb` in `resource-telemetry.ts`. No Ollama-process recycler this pass. **FallbackAnalyzer unaffected** — device logic never touches error classification; a CPU-model `LocalUnreachableError` → Gemini fallback exactly as today.

## Architectural impact

- **New seams:** `model-device.ts` (`resolveAnalyzerDevice`, `CPU_MODEL_TAGS`), `device` on `ModelOption`, five `ANALYZER_CPU_*` env vars.
- **Invariants preserved:** structured-output contract unchanged (Ollama `format` JSON schema); Phase0/Phase1 selection unchanged; GPU path byte-identical (num_thread key omitted, cost 4 kept); FallbackAnalyzer trigger unchanged.
- **Behaviour change to document:** a CPU-device analyzer does NOT participate in the GPU semaphore or the XTTS auto-evict dance.
- **Reversibility:** default `gpu` for every existing model → no behaviour change until a model is marked/env-forced CPU.

## Phased breakdown

- **A** device-resolution core (`model-device.ts` + tests; `device` on `ModelOption`; ctor stores device, still GPU defaults — ships dark).
- **B** the load-bearing branch (num_gpu:0 + num_ctx + num_thread + semaphore-skip + keep_alive device branch) — the concurrency win.
- **C** Load/Unload + auto-evict device-awareness (`ollama-health.ts`) — required.
- **D** Gemma 4 12B entry (env-gated → picker once pull + constrained-decode validated).
- **E** RAM-pressure warn + optional telemetry field + docs (`docs/local-llm.md`, `CLAUDE.md` analyzer section, `server/.env.example`).

## Test plan

Unit (server, fetch mocked): device resolution (env > static > default; case-insensitive/trimmed; garbage env ignored); `num_gpu===0`/`num_ctx===CPU_CTX` on CPU vs `999`/`16384` on GPU; `num_thread` present iff capped; `keepAliveFor` per device; **semaphore SKIP** (spy `gpuSemaphore.acquire` — not called for CPU, called cost-4 for GPU); **headline concurrency test** (hold all 4 GPU tokens, then a CPU analyzer call resolves without waiting, and a concurrent `acquire(coqui=3)` grants immediately while it runs); FallbackAnalyzer still fires on CPU-model `LocalUnreachableError`; `/load` device-awareness. Manual/gated: Gemma 4 pull+run+constrained-decode validation; `ollama ps` shows the CPU model at 100% CPU / 0% GPU while a TTS render runs on GPU, both progressing concurrently; TTS load does NOT unload the CPU analyzer.

## Risks

CPU prefill latency (Phase 1 can dominate a novel's wall-clock — mitigated by GPU TTS overlapping + `ANALYZER_CPU_NUM_CTX`); Gemma 4 newness (gate behind validation; real Ollama tag unconfirmed); RAM pressure on 32 GB boxes (warn + shorter keep_alive; prefer 64 GB); Windows thread-vs-ffmpeg oversubscription (`ANALYZER_CPU_NUM_THREAD`); **auto-evict regression if Phase C is skipped** (required, not optional).

## Ship notes

_Deferred — not yet scheduled. Backlog `srv-30` (#507)._
