---
status: active
shipped: null
owner: null
---

# 236 — Multi-GPU per-model placement and per-card safety

> Status: active — Wave 1 (placement + visibility) merged to `main` (#1180); a
> basic device-picker dropdown merged (#1205); **Wave 2 (per-card safety) is
> this PR** — sidecar + server runtime hardening, no UI change. **Plan 2
> (picker UI: canonical GPU-UUID identity, stale-reason badges, footprint
> pre-warn, analyzer read-only row, auto-revert) is a follow-up PR**, gated on
> this PR's on-box acceptance.
> Key files: `server/tts-sidecar/main.py` (`DeviceLedger`, `_check_per_card_ceilings`,
> `shares_device`/`_VdKokoroArbiter`, `_write_restart_breadcrumb`),
> `server/src/tts/sidecar-supervisor.ts` (code-43 streak guard,
> `clearTripAndRespawn`), `server/src/tts/restart-breadcrumb.ts`,
> `server/src/gpu/{engine-device,analyzer-device-state,residency,gpu-load}.ts`,
> `server/src/tts/{engine-vram-cost,ensure-sidecar-loaded,persona-gpu-plan}.ts`,
> `server/src/routes/{qwen-voice,analysis}.ts`, `server/src/config/registry.ts`
> (`sidecar.vramFreeFloorMb`).
> URL surface: none (Wave 2 is runtime-only; Plan 2 will extend the existing
> Advanced Configuration device rows from #1205).
> OpenAPI ops: none (internal `/health` `gpus[]` payload gained
> `free_floor_mb`/`reserved_ceiling_mb`; no public API change).
> Design spec + plans: `docs/superpowers/specs/2026-06-27-multi-gpu-per-model-design.md`,
> `docs/superpowers/plans/2026-06-27-multi-gpu-wave1-placement-visibility.md`,
> `docs/superpowers/plans/2026-07-02-multi-gpu-wave2-plan2.md`.

## Benefit / Rationale

- **User:** on a multi-GPU box, pinning different engines to different cards
  (e.g. Qwen on a 16 GB card, Kokoro on an 8 GB card) no longer risks a silent
  OOM crash-loop — a structurally-too-small assignment now self-heals into a
  clear "TTS is down, this device pin needs fixing" state instead of an
  endless respawn storm, and the two engines run fully concurrently instead
  of needlessly serializing when they're on different cards.
- **Technical:** a new `DeviceLedger` (sidecar) is the single source of
  per-card VRAM truth, never silently substituting one physical card's
  reading for another's across a driver renumber. A code-43 self-exit now
  persists which card triggered it to disk, so the Node-side supervisor —
  which outlives any one sidecar process — can count a structural-undersize
  streak across restarts and hold TTS down, with `clearTripAndRespawn()` as
  the only way back (neither the existing manual restart route nor a fresh
  exit could recover a tripped supervisor before this).
- **Architectural:** Node's GPU semaphore stays ONE global pool by design
  (no per-card rebuild) — this PR adds two coarse guards on top
  (`engineDeviceIsGpu`) so a CPU-confirmed engine or analyzer doesn't
  cross-charge or cross-evict for GPU contention it can't cause. This is
  the "Plan 1 / Wave 2" half of the design spec; Plan 2 (picker UI) builds
  on the same primitives without needing new server-side plumbing.

## Architectural impact

- **New seams:** `DeviceLedger.card_lock(idx)` — a per-card mutex any future
  same-card-pairing code can wire into (Wave 2 wires exactly one proven call
  site: the Qwen 1.7B-Base design-load path; other pairings are deferred,
  YAGNI, until actually hit on-box). `shares_device()` — a pure function any
  future coupling decision can reuse. `SidecarSupervisor.tripEvent()`/
  `clearTripAndRespawn()` — the recovery primitive Plan 2's auto-revert
  (Task 16) will call.
- **Invariants preserved:** the Node GPU semaphore stays one global pool
  (Non-goal, confirmed in the design spec's Round 5 decisions) — no per-card
  Node budget was introduced. The driver-free VRAM floor is an ABSOLUTE MB
  value, never a fraction (a fraction would self-satisfy on an idle
  low-VRAM card and never trip).
  All new function parameters (`card`, `shares_device`, `engineOnGpu`) default
  to values that reproduce prior behaviour exactly for every existing caller.
- **Migration story:** none — no data-shape change. The new registry knob
  `sidecar.vramFreeFloorMb` defaults to 1024 MB and is `apply:'restart-sidecar'`
  (injected as `SIDECAR_VRAM_FREE_FLOOR_MB` via the existing generic
  `buildSidecarEnv()` loop — no per-knob Node wiring needed).
- **Reversibility:** every guard is additive and independently toggleable
  (env var overrides, or reverting the specific commit) — no destructive
  change to any existing code path.

## Invariants to preserve

- The driver-free floor is absolute MB, never a fraction — `main.py`'s
  `_sidecar_vram_free_floor_mb()`.
- `_VdKokoroArbiter(shares_device=True)` default preserves single-card-box
  blocking semantics exactly — never weaken the default.
- The code-43 streak counter (`sidecar-supervisor.ts`'s `restart43Timestamps`)
  must stay independent of the existing `consecutiveFailures`/lived-based
  backoff reset — merging them back together would reintroduce the "loads
  fine for 35s, dies every time, never trips" gap this PR closes.
- `clearTripAndRespawn()` is the only recovery path for a tripped supervisor
  — do not remove it without providing an equivalent, since neither the
  existing manual restart route nor a fresh exit can recover a trip
  otherwise (see `sidecar-supervisor.ts`'s interface doc comment).

## Test plan

### Automated coverage

- Pytest sidecar: `server/tts-sidecar/tests/test_device_ledger.py` (`DeviceLedger`
  thread-safety, renumber detection, per-card mutex serialization),
  `test_per_card_ceilings.py` (driver-free floor, reserved ceiling, restart
  breadcrumb), `test_design_kokoro_exclusion.py` (`shares_device` coupling,
  arbiter gating).
- Vitest server: `server/src/tts/sidecar-supervisor.test.ts` (code-43 streak,
  `clearTripAndRespawn` recovery + re-trip), `restart-breadcrumb.test.ts`,
  `server/src/gpu/{engine-device,analyzer-device-state,residency,gpu-load}.test.ts`,
  `server/src/tts/engine-vram-cost.test.ts`, `server/src/routes/{qwen-voice,analysis}.test.ts`
  (cross-charge/cross-evict guards), `server/src/tts/spawn-sidecar.test.ts`
  (per-card free-floor reconcile diagnostics).
- No e2e/frontend coverage — Wave 2 has no UI surface.

### Manual acceptance walkthrough (owed — needs the real 2-GPU box)

Full checklist lives in the plan doc's Ship notes:
`docs/superpowers/plans/2026-07-02-multi-gpu-wave2-plan2.md` → "## Ship notes"
→ "### Wave 2". `test:sidecar` is venv-gated so CI never exercises the real
CUDA paths — this on-box run is the only place these invariants get verified
against real hardware (RTX 4070 Laptop 8GB + RTX 5070 Ti 16GB).

## Out of scope

- Plan 2 (picker UI: canonical GPU-UUID identity, stale-reason badges,
  footprint pre-warn, analyzer read-only row, auto-revert) — split into
  [237](237-multi-gpu-device-picker-plan2a.md) ("Plan 2a," everything except
  auto-revert) and a further follow-up for Task 16/16.5 (auto-revert),
  gated on this PR's on-box acceptance since auto-revert directly consumes
  this PR's `tripEvent()`.
- Per-card Node GPU budgets (the semaphore stays one global pool) — deferred,
  confirmed as a Non-goal in the design spec's Round 5 decisions.
- Wiring the per-card mutex at any same-card engine pairing besides the one
  proven Qwen-1.7B-Base-design site — deferred until an actual multi-engine
  same-card assignment is configured on a real box (YAGNI).

## Ship notes

(Filled in once this PR merges.)
