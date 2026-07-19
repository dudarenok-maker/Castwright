---
title: Op capacity admission — wrap /load, design_voice, mint_variant, /transcribe, /embed (sidecar + Node)
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
(`SidecarTtsProvider.postWithCapacityRetry`). The other heavy GPU ops go through
**neither**. While `SEG_CAPACITY_ADMISSION` is OFF that is safe (sequential
workflow + `poolWidth=1` + the coarse `withGpuLoad` load-path evict). But it is
the main blocker to flipping the flag ON, on **two** sides:

1. **Sidecar:** a cold `/load`, `design_voice` / `mint_variant` (the 1.7B ops),
   `/transcribe` (ASR) and `/embed` (ECAPA) don't reserve, so they can
   double-book the VRAM a synth reservation is protecting, or OOM instead of
   refusing.
2. **Node (adversarial-review finding):** even once the sidecar refuses with a
   `noCapacity` 503, only `/synthesize` + `/synthesize-batch` route through the
   retry orchestration (`server/src/tts/sidecar.ts:184,252`). The other ops are
   called from unrelated modules — `routes/qwen-voice.ts` (design/mint, inside
   `withGpuLoad`), `routes/sidecar-health.ts:325` (`POST /api/sidecar/load`
   proxy), `tts/transcribe-client.ts`, `tts/embed-client.ts` — so a `noCapacity`
   503 would become a **hard failure** where flag-OFF today evicts and proceeds.

This spec closes **both** sides so the flag is genuinely flippable (gated on the
on-box acceptance still owed in regression plan 264).

## Goal

- **Sidecar:** route every heavy GPU op through `PlacementController.reservation()`,
  with **full multi-GPU load steering** — a cold load physically lands on the
  admitted best-fit card; when no card fits, refuse with a `noCapacity` 503.
- **Node:** every caller of those ops handles that 503 with the same
  evict-Ollama-or-bounded-poll orchestration `/synthesize` uses, and the coarse
  Node-side `withGpuLoad` arbiter steps aside when the flag is ON so there is
  exactly one admission authority and one eviction authority.

Non-goals (separate follow-ups): per-device idle-evict +
`reset_peak_memory_stats` (**#1721**); dead-code deletion (**#1722**); flipping
`SEG_CAPACITY_ADMISSION` default ON (waits on on-box 1-/2-card acceptance).

Scope note: the issue's literal list is four ops; `/qwen/mint-variant` is pulled
in as a fifth because it is the **primary** anchored-emotion path (loads the 1.7B
`_base17`) and `design_voice` is only its fallback — admitting the fallback but
not the primary would leave an OOM hole on a tight card. #1720's real scope is
"the heavy ops sharing the 1.7B / synth VRAM class," so mint-variant rides along.

## Part A — Sidecar admission

### Inherited core (unchanged)

`PlacementController.reservation()`, `FootprintTable`, `ReservationLedger` reused
verbatim. Footprints already seeded for every op (`coqui:3584`, `kokoro:1200`,
`qwen:6144`, `qwen.1.7b:7168`, `asr:400`, `spk:200`) — no footprint work.
Reservation semantics fit a load: `reservation()` holds the peak on the winning
device for the op's duration then releases in its `finally` **after** the load
completes (`main.py` ~2168–2179), so the now-resident model is already reflected
in the next `probe_capacity()` read — the reserved→resident handoff overlaps
(briefly double-counts, conservative) and never gaps.

### A1. Device-plumbing contract

Additive and back-compatible. Two mechanisms because the engines differ:

- **Param plumbing** (device passed in): `CoquiEngine._ensure_loaded(model,
  device=None)`, `KokoroEngine._ensure_loaded(model, device=None)`,
  `QwenEngine._ensure_base_loaded(device=None)` / `_ensure_base17_loaded(device=None)`,
  `QwenEngine.design_voice(..., device=None)` and the mint-variant entry point
  (both route their internal `_ensure_design_loaded`/`_ensure_base17_loaded` +
  `_ensure_base_loaded` to the same device).
- **Attr-set plumbing** (no param today): `WhisperEngine` reads `self._device`
  (set from `ASR_DEVICE` at `__init__`, `main.py:4290,4301`) and
  `SpeakerEmbedder` reads `self.device` (`4428,4439`). Here the handler sets the
  instance attr to the admitted device **under the engine's load lock** before
  the load. Single-instance engines; a resident engine pins to its own card, so
  the attr is set once on the cold load and is stable thereafter.

`device=None` / no-override preserves today's env/enumeration resolution
byte-for-byte. Accepted device forms: `cuda:N`, `rocm:N`, `cpu`.

### A2. Operator pins are a hard constraint

A concrete device env (`COQUI_DEVICE=cuda:1`, `QWEN_DEVICE=cuda:0`,
`ASR_DEVICE=cuda`, …) must never be steered elsewhere; `auto`/unset means
"capacity decides." Mechanism: add an optional **`pinned: Optional[str] = None`**
arg to `PlacementController.admit()` / `.reservation()`. When set it filters the
GPU candidate set to that one device, exactly as a resident engine is filtered in
`_gpu_candidates()`. Effective constraint per call site: `resident_device if
resident else env_pin` (else all GPUs → best-fit, plumbed back via A1). Helper
`_engine_env_pin(engine_id) -> Optional[str]` reads the engine's device env via
the existing `_read_device_env` + `_parse_device`.

### A3. Per-op wiring

Each handler mirrors `/synthesize`: enter `reservation()` → on `noCapacity`
return a 503 `{noCapacity, neededMb, deviceKey}` → else take the per-engine load
lock → `to_thread(load, ..., device=adm["device"])`.

| Handler | engine_id / model key | Profile | Plumb |
|---|---|---|---|
| `/load` coqui | `coqui` | heavy, GPU-only | param |
| `/load` qwen 0.6b | `qwen` (→ `qwen`) | heavy, GPU-only | param |
| `/load` qwen 1.7b | `qwen`+`"1.7b"` (→ `qwen.1.7b`) | heavy, GPU-only | param |
| `/qwen/design-voice` | `qwen`+`"1.7b"` (→ `qwen.1.7b`) | heavy, GPU-only | param |
| `/qwen/mint-variant` | `qwen`+`"1.7b"` (→ `qwen.1.7b`) | heavy, GPU-only | param |
| `/load` kokoro | `kokoro` | cpu-capable | param |
| `/transcribe` | `asr` | cpu-capable | attr-set |
| `/embed` | `spk` | cpu-capable | attr-set |

`_ENGINE_CAPACITY_PROFILE` has no `asr`/`spk` entries (`main.py:2189`); those two
handlers pass explicit `cpu_capable`/`heavy` literals.

### A4. cpu-capable wrap rule

- **asr / spk:** resolved device is env-known at `__init__`. Wrap in
  `reservation()` **only when that device is a GPU** (`ASR_DEVICE=cuda` /
  `SPK_DEVICE=cuda`); the documented cpu default (zero VRAM) runs **directly,
  unwrapped** — unchanged, no pointless `spk:200` reservation, no incoherent
  "fall back to cpu but the model is on cuda" edge.
- **kokoro:** `KOKORO_DEVICE=auto` resolves only *during* load, so it is
  **always wrapped with `cpu_capable=True`** — admission returns `cpu` when no
  GPU fits (coherent for kokoro), else a GPU device. Idempotent `ready`
  short-circuits first, so a warm kokoro `/load` never reserves.

### A5. Lock ordering (preserved from parent spec)

Idle-evict reachable from admission takes the **threading** load locks
(`_base_load_lock`/`_base17_load_lock`) + engine unload paths, never the asyncio
`_load_lock`; the ledger lock releases before any forward/load. Coqui/Kokoro keep
their asyncio `_load_lock` (not idle-evict targets). Handlers enter the sync
`reservation()` with a plain `with`. Note: a `design_voice`/`mint_variant` admit
may idle-evict a warm VoiceDesign the incoming op then re-loads — wasteful, not
incorrect (`design_voice` re-ensures under `_synth_lock`).

## Part B — Node noCapacity handling

### B1. Extract a reusable `withCapacityRetry` with a corrected contract

`postWithCapacityRetry` is a `SidecarTtsProvider` method, but every dep already
defaults to a module singleton (`capacityProbe`, `evictOllama`,
`analyzerEvictWouldHelp`, `isAnalysisInFlight`, `GPU_CAPACITY_POLL_MS`,
`GPU_CAPACITY_MAX_ATTEMPTS`). Extract a **free function** `withCapacityRetry(doPost,
opts)` into a new `server/src/gpu/capacity-retry.ts`.

**Contract (the review correction — NOT a pure lift):** the helper retries a
`noCapacity` 503 only (parsed by the existing `parseNoCapacity`), doing the
evict-once-then-bounded-poll loop; on **every other** outcome — an `ok` response
OR any non-`noCapacity` response (poisoned, other 5xx, 4xx, or a different-shaped
503 like design's `base17-unavailable`) — it **returns the `Response` to the
caller**. It does *not* call `throwForResponse` internally. This is what lets each
caller keep its bespoke error handling: `SidecarTtsProvider` applies
`throwForResponse` in its thin wrapper (synth behaviour unchanged, locked by its
tests); `transcribe-client`/`embed-client` apply their own `Error(...)`;
`qwen-voice`'s `postDesignAndCache` applies its `SidecarDesignError` +
`base17-unavailable` branch. `opts` carries the deps (defaulting to the
singletons), an `engine` label for `NoCapacityError`, and an optional
`AbortSignal`; the `_capacityWaiters` telemetry counter + `getCapacityWaiterCount`
move into the shared module (its one importer re-points).

### B2. `withGpuLoad` steps aside when the flag is ON (Q1 + Q2)

`design_voice`/`mint_variant` (`qwen-voice.ts:342`) and the `/api/sidecar/load`
proxy path both run inside `withGpuLoad`, which today does its own coarse
probe→evict→refuse inside the global `withGpuLoadLock`. Rather than stack three
VRAM arbiters, **flag-gate `withGpuLoad`**:

- **Flag ON:** `withGpuLoad` is a **passthrough** — it skips its probe/evict/
  refuse **and acquires no `withGpuLoadLock`** — and simply runs `loadFn`. The
  sidecar admission is the sole *admission* authority; the Node-side
  `withCapacityRetry` (wrapping the POST inside `loadFn`) is the sole *eviction*
  authority. Because the poll no longer runs under the global mutex, a capacity
  wait can't block other loads; the sidecar's per-engine load locks + atomic
  `try_hold` provide serialization + no-double-book, and `evictOllama` is
  idempotent so concurrent single-shot evicts are safe.
- **Flag OFF:** `withGpuLoad` is **byte-for-byte today** (coarse evict-before-load
  under the lock); `withCapacityRetry` is inert (the sidecar never emits
  `noCapacity`).

The gate reads the same `process.env.SEG_CAPACITY_ADMISSION` the sidecar reads
(Node spawns the sidecar, so it has the env).

**Deliberate behaviour change when ON:** the tight-card + analysis-busy case that
today throws `GpuBusyError` (409) immediately instead becomes a bounded poll →
`NoCapacityError` (it waits out a finishing analysis within the budget, then
fails). Named here so the plan documents it in the regression plan.

### B3. Wire the callers through `withCapacityRetry`

- **`/qwen/design-voice` + `/qwen/mint-variant`** (`qwen-voice.ts` inside the
  `withGpuLoad` closure): wrap each sidecar POST (`postDesignAndCache`'s `fetch`)
  in `withCapacityRetry` with default deps and `job.controller.signal`. Silent
  evict-and-retry policy (the shared helper's default) — the interactive UX we
  chose. The `base17-unavailable` fallback path is untouched (that 503 isn't a
  `noCapacity` shape, so the helper returns it and the existing
  `SidecarDesignError` branch runs).
- **`/load`** (`routes/sidecar-health.ts:325`, the `POST /api/sidecar/load`
  proxy): wrap the proxied POST in `withCapacityRetry`. The frontend Load button
  is the caller; thread the request's abort signal if available.
- **`/transcribe`** (`transcribe-client.ts`) / **`/embed`** (`embed-client.ts`):
  wrap the `undiciFetch` in `withCapacityRetry` (they already carry `opts.signal`
  and gate on `asrRunsOnGpu()`/`spkRunsOnGpu()`, so the wrap is inert on the cpu
  default).

`NoCapacityError` (thrown after `maxCapacityAttempts`) is classified as transient
and surfaced through each caller's existing failure path (design toast, QA, load
pill). No new user-facing surface is invented.

## Flag discipline

Everything is behind `SEG_CAPACITY_ADMISSION` (default OFF). Sidecar: the
`device=None`/`pinned=None` defaults keep flag-OFF byte-for-byte. Node: flag OFF →
`withGpuLoad` unchanged and `withCapacityRetry` a transparent pass-through (first
POST is ok). This PR does **not** change the default.

## Testing

**Sidecar (pytest, `test_placement.py` + per-handler):** flag-OFF parity (no
probe, no reservation) for every handler; `pinned` candidate filtering (a full
pinned card → `noCapacity` even with another card free); concurrent double-book
refusal on a load path; `noCapacity` 503 shape per handler; device routing
(mocked probe favouring `cuda:1` → load invoked with `device="cuda:1"`; operator
pin wins over a roomier card); cpu asr/spk stay unwrapped; mint-variant reserves
`qwen.1.7b` like design-voice.

**Node (vitest):** `withCapacityRetry` unit tests (evict-once-then-poll, abort,
max-attempts → `NoCapacityError`, **and the contract test: a non-`noCapacity`
response is returned, not thrown**); `SidecarTtsProvider` synth path unchanged
(existing tests green); `withGpuLoad` flag-ON passthrough (no probe, no lock, no
evict) vs. flag-OFF unchanged; one test per new caller that a `noCapacity` 503
triggers evict/retry and a non-`noCapacity` 503 still hits its own error path.

Flag-ON no-OOM acceptance on 1-/2-card boxes is the on-box bar in regression plan
264; not automatable here.

## Risks

| Risk | Mitigation |
|---|---|
| Node caller 503 unhandled → flag-ON regression (review finding) | Part B wires all callers through `withCapacityRetry`; per-caller tests lock it. |
| Triple-arbiter evict (withGpuLoad + sidecar + retry) | B2 flag-gates `withGpuLoad` to a passthrough when ON → one admission + one eviction authority. |
| Capacity poll starves other loads under the global mutex | B2 flag-ON passthrough acquires no `withGpuLoadLock`; sidecar load-locks + atomic ledger serialize instead. |
| Extraction changes a caller's non-`noCapacity` error handling | B1 contract: helper returns every non-`noCapacity` response; each caller keeps its own error path; contract test. |
| `mint-variant` OOM while its fallback is admitted | mint-variant pulled into scope (A3), same `qwen.1.7b` treatment. |
| `pinned` mis-filters onto the wrong card | New `pinned` candidate-filter test; mirrors the tested resident filter. |
| Touching OOM-critical `admit`/`reservation` | Additive optional args; parent atomic `try_hold` race test intact. |
| GpuBusyError→NoCapacityError UX shift when ON | Deliberate, documented in the regression plan; bounded wait then fail is not worse than instant 409. |
