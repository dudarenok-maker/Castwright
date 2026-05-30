---
status: active
shipped: null
owner: null
---

# 143 — Sidecar process-recycle for the variable-input-shape host-memory leak

> Status: active — code + tests landed; live recycle-cycle validation (ceiling hit → respawn → resume) pending.
> Key files: `server/tts-sidecar/main.py` (memory watchdog)
> URL surface: indirect (sidecar lifecycle); reads `GET /debug/memory`
> OpenAPI ops: none

## Benefit / Rationale

- **User:** a full-book Qwen render survives to completion instead of OOM-killing the box partway. The sidecar recycles itself before it starves the machine; srv-16 means only the single in-flight chapter re-renders.
- **Technical:** bounds a native host-memory leak that `gc`/`empty_cache` cannot reclaim, using the process-recycle pattern the research report calls "the bulletproof" mitigation — made clean by srv-15 (respawn) + srv-16 (skip-completed-on-resume).
- **Architectural:** corrects + supplements plan 141's root-cause scope (which addressed only the design-cycle half).

## Root cause — corrected from plan 141

Plan 141 attributed the 54 GB incident to repeated VoiceDesign load/unload cycles (PyTorch reference cycles + lagging cyclic GC) and shipped `gc.collect()` on unload. That's real but was **not the dominant driver.** A live run on the merged build (2026-05-30) reproduced the climb during **generation with zero designs**, and a controlled experiment settled it:

- **Fixed-shape batches (40× identical batch-16 against `/synthesize-batch`, no contention): the RSS/private FLOOR held flat** (~28–30 GB private, peaks transient).
- **Variable-shape real generation: the floor climbed unbounded** (~+0.3 GB/min, private floor 11.5 → 27 GB over ~30 min, peaks to 41 GB).
- `cuda_allocated` / `cuda_reserved` stayed flat (~1.9 GB) throughout — **it's host memory, not VRAM.**

That signature — *RSS climbs, CUDA flat, only with varying input shapes* — is exactly pytorch/pytorch #32596 ("new MKLDNN/allocator workspace per new input shape, RAM grows monotonically") and the Qwen-leak research report's category #4/#5. Every sentence is a different length, so the generation forward never reuses a shape; `gc.collect()` + `empty_cache()` reclaim ~0 because the retained memory is native per-shape workspace, not Python cycles or the CUDA cache.

A true root-cause *elimination* (force fixed shapes via padding/bucketing, disable MKLDNN, or an upstream `qwen_tts` fix) is uncertain and higher-risk — tracked as backlog `side-11`. This plan ships the **guaranteed** mitigation.

## The fix — RSS hard-ceiling self-restart

`server/tts-sidecar/main.py` memory watchdog now has two thresholds:

- **Soft** (`SIDECAR_RSS_WARN_MB`, default 8192): the existing `gc+empty_cache` reclaim. Kept — it helps the design-cycle leak (plan 141) — but logs that it's largely futile against the variable-shape leak.
- **Hard** (`SIDECAR_RSS_RESTART_MB`, default **55% of total physical RAM** via psutil — ~35 GB on a 64 GB box, ~9 GB on 16 GB; `<=0` disables; `0` if psutil can't read RAM and no override is set): the sidecar self-exits with code 43, and the srv-15 supervisor respawns a fresh process. Checked **before** the soft reclaim (don't waste a tick once at the ceiling). Idempotent via `_rss_restart_scheduled`; a `threading.Timer` flush delay lets the warning land in `tts.err.log` first.

srv-16's skip-completed-on-resume means a recycle only re-renders the single in-flight chapter; the queue carries on. The crash-loop cap in the supervisor doesn't trip because recycles are minutes/hours apart (well past its 30 s "lived long enough" reset).

### Post-ship correction (2026-05-30): keyed on committed-private, not RSS

The original ceiling above was keyed on **RSS**, which is wrong: the OOM-relevant metric is **committed-private** bytes. Live monitoring showed **private ≈ 1.7–1.9× RSS** during generation, so an RSS-37 GB ceiling maps to private ~65–70 GB — *above* the 64 GB box's RAM. Private would hit the ~54 GB crash cliff (≈ RSS 28 GB) **before** an RSS-37 GB ceiling ever fired, so the recycle would never trigger in time. Corrected:

- The recycle now keys on **committed-private** (`_process_commit_mb()` — Windows `pmem.private`, elsewhere `memory_full_info().uss`; falls back to RSS only if unavailable).
- Env knob renamed `SIDECAR_RSS_RESTART_MB` → **`SIDECAR_RESTART_MB`**, default **70% of total physical RAM** (~45 GB on 64 GB — below the observed ~54 GB cliff with margin for the 60 s sampling). The old RSS-keyed env name is gone (its RSS-tuned values would mis-apply as a private ceiling).
- Helpers renamed accordingly: `_should_restart`, `_schedule_restart_exit`, `_restart_now`, `_restart_scheduled`. The soft `SIDECAR_RSS_WARN_MB` reclaim is unchanged (RSS-keyed is fine for that — it's just a gc nudge).

## Architectural impact

- **New seams:** `SIDECAR_RSS_RESTART_MB` env; `_mem_restart_threshold_mb()`, `_should_restart_for_rss()`, `_schedule_rss_restart_exit()` / `_rss_restart_now()` (the last is the test seam); exit code 43.
- **Invariants preserved:** the soft-reclaim + per-tick logging behaviour; `/debug/memory` shape; the watchdog never dies on a transient error. Relies on srv-15 (any-exit respawn) + srv-16 (audio-exists skip) — both already merged.
- **Reversibility:** set `SIDECAR_RSS_RESTART_MB=0` to disable recycling entirely (back to plan-141 behaviour).

## Invariants to preserve

- The hard ceiling is checked BEFORE the soft reclaim in the watchdog loop.
- `_schedule_rss_restart_exit` fires at most once per process (`_rss_restart_scheduled`).
- Default ceiling is 0 (disabled) when psutil is unavailable AND no override — never guess a ceiling that could fire on a healthy small box.
- A recycle must re-render only the in-flight chapter, not completed ones (depends on srv-16; don't regress it).

## Test plan

Automated (`npm run test:sidecar`, `server/tts-sidecar/tests/test_memory.py`):

- `_mem_restart_threshold_mb()` parsing: override, `0`=disabled, garbage→RAM default, unset→55% of total RAM, and disabled-without-psutil.
- `_should_restart_for_rss()` decision (inclusive at threshold; disabled ceiling never fires).
- `_schedule_rss_restart_exit()` idempotency (two over-ceiling ticks → one exit), with `_rss_restart_now` patched so the timer can't kill the suite.

Manual acceptance (pending): run a Qwen book with a deliberately low `SIDECAR_RSS_RESTART_MB`, confirm the sidecar self-exits at the ceiling, the server respawns it within the backoff, and the queue resumes WITHOUT re-rendering completed chapters (only the in-flight one). Then confirm the full book completes without an OOM at the default ceiling.

## Ship notes

_Pending._ Branch `fix/sidecar-rss-recycle` (off main, post-#351). Fill shipped date + SHA on merge; flip → `stable` after the manual recycle-cycle acceptance. Research input: the user-supplied "Qwen3 TTS 0.6B PyTorch Memory Leak" report (independently corroborated the CPU/MKLDNN host-leak diagnosis and recommended process recycling).
