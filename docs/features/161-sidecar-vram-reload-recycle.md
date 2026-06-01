---
status: active
shipped: null
owner: null
---

# Sidecar VRAM-keyed recycle + non-leaky Qwen reload

> Status: active (code + tests landed; live-GPU acceptance pending → stable)
> Key files: `server/tts-sidecar/main.py` (`QwenEngine.unload`, `_memory_watchdog`, `_cuda_vram_mb` + VRAM thresholds, `/health`, `/debug/memory`), `server/src/tts/spawn-sidecar.ts`, `server/src/routes/sidecar-health.ts`, `server/.env`
> URL surface: indirect — sidecar `GET /health`, `GET /debug/memory`, `POST /recycle`
> OpenAPI ops: none (sidecar-internal)

## Benefit / Rationale

Closes the 2026-06-01 stall: a long Qwen run that used to cap ~6.5 GB VRAM and
run for hours (until the *host*-RAM recycle fired) instead crept past the 8 GB
card and **stalled** — GPU pinned at 100% util but crawling.

- **User:** generation no longer stalls indefinitely on a VRAM blow-up. If
  reserved VRAM creeps toward the card it recycles cleanly at a chapter boundary
  (no dropped chapters); the spill that caused the crawl can't recur silently.
- **Technical:** the leak watchdog now watches **two** pressures — host
  committed RAM (side-11) *and* reserved VRAM — each with soft (clean boundary
  recycle) + hard (self-exit) tiers. A Qwen reload no longer stacks a second
  model copy. `/health` + `/debug/memory` expose VRAM headroom.
- **Architectural:** the VRAM soft signal **reuses the existing
  `recycle_pending` flag**, so the server's chapter-boundary recycle
  ([[158-sidecar-soft-recycle-boundary]]) drives it unchanged — no new server
  signal, no generation.ts change.

## Root cause (confirmed live)

The card is 8188 MiB; steady-state Qwen generation peaks ~6.5 GB. VRAM was never
the binding constraint — until a **reload** doubled it:

1. `QwenEngine.unload()` did **not** take `_synth_lock` (unlike
   `unload_design()`). An `/unload` landing mid-synth nulled `_base` while a
   clone/synth forward was still running on it; the running thread kept the old
   model alive past the null, so `gc.collect()`+`empty_cache()` couldn't reclaim
   its VRAM. The idempotent `/load` then saw `_base is None` and loaded a
   **second** copy. Measured live: across one `/unload`+`/load`, `cuda.allocated`
   went **7.4 → 10.8 GB** and `reserved` 10.5 → 17 GB.
2. Crossing the 8 GB card doesn't OOM on Windows — the NVIDIA **sysmem fallback**
   maps the overflow into host RAM (torch has no `expandable_segments` on
   Windows, logged), so the GPU thrashes over PCIe at 100% util instead of
   erroring. That's the stall.
3. The leak watchdog ([[143-sidecar-process-recycle]] / [[158-sidecar-soft-recycle-boundary]])
   keyed **only on host committed RAM**, which lags the VRAM spill by tens of GB,
   so nothing recycled the process out of the spill.

This is distinct from: the **host** variable-shape leak ([[153-sidecar-variable-shape-host-leak]] / side-11),
the **load-failure** orphan ([[155-qwen-load-failure-reclaim]]), and the
unconditional-Kokoro-prewarm spill ([[146-loud-fallback-gate]]).

## What shipped

**Lever C — non-leaky reload (the root-cause fix).** `unload()` now acquires
`_synth_lock` before nulling the models (mirrors `unload_design`), so an
in-flight forward finishes and drops its reference first → `gc`+`empty_cache`
reclaims → the next `/load` is clean. It logs the reserved-VRAM delta so a
unload that fails to free is visible.

**Lever B — VRAM-keyed recycle.** `_cuda_vram_mb()` returns
(allocated, reserved, total). New thresholds `_vram_recycle_soft_threshold_mb` /
`_vram_restart_threshold_mb` default to 90% / 98% of device total (auto-scale),
overridable via `SIDECAR_VRAM_RECYCLE_SOFT_MB` / `SIDECAR_VRAM_RESTART_MB`. The
watchdog gains two branches (evaluated after both host branches, keyed on
**reserved**, reusing the generic `_should_restart` / `_should_soft_recycle`):
soft → `recycle_pending` (clean boundary recycle), hard → `_schedule_restart_exit`
labelled "reserved VRAM". `/health` adds `vram_reserved_mb` / `vram_total_mb`
(forwarded as `vramReservedMb` / `vramTotalMb`); `/debug/memory` cuda block adds
`total_mb`.

**Lever A — stop the silent spill.** A loud `VRAM SPILL` watchdog warning when
reserved > card (sysmem fallback active). `server/.env` sets a Windows-effective
`PYTORCH_CUDA_ALLOC_CONF=garbage_collection_threshold:0.8,max_split_size_mb:256`
and `SIDECAR_VRAM_*` knobs (soft 7400 / hard 8000 for this 8 GB card). The
sidecar README documents disabling the NVCP "CUDA – Sysmem Fallback Policy" for
`python.exe`. **Corrects [[144-sidecar-cuda-frag-oom]]:** its
`expandable_segments:True` default is a silent no-op on Windows; the spawn-env
default now also carries `max_split_size_mb` + `garbage_collection_threshold`,
which DO apply on Windows.

## Invariants to preserve

- `QwenEngine.unload()` MUST take `_synth_lock` before nulling `_base`/`_design`
  (`main.py` ~1132) — it's the root-cause fix; reverting re-opens the
  reload-doubling. It is non-reentrant: only the `/unload` route (holding no
  lock) may call it.
- The VRAM soft branch sets the SAME `_recycle_pending` flag as the host soft
  branch (`_memory_watchdog`) — do NOT add a parallel server signal; the
  boundary recycle reads `recycle_pending` only.
- Both HARD branches (host then VRAM) are evaluated, each with `continue`,
  BEFORE either soft branch, so a hard ceiling never races the soft signal.
- VRAM branches are guarded on `vram_reserved is not None` so a CUDA-less host
  (or CI) skips them cleanly.
- `PYTORCH_CUDA_ALLOC_CONF` must NOT use `expandable_segments` ALONE as the
  Windows default (unsupported); keep the cross-platform knobs in the string.

## Test plan

Automated (landed):

- `server/tts-sidecar/tests/test_memory.py` — `_vram_*` threshold parsing
  (env / fraction / disabled), watchdog VRAM-soft sets `recycle_pending` below
  hard, watchdog VRAM-hard self-exits labelled "reserved VRAM", no-VRAM-branch
  when CUDA unavailable, `/health` VRAM fields, and `unload()` waits on
  `_synth_lock` (blocks while held, completes on release). 37 pass.
- `server/src/routes/sidecar-health.test.ts` — proxy forwards
  `vramReservedMb` / `vramTotalMb` + null defaults for an older sidecar. 21 pass.
- `server/src/tts/spawn-sidecar.test.ts` — the new cross-platform alloc-conf
  default + explicit override wins. 18 pass.

Manual acceptance (live GPU — pending, requires a sidecar restart):

1. Restart the sidecar; before generating, `curl :9000/debug/memory` → clean
   base `allocated` ≈ 6.5 GB (confirms no per-load size regression; the leaky
   reload was the doubler).
2. Force `/unload`+`/load`; re-measure → `allocated` returns to ~6.5 GB (Lever C).
3. Drive a long generation; watch `/debug/memory` cuda + the watchdog log. With
   NVCP sysmem fallback disabled, an over-card allocation OOMs cleanly (recycle
   catches it) rather than the 100%-util crawl.
4. Lower `SIDECAR_VRAM_RECYCLE_SOFT_MB` and confirm a clean boundary recycle
   fires (VRAM resets) without dropping queued chapters.

## Ship notes

_Pending: shipped date + SHA on merge; flip status → stable after live acceptance._
