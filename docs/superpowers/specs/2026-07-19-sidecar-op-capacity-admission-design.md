---
title: Op capacity admission — wrap /load, design_voice, /transcribe, /embed (sidecar + Node)
date: 2026-07-19
status: approved
issue: 1720
parent_spec: docs/superpowers/specs/2026-07-18-vram-aware-gpu-placement-design.md
parent_plan: docs/superpowers/plans/2026-07-18-vram-aware-gpu-placement.md
regression_plan: docs/features/264-vram-aware-gpu-placement.md
refs:
  - 845
---

# Op capacity admission (#1720)

## Problem

The capacity-aware admission shipped in PR #1719 wraps **only** `/synthesize`
(sidecar `PlacementController.reservation()`) and its Node retry orchestration
(`SidecarTtsProvider.postWithCapacityRetry`). The four other heavy GPU ops — a
cold model `/load`, `design_voice` (VoiceDesign 1.7B), ASR `/transcribe`, and
speaker (ECAPA) `/embed` — go through **neither**. While
`SEG_CAPACITY_ADMISSION` is OFF that is safe (sequential workflow + `poolWidth=1`
+ the capacity-based `withGpuLoad` load-path evict). But it is the main blocker
to flipping the flag ON, on **two** sides:

1. **Sidecar:** those four ops don't reserve, so they can double-book the VRAM a
   synth reservation is protecting, or OOM instead of refusing.
2. **Node (found in adversarial review):** even once the sidecar refuses with a
   `noCapacity` 503, only `/synthesize` + `/synthesize-batch` route through
   `postWithCapacityRetry` (`server/src/tts/sidecar.ts:184,252` — the function's
   only callers). The four ops are called from unrelated modules with plain
   `fetch` (`routes/qwen-voice.ts` `postDesignAndCache`, `gpu/gpu-load.ts`,
   `tts/transcribe-client.ts`, `tts/embed-client.ts`), so a `noCapacity` 503
   would become a **hard failure** where flag-OFF today evicts and proceeds.

This spec closes **both** sides so the flag is genuinely flippable (gated on the
on-box acceptance still owed in regression plan 264).

## Goal

- **Sidecar:** route all four ops through `PlacementController.reservation()`,
  with **full multi-GPU load steering** — a cold load physically lands on the
  admitted best-fit card; when no card fits, refuse with a `noCapacity` 503.
- **Node:** every one of the four callers handles that 503 with the same
  evict-Ollama-or-bounded-poll orchestration `/synthesize` already uses, so
  flag-ON is non-regressive (a design/embed/transcribe/load waits or evicts and
  proceeds instead of failing).

Non-goals (separate follow-ups): per-device idle-evict +
`reset_peak_memory_stats` (**#1721**); dead-code deletion (**#1722**); flipping
`SEG_CAPACITY_ADMISSION` default ON (waits on on-box 1-/2-card acceptance).

## Part A — Sidecar admission

### Inherited core (unchanged)

`PlacementController.reservation()`, `FootprintTable`, `ReservationLedger` reused
verbatim. Footprints are already seeded for every op (`coqui:3584`,
`kokoro:1200`, `qwen:6144`, `qwen.1.7b:7168`, `asr:400`, `spk:200`) — no
footprint work. Reservation semantics fit a load: `reservation()` holds the peak
on the winning device for the op's duration then releases in its `finally`
**after** the load completes (`main.py` ~2168–2179), so the now-resident model is
already reflected in the next `probe_capacity()` free-VRAM read — the
reserved→resident handoff overlaps (briefly double-counts, conservative) and
never gaps.

### A1. Device-plumbing contract

Additive and back-compatible. Two mechanisms because the engines differ:

- **Param plumbing** (device passed in): `CoquiEngine._ensure_loaded(model,
  device=None)`, `KokoroEngine._ensure_loaded(model, device=None)`,
  `QwenEngine._ensure_base_loaded(device=None)` / `_ensure_base17_loaded(device=None)`,
  `QwenEngine.design_voice(..., device=None)` (routes its internal
  `_ensure_design_loaded` + `_ensure_base_loaded` to the same device).
- **Attr-set plumbing** (no param today): `WhisperEngine` reads `self._device`
  (set from `ASR_DEVICE` at `__init__`, `main.py:4290,4301`) and
  `SpeakerEmbedder` reads `self.device` (`4428,4439`). Here the handler sets the
  instance attr to the admitted device **under the engine's load lock** before
  the load, then restores/leaves it. (These are single-instance engines; a
  resident engine is pinned to its own card, so the attr is set once on the cold
  load and stable thereafter.)

`device=None` / no-override preserves today's env/enumeration resolution
byte-for-byte. Accepted device forms: `cuda:N`, `rocm:N`, `cpu` (what
`_device_key` emits).

### A2. Operator pins are a hard constraint

A concrete device env (`COQUI_DEVICE=cuda:1`, `QWEN_DEVICE=cuda:0`,
`ASR_DEVICE=cuda`, …) must never be steered elsewhere; `auto`/unset means
"capacity decides." Mechanism: add an optional **`pinned: Optional[str] = None`**
arg to `PlacementController.admit()` / `.reservation()`. When set it filters the
GPU candidate set to that one device, exactly as a resident engine is already
filtered in `_gpu_candidates()`. Effective constraint per call site:
`resident_device if resident else env_pin` (else all GPUs → best-fit, plumbed
back via A1). Helper `_engine_env_pin(engine_id) -> Optional[str]` reads the
engine's device env through the existing `_read_device_env` + `_parse_device`,
returning a concrete key or `None`.

### A3. Per-op wiring

Each handler mirrors `/synthesize`: enter `reservation()` (admits + holds, or
`noCapacity`) → on `noCapacity` return a 503 `{noCapacity, neededMb, deviceKey}`
→ else take the per-engine load lock → `to_thread(load, ..., device=adm["device"])`.

| Handler | engine_id / model key | Profile | Plumb |
|---|---|---|---|
| `/load` coqui | `coqui` | heavy, GPU-only | param |
| `/load` qwen 0.6b | `qwen` (→ `qwen`) | heavy, GPU-only | param |
| `/load` qwen 1.7b | `qwen`+`"1.7b"` (→ `qwen.1.7b`) | heavy, GPU-only | param |
| `/qwen/design-voice` | `qwen`+`"1.7b"` (→ `qwen.1.7b`) | heavy, GPU-only | param |
| `/load` kokoro | `kokoro` | cpu-capable | param |
| `/transcribe` | `asr` | cpu-capable | attr-set |
| `/embed` | `spk` | cpu-capable | attr-set |

`_ENGINE_CAPACITY_PROFILE` has no `asr`/`spk` entries (`main.py:2189`); those two
handlers pass explicit `cpu_capable`/`heavy` literals.

### A4. cpu-capable wrap rule

- **asr / spk:** their resolved device is env-known at `__init__`. Wrap in
  `reservation()` **only when that device is a GPU** (`ASR_DEVICE=cuda` /
  `SPK_DEVICE=cuda`); the documented cpu default (zero VRAM) runs **directly,
  unwrapped** — unchanged behaviour, no pointless `spk:200` reservation and no
  incoherent "fall back to cpu but model is on cuda" edge.
- **kokoro:** `KOKORO_DEVICE=auto` only resolves to cpu/cuda *during* load, so
  its target isn't known pre-admission. Kokoro genuinely runs on cpu, so it is
  **always wrapped with `cpu_capable=True`** — admission returns `cpu` when no
  GPU fits (a coherent cpu fallback for kokoro), else a GPU device. Idempotent
  `ready` short-circuits first, so a warm kokoro `/load` never reserves.

### A5. Lock ordering (preserved from parent spec)

Idle-evict reachable from admission takes the **threading** load locks
(`_base_load_lock`/`_base17_load_lock`) + engine unload paths, never the asyncio
`_load_lock`; the ledger lock releases before any forward/load. Coqui/Kokoro keep
their asyncio `_load_lock` (not idle-evict targets). Handlers enter the sync
`reservation()` with a plain `with` in the async handler as `/synthesize` does.
Note: on a `design_voice` admit, `idle_evict` may evict a warm VoiceDesign the
incoming design then re-loads — wasteful, not incorrect (`design_voice`
re-ensures under `_synth_lock`).

## Part B — Node noCapacity handling

### B1. Extract a reusable `withCapacityRetry`

`postWithCapacityRetry` is a `SidecarTtsProvider` method bound to instance deps,
but every dep already defaults to a module singleton (`capacityProbe`,
`evictOllama`, `analyzerEvictWouldHelp`,
`isAnalysisInFlight = getAnalyzerConcurrencyStats().inFlight > 0`,
`GPU_CAPACITY_POLL_MS`, `GPU_CAPACITY_MAX_ATTEMPTS`). Extract a **free function**
`withCapacityRetry(doPost, opts)` (new `server/src/gpu/capacity-retry.ts`), where
`doPost: (signal?) => Promise<Response>` performs the actual POST and `opts`
carries the deps (all defaulting to the singletons) plus `engine` label,
`neededMb`/`deviceKey` parsing via the existing `parseNoCapacity`, and the
`_capacityWaiters` telemetry counter (moved into the shared module).
`SidecarTtsProvider.postWithCapacityRetry` becomes a thin wrapper preserving its
injectable test doubles — no behaviour change on the synth path (locked by its
existing tests).

### B2. Wire the four callers

Each caller routes its sidecar POST through `withCapacityRetry` with default
deps:

- **`/qwen/design-voice`** (`routes/qwen-voice.ts` `postDesignAndCache`): wrap the
  `fetch` in `withCapacityRetry`. On exhausted attempts the resulting
  `NoCapacityError` maps to the design-voice error surface. **Policy: silent
  evict-Ollama-and-retry** (same as `/synthesize`) — the shared helper already
  does exactly this; no design-specific branch. Its existing `base17-unavailable`
  503 branch is untouched (that body isn't a `noCapacity` shape, so
  `parseNoCapacity` returns null and it falls through as today).
- **`/transcribe`** (`tts/transcribe-client.ts`) and **`/embed`**
  (`tts/embed-client.ts`): wrap through `withCapacityRetry`. These only ever hit
  a `noCapacity` when their engine is GPU-configured (Part A4); on cpu default
  the sidecar never emits it, so the wrap is inert.
- **`/load`** (`gpu/gpu-load.ts`): this caller **already** has capacity logic
  (`withGpuLoad` coexist-vs-evict, the flag-OFF protection). Reconcile: when the
  flag is ON the sidecar admits/refuses `/load` itself, so the load POST routes
  through `withCapacityRetry`; the existing `withGpuLoad` evict remains the
  flag-OFF path. The two must not double-evict — the shared helper's
  `!isAnalysisInFlight` + single-shot `evicted` guard already bounds evictions to
  one, and the plan resolves whether `withGpuLoad`'s own evict is skipped when
  the flag is ON.

### B3. NoCapacityError surfacing

Each caller already has a failure path; `NoCapacityError` (thrown after
`maxCapacityAttempts`) is classified as transient and surfaced through that
path's existing toast/error (design-voice, QA, load). No new user-facing surface
is invented here beyond reusing what the synth path established.

## Flag discipline

Everything is behind `SEG_CAPACITY_ADMISSION` (default OFF). Sidecar: the
`device=None`/`pinned=None` defaults keep flag-OFF byte-for-byte. Node: with the
flag OFF the sidecar never emits `noCapacity` for these ops, so `withCapacityRetry`
is a transparent pass-through (first POST is ok, returned immediately). This PR
does **not** change the default.

## Testing

**Sidecar (pytest, `test_placement.py` + per-handler):** flag-OFF parity (no
probe, no reservation) for all four handlers; `pinned` candidate filtering (a
full pinned card → `noCapacity` even with another card free); concurrent
double-book refusal on a load path; `noCapacity` 503 shape per handler; device
routing (mocked probe favouring `cuda:1` → load invoked with `device="cuda:1"`;
operator pin wins over a roomier card); cpu asr/spk stay unwrapped.

**Node (vitest):** `withCapacityRetry` unit tests moved/adapted from the current
`postWithCapacityRetry` coverage (evict-once-then-poll, abort, max-attempts →
`NoCapacityError`); `SidecarTtsProvider` synth path unchanged (existing tests
green); one test per new caller that a `noCapacity` 503 triggers the
evict/retry (with injected doubles) and that a non-`noCapacity` 503 still throws
as before.

Flag-ON no-OOM acceptance on 1-/2-card boxes is the on-box bar in regression
plan 264; not automatable here.

## Risks

| Risk | Mitigation |
|---|---|
| Node caller 503 unhandled → flag-ON regression (the review finding) | Part B wires all four through `withCapacityRetry`; per-caller tests lock it. |
| Extraction changes synth-path behaviour | Free function is a pure lift of the existing method; `SidecarTtsProvider` wrapper + its tests stay green. |
| `/load` double-evicts (withGpuLoad + capacity-retry) | Single-shot `evicted` guard bounds to one evict; plan decides withGpuLoad-evict skip when flag ON. |
| Signature change breaks a caller/test | New params optional with env-preserving defaults; flag-OFF parity tests. |
| Operator pin overridden | `pinned` makes a concrete env pin a hard constraint; device-routing test asserts pinned card wins. |
| Touching OOM-critical `admit`/`reservation` | Additive optional args; parent atomic `try_hold` race test intact; new `pinned` test. |
