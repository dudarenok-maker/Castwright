---
title: Per-model GPU assignment (multi-GPU)
date: 2026-06-27
status: draft
---

# Per-model GPU assignment (multi-GPU)

> Revised twice after adversarial review. The first revision fixed the
> engine-grammar / VRAM-allocator model; the second (this one) folds in a
> five-lens parallel review that found the **config layer** and the **Node-side
> orchestration layer** were under-modeled, split the work into **two sequential
> plans**, cut auto-placement, and made the analyzer row implementable by
> **owning the Ollama daemon**.

## Problem

The TTS sidecar is single-GPU by design. Every model loads onto one device, and
the defaults (`auto` → `cuda:0`, `COQUI_DEVICE=cuda`, `ASR_DEVICE=cuda`) resolve
to the same card. On a 2-GPU box the second card sits idle, and **safety
machinery on both sides of the process boundary is single-card-bound**:

- **Sidecar (Python):** the reserved-VRAM recycle ceiling, `/health` telemetry,
  and co-residency eviction are hardcoded to device 0 (`main.py:3342`,
  `_cuda_vram_mb`); the `_VdKokoroArbiter` (`main.py:457`) couples VoiceDesign↔Kokoro
  unconditionally even across cards.
- **Server (Node):** the weighted GPU semaphore is a **single global token pool**
  (`gpu/semaphore.ts:36-152`) with one `gpu.vramBudget`; the analyzer↔TTS
  co-eviction (`tts/gpu-load.ts`, `residency.ts`) keys on **one scalar total**.
  Neither can express "card A free / card B free."

Per-engine device knobs let a user *pin* engines to cards today, but the moment
two engines live on different cards the safety net is blind or wrong, and — per
the review — shipping a naive picker would make a 2-card box **more** OOM-prone
and **unable** to run the parallel analyze+synth workload that justifies the
second card.

Reference hardware: **RTX 4070 Laptop 8 GB** (drives the display → *free* VRAM
well under 8 GB) and **RTX 5070 Ti 16 GB**. A verified stop-gap
(`CUDA_DEVICE_ORDER=PCI_BUS_ID` + `CUDA_VISIBLE_DEVICES=1,0` in `server/.env`)
remaps the 16 GB card to the visible `cuda:0`. **This feature owns device
mapping**; the stop-gap is retired by an explicit `.env` cutover when Plan B
lands (see §B5).

## Goal

Let the user choose, **per model**, which GPU (or CPU) each runs on, with a
runtime — sidecar **and** server — that's genuinely device-aware so any
assignment is honored **safely**: per-card recycle, per-card VRAM budgeting,
same-card-only coupling, and **observability of the card a model *actually*
loaded onto** (not just the one requested). A bad assignment must **degrade
loudly and recoverably**, never brick.

Auto-placement is **cut** (a 2-card box has one obvious layout, set once).

### Delivery: two sequential plans

The review converged on this split; it de-risks the hard config work.

- **Plan A — Device-aware safety net.** Pure runtime (sidecar Python + Node
  semaphore/eviction). Ships value alone by fixing the device-0 hardcodes and
  the unconditional cross-card coupling. No UI. Testable as far as it ever will
  be (stub-torch for shape; on-box for truth).
- **Plan B — The picker + owned Ollama daemon.** Config-layer rework, device
  discovery, Settings UI, and app-owned `ollama serve` so the analyzer is really
  assignable. Built on a green Plan A.

### Assignable units (6)

| Unit | Runtime | Device API | Knob status | Notes |
|---|---|---|---|---|
| **Qwen** (Base 0.6B + VoiceDesign 1.7B) | torch | `cuda:N` via `.to()` | `QWEN_DEVICE` (string ✓) | Base + VoiceDesign **share one assignment**; co-reside during a design. Peak ~6.5 GB. |
| **Coqui XTTS** | torch | `cuda:N` via `.to()` | `COQUI_DEVICE` (**enum → widen to string**) | rarely loaded (`PRELOAD_COQUI=0`). |
| **ECAPA drift** (voice-consistency QA) | torch (speechbrain) | `cuda:N` via `.to()` | `SPK_DEVICE` (**enum → widen to string**) | promotable to spare card. |
| **Kokoro** | **onnxruntime** | **ORT provider `device_id`** | _new_ `KOKORO_DEVICE` | eager at startup (~1 GB). Separate allocator from torch (`main.py:460`). |
| **Whisper ASR** (content QA / WER) | **CTranslate2** | **`device="cuda"` + `device_index`** | **no knob today → add one** | separate allocator; read by a Node gate too (`transcribe-client.ts:59`). |
| **Analyzer (Ollama)** | Ollama daemon (**now app-owned**) | daemon `CUDA_VISIBLE_DEVICES` | _new_ pref | app will spawn/supervise `ollama serve` (§B6) so env injection is real. Dormant on this box until `ANALYZER=local`. |

**No uniform device grammar.** Three engines are torch (`cuda:N`), Kokoro is ORT
(`device_id`), Whisper is CTranslate2 (`device`+`device_index`). The picker
stores a **canonical UUID** (or `cpu`); a Python-side **engine device-adapter**
(§A7) translates it per engine. The adapter also accepts legacy forms
(`cuda:N | cuda | cpu | auto`) so existing pins keep working.

### Apply semantics

**Restart-to-apply** for every unit (sidecar restart for the 5 engines; daemon
restart for the analyzer). Matches existing `apply:'restart-sidecar'` knobs; no
live cross-card migration.

## Non-goals

- **Auto-placement** (cut).
- **Multi-process sidecar.** One process drives N cards; per-device accounting ≠
  per-device processes.
- **Live re-placement.** Restart-to-apply only.
- **Sharding one model across cards.**

---

# Plan A — Device-aware safety net

## A1. `DeviceLedger` (sidecar, new module) — thread-safe, never caches an index

Owns `engine → device` (by **GPU UUID**) and per-device VRAM samples. It is read
from **three thread contexts** — the `_memory_watchdog` event loop, the sync
`/health` + `/devices` Starlette threadpool threads, and `asyncio.to_thread`
synth/load workers — so:

- **One `threading.Lock`** guards the `uuid→index` map and any cached state.
  Today's `_cuda_vram_mb` is stateless (safe by accident); the ledger is mutable
  and must not rely on the GIL for multi-bytecode map updates.
- **uuid→index is re-resolved and re-validated every sample, never cached.** A
  vanished card makes torch renumber survivors *downward*, so a stale index
  silently reads the **wrong healthy card** (no exception). Each read asserts
  `get_device_properties(idx).uuid == expected_uuid`; mismatch ⇒ treat as
  vanished (ceiling → 0). This is what actually makes the "vanished → None"
  fail-safe true.
- **Two distinct per-device quantities, never conflated:**
  - **driver free/total** via `mem_get_info(idx)` — visible across *all*
    allocators (torch, ORT, CTranslate2). Drives capacity/OOM/eviction reasoning.
  - **torch reserved** via `memory_reserved(idx)` — torch caching-allocator pool
    only; invisible to Kokoro(ORT)/Whisper(CT2). Drives *only* the
    fragmentation self-exit, *only* on torch-hosting cards.

## A2. Per-device recycle / watchdog — and a real driver-free ceiling

- **Fragmentation ceiling** (torch reserved): computed per torch-hosting device,
  fires on **any** crossing (OR rule). Each card is evaluated on its own freshly
  read value (no torn-snapshot risk).
- **Driver-free ceiling (new):** a card hosting *only* ORT/CT2 engines reads
  torch-reserved ≈ 0, so the fragmentation ceiling is inert — it has **no OOM
  protection today**. Add a per-device watchdog branch that recycles/self-exits
  on **driver-free** crossing, so ORT/CT2-only cards are actually guarded, not
  just sampled for display.
- **Blast-radius (documented limitation):** the hard self-exit (code 43) is
  **whole-process** — `_restart_pending` + `_drain_then_restart` are process-wide
  (`main.py:3485,3512`). So the 8 GB card crossing its ceiling drains and aborts
  in-flight synth on the *healthy* 16 GB card. v1 accepts this (per-device drain
  on a single `_inflight_synth` is non-trivial); it is stated, not buried, and
  deferred as a known limitation.
- **Crash-loop protection (new — closes a brick path):** a structurally-too-small
  assignment loops `load→synth→cross→drain(≤180 s)→self-exit` forever, because
  living >`QUICK_DEATH_MS` (30 s) **resets** `consecutiveFailures`
  (`sidecar-supervisor.ts:40,263`) and `onChildExit` never inspects `code`. Add a
  **code-43 streak detector** counting consecutive VRAM self-exits in a
  wall-clock window *regardless of child uptime*; on cap-trip, hold TTS down,
  **auto-revert the offending unit to its safe default**, and name the knob in a
  FATAL line.

## A3. `shares_device` coupling — symmetric, resolved once

Both VRAM-coupling mechanisms gate on `shares_device(a, b)`:

1. load-time evict-to-free paths, **and**
2. the synth-time `_VdKokoroArbiter` (`main.py:457`) VoiceDesign↔Kokoro forward lock.

Rules:
- `auto` is resolved to a **concrete UUID at ledger init**, before any
  `shares_device` evaluation (an unresolved `auto` drifts across boots once the
  remap is gone).
- `shares_device(cpu, *)` ⇒ **false** (no VRAM contention).
- The VD↔Kokoro boolean is computed **once at startup into a single flag both
  `design()` and `kokoro_synth()` read** — never recomputed per-call on either
  side. A predicate only one party respects is no lock (asymmetric → the 8 GB
  three-way spill returns).

## A4. Per-card load/evict mutex

`_VD_KOKORO` only covers VoiceDesign↔Kokoro. Any *other* same-card pair the
design now allows (e.g. Coqui + ASR on `cuda:0`) has a check-residency → evict →
load TOCTOU with no covering lock (the `is not None` residency checks at
`main.py:2147,2163` already race). Add a **per-physical-card load/evict mutex**
in the ledger; the whole check-evict-load sequence on a card holds it.

## A5. Node GPU semaphore → per-device

The single global pool (`semaphore.ts:36-152`, budget sized for one 8 GB card)
gives **zero per-card protection** on two cards. Make the budget **per-device**,
keyed by the resolved engine→card UUID; costs (`engine-vram-cost.ts`) charge the
**target card's** pool. Consequences:

- The analyzer (cost 4 = whole budget, `engine-vram-cost.ts:23`) must **not**
  charge the TTS card's pool when it resolves to a different card — otherwise it
  serializes all TTS and forbids the parallel analyze+synth that justifies the
  second card.
- `costForEngine`'s unknown-key fallback of 1 (`engine-vram-cost.ts:57`) is
  unsafe against a small per-card budget — make it conservative (refuse, or
  charge a high cost) rather than 1.

## A6. Node co-eviction + the `/health` scalar that feeds it

- `shouldEvictBeforeSidecarLoad` (`residency.ts:9`) must take **both** the
  incoming sidecar engine's card and the analyzer's card and return **false when
  they differ** — else it evicts the warm analyzer to "free" a card it isn't on.
- **The scalar that feeds eviction must be the target *load* card's total**, not
  Qwen's device (my earlier M2 choice was wrong: reporting 16 GB makes eviction
  skip and loads XTTS onto the cramped 8 GB card → OOM).

## A7. Engine device-adapter (Python) + actual-card reporting

- One Python module translates a canonical assignment (UUID / `cpu` / legacy
  `cuda:N|cuda|auto`) into each engine's native API: torch `cuda:N`
  (Qwen/Coqui/SPK), ORT provider `device_id` (Kokoro), CT2 `device`+`device_index`
  (Whisper). **All `*_DEVICE` env reads route through it** — including the Node
  ASR gate (`transcribe-client.ts:59`), which must learn the `cuda:N` form or it
  silently skips the GPU token.
- **`/health` reports the card each engine *actually* loaded onto**, probed from
  the live module / ORT session (`get_providers()` already exists,
  `main.py:4010`) — not the requested assignment. This closes the recurring
  "Kokoro silently on CPU" class (memory: `project_kokoro_cpu_onnxruntime_gpu_swap`)
  instead of re-creating it at 2× surface. ORT/CT2 bad-`device_id` silently falls
  back to CPU and the eager loader swallows it (`main.py:3716`), so read-back +
  WARN + a structured stale flag is the only honest signal.
- **`/health` field naming:** `/health` *already* exposes a `devices` map
  (engine→family, `main.py:4109`). The new per-card array is **`gpus[]`**
  (`{uuid, idx, name, free, total, torch_reserved, resident:[{engine, actual_card}]}`),
  leaving `devices` untouched.

## A8. Plan A testing

- **Honest framing:** stub-torch (`test_device_probe.py`'s `_StubTorch` has no
  `mem_get_info`/`uuid`/`memory_reserved`) can only test **shape/arithmetic** of
  a *new richer stub we hand-feed*. It cannot reproduce multi-allocator VRAM, ORT
  `device_id`, CT2 `device_index`, or UUID drift. Mark these pytest cases
  "shape-only."
- **The gating validation is the on-box 2-GPU acceptance** (`test:sidecar` is
  venv-gated → skips in CI). Budget it as a deliverable, not a footnote.
- Pytest (shape): ledger lock present; uuid mismatch ⇒ vanished; per-card OR
  fires on the 8 GB but not 16 GB; `shares_device` cpu/auto/same-uuid truth
  table; adapter resolves each engine's dialect; code-43 streak detector trips on
  a uptime-resetting loop.
- Server vitest: per-device semaphore charges the right card; cross-card analyzer
  doesn't block TTS; `shouldEvictBeforeSidecarLoad` false across cards; ASR Node
  gate handles `cuda:N`.

---

# Plan B — Picker + owned Ollama daemon

## B1. Config schema — the foundation the picker needs

The "reuse the four knobs + store UUID" premise was wrong on three counts:

- **Widen the device knobs from `enum` to `string`** — `COQUI_DEVICE`/`SPK_DEVICE`
  are `enum[auto/cpu/cuda]` (`registry.ts:424,281`) and `coerceAndValidate`
  rejects anything else (`resolver.ts:73`); they cannot hold a UUID. Validate
  against discovered `/devices` UUIDs instead of a fixed list.
- **Add an `ASR_DEVICE` registry knob** (`apply:'restart-sidecar'`) — there is
  none today (`registry.ts`), so the injection loop (`spawn-sidecar.ts:464`) has
  nothing to write. "Reuse `ASR_DEVICE`" was a false premise.
- **Env carries the UUID; Python resolves it.** Node can't run torch, so
  `buildSidecarEnv` injects the UUID verbatim and the adapter (§A7) resolves
  UUID→index at load. Delete the "Node produces the resolved torch form" claim;
  rewrite `_resolve_torch_device` to map UUID→index (today it passes a non-`auto`
  value straight into `torch.to(...)` → crash on a UUID).

## B2. `.env` shadow cutover

`resolveKnob` checks `process.env` **first** and returns `locked` before reading
config overrides (`resolver.ts:15-30`). The user's `.env` sets `COQUI_DEVICE`,
`ASR_DEVICE` — so a picker write to those is a **silent no-op**. Therefore:

- The picker **detects a locked env knob** and surfaces "shadowed by
  server/.env" rather than pretending the write took.
- The cutover step strips `COQUI_DEVICE`/`ASR_DEVICE`/`SPK_DEVICE` **and**
  `CUDA_VISIBLE_DEVICES`/`CUDA_DEVICE_ORDER` from `.env` (these live only in the
  user's gitignored `.env`; **no code edits a user's `.env`** — the spec's
  earlier "removed in spawn-sidecar.ts" was fiction). The sidecar **WARNs** if
  `CUDA_VISIBLE_DEVICES` is still set while the picker owns mapping.

## B3. Device discovery

`GET /devices` (sidecar) → server proxy → frontend:
`[{uuid, idx, name, total_mb, free_mb}]` + a `cpu` option. `free_mb` (driver
truth) is shown so the picker reflects the display card's real headroom.

## B4. Settings picker UI

One row per unit; a dropdown of discovered cards (each showing **free** VRAM);
**the stale badge compares assigned-vs-*actual*** (from §A7), not
assigned-vs-discovered — so a silent CPU fallback is visible. A structured
`/health` field **and a visible picker banner** carry the "fell back / shadowed /
stale" signal — not a log WARN the user must grep (memory:
`feedback_self_service_observability`). The existing "restart sidecar to apply"
affordance applies.

## B5. Failure handling at the picker boundary

- **Stale/invalid heavy engine (Qwen/Coqui) clamps to `cpu` or hard-fails** with
  the surfaced "needs ~X GB, card has Y GB free" error — **not** `cuda:0`, which
  on this box is the 8 GB display card (clamping there just relocates the OOM and
  arms the A2 crash-loop). Only CPU-degradable QA engines (ASR/SPK) may clamp to
  CPU silently-but-flagged.
- **Vanished card mid-run** escalates to the existing **poison self-exit (code
  42)** path (`main.py:4689`) + supervised respawn — the real recovery the spec
  must name; disabling the ceiling alone only blinds the watchdog.
- **Footprint pre-warn uses driver *free* and Qwen *peak*** (Base+VoiceDesign
  co-resident ~6.5 GB), re-checked **at load time** in the sidecar (the WDDM
  display card's free swings between pick-time and load-time), not only at pick
  time in the UI.

## B6. Own the Ollama daemon (makes the analyzer row real)

Today the app only *connects* to a user-managed daemon (`ollama.ts:78`); it never
spawns `ollama serve`, so it **cannot** inject `CUDA_VISIBLE_DEVICES`. Per the
chosen direction, the app **takes over the daemon lifecycle**, mirroring the
sidecar supervisor (`sidecar-owner.ts` / `spawn-sidecar.ts`):

- spawn/supervise `ollama serve` with the analyzer card's `CUDA_VISIBLE_DEVICES`
  in its env; an `autoStartOllama` preference (default following existing
  behavior); `taskkill /T /F` teardown on Windows.
- **Adopt-don't-fight** an externally-running daemon (as the sidecar owner does)
  so we don't kill a user's existing `ollama serve`; only an app-owned daemon
  carries the pinned env. Restart-to-apply.
- Gated behind `ANALYZER=local` (dormant on this box under `ANALYZER=gemini`).

## B7. Portability + legacy pins

`user-settings.json` lives in `~/.castwright` and is shared across checkouts /
copyable (`user-settings.ts:24`). A stored UUID is **box-specific** — reconcile
every stored UUID against `/devices` **on read** (mark stale in `/health` +
picker), and have the adapter accept `{uuid | cuda:N | cuda | cpu | auto}` so a
pre-existing `QWEN_DEVICE=cuda:1` keeps working. `device-total.ts`'s first-GPU-only
nvidia-smi parse (`device-total.ts:15`) must become per-GPU (`--id=<uuid>`) before
the analyzer plane consumes it for keep-alive sizing.

## B8. Plan B testing

Frontend vitest (rows, discovery-populated dropdown, assigned-vs-actual stale
badge, banner); server vitest (knob widening accepts UUID + rejects unknown;
ASR knob injection; env-shadow detection; owned-daemon env injection); one
Playwright e2e (Settings GPU panel against mocked `/devices`, select, persists);
**on-box 2-GPU acceptance** is the gating sign-off, with the note that `/health`
`free/total` (driver) is the VRAM truth while `torch_reserved` under-reports any
ORT/CT2 card by design.

---

## Key files

**Plan A** — `server/tts-sidecar/main.py` (`_cuda_vram_mb`, `_vram_recycle_*`,
`_memory_watchdog`, `_VdKokoroArbiter` 457, eviction call-sites, `/health`;
new `DeviceLedger` + adapter + driver-free ceiling + actual-card probe);
`server/src/gpu/semaphore.ts` + `server/src/tts/engine-vram-cost.ts` (per-device
budget); `server/src/tts/gpu-load.ts` + `residency.ts` + `vram-state.ts`
(cross-card eviction + target-card scalar); `server/src/tts/transcribe-client.ts`
(ASR `cuda:N` gate); `server/src/tts/sidecar-supervisor.ts` (code-43 streak).

**Plan B** — `server/src/config/registry.ts` (widen enums → string, add
`ASR_DEVICE`); `server/src/config/resolver.ts` (env-shadow surfacing);
`server/src/tts/spawn-sidecar.ts` (`KOKORO_DEVICE`/`ASR_DEVICE` injection);
new `GET /devices` + server proxy; `server/src/analyzer/ollama.ts` + a new
ollama-owner (spawn/supervise daemon); Settings view + GPU-assignment panel;
`server/src/tts/device-total.ts` (per-GPU); `.env.example` (document knobs +
cutover); `~/.castwright/user-settings.json` reconcile-on-read.

## Open questions / deferred

- **Per-card recycle drain** — v1 self-exits the whole process on any card's hard
  cross (documented limitation A2). A future refinement could drain/reload only
  the offending card's engines.
- **Owned-daemon migration** — taking over `ollama serve` for users who run it as
  a system service needs a graceful adopt/handover story (sketched in B6, to be
  detailed in Plan B's implementation plan).
