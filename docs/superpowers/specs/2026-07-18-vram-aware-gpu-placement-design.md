---
status: draft
date: 2026-07-18
revised: 2026-07-18 (Option A — sidecar-owned TTS admission, after adversarial review)
supersedes:
  - docs/superpowers/specs/2026-06-16-vram-budget-aware-gpu-policy-design.md (deferred MB-accounting — this reverses that deferral)
related:
  - docs/superpowers/specs/2026-07-17-ollama-parallel-chunk-analysis-design.md (per-model lease / K limiter)
  - docs/features/223-vram-telemetry-substrate.md (fs-45 telemetry)
  - docs/superpowers/plans/2026-06-14-amd-gpu-phase2-enablement.md (AMD groundwork)
  - docs/local-llm.md (maintained seed footprints)
  - docs/tts-performance.md (measured decode-peak VRAM)
---

# Capacity-aware model placement — replace the hand-set GPU budget with live measurement

## Problem

Castwright's GPU arbitration is a hand-set token budget disconnected from real
hardware. An operator is expected to hand-tune **four overlapping knobs**:

- `GPU_VRAM_BUDGET` (default `0` = disabled) — a token budget for a weighted
  FIFO semaphore.
- `GPU_CONCURRENCY` (default `1`) — a fallback used when the budget is `0`.
- Six `GPU_WEIGHT_*` knobs (`kokoro 1, qwen 1, coqui 3, analyzer 4, asr 1,
  spk 1`) — per-engine "costs", **explicitly marked provisional and never
  measured** (`server/src/tts/engine-vram-cost.ts`).
- `ANALYZER_OLLAMA_CONCURRENCY` (K, default `2`) — a separate analyzer limiter.

None read the hardware. The one `nvidia-smi` probe that exists
(`getDeviceTotalVramMb()`) is "recorded but unconsumed"; the only knob tied to
detected VRAM is a coarse evict threshold (`GPU_SAFE_COEXIST_MB`).

This was adequate for one fixed 8 GB NVIDIA card. It fails the operator's actual
hardware and the product's target hardware:

- **8 GB laptop RTX 4070** (always present), **plus sometimes a 16 GB card over
  eGPU**. The operator switches between a 1-card and a 2-card machine, and the
  eGPU can **drop off the CUDA bus mid-session** (the known "GPU is lost"
  poison/hang). A boot-time snapshot or a static per-machine profile is wrong the
  moment the hardware changes.
- **Ollama self-distributes** the analyzer model's layers across *both* cards
  when the eGPU is present. A single pooled token budget structurally **cannot
  represent an opaque process that spreads itself across two physical cards.**
- **Non-NVIDIA hardware.** Castwright must also run on AMD (ROCm) and Apple
  Silicon (Metal/unified memory), plus pure CPU.

The result is a per-machine hand-tuning treadmill with no upside, and a
"effective N" number that misleads operators into raising the budget — which
enables model co-residence and causes the exact OOM the feature exists to
prevent.

## Goals

1. **No OOM in any hardware state** — 1-card (8 GB), 2-card (8 + 16 GB), AMD,
   Apple, or CPU-only — **without any config change between them.** Primary
   acceptance criterion.
2. **Zero hand-tuning.** The system reads real free capacity per device and its
   own measured footprint history; the operator sets nothing per machine.
3. **Cross-vendor.** NVIDIA, AMD (ROCm), Apple (unified memory), and CPU are all
   first-class.
4. **Survive eGPU hot-plug/unplug** without a restart.
5. **Use every available device** — heavy models prefer the roomier one.
6. **Delete the confusing surface.** Remove the four budget knobs + the six
   weights + the weighted-token math. Keep exactly **one** safety knob.

## Non-goals

- **Controlling Ollama's placement.** Its layer-splitting stays as-is; we read
  the capacity it leaves behind, never pin or reshape it.
- **Rebalancing already-resident models.** Placement is decided at *load* time;
  a resident model is not migrated between devices. A per-synth call runs the
  model on the device it's already resident on.
- **Perfect footprint prediction.** Estimates are measured-then-learned and
  deliberately conservative; the reserve knob + the reservation ledger absorb the
  slack.
- **Replacing the analyzer K limiter** (`ANALYZER_OLLAMA_CONCURRENCY`); it stays.
- **Making every engine run on every accelerator.** Where an engine can't use the
  local accelerator (e.g. faster-whisper has no Metal path), it degrades to CPU.

## Governing principle

> **Real free capacity per compute device, measured live, is the only source of
> truth. Every external process (Ollama especially) is an opaque consumer we read
> but never model. No model load or synth starts unless its measured
> peak-under-load footprint provably fits the real free capacity on its device,
> minus a reserve — and the decision is made where the model's residency lives.**

That last clause is the outcome of the adversarial review (below): the TTS
engines are **resident singletons owned by the Python sidecar**, which evicts
them on its own idle watchdogs invisibly to Node. A Node-held reservation for
them would either leak or reserve the wrong device. So **TTS admission lives in
the sidecar**, co-located with residency and eviction. The **analyzer** is
Node-observable (Ollama `/api/ps`) and stays Node-gated.

## Ownership split

| Concern | Owner | Why |
|---|---|---|
| Per-device free VRAM (`/capacity`) | **Sidecar** (torch), Node client + `nvidia-smi`/`rocm-smi` fallback | torch gives portable global-free across CUDA/ROCm; sidecar is where models load |
| TTS/ASR/embed placement + reservation + own-idle-evict | **Sidecar** (`PlacementController`) | residency + eviction live here; only place a per-device reservation is safe |
| TTS peak footprints | **Sidecar** (`FootprintTable`, Python) | placement needs them in-process; seeded from `local-llm.md`, up-only from torch `max_memory_allocated` |
| Same-engine synth thread-safety serialization | **Sidecar** (`_synth_lock`, existing) | the Qwen forward is not thread-safe (`tts-performance.md`) |
| Analyzer width-K limiter + per-model GPU lease | **Node** (`CountSemaphore`) | analyzer is Node-observable via `/api/ps`; K governs call concurrency |
| Evict the Ollama analyzer to free room for TTS | **Node** (`residency.ts`) | Node owns the Ollama lifecycle |
| The "Queued (N ahead)" surface | **Node** (`/api/gpu/queue`) | Node orchestrates the TTS retry/queue loop |

## Architecture

### Sidecar (Python) — the TTS admission authority

- **`GET /capacity`** — a vendor-abstracted probe returning a live
  `ComputeDevice[]`: `{ kind: 'cuda'|'rocm'|'mps'|'cpu', index, label, totalMb,
  freeMb }`. Backends: `torch.cuda.mem_get_info(i)` per device (driver-global
  free, so it sees Ollama too; torch reports ROCm as `cuda`); Apple = one `mps`
  device whose free is available system RAM; CPU always present. A per-device
  exception (dropped eGPU / "GPU is lost") **omits** that device, never fatal.

- **`FootprintTable` (Python)** — **peak-under-load** MB per (engine, model,
  run-config) for the sidecar engines only. `local-llm.md` is the maintained seed
  source of truth; the Python seed map is a **parity-tested mirror** (a pytest
  parses the doc's numbers and asserts equality — not a keyword regex). At the end
  of each synth the controller reads `torch.cuda.max_memory_allocated(device)` and
  **ratchets the stored estimate up-only** (`max(seed, observed)`); a lower
  observation never lowers the guard.

- **`PlacementController` (Python)** — the admission authority for the sidecar's
  own models. For a `/load` or `/synthesize`, under the per-engine synth lock:
  1. **Target device.** Resident engine → its current device (no migration).
     New load → the device with the most headroom that fits.
  2. **Peak.** `peak = FootprintTable.peak(engine, model, cfg)`.
  3. **Reserve.** Hold `peak` in a Python `ReservationLedger` for **this op's
     duration only** (released in a `finally`). Admit against
     `min(torch_free(device), total(device) − Σ reserved(device)) − reserve`.
     Per-call because the peak is a decode-time spike; an idle resident model's
     weights are already in `torch_free`, so only in-flight peaks need reserving.
  4. **If it doesn't fit:** try the sidecar's own idle-evict (Qwen VoiceDesign /
     Base17 past idle-TTL, idle ASR/ECAPA), re-check. Cheap CPU-capable engines
     (Kokoro/ASR/embed) fall back to `cpu`.
  5. **If it still doesn't fit:** return **`503` `{ neededMb, deviceKey,
     analyzerEvictWouldHelp }`** — a structured no-capacity, not a hang.
     `analyzerEvictWouldHelp` is true when the shortfall on `deviceKey` would be
     covered by whatever the Ollama analyzer holds there.

- **Device honoring on load** (`main.py`) — the real load handlers
  (`_ensure_base_loaded` / `_ensure_base17_loaded` / `_ensure_design_loaded` /
  the ORT `InferenceSession` device pin / Coqui `.to`) accept the
  `PlacementController`'s chosen device instead of the fixed `QWEN_DEVICE` /
  `COQUI_DEVICE` env. Since a resident model is never migrated, device selection
  happens only on a cold load, honoring the non-goal.

### Server (Node) — analyzer gate + evict + queue

- **`CountSemaphore`** (`server/src/gpu/count-semaphore.ts`, new) — the **count**
  core extracted from today's `GpuSemaphore` (FIFO, `acquire`/release,
  `resize()`, `queueDepth`, `inFlight`), *without* the token/cost weighting.
  Backs the analyzer width-K limiter (`analyzer-concurrency.ts`, unchanged
  behavior — it was already a `GpuSemaphore` used as a count limiter with live
  `resize()`).

- **`CapacityProbe`** (`server/src/gpu/capacity-probe.ts`, new) — a thin client
  of the sidecar `/capacity`, last-known-good cached like `sidecar-health.ts`.
  **Sidecar-down fallback:** when `/capacity` is unreachable (analysis phase,
  RSS recycle) the server shells its own `nvidia-smi` / `rocm-smi` so GPU truth
  survives sidecar churn; only when *no* probe of any kind succeeds does it report
  CPU-only. Consumed by the evict decision and the status display — **not** on the
  TTS synth hot path.

- **TTS call sites** (`server/src/tts/sidecar.ts`) — a synth calls the sidecar and
  handles its response: `200` → done; `503 no-capacity` → if
  `analyzerEvictWouldHelp` **and** no analysis is mid-flight, evict the Ollama
  analyzer (`residency.ts`) and retry once; else **enqueue** the op (visible in
  the pill) and retry when a release signal fires. The old per-engine
  `GpuSemaphore(1)` synth lock here is **removed** — same-engine serialization is
  the sidecar's `_synth_lock`.

- **Analyzer GPU lease** (`analyzer-concurrency.ts`) — the per-model lease that
  today takes a weighted `gpuSemaphore` slot no longer touches a VRAM budget; the
  analyzer's actual footprint is read from Ollama `/api/ps`
  (`server/src/routes/ollama-health.ts`), and the K limiter runs on the extracted
  `CountSemaphore`. Node's only VRAM action for the analyzer is the evict.

- **`GET /api/gpu/queue`** — payload becomes `{ devices: ComputeDevice[],
  residentByDevice, queueDepth }`. The existing `diagnostics.ts` consumer
  (`readGpuQueueState`) and the frontend pill's `max`/depth contract are migrated
  in the same change, not left dangling.

### Why footprint = peak-under-load, not weight size

The number admitted against must be the model's **peak under its run config**,
because that is what OOMs:

- Qwen 0.6B **weights ~1.2 GB**, but **decode peak** at
  `QWEN_BATCH_SIZE=32/QWEN_BATCH_TOKEN_BUDGET=3600` is **~5.6 GB**; 4800 → ~6.9 GB
  ("too hot" on 8 GB) — `tts-performance.md`. Operator-confirmed: 0.6B ≈ 4 GB,
  1.7B ≈ 7 GB max. The seed rounds up to the higher of doc vs. operator.
- Analyzer weights + KV: qwen3.5:4b ~3.0 GB + ~1.0–1.5 GB KV — `local-llm.md`
  (but the analyzer is read from `/api/ps`, not seeded).

### Data flow

**TTS/ASR/embed op (sidecar-authoritative):**
```
Node synth request ─► sidecar /synthesize (device unset; sidecar decides)
                         │  under _synth_lock(engine):
                         │   peak = FootprintTable.peak(engine, model, cfg)
                         │   dev  = resident_device(engine) or best_fit()
                         │   if min(torch_free(dev), total(dev)-Σreserved(dev)) - reserve >= peak:
                         │        reserve(dev, peak); place/run; record peak up-only; release
                         │   else: idle_evict() and retry; cpu-fallback if cheap
                         │   else: 503 { neededMb, deviceKey, analyzerEvictWouldHelp }
                         ▼
Node handles 503: analyzerEvictWouldHelp && !analysisInFlight ? evictOllama()+retry
                  : enqueue (pill), retry on release
```

**Analyzer op (Node-authoritative):** width-K `CountSemaphore` + per-model lease;
footprint read from `/api/ps`; Node evicts Ollama before a TTS load only when the
sidecar's `503.analyzerEvictWouldHelp` says it would help.

## Multi-device & eGPU hot-plug

- **Live enumeration.** Each cold-load decision re-reads `/capacity`, so an
  attached eGPU (two devices) or a dropped one (one device) is picked up with no
  restart. Per-synth calls on a resident model do **not** re-probe (residency is
  fixed) — the probe is off the hot path.
- **eGPU attach** → new device with ~16 GB free; the next cold load prefers it.
- **eGPU drop mid-session** → the device vanishes from `/capacity`; any op in
  flight on it is already dead (existing "GPU is lost" handling fails it fast);
  the sidecar's ledger reservation for that op is released in its `finally`; new
  placement sees only the remaining device. Node surfaces a toast + re-queues.
- **Apple / CPU-only** collapse to a single device; unchanged algorithm.

## Ollama as an opaque consumer

We never set `CUDA_VISIBLE_DEVICES` / `OLLAMA_SCHED_SPREAD` / `num_gpu` for
placement. Ollama's split is invisible to torch's own accounting but **included
in `torch.cuda.mem_get_info` driver-global free**, so `/capacity` already
reflects it. Our only lever is eviction (Node-owned), fired only when the
sidecar's `503` says it would help and no analysis is mid-flight.

## Failure modes & mitigations

| Failure | Mitigation |
|---|---|
| **Transient decode-peak double-book** (the killer) | Sidecar holds a `peak` reservation **for the op's duration** (released in `finally`); admits against `min(torch_free, total−Σreserved) − reserve`. Per-call + co-located with residency ⇒ never leaks, always the right device. |
| **Sidecar evicts its own model mid-run** (idle watchdog) | The reservation is the sidecar's own and per-call; there is no cross-process ledger to go stale. |
| **Probe unreachable (sidecar down: analysis phase / RSS recycle)** | Node shells `nvidia-smi`/`rocm-smi`; CPU-only only when no probe works. TTS admission isn't needed while the sidecar is down anyway. |
| **Fragmentation OOM despite "fit"** | `GPU_RESERVE_MB` (768) **plus** the shipped `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` (plan 144). The reserve is the last-MB cushion, not the frag fix. |
| **Same-model concurrent peaks** (`generationWorkers=2`) | The sidecar `_synth_lock` serializes same-engine forwards (thread-safety, `tts-performance.md`); two peaks never co-run on one engine regardless of VRAM. |
| **Peak estimate too low** | Seed = measured, rounded up; up-only ratchet from `torch.cuda.max_memory_allocated`. |
| **eGPU drops mid-load** | Device omitted from `/capacity`; in-flight op fails fast; its per-call reservation releases; toast + re-queue. |
| **Queue starvation / can't-evict-mid-analysis** | Node queue (FIFO); a heavy op that can't fit and can't evict the mid-flight analyzer sits in the visible pill until analysis frees room — a queued state, never a silent hang. |

## The one knob

- **`GPU_RESERVE_MB`** — per-device capacity held back from admission (default
  `768`). `apply: live`. Read by **both** the sidecar (its env) and Node. The only
  GPU-arbitration knob that survives. Default is a real cushion, not a token 512:
  peaks brush 6.9 GB on an 8 GB card and the codec-GPU experiment poisoned the
  context near the ceiling. Works with, not instead of, `expandable_segments`.

## What gets deleted / migrated

**Deleted** (registry knobs + code): `gpu.vramBudget`, `gpu.concurrency`, the six
`gpu.weight.*`, `gpu.safeCoexistMb`; the weighted-token math in `GpuSemaphore`,
all of `engine-vram-cost.ts` (`ENGINE_VRAM_COST` / `costForEngine` /
`DEFAULT_GPU_VRAM_BUDGET`), `gpu-semaphore-gate.ts` (`acquireGpuTokenIfOnGpu`),
`device-total.ts`, and `scripts/check-no-budget-poll.mjs`.

**Extracted, not deleted:** the FIFO count core of `GpuSemaphore` becomes
`CountSemaphore` (no weighting) for the analyzer K limiter and any remaining
count-only use.

**All direct consumers reconciled (explicit tasks):** `synthesise-chapter.ts`
(the `gpuSemaphore.acquire(budget)` barrier + the `maxConcurrency` pool-width
default), `persona-gpu-plan.ts` (VoiceDesign barrier), `embed-client.ts` (`budget
>= 2` gate), `ollama.ts` (the module-load `describeAnalyzerConcurrency` log),
`diagnostics.ts` + `diagnostics.test.ts` (the `readGpuQueueState` shape). None are
left to a "fix imports" hand-wave.

**Kept / re-pointed:** the analyzer K limiter + `syncAnalyzerConcurrency` (now on
`CountSemaphore`); the per-engine `tts.{coqui,kokoro,qwen}.device` pins as an
optional manual override the sidecar honors; `GET /api/gpu/queue` (payload
migrated). Deleted knobs get inert `removed` handling verified against how
`ANALYZER` was actually retired.

## Testing

- **Primary acceptance (no OOM):** a **sidecar** pytest with a mocked capacity
  probe drives each hardware state — (a) 8 GB CUDA, (b) 8 + 16 GB, (c) Apple
  `mps`, (d) CPU-only — and asserts `Σ held reservations per device ≤ total −
  reserve` at every admission, across a Kokoro + Qwen + Coqui sequence. The
  reservation-holds-the-peak case (two ops whose loads fit but peaks don't) is the
  test a naive free-read fails.
- **Reservation lifecycle (sidecar):** reservation released in `finally` on
  success, error, and mid-run idle-evict; no leak across a synth loop.
- **Device honoring (sidecar):** a cold load places on the assigned device;
  resident models are not migrated per synth. Tests target the **real** load
  handlers, not fictional stubs.
- **Footprint parity (sidecar pytest):** parse the numbers out of `local-llm.md`
  and assert the Python seed map equals them (real parity, not a keyword match).
- **Footprint up-only:** a higher `max_memory_allocated` raises the estimate; a
  lower one doesn't.
- **503 orchestration (Node):** sidecar `503 analyzerEvictWouldHelp=true` + no
  analysis → Node evicts Ollama + retries; `=false` or analysis-in-flight →
  queued (pill), never 500/hang.
- **CountSemaphore:** the analyzer K limiter still resizes live and FIFO-drains
  (port the existing `GpuSemaphore` count tests).
- **Consumer migrations:** `synthesise-chapter` pool-width, `diagnostics` payload,
  `embed-client` gate each keep a green test after the cutover.
- **Capacity fallback (Node):** `/capacity` down → `nvidia-smi` fallback reports
  the GPU; no probe → CPU-only.
- **Frontend e2e:** a queued heavy op shows "Queued (N ahead)", never a
  spinner-forever; eGPU-drop dispatches a toast + re-queue.
- Regression plan under `docs/features/` per the before-shipping checklist.

## Implementation notes

- **Own worktree + `feat/…` branch off `main`.** No direct work on `main`.
- Reverses the 2026-06-16 MB-accounting deferral — correct then for a fixed 8 GB
  card, void once a 16 GB eGPU / AMD / Apple device is in play.

## Resolved decisions

1. **Capacity read is sidecar-owned** (`GET /capacity`, torch), with a Node
   `nvidia-smi`/`rocm-smi` fallback for sidecar-down.
2. **TTS admission is sidecar-owned (Option A).** Placement, per-call peak
   reservation, and own-idle-evict live in the sidecar where residency lives;
   Node orchestrates evict-Ollama-or-queue off the sidecar's `503`. Chosen after
   the adversarial review showed a Node-only ledger can't safely gate
   sidecar-resident models it never observes.
3. **Footprint keyed by (engine, model) + the Qwen batch/token-budget levers**;
   seeded from the maintained `local-llm.md` (parity-tested), ratcheted up-only.
4. **eGPU drop → toast + auto-requeue.**

## Remaining open questions

- Non-blocking: the exact `/capacity` cache TTL; whether the sidecar persists the
  learned footprint high-water across restarts or re-learns each boot from the
  seed (either is OOM-safe — the seed is the floor).
