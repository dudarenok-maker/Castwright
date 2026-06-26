---
title: Per-model GPU assignment (multi-GPU)
date: 2026-06-27
status: draft
---

# Per-model GPU assignment (multi-GPU)

## Problem

The TTS sidecar is single-GPU by design. Every model loads onto one device,
and the device defaults (`auto` → `cuda:0`, plus `COQUI_DEVICE=cuda` /
`ASR_DEVICE=cuda`) all resolve to the same card. On a box with two GPUs the
second card sits idle, and three pieces of safety machinery are hardcoded to
device 0:

- the reserved-VRAM **recycle ceiling** (`_vram_recycle_soft_threshold_mb` /
  `_vram_restart_threshold_mb` read `_cuda_vram_mb()`, which calls
  `torch.cuda.get_device_properties(0)` and default-device `memory_reserved()`),
- the `/health` **VRAM telemetry**,
- the **co-residency eviction** logic (Kokoro ↔ Qwen-Base ↔ VoiceDesign ↔ ASR
  ↔ SPK all assumed to compete on one card).

Per-engine device knobs already exist (`QWEN_DEVICE`, `COQUI_DEVICE`,
`ASR_DEVICE`, `SPK_DEVICE`), so a user *can* pin engines to different cards
today — but the moment two engines live on different cards, the safety net is
blind or wrong: the watchdog watches the wrong card, and eviction fires
across cards that don't actually share VRAM.

This box (the reference hardware) has an **RTX 4070 Laptop 8 GB** (`cuda:0` by
torch's default enumeration; **also drives the display**, so its *free* VRAM is
well under 8 GB) and an **RTX 5070 Ti 16 GB** (`cuda:1`). A verified stop-gap
(`CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES=1,0` in `server/.env`)
remaps the 16 GB card to the visible `cuda:0` so the heavy synth path and the
watchdog both land on it.

**This feature owns device mapping.** When the picker ships, the
`CUDA_VISIBLE_DEVICES` stop-gap is **removed**: the sidecar enumerates all
physical cards in raw order, and the picker assigns by **GPU UUID** (see the
`DeviceLedger` keystone below) directly to physical cards — one mechanism, no
hidden remap layer. The stop-gap stays in place only until the picker lands.

## Goal

Let the user choose, **per model**, which GPU (or CPU) it runs on, and make the
sidecar runtime genuinely device-aware so that any assignment is honored
**safely** — the recycle ceiling, `/health`, and eviction all reason per
device, not against a hardcoded device 0. A bad assignment must **degrade
loudly and recoverably**, never brick the sidecar.

Auto-placement (the app proposing a layout by available VRAM) is an **optional,
default-off** layer on top of the manual picker.

### Assignable units (6)

| Unit | Runtime | Device API | Existing knob | Notes |
|---|---|---|---|---|
| **Qwen** (Base 0.6B + VoiceDesign 1.7B) | torch | `cuda:N` via `.to()` | `QWEN_DEVICE` | Base + VoiceDesign **share one assignment** — they co-reside during a design session. One picker row. |
| **Coqui XTTS** | torch | `cuda:N` via `.to()` | `COQUI_DEVICE` | |
| **ECAPA drift** (voice-consistency QA) | torch (speechbrain) | `cuda:N` via `.to()` | `SPK_DEVICE` | srv-47 already made `cuda` *safe*; CPU is today's default. |
| **Kokoro** | **onnxruntime** | **ORT provider `device_id`** | _new_ `KOKORO_DEVICE` | eagerly-resident English fallback (~1 GB). **Separate allocator from torch** (`main.py:460`) — `cuda:N` is meaningless to it. |
| **Whisper ASR** (content QA / WER) | **CTranslate2** | **`device="cuda"` + `device_index`** | `ASR_DEVICE` | already CPU-first-capable. **Separate allocator from torch**; does *not* accept `cuda:N`. |
| **Analyzer (Ollama)** | Ollama daemon | **daemon `CUDA_VISIBLE_DEVICES`** | _new_ pref | separate process. Restart-to-apply via daemon env; `main_gpu` is *not* a reliable pin (it only chooses the primary GPU in split mode). Note: this box currently runs `ANALYZER=gemini` (cloud), so local placement is moot until `ANALYZER=local`. |

**The five sidecar engines do not share a device grammar.** Three are torch
(`cuda:N`), Kokoro is onnxruntime (provider `device_id`), Whisper is CTranslate2
(`device` + `device_index`). The picker therefore stores a **canonical**
assignment per unit (a GPU **UUID**, or `cpu`), and an **engine device-adapter**
(see Components §3a) translates that canonical value into each engine's native
device API at load. The knob env values (`QWEN_DEVICE` etc.) carry the resolved
torch/native form the adapter produces.

### Apply semantics

**Restart-to-apply.** Changing an assignment writes config; it takes effect on
the next sidecar/Ollama restart (the one-click "restart sidecar" affordance
already exists). This matches every existing device knob (`apply:
'restart-sidecar'`) and means each model simply loads onto its assigned card at
startup — no live cross-card migration in the eviction state machine.

## Non-goals

- **Multi-process sidecar.** The sidecar stays one process driving N cards.
  Per-device accounting does **not** mean per-device processes.
- **Live re-placement.** Out of scope (restart-to-apply only).
- **Auto-placement as default behavior.** It ships off; the user opts in.
- **Cross-engine load balancing / sharding a single model across cards.**

## Architecture

### Keystone: `DeviceLedger` (sidecar, new module)

One small module that owns two facts and is the single source of truth that
makes a one-process / N-card sidecar safe:

1. **`engine → device`** — where each loadable engine (Qwen, Coqui, Kokoro,
   ASR, SPK) is assigned, resolved once at startup from the canonical
   UUID-keyed assignment via the engine device-adapter (§3a). Identity is the
   **GPU UUID** (`torch.cuda.get_device_properties(idx).uuid`), not the bare
   index — so the ledger maps `uuid → current torch index` and warns on drift.
2. **Two distinct per-device quantities** (the v1 design conflated these — they
   are not the same and must not be):
   - **driver free / total** via `torch.cuda.mem_get_info(idx)` — the **driver
     truth**, visible across *all* allocators (torch, ORT, CTranslate2). This is
     what **capacity, footprint pre-warning, eviction, and OOM** reasoning use.
   - **torch reserved** via `memory_reserved(idx)` — the **torch caching-allocator
     pool only**. Valid *solely* for the fragmentation self-exit, and *solely*
     on cards hosting torch engines. **Kokoro (ORT) and Whisper (CT2) VRAM is
     invisible to `memory_reserved`** (`main.py:460`), so a card hosting only
     those reads reserved ≈ 0 — its fragmentation ceiling is inert by design,
     and its safety comes from the driver-free path above.

Everything safety-critical reads **through** the ledger:

- **Recycle / watchdog** — the **fragmentation** soft/hard thresholds are
  computed per **torch-hosting** device (each card's fraction × that card's
  total, on the torch `reserved` pool) and fire if **any** crosses. A hard cross
  still triggers the existing **whole-process self-exit (code 43)**; the
  supervisor respawns and all cards' contexts reload. The multi-card rule is an
  **OR over in-use torch devices**. (Capacity/OOM for non-torch cards is the
  driver-free path, not this ceiling.)
- **`/health`** — reports a `devices[]` array (`uuid`, `idx`, `name`,
  `free`, `total`, `torch_reserved`, resident engines). Existing scalar fields
  stay for back-compat, derived from a **defined** card: Qwen's resolved device,
  falling back to torch index 0 (M2).
- **Eviction / co-residency** — **both** VRAM-coupling mechanisms gain the
  predicate **`shares_device(a, b)`**: (1) the load-time "free VRAM before
  loading X" evictions, **and** (2) the synth-time `_VdKokoroArbiter`
  (`main.py:457`) forward-overlap lock between VoiceDesign and Kokoro. Models
  couple only when assigned the **same physical card**; Qwen on one card +
  Kokoro on another → no eviction *and* no forward serialization.
  `shares_device` resolves `auto` to its concrete device first, and returns
  **false** for any pair where either side is `cpu` (no VRAM contention) (M3).

### Two control planes

- **Sidecar engines (5)** — the canonical UUID assignment flows through the
  registry-knob → `buildSidecarEnv` path; the **engine device-adapter** (§3a)
  resolves it to each engine's native form. Four knobs exist; we add
  **`KOKORO_DEVICE`** (mapped to an ORT provider `device_id`). `ASR_DEVICE`
  grows from `cpu|cuda` to also carry a device index that the adapter splits
  into CTranslate2's `device` + `device_index`.
- **Analyzer Ollama (1)** — a stored preference applied as **daemon-level
  `CUDA_VISIBLE_DEVICES`** at `ollama serve` (restart-to-apply, consistent with
  the rest of the feature). `main_gpu` is **not** a reliable pin — it only
  selects the primary GPU in split mode — so it is at most a secondary hint, not
  the mechanism. On this box the analyzer is `ANALYZER=gemini` today, so this
  plane is dormant until `ANALYZER=local`.

## Components

1. **Device discovery** — `GET /devices` on the sidecar enumerates CUDA devices
   `[{uuid, idx, name, total_mb, free_mb}]` (+ a `cpu` pseudo-option) via
   `torch.cuda.mem_get_info` / `get_device_properties`; a server proxy (copy the
   `/health` proxy pattern) exposes it to the frontend. `free_mb` (driver truth)
   is shown so the picker reflects the display-driven card's real headroom.
   Depends on: torch.
2. **Device-assignment config** — the 6 stored canonical assignments (GPU UUID
   or `cpu`). Adds `KOKORO_DEVICE` (reuses `QWEN/COQUI/ASR/SPK_DEVICE`) + an
   analyzer-GPU preference. `buildSidecarEnv` already injects non-default
   `restart-sidecar` knobs, so Kokoro slots in; the analyzer value becomes the
   daemon's `CUDA_VISIBLE_DEVICES`. Depends on: registry, env-builder,
   `ollama.ts`.
3. **`DeviceLedger`** — the keystone above (UUID identity; driver-free vs
   torch-reserved split). Independently unit-testable with a stub torch (the
   `_StubTorch` pattern in `test_device_probe.py`).
   - **3a. Engine device-adapter** — translates one canonical assignment
     (UUID / `cpu`) into each engine's native device API: torch `cuda:N`
     (Qwen/Coqui/SPK), ORT provider `device_id` (Kokoro), CTranslate2
     `device`+`device_index` (Whisper). Owns the `uuid → current torch index`
     resolution and the stale/drift detection. The single place that knows each
     engine's device dialect — so the ledger and picker stay dialect-agnostic.
4. **Device-aware recycle / watchdog / `/health`** — refactor: replace
   `get_device_properties(0)` / default-device `memory_reserved()` with ledger
   lookups; per-device thresholds; fire on any-card cross; `/health` gains
   `devices[]`. Highest-risk unit → heaviest test coverage.
5. **Device-aware eviction + arbiter** — gate **both** VRAM-coupling
   mechanisms on `ledger.shares_device(...)`: the load-time evict-to-free paths
   **and** the synth-time `_VdKokoroArbiter` (`main.py:457`) VoiceDesign↔Kokoro
   forward lock. Cross-card pairs neither evict nor serialize.
6. **Settings picker UI** — a "GPU assignment" panel: one row per unit, a
   dropdown of discovered devices (each showing its VRAM), the current value, a
   stale-assignment indicator, and the existing "restart sidecar to apply"
   affordance. Depends on: discovery endpoint + the config-write path Settings
   already uses.
7. **Auto-placement (optional, default-off)** — a toggle + "Suggest layout"
   button that reads device VRAMs and proposes a placement (heavy synth →
   largest card; QA models → spare) the user can accept into the knobs. Never
   runs unless invoked; it only *fills in* the same knobs the manual picker
   writes.

Clean seam: 1–2 plumbing, 3 the new abstraction, 4–5 consume it, 6–7 UI over it.

## Data flow

**Sidecar engine (happy path):** picker calls `GET /devices` → shows each card
with VRAM → user picks a device per unit → write to registry config
(`user-settings.json`) → user clicks "restart sidecar" → `buildSidecarEnv`
injects the `*_DEVICE` knobs → sidecar boots → each engine loads onto its
assigned card → `DeviceLedger` records `engine→device` → watchdog samples each
in-use device per cycle → recycle fires per-card, `/health` reports `devices[]`.

**Analyzer:** stored preference → written as the Ollama daemon's
`CUDA_VISIBLE_DEVICES` and applied on daemon restart (restart-to-apply).
`main_gpu` is not relied on as the pin.

## Error handling

The principle: **a bad assignment degrades loudly and recoverably; it never
bricks the sidecar.**

- **Stale / invalid assignment** (knob says `cuda:2`, or a card was removed) →
  the device resolver clamps to a safe fallback (`cuda:0`, then `cpu`) with a
  loud one-time WARN; `/health` + the picker flag the assignment as **stale**
  rather than silently honoring a phantom. Extends `_resolve_torch_device`.
- **Card vanishes mid-run** (driver reset) → `mem_get_info(idx)` throws → ledger
  returns `None` for that device → its ceiling derives to **0 (disabled)**,
  exactly today's unknown-VRAM fail-safe; the host-RAM watchdog governs. No
  guessed ceiling that could false-fire.
- **Heavy engine on a too-small card** → QA models (ASR, SPK) have CPU-degrade
  paths → demote with a WARN. Synth engines (Qwen/Coqui) that can't sensibly
  CPU-fall-back → load fails with a clear surfaced error ("Qwen needs ~X GB,
  this card has Y GB free"). The picker pre-warns against the card's **free**
  VRAM (driver truth — the display-driven card has well under its nominal
  total), and for Qwen uses the **peak** footprint (**Base + VoiceDesign
  co-resident**, ~6.5 GB during a design), not Base alone — so it catches a
  Qwen-on-8 GB assignment that would only OOM when someone designs a voice (M1).
- **Two co-resident models on the same small card** (e.g. Qwen Base +
  VoiceDesign during a design) → the existing co-residency OOM guard still
  applies, now correctly **scoped to that one card** via `shares_device`.

## Testing

Mapped to the five tiers, weighted toward the risky units.

**Sidecar pytest (heaviest):**
- `DeviceLedger` with a stub torch (reuse `_StubTorch`/`_torch` from
  `test_device_probe.py` / `test_qwen_device.py`): `uuid→index` resolution
  (incl. drift warn), per-device **driver-free** vs **torch-reserved** sampling
  kept distinct, `shares_device` truth table, stale-device → safe-fallback +
  WARN.
- Recycle thresholds computed **per device**, firing when *any* in-use card
  crosses (the OR rule) — including the asymmetric case (16 GB fine, 8 GB over →
  recycle fires).
- Eviction: same-card pair evicts (today's behavior preserved) vs cross-card
  pair does **not** evict (the new behavior / the bug being fixed).
- `GET /devices` shape; `/health` `devices[]` shape + back-compat scalars.

**Server vitest:** `buildSidecarEnv` injects `KOKORO_DEVICE` (and the
`ASR_DEVICE` index form) when non-default; the analyzer pref resolves to the
daemon's `CUDA_VISIBLE_DEVICES`; `/devices` proxy; config write **validates
against discovered devices by UUID** (reject an assignment whose UUID isn't
present).

**Frontend vitest:** picker renders one row per unit, dropdown populated from
discovery, stale-assignment indicator, "restart to apply" affordance present.

**E2E (Playwright, one spec):** Settings → GPU panel renders against mocked
`/devices`, select a device for a unit, value persists across reload.

Add cases for the **engine device-adapter** (§3a): a UUID canonical assignment
resolves to torch `cuda:N` for Qwen/Coqui/SPK, an ORT `device_id` for Kokoro,
and CTranslate2 `device`+`device_index` for Whisper; an unknown UUID falls back
loudly. And for `shares_device`: torch-vs-ORT engines on the same physical card
*do* couple (same UUID), `cpu` pairs never couple.

**Regression plan:** a new `docs/features/<n>-multi-gpu-per-model.md` from
`TEMPLATE.md` documenting the invariants (per-device recycle, same-card-only
eviction *and* arbiter, loud-degrade-never-brick, UUID identity) and a manual
**2-GPU on-box acceptance** walkthrough — the automated tiers run on stub torch
/ single-GPU CI, so the real 2-card behavior needs an on-box pass. The
walkthrough must note that **`/health` `free`/`total` (driver) is the VRAM
truth; `torch_reserved` is torch-pool-only and will under-report** any card
hosting Kokoro (ORT) or Whisper (CT2) — an expected gap, not a bug (L1).

## Key files

- `server/tts-sidecar/main.py` — `_cuda_vram_mb`, `_vram_recycle_*`,
  `_resolve_torch_device`, `_normalize_device_family`, the engine classes
  (`QwenEngine`, `CoquiEngine`, `KokoroEngine`, `WhisperEngine`, the ECAPA/SPK
  class), the eviction call-sites, **`_VdKokoroArbiter`** (`main.py:457`),
  `/health`. New: `DeviceLedger` module, the **engine device-adapter**, and
  `GET /devices`.
- `server/src/tts/spawn-sidecar.ts` — `buildSidecarEnv` (`KOKORO_DEVICE`;
  `ASR_DEVICE` index form). The `CUDA_VISIBLE_DEVICES` stop-gap is **removed**
  here once the feature owns mapping.
- `server/src/config/registry.ts` — the device knobs (`KOKORO_DEVICE` knob +
  analyzer-GPU pref) carrying canonical UUID values.
- `server/src/analyzer/ollama.ts` — analyzer GPU pref → daemon
  `CUDA_VISIBLE_DEVICES` (not `main_gpu`).
- `server/src/routes/sidecar-health.ts` (+ a new devices route) — proxy.
- Frontend Settings view + a new GPU-assignment panel component.
- `server/.env.example` — document `KOKORO_DEVICE`, the analyzer GPU pref, and
  note the `CUDA_VISIBLE_DEVICES` / `CUDA_DEVICE_ORDER` stop-gap as superseded
  by the picker.

## Open questions / deferred

- **Auto-placement heuristic** — v1 ships the toggle + a simple "largest card
  gets synth, spare gets QA" suggestion. A smarter footprint-aware solver is a
  follow-up.
- **Per-card recycle granularity** — v1 self-exits the whole process on any
  card's hard cross (simplest, correct). A future refinement could reload only
  the offending card's engines if the self-exit cost becomes a problem.
