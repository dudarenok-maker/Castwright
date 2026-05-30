---
status: active
shipped: null
owner: null
---

# 141 — Sidecar host-memory leak guard (gc-on-unload + RSS watchdog + /debug/memory)

> Status: active — primary fix + instrumentation landed; awaiting an instrumented live-run confirmation of the curve before → stable.
> Key files: `server/tts-sidecar/main.py`, `server/tts-sidecar/requirements.txt`, `server/tts-sidecar/tests/test_memory.py`
> URL surface: `GET /debug/memory` (sidecar :9000), proxied: none yet
> OpenAPI ops: none (sidecar-internal protocol)

## Benefit / Rationale

- **User:** an overnight Qwen render no longer dies because the sidecar quietly ate all system RAM and the OS killed the server. Stability of long runs.
- **Technical:** model-unload paths now release host RAM deterministically instead of waiting on a lagging cyclic GC; a watchdog + on-demand `/debug/memory` make the host-RAM curve observable without a profiler.
- **Architectural:** establishes "dropping a heavy model must `gc.collect()`" as the unload contract, and adds a reusable process-memory readout other engines can lean on.

## The incident (2026-05-30)

A long-lived sidecar (`:9000`, single process across many design + generation operations) grew to **54–60 GB committed-private** host RAM (working set 42 GB, virtual 164 GB), driving the 64 GB box to **5% → 1% free**. Under that pressure the **Node server was killed** — `server.log` stopped cleanly at the last rendered chapter with **no crash trace** in `server.err.log` (killed, not crashed). Generation stalled; an orphaned sidecar kept the GPU at 100% on a batch whose result had nowhere to go.

Decisive measurement: **private/committed bytes = 54 GB** (via `Get-Process … PrivateMemorySize64`). Committed-private is anonymous heap — not shared libraries, not mmap'd weight files — so this was a true leak, not a working-set/mmap artifact.

## Root cause

Static review cleared the obvious suspects: our synth/batch paths return PCM bytes (not retained), `_prompt_cache` is bounded by voice count, and the `qwen_tts` library wraps its generate paths in `@torch.inference_mode()`/`@torch.no_grad()` with a per-call `DynamicCache` (freed when the call returns). So neither our Python nor the library accumulates Python objects.

The leak is the **model-unload path**: models load with `low_cpu_mem_usage=False` (full CPU materialisation — VoiceDesign 1.7B ≈ 3.4 GB host, Base 0.6B ≈ 1.2 GB), and `unload()`/`unload_design()` did `self._model = None` + `torch.cuda.empty_cache()`. But `empty_cache()` frees **VRAM only**, and PyTorch `nn.Module`/`Parameter` graphs hold **reference cycles**, so dropping the last Python reference does **not** refcount-free them — they wait for CPython's *cyclic* collector, which lags badly under the GIL-contended `asyncio.to_thread` synth load. Across a cast-review session of repeated voice designs, the dead VoiceDesign corpses pile up: **54 GB ≈ ~15–16 design cycles × 3.4 GB**.

## The fix

1. **`gc.collect()` in every unload path** before `empty_cache()` — `CoquiEngine.unload`, `QwenEngine.unload`, `QwenEngine.unload_design`. Breaks the dropped graph's cycles so host storage is released immediately. (Order matters: collect host first, then return VRAM blocks.) `unload_design` runs on the first generation after a design session and early-returns when no design is resident, so it does **not** add per-batch GC cost.
2. **Host-memory watchdog** (`_memory_watchdog`, startup task alongside the design idle watchdog): logs process RSS each tick (greppable `sidecar memory:`) and, past `SIDECAR_RSS_WARN_MB` (default 8192), forces a defensive `gc+empty_cache` and warns. It **does not self-exit** — see "Reversibility / known gap".
3. **`GET /debug/memory`**: process RSS/private + Python GC stats + per-engine resident-model & cache footprint + torch CUDA alloc/reserved, for on-demand curve-watching.
4. **`psutil`** pinned explicitly in `requirements.txt` (was transitive via accelerate) since the watchdog/endpoint now depend on it directly.

## Architectural impact

- **New seams:** module helpers `_process_mem()` / `_reclaim_host_and_vram()`; env flag `SIDECAR_RSS_WARN_MB`; the `/debug/memory` route; a second startup/shutdown watchdog pair mirroring the design-idle watchdog.
- **Invariants preserved:** `/health` one-poll contract untouched; synth/batch wire format unchanged; the `_synth_lock` serialisation and the design-idle watchdog are not altered.
- **Reversibility / known gap:** the watchdog reclaims **in-process** and never kills the sidecar, because under `npm start` the Node server spawns the sidecar but does **not** respawn it on exit (`spawn-sidecar.ts` only logs) — a self-exit would just stall the run. Closing that respawn gap is tracked as **`srv-15`**; until then, a hard self-exit is deliberately avoided.

## Invariants to preserve

- Every engine `unload*` path that drops a model MUST `gc.collect()` before `torch.cuda.empty_cache()` (`main.py` — three sites). A new engine added to `ENGINES` inherits this contract.
- `unload_design()` MUST early-return (no GC, no reclaim) when `self._design is None` so the common per-generation call stays free.
- `_process_mem()` / `/debug/memory` MUST degrade to `{}` / a partial dict when psutil or torch is unavailable, never raise.

## Test plan

Automated — `server/tts-sidecar/tests/test_memory.py` (`npm run test:sidecar`):

- `unload_design` / `unload` (Qwen) and `unload` (Coqui) each force a `gc.collect()` and drop their model refs (counting-gc stub).
- `unload_design` is a no-op (no collect) when idle.
- `_reclaim_host_and_vram()` collects (best-effort empty_cache swallowed).
- `_process_mem()` reports a positive RSS with psutil present; returns `{}` when `_PROC` is None.
- `_mem_warn_threshold_mb()` parsing: default 8192, override, garbage→default, `0`→disabled.
- `GET /debug/memory` returns the process/gc/engines/cuda shape; Qwen reads cold (base/design unloaded, cache empty).

Manual confirmation (pending, before → stable): run a real multi-design + multi-chapter Qwen session with `/debug/memory` polled (or watch the `sidecar memory:` log line). Expected: private bytes rise during a design and **drop back** after the first generation's `unload_design` (and after the idle watchdog frees design), instead of ratcheting up monotonically. ffprobe-confirmed audio still byte-correct.

## Ship notes

_Pending._ Branch `fix/sidecar-memory-leak`. Fill shipped date + SHA on merge. Flip → `stable` only after the manual instrumented-run confirms the curve recovers.
