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
torch's default enumeration) and an **RTX 5070 Ti 16 GB** (`cuda:1`). A
verified stop-gap (`CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES=1,0`
in `server/.env`) remaps the 16 GB card to the visible `cuda:0` so the heavy
synth path and the watchdog both land on it. This spec replaces that stop-gap
with a real, per-model picker backed by a device-aware runtime.

## Goal

Let the user choose, **per model**, which GPU (or CPU) it runs on, and make the
sidecar runtime genuinely device-aware so that any assignment is honored
**safely** — the recycle ceiling, `/health`, and eviction all reason per
device, not against a hardcoded device 0. A bad assignment must **degrade
loudly and recoverably**, never brick the sidecar.

Auto-placement (the app proposing a layout by available VRAM) is an **optional,
default-off** layer on top of the manual picker.

### Assignable units (6)

| Unit | Control plane | Existing knob | Notes |
|---|---|---|---|
| **Qwen** (Base 0.6B + VoiceDesign 1.7B) | sidecar env | `QWEN_DEVICE` | Base + VoiceDesign **share one assignment** — they co-reside during a design session. One picker row. |
| **Coqui XTTS** | sidecar env | `COQUI_DEVICE` | |
| **Kokoro** | sidecar env | _new_ `KOKORO_DEVICE` | eagerly-resident English fallback (~1 GB). |
| **Whisper ASR** (content QA / WER) | sidecar env | `ASR_DEVICE` | already CPU-first-capable. |
| **ECAPA drift** (voice-consistency QA) | sidecar env | `SPK_DEVICE` | srv-47 already made `cuda` *safe*; CPU is today's default. |
| **Analyzer (Ollama)** | Ollama daemon / `/api/chat` | _new_ pref → `main_gpu` | separate process; `main_gpu` per-request lever + documented daemon `CUDA_VISIBLE_DEVICES` hard-pin. Note: this box currently runs `ANALYZER=gemini` (cloud), so local placement is moot until `ANALYZER=local`. |

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
   ASR, SPK) is assigned, resolved once from the device knobs at startup via the
   existing `_resolve_torch_device` pattern.
2. **`device → {reserved, total}`** — sampled per CUDA device actually in use
   (`torch.cuda.mem_get_info(idx)` / `memory_reserved(idx)` /
   `get_device_properties(idx)`), replacing today's hardcoded `(0)` reads.

Everything safety-critical reads **through** the ledger:

- **Recycle / watchdog** — soft & hard thresholds computed **per device** (each
  card's own fraction × that card's total) and fire if **any in-use device**
  crosses. A hard cross still triggers the existing **whole-process self-exit
  (code 43)**; the supervisor respawns a fresh process and all cards' contexts
  reload. So cross-card models recycle together — correct and simple. The
  multi-card rule is an **OR over in-use devices**.
- **`/health`** — reports a `devices[]` array (`idx`, `name`, `reserved`,
  `total`, resident engines) instead of one device's numbers. Existing scalar
  fields stay for back-compat, derived from the synth card.
- **Eviction / co-residency** — every "free VRAM before loading X" path gains
  the predicate **`shares_device(incoming, resident)`**. Models evict each other
  only when assigned the **same** card. Qwen on `cuda:0` + Kokoro on `cuda:1` →
  no eviction.

### Two control planes

- **Sidecar engines (5)** — assignment flows through the registry-knob →
  `buildSidecarEnv` path. Four knobs exist; we add **`KOKORO_DEVICE`**. The
  ledger reads these at load.
- **Analyzer Ollama (1)** — a stored preference threaded as the `main_gpu`
  option on `/api/chat` (sibling to the existing `num_gpu` via
  `resolveAnalyzerNumGpu()`), with daemon-level `CUDA_VISIBLE_DEVICES` as the
  documented robust hard-pin.

## Components

1. **Device discovery** — `GET /devices` on the sidecar enumerates CUDA devices
   `[{idx, name, total_mb, free_mb}]` (+ a `cpu` pseudo-option); a server proxy
   (copy the `/health` proxy pattern) exposes it to the frontend. Populates the
   picker and validates assignments. Depends on: torch.
2. **Device-assignment config** — the 6 stored assignments. Adds `KOKORO_DEVICE`
   (reuses `QWEN/COQUI/ASR/SPK_DEVICE`) + an analyzer-GPU preference.
   `buildSidecarEnv` already injects non-default `restart-sidecar` knobs, so
   Kokoro slots in; the analyzer value threads into `/api/chat`
   `options.main_gpu`. Depends on: registry, env-builder, `ollama.ts`.
3. **`DeviceLedger`** — the keystone above. Independently unit-testable with a
   stub torch (the `_StubTorch` pattern in `test_device_probe.py`).
4. **Device-aware recycle / watchdog / `/health`** — refactor: replace
   `get_device_properties(0)` / default-device `memory_reserved()` with ledger
   lookups; per-device thresholds; fire on any-card cross; `/health` gains
   `devices[]`. Highest-risk unit → heaviest test coverage.
5. **Device-aware eviction** — gate every evict-to-free path on
   `ledger.shares_device(...)`.
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

**Analyzer:** stored preference → threaded as `options.main_gpu` on the next
`/api/chat` model load; daemon `CUDA_VISIBLE_DEVICES` is the documented hard-pin
fallback.

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
  CPU-fall-back → load fails with a clear surfaced error ("Qwen needs ~XGB,
  cuda:1 has 8 GB"). The picker pre-warns when a known footprint exceeds the
  target card's VRAM.
- **Two co-resident models on the same small card** (e.g. Qwen Base +
  VoiceDesign during a design) → the existing co-residency OOM guard still
  applies, now correctly **scoped to that one card** via `shares_device`.

## Testing

Mapped to the five tiers, weighted toward the risky units.

**Sidecar pytest (heaviest):**
- `DeviceLedger` with a stub torch (reuse `_StubTorch`/`_torch` from
  `test_device_probe.py` / `test_qwen_device.py`): `engine→device` resolution
  from knobs, per-device `{reserved,total}` sampling, `shares_device` truth
  table, stale-device → safe-fallback + WARN.
- Recycle thresholds computed **per device**, firing when *any* in-use card
  crosses (the OR rule) — including the asymmetric case (16 GB fine, 8 GB over →
  recycle fires).
- Eviction: same-card pair evicts (today's behavior preserved) vs cross-card
  pair does **not** evict (the new behavior / the bug being fixed).
- `GET /devices` shape; `/health` `devices[]` shape + back-compat scalars.

**Server vitest:** `buildSidecarEnv` injects `KOKORO_DEVICE` when non-default;
analyzer `main_gpu` threads into `/api/chat`; `/devices` proxy; config write
**validates against discovered devices** (reject `cuda:5` on a 2-card box).

**Frontend vitest:** picker renders one row per unit, dropdown populated from
discovery, stale-assignment indicator, "restart to apply" affordance present.

**E2E (Playwright, one spec):** Settings → GPU panel renders against mocked
`/devices`, select a device for a unit, value persists across reload.

**Regression plan:** a new `docs/features/<n>-multi-gpu-per-model.md` from
`TEMPLATE.md` documenting the invariants (per-device recycle, same-card-only
eviction, loud-degrade-never-brick) and a manual **2-GPU on-box acceptance**
walkthrough — the automated tiers run on stub torch / single-GPU CI, so the
real 2-card behavior needs an on-box acceptance pass (consistent with the
"owed on-box" pattern on other GPU features).

## Key files

- `server/tts-sidecar/main.py` — `_cuda_vram_mb`, `_vram_recycle_*`,
  `_resolve_torch_device`, `_normalize_device_family`, the engine classes
  (`QwenEngine`, `CoquiEngine`, Kokoro, `WhisperEngine`, the ECAPA/SPK class),
  the eviction call-sites, `/health`. New: `DeviceLedger` module + `/devices`.
- `server/src/tts/spawn-sidecar.ts` — `buildSidecarEnv` (`KOKORO_DEVICE`).
- `server/src/config/registry.ts` — the device knobs (`KOKORO_DEVICE` knob +
  analyzer-GPU pref).
- `server/src/analyzer/ollama.ts` — `main_gpu` threading (sibling to
  `resolveAnalyzerNumGpu`).
- `server/src/routes/sidecar-health.ts` (+ a new devices route) — proxy.
- Frontend Settings view + a new GPU-assignment panel component.
- `server/.env.example` — document `KOKORO_DEVICE`, the analyzer GPU pref, and
  the `CUDA_VISIBLE_DEVICES` / `CUDA_DEVICE_ORDER` multi-GPU remap.

## Open questions / deferred

- **Auto-placement heuristic** — v1 ships the toggle + a simple "largest card
  gets synth, spare gets QA" suggestion. A smarter footprint-aware solver is a
  follow-up.
- **Per-card recycle granularity** — v1 self-exits the whole process on any
  card's hard cross (simplest, correct). A future refinement could reload only
  the offending card's engines if the self-exit cost becomes a problem.
