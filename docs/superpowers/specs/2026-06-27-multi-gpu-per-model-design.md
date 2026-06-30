---
title: Per-model GPU assignment (multi-GPU)
date: 2026-06-27
status: draft
---

# Per-model GPU assignment (multi-GPU)

> Four adversarial review rounds. R1 fixed the engine-grammar / VRAM-allocator
> model; R2 surfaced the config + Node-orchestration gaps; R3 re-cut
> foundation-first and reverted "own the Ollama daemon"; R4 (per-plan) proved the
> enablement layer and the per-card safety net are **co-requisite** (placement
> without per-card safety is an active OOM regression) and that several engine
> device APIs don't work as assumed. This revision merges them into **one runtime
> plan delivered in waves** + a picker plan, and folds in the engine-wiring
> reality.

## Problem

The TTS sidecar is single-GPU by design. Where engines *can* be GPU-pinned today
they default to one card (`QWEN_DEVICE=auto` → `cuda:0`; `COQUI_DEVICE` default
`auto`; `SPK_DEVICE`/`ASR_DEVICE` default **cpu**). On a 2-GPU box the second
card sits idle, and safety machinery on **both sides of the process boundary** is
single-card-bound:

- **Sidecar (Python):** the recycle ceiling, `/health` telemetry, and
  co-residency eviction read **device 0** (`_cuda_vram_mb`,
  `get_device_properties(0)`, `main.py:3342/4188`); `_VdKokoroArbiter`
  (`main.py:457`) couples VoiceDesign↔Kokoro unconditionally, across cards.
- **Server (Node):** the weighted GPU semaphore is a **single global pool**
  (`gpu/semaphore.ts:152`); the analyzer↔TTS co-eviction (`gpu/gpu-load.ts`,
  `gpu/residency.ts`, `gpu/vram-state.ts`) keys on **one device-0 scalar**.

Only Qwen is pinnable to a second card today (its knob is a free string; the
others are enums or absent). The moment two engines land on different cards the
safety net is blind or wrong — so **making engines placeable and making the
runtime per-card-safe must ship together** (R4: shipping placement alone hands
the user the device-0-watchdog OOM with no protection).

Reference hardware: **RTX 4070 Laptop 8 GB** (drives the display → *free* VRAM
well under 8 GB) + **RTX 5070 Ti 16 GB**. A verified stop-gap
(`CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES=1,0` in `server/.env`)
remaps the 16 GB card to visible `cuda:0`; retired by an `.env` cutover with the
picker (§2.5).

## Goal

Choose, **per model**, which GPU (or CPU) each runs on, with a runtime — sidecar
and server — that honors any assignment **safely** (per-card recycle,
same-card-only coupling, no harmful cross-card eviction) and shows the card a
model *actually* loaded onto. A bad assignment **degrades loudly and
recoverably**, never bricks.

### Delivery: two plans (Plan 1 in two waves)

- **Plan 1 — Device-aware placement & safety** (runtime, no UI). Placement and
  per-card safety are co-requisite, so they ship as one plan in two waves:
  - **Wave 1 — Placement + visibility:** discovery, config knobs, the engine
    device-adapter (incl. the inline `== "cuda"` sites), actual-card readback.
  - **Wave 2 — Per-card safety:** the ledger, per-card recycle + driver-free
    floor, `shares_device` coupling, per-card mutex, the code-43 streak guard,
    and the Node guards.
  Wave 1 is testable alone (pin an engine, see where it landed); Wave 2 must land
  **before** any cross-card placement is advertised as safe.
- **Plan 2 — Picker UI + canonical UUID.** Settings panel, UUID identity, the
  analyzer read-only row, `.env` cutover, auto-revert UX.

### Assignable units (6)

| Unit | Runtime | Real device API | Knob (after W1) |
|---|---|---|---|
| **Qwen** (Base + VoiceDesign, one assignment; peak ~6.5 GB) | torch | `.to("cuda:N")` | `QWEN_DEVICE` (string ✓) |
| **Coqui XTTS** (rarely loaded) | torch | `.to("cuda:N")` | `COQUI_DEVICE` (**enum→string**) |
| **ECAPA drift** (voice QA) | torch (speechbrain) | `run_opts={"device":"cuda:N"}` | `SPK_DEVICE` (**enum→string**) |
| **Kokoro** (eager, ~1 GB) | onnxruntime | **provider_options `[{device_id:N}]`** (not a name list) | new `KOKORO_DEVICE` |
| **Whisper ASR** (content QA) | CTranslate2 | **`device="cuda"` + `device_index=N`** (raises on bad index) | new `ASR_DEVICE` registry knob (env already read) |
| **Analyzer (Ollama)** | Ollama daemon (user/OS-managed) | OS-env `CUDA_VISIBLE_DEVICES` | **not app-pinnable; GPU/CPU-only signal** (§2.4) |

Five distinct device dialects; the analyzer's card is **unknowable to the app**
(only GPU/CPU via `detectOllamaDevice`, `ollama-health.ts:76`).

### Apply semantics

**Restart-to-apply**, but the restart differs by knob source: a value in
`server/.env` needs a **server** restart (re-read at process start); a config
*override* needs only the **sidecar** restart (the existing affordance). The
picker (Plan 2) wires the existing restart banner. The analyzer applies via
OS-env + an Ollama service restart (§2.4).

## Non-goals

- Auto-placement; app-owned Ollama daemon; synchronous per-card Node budgets
  (we ship guards over the global pool); multi-process sidecar; live
  re-placement; sharding one model across cards.

---

# Plan 1 — Device-aware placement & safety

## Wave 1 — Placement + visibility

**1.1 Device discovery + per-card sampler.** `GET /devices`
`[{uuid, idx, name, total_mb, free_mb}]` (+ `cpu`) via
`mem_get_info`/`get_device_properties`; server proxy. `/health` gains a **`gpus[]`**
array — a strict superset `{uuid, idx, name, total_mb, free_mb, torch_reserved_mb,
resident[], stale_reason?}` (the existing `devices` engine→family map at
`main.py:4109` stays). The per-device read here is the **single reusable
sampler** Wave 2's ledger wraps.

**1.2 Config knobs.** Widen `COQUI_DEVICE`/`SPK_DEVICE` from enum to **string**
(`registry.ts:424,281`; `SPK_DEVICE` has no `auto`). Add **`KOKORO_DEVICE`** and
an **`ASR_DEVICE`** registry knob (the ASR env is read today but isn't a knob).
Values accept `{cuda:N | cuda | cpu | auto}`.

**1.3 Engine device-adapter (Python) — and the inline `== "cuda"` sites.** One
module mapping a knob value to each engine's real API. It is *not* enough to add
the module; these exact-equality sites must be converted to `startswith("cuda")`
+ index handling, or they silently break under `cuda:N`:
- **Whisper:** `_compute_type` keys on `self._device == "cuda"` (`main.py:2824`);
  `WhisperModel(device=self._device, …)` (`main.py:2842`) — split into
  `device="cuda"` + `device_index=N` (faster-whisper rejects `cuda:1`; **raises**
  on a bad index — surfaces as a load error, not a silent CPU fallback).
- **SPK:** present-checks `self.device == "cuda"` (`main.py:2954,2969`); loads via
  `run_opts={"device":…}` (`main.py:2943`), not `.to()`.
- **Kokoro:** real `device_id` plumbing — `_resolve_ort_providers` (`main.py:843`)
  passes a provider **name list** with no `device_id`; rewrite to pass
  `provider_options=[{"device_id":N}]` into CUDAExecutionProvider (verify the
  pinned `kokoro-onnx` accepts it; else construct the `InferenceSession`
  directly), and reconcile with the legacy `KOKORO_ORT_PROVIDERS` env.
- **Qwen/Coqui:** torch `.to("cuda:N")` (already index-capable).

**1.4 Node device gates (separate change — Node can't call the Python adapter).**
**Both** `asrRunsOnGpu()` (`transcribe-client.ts:59`) **and the SPK embed gate**
(`embed-client.ts:41`) are `=== 'cuda'` tests that must parse `{cpu|cuda|cuda:N}`
and still emit the GPU semaphore token for the indexed form — else indexed
ASR/SPK runs untracked → OOM. (Widening `SPK_DEVICE` in 1.2 *creates* the embed
hazard; fixing both gates is part of the same wave.)

**1.5 Actual-card readback.** `/health gpus[].resident` reports the card each
engine **actually** loaded onto — replacing today's *requested-knob* echo
(`main.py:4106`). Index granularity is available only for the **3 torch engines**
(`param.device.index`); ORT/CT2 expose **family + a `fell_back` flag** only
(`get_providers()`/`get_provider_options()` — no reliable index). `stale_reason`
is an **enum** `{cpu_fallback | env_shadow | uuid_unresolved}`, set here for
`cpu_fallback`.

*Wave 1 DoD:* pin any engine via its knob; `/health gpus[].resident` shows it on
the requested card or flags `fell_back`. (Qwen is fully index-verifiable; Kokoro/
Whisper verify family + no-fallback.)

## Wave 2 — Per-card safety (co-requisite with Wave 1)

**Build order:** W2.1 ledger first; W2.2/W2.3/W2.4 read it; W2.5/W2.6 are independent.

**W2.1 `DeviceLedger` (thread-safe, never caches an index).** Wraps the 1.1
sampler. Read from three thread contexts (the `_memory_watchdog` loop, the sync
`/health`+`/devices` threadpool threads, `to_thread` workers) → **one
`threading.Lock`**. Index is **re-resolved and re-validated every sample**
(assert `get_device_properties(idx).uuid == expected`; mismatch ⇒ vanished →
ceiling 0). Two quantities, never conflated: **driver free/total** (`mem_get_info`,
all allocators — capacity/OOM) vs **torch reserved** (`memory_reserved`, torch
pool only — fragmentation; ORT/CT2 invisible).

**W2.2 Per-card recycle + driver-free floor + ceiling reconcile.** Fragmentation
ceiling per torch card (OR rule, each on its own freshly-read value). **New
driver-free floor** — an *absolute* free-headroom floor (`free_mb < FLOOR`; a
fraction self-satisfies on the idle display card → boot-loop). Default **1024 MB,
per-card, env `SIDECAR_VRAM_FREE_FLOOR_MB`; tune on-box** — the *only* OOM guard
for an ORT/CT2-only card. **Reconcile the Node adoption gate:** `/health` still
emits scalar `vram_total_mb`/`vram_restart_mb` from device 0 (`main.py:4126`) and
`sidecarCeilingMismatch` compares one scalar (`spawn-sidecar.ts:149`) — surface
per-card ceilings (incl. the free-floor) in `gpus[]` and make that check
per-card. *Blast-radius (documented limitation):* the hard self-exit (code 43) is
**whole-process** (`_restart_pending`/`_drain_then_restart`, `main.py:3485,3512`,
shared with the code-42 poison fence) — the 8 GB card's cross aborts in-flight
synth on the healthy 16 GB card; per-card drain deferred.

**W2.3 `shares_device` coupling.** Gate **both** the load-time evict-to-free paths
**and** the synth-time `_VdKokoroArbiter` (`main.py:457`). `auto` resolves to a
concrete device at ledger init; `shares_device(cpu,*)` ⇒ false; the VD↔Kokoro
boolean is computed **once into one flag both `design()` and `kokoro_synth()`
read** (asymmetric = no lock → the 8 GB spill returns). **Lock ordering:**
`design()` holds both the arbiter and the per-card mutex (W2.4) — define a fixed
acquire order to avoid deadlock.

**W2.4 Per-card load/evict mutex** (in the ledger). `_VD_KOKORO` covers only
VD↔Kokoro; any other same-card pair (e.g. Coqui + ASR) has a
check-residency→evict→load TOCTOU (`main.py:2147,2163`) — the whole sequence on a
card holds the card's mutex.

**W2.5 code-43 streak guard (detect + hold + log; revert deferred to Plan 2).**
`onChildExit` ignores `code` and `lived ≥ QUICK_DEATH_MS` resets the failure
counter (`sidecar-supervisor.ts:258,263`) — so a structurally-too-small
assignment recycles forever. Count **code-43 self-exits regardless of uptime**
(proposed **3 / 10 min**); on trip, **hold TTS down** and emit a **structured
trip event `{card, residentEngines[]}`** (written to the last-`/health` field +
a FATAL log) — the sidecar must plumb the offending card into its self-exit (a
bare code-43 carries none today). Plan 2 consumes the event for auto-revert.

**W2.6 Node guards over the global pool (GPU/CPU-scoped — Node isn't card-aware).**
Keep the single global semaphore (built eagerly with a fixed budget,
`semaphore.ts:152`; `acquire()` is synchronous so it can't await per-card data —
*that* is why these guards use coarse signals, not 1.5's actual card). Two guards:
- **Don't cross-charge:** drop the analyzer's whole-budget cost when the analyzer
  is on GPU and the TTS engine's *configured* card differs — scoped to the
  GPU/CPU signal Node actually has (`detectOllamaDevice`, `ollama-health.ts:76`),
  since the analyzer's card index is unknowable. Side effect to state: analyzer
  cost→0 also drops analyzer-vs-analyzer self-serialization.
- **Don't cross-evict:** `shouldEvictBeforeSidecarLoad` (`gpu/residency.ts:7`)
  takes only a scalar today — this is a **signature + call-site change** to pass
  the incoming engine's configured card; return false when it differs from the
  analyzer's GPU/CPU placement.
- `costForEngine` fallback of 1 (`engine-vram-cost.ts:40`, a deliberate
  "never grab the whole budget" invariant) → **high cost = serialize alone**
  (the semaphore can't "refuse"); update that comment in the same change.

*Plan 1 testing.* Pytest (shape, on a new richer stub with `mem_get_info`/`uuid`/
`memory_reserved`): adapter dialects incl. Kokoro `device_id`; the 6 `== "cuda"`
sites; ledger lock + uuid-mismatch→vanished; per-card OR fires on 8 GB not 16 GB;
driver-free floor trips on synthetic low-free; `shares_device` truth table;
code-43 streak trips despite uptime resets; the two Node guards. **On-box
(gating) — a WRITTEN checklist, not "named":** pin each engine and confirm actual
card; force an ORT-CPU fallback → `fell_back` shows; recycle fires on the right
card; cross-card analyzer+synth runs parallel; a too-small pin trips the streak +
holds TTS. Run by the one operator with the box (`test:sidecar` is venv-gated →
CI skips).

---

# Plan 2 — Picker UI + canonical UUID

**2.1 Canonical UUID identity.** Store assignments as a GPU **UUID** (stable
across index drift); **extend the 1.3 Python adapter** with a `uuid→index`
resolver (the injected env value may now be a UUID — 1.3 ships index-only, so
this is an explicit extension, and 1.3 should leave a resolve-to-index front
seam). **Reconcile every stored UUID against `/devices` on read** (config lives
in shared `~/.castwright/user-settings.json`; a UUID is box-specific) → set
`stale_reason: uuid_unresolved`.

**2.2 Settings picker.** One row per sidecar engine; dropdown of `/devices` cards
showing **free** VRAM; the badge renders the **three `stale_reason`s distinctly**
(`cpu_fallback`/`env_shadow`/`uuid_unresolved`) and **not by color alone** (a11y),
comparing assigned-vs-**actual** (1.5). **Wire the existing restart affordance**
(`RestartSidecarBanner` + `restartSidecar()`, today in `advanced.tsx`) into the
panel; **batch N row edits into one restart**; **disable env-locked rows** and
surface the locked-write 409 (`config.ts:53`). Footprint pre-warn uses driver
**free** + each engine's peak (Qwen ~6.5 GB; Coqui ~3 GB), re-checked **at load
time** in the sidecar.

**2.3 Auto-revert (consumes the W2.5 trip event).** On a code-43 streak trip,
revert the offending unit(s) and name them. Selection rule: the trip event
carries `{card, residentEngines[]}` — revert the engine(s) on that card to a
**different** safe card or CPU (not the knob default `auto`→cuda:0, which can
re-land on the same undersized card). Wiring: streak event → `writeConfigOverride`
→ restart.

**2.4 Analyzer read-only row.** Display GPU/CPU/unknown (`detectOllamaDevice`) +
a link to the documented OS-env path (set `CUDA_VISIBLE_DEVICES` +
`OLLAMA_FLASH_ATTENTION`/`KV_CACHE_TYPE` on the service, restart Ollama —
`docs/local-llm.md`). Not app-pinnable; gated on `ANALYZER=local`.

**2.5 env-shadow surfacing + `.env` cutover.** The `locked` state already exists
in `resolveKnob` (`resolver.ts:15`); expose a `lockedByEnv` field in the config
read so the picker shows `stale_reason: env_shadow`. `CUDA_VISIBLE_DEVICES`/
`CUDA_DEVICE_ORDER` are **raw env, not knobs**, so add a dedicated picker check
for them (the registry path can't see them). Cutover = a **documented manual
step** stripping `COQUI/ASR/SPK_DEVICE` + the two `CUDA_*` lines from
`server/.env` (no code edits a user's `.env`); the sidecar WARNs if
`CUDA_VISIBLE_DEVICES` is still set.

*Plan 2 testing.* Frontend vitest (rows, dropdown, three-reason badge,
analyzer read-only, disabled locked rows); server vitest (UUID accept/reject +
reconcile; auto-revert selection from a trip event; batched apply→one restart);
**a responsive `e2e/responsive/coverage.spec.ts` case (3 viewports)** + an **e2e
asserting the `fell_back` badge** against a mocked `/health` (it crosses
`/health`→redux→layout — CLAUDE.md's e2e bar); `test:a11y` on the panel. On-box
sign-off: `/health` driver free/total is VRAM truth; `torch_reserved`
under-reports ORT/CT2 by design.

---

## Key files

**Plan 1 / Wave 1** — `main.py` (`/devices`, `gpus[]`, engine adapter, the
Whisper/SPK/Kokoro device sites, actual-card readback replacing `:4106`);
`registry.ts` (widen `COQUI`/`SPK`; add `KOKORO`/`ASR`); `spawn-sidecar.ts`
(knob injection); `transcribe-client.ts` **+ `embed-client.ts`** (Node gates);
new `/devices` proxy route.

**Plan 1 / Wave 2** — `main.py` (`DeviceLedger`+lock, per-card recycle +
driver-free floor, `_VdKokoroArbiter` 457, per-card mutex, eviction sites,
self-exit card plumbing); `sidecar-supervisor.ts` (code-43 streak);
`spawn-sidecar.ts` (`sidecarCeilingMismatch` per-card); `gpu/semaphore.ts` +
**`tts/engine-vram-cost.ts`** + `gpu/gpu-load.ts` + `gpu/residency.ts`
(signature change) + `gpu/vram-state.ts` (Node guards).

**Plan 2** — `user-settings.json` (UUID + reconcile); Settings view + GPU panel
(reusing `advanced.tsx`'s restart banner); `resolver.ts` (`lockedByEnv` field);
`docs/local-llm.md`; `.env.example`.

## Open questions / deferred

- **Driver-free floor default** — 1024 MB proposed; confirm on-box.
- **Per-card recycle drain** — whole-process self-exit is a documented v1 limit.
- **Eventually-consistent per-card Node budgets** — the full per-UUID pool map
  (vs the §W2.6 guards) is a deliberate post-v1 item.
- **Kokoro `device_id` support** — contingent on the pinned `kokoro-onnx`
  accepting `provider_options`; the InferenceSession fallback is the hedge.
