---
status: draft
date: 2026-07-18
revised: 2026-07-18 (Option A + THREE adversarial-review rounds folded)
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
hardware. An operator hand-tunes **four overlapping knobs** (`GPU_VRAM_BUDGET`
default `0`=off, `GPU_CONCURRENCY` default `1`, six provisional `GPU_WEIGHT_*`,
and the separate `ANALYZER_OLLAMA_CONCURRENCY` K). None read the hardware; the one
`nvidia-smi` probe is "recorded but unconsumed."

Adequate for one fixed 8 GB NVIDIA card. It fails the real hardware:

- **8 GB laptop RTX 4070** always present, **+ sometimes a 16 GB eGPU** that can
  **drop off the CUDA bus mid-session** ("GPU is lost"). A boot snapshot or static
  profile is wrong the moment the hardware changes.
- **Ollama self-distributes** the analyzer across both cards — a pooled token
  budget can't represent an opaque process that spreads itself.
- **Cross-vendor**: must also run on AMD (ROCm), Apple (Metal/unified memory), CPU.

The "effective N" number misleads operators into raising the budget → co-residence
OOM, the exact failure the feature was meant to prevent.

## Goals

1. **No OOM in any hardware state** (8 GB, 8+16 GB, AMD, Apple, CPU) with **no
   config change between them.** Primary acceptance criterion.
2. **Zero hand-tuning.**
3. **Cross-vendor** first-class.
4. **Survive eGPU hot-plug/unplug** without a restart.
5. **Use every device** — heavy models prefer the roomier one.
6. **Delete the confusing surface**; keep one safety knob.

## Non-goals

- Controlling Ollama's placement. Rebalancing already-resident models (placement
  decided at load; a per-synth call runs on the resident device). Perfect
  footprint prediction. Replacing the analyzer K limiter. Making every engine use
  every accelerator (CPU-degrade where it can't).

## Governing principle

> **Real free capacity per compute device, measured live, is the only source of
> truth. Every external process (Ollama especially) is an opaque consumer we read
> but never model. No load or synth starts unless its measured peak-under-load
> footprint provably fits real free capacity on its device minus a reserve — and
> the decision is made where the model's residency lives.**

Three adversarial-review rounds shaped the last clause and the mechanics below. TTS
engines are **resident singletons owned by the Python sidecar**, evicted on the
sidecar's own idle watchdogs invisibly to Node — so a Node-held reservation for
them leaks or reserves the wrong device. **TTS admission lives in the sidecar.**
The **analyzer** is Node-observable (Ollama `/api/ps`) and stays Node-gated. The
evict-vs-queue *policy*, however, needs Ollama attribution the sidecar lacks — so
**Node computes the evict decision** (see §Evict & wake).

**Analyzer and heavy TTS take turns on a device — they never ramp concurrently
(round-3 decision).** On the 8 GB card the analyzer (Ollama, self-splitting and
opaque to the sidecar ledger) and a heavy TTS decode-peak fundamentally cannot
co-reside; forcing them to was the whole "budget dance" this feature removes. The
sidecar reads `torch_free` at admit-time, but the real allocation ramps to peak
*inside the forward* — a window in which an Ollama model load could eat the
headroom the reservation assumed, invisibly to the ledger. Node closes that window
by **serializing the two big consumers per device**: it does not start a new
Ollama load while a heavy TTS forward is in flight on that device, and a heavy TTS
op waits (evict-or-queue, below) rather than admitting alongside a loading/resident
analyzer that leaves no room. True concurrency returns only when the roomier 16 GB
eGPU is attached. This is the honest capacity answer, and it is why `GPU_RESERVE_MB`
stays a small fragmentation cushion (768) rather than being inflated to cover a
whole analyzer load.

## Ownership split

| Concern | Owner | Why |
|---|---|---|
| Per-device free VRAM (`/capacity`) | **Sidecar** (torch) + Node `nvidia-smi`/`rocm-smi` fallback | torch = portable global-free across CUDA/ROCm; models load here |
| TTS/ASR/embed placement + per-call peak reservation + own-idle-evict | **Sidecar** (`PlacementController`) | residency + eviction live here |
| TTS peak footprints | **Sidecar** (`FootprintTable`) | placement needs them in-process |
| Same-engine synth thread-safety | **Sidecar, existing locks** — Qwen keeps `_synth_lock` (Base model isn't thread-safe); Coqui/Kokoro stay parallel (the `test_concurrent_synthesis` contract) | admission does NOT add a cross-forward mutex; VRAM double-book is prevented by the ledger reservation, not a lock |
| Admission decision + peak reservation | **Sidecar** (`ReservationLedger` own lock — a SHORT critical section) | decide+reserve must be atomic and must NOT sit behind another op's multi-minute forward, so a 503 stays prompt |
| Analyzer width-K limiter + per-model lease | **Node** (`CountSemaphore`) | analyzer is Node-observable via `/api/ps` |
| **Evict-decision** (would freeing Ollama fit the 503'd op?) + eviction | **Node** (`residency.ts`) | only Node sees Ollama's per-model size (`/api/ps`) |
| TTS retry/queue + wake loop + the "Queued" pill | **Node** (`sidecar.ts` + `/api/gpu/queue`) | Node orchestrates around the sidecar 503 |

## Architecture

### Sidecar (Python)

- **`GET /capacity`** — vendor-abstracted `ComputeDevice[]` (`kind`, `index`,
  `label`, `totalMb`, `freeMb`) via `torch.cuda.mem_get_info(i)` (driver-global,
  sees Ollama; ROCm reports as `cuda`), `mps` (available system RAM), always a
  `cpu` device. A per-device exception **omits** that device. `psutil` is already
  module-level (guarded, may be `None`) — the CPU/mps rows fall back to
  `os`-level totals when `psutil is None`, so the probe **never raises**.

- **`FootprintTable`** — **peak-under-load** MB per (engine, model, run-config).
  `local-llm.md` is the maintained seed source of truth; the Python seed map is a
  **parity-tested mirror** (pytest parses the doc's `<!-- footprint:… -->` anchors
  and asserts equality). **Seeds are the measured DECODE PEAK, not weight size:**
  `qwen` at the default `32/3600` = **6144** (measured ~5.6 GB, rounded up — the
  operator's "≈4 GB" was resident size, not the decode peak; using it would
  under-reserve and OOM), `qwen.1.7b` = 7168, `coqui` = 3584, `kokoro` = 1200,
  `asr` = 400, `spk` = 200. Qwen scales with the batch/token-budget passed per
  call (below). After each op the controller ratchets the estimate **up-only**
  from `torch.cuda.max_memory_allocated(device)`.

- **`ReservationLedger`** — per-device `{token: mb}` under its **own lock** (the
  GIL does not make read-`reserved_mb`→decide→`hold` atomic across worker
  threads). `reserved_mb(key)`, `hold(key, mb)→token`, `release(token)`.

- **`PlacementController`** — the admission **decision** for a `/load` or
  `/synthesize` is a **short critical section under the `ReservationLedger`'s own
  lock**, NOT a lock held across the forward (round-3 decision — see §Locking &
  concurrency). It decides and reserves, then releases the lock; the forward runs
  under the existing engine locks and the held reservation is pure VRAM
  bookkeeping. Steps:
  1. `peak = FootprintTable.peak(engine, model, cfg)` where `cfg` carries the
     batch width + token budget (threaded from Node — see below).
  2. Target device: resident engine → its device (no migration); new load →
     max-headroom device that fits.
  3. **Under the ledger lock (short):** admit against
     `min(torch_free(dev), total(dev) − Σ reserved(dev)) − reserve` ≥ `peak`;
     on fit `hold` the peak → `token`, release the lock, and hold `token` for
     **this op's duration** (released in `finally`, on success/error/mid-evict).
     Two concurrent same-engine admits (e.g. Coqui) each see the other's peak in
     `Σ reserved`, so they cannot double-book even though their forwards run in
     parallel.
  4. No fit → try own idle-evict (VoiceDesign/Base17/ASR/ECAPA past idle) — the
     evict acquires the relevant **threading** load lock (`_base_load_lock` /
     `_base17_load_lock`), NOT the ledger lock and NOT `_synth_lock` — then
     re-check; cheap CPU-capable engines (kokoro/asr/embed) → `cpu`.
  5. Still no fit → return **`503` `{ "noCapacity": true, "neededMb", "deviceKey" }`**
     (discriminator `noCapacity:true`, distinct from the existing poison
     `{poisoned:true}` and recycle 503s). **The sidecar does NOT decide whether
     evicting Ollama would help** — it can't see Ollama's per-model share; Node
     does that.

- **Locking & concurrency (round-3, resolves the gate's Critical findings).** The
  gate confirmed against `main.py`: `_synth_lock` is a **non-reentrant
  `threading.Lock`** (2071) whose unload/evict paths re-acquire it (self-deadlock
  if held during evict — 4 in-file warnings), and `_load_lock` is an
  **`asyncio.Lock`** (2043) a `to_thread` worker **cannot** acquire (2074) — cold
  loads therefore use the *threading* `_base_load_lock`/`_base17_load_lock`
  (2328/2346). So:
  - Admission holds **only** the ledger lock, briefly — never `_synth_lock`,
    never `asyncio` `_load_lock`.
  - **Global lock order (evict never up-orders):** `ReservationLedger` lock →
    per-engine threading load lock (`_base_load_lock`/`_base17_load_lock`) →
    per-engine `_synth_lock`/`_infer_lock`. Admission takes the ledger lock and
    releases it before any forward; an idle-evict inside admission takes a load
    lock (lower in the order) and never re-enters the ledger lock. No admit ever
    waits on another engine's in-flight forward while holding its admission lock.
  - Same-engine serialization is unchanged: Qwen's forward keeps `_synth_lock`
    (thread-safety); Coqui/Kokoro forwards stay parallel (existing tested
    contract). The `_admission_lock` concept from earlier rounds is **dropped** —
    it conflated "decide admission (fast, must 503 promptly)" with "run forward
    (slow)" and would have hung the request instead of returning the queue-able
    503.

- **Batch peak threading.** Node's `/synthesize` **and** `/synthesize-batch`
  request bodies gain `batchWidth` + `tokenBudget` so the controller reserves the
  batch's TRUE peak (which scales with width), not a single-item peak. Without
  this a wide Qwen batch under-reserves — the OOM the feature targets.

### Server (Node)

- **`CountSemaphore`** (`count-semaphore.ts`) — the FIFO count core extracted from
  `GpuSemaphore` (no token weighting; `acquire`/release/`resize`/`queueDepth`).
  Backs the analyzer K limiter unchanged.

- **`CapacityProbe`** (`capacity-probe.ts`) — sidecar `/capacity` client,
  last-known-good cached, **`nvidia-smi`/`rocm-smi` fallback when the sidecar is
  down** (analysis phase / RSS recycle); CPU-only only if no probe works. Off the
  synth hot path (resident models don't re-probe).

- **Evict & wake (round-2, refined round-3).** When a synth gets `503 noCapacity`,
  Node:
  1. Reads Ollama `/api/ps` (`ollama-health.ts`) to learn what the analyzer holds
     on `deviceKey`, and `/capacity` for free there. **Node computes
     `evictWouldHelp = analyzerMbOnDevice + freeOnDevice ≥ neededMb`.**
  2. If `evictWouldHelp` **and** no analysis is mid-flight → evict Ollama
     (`residency.ts`) and retry once. This is also the analyzer-vs-TTS VRAM
     protection that replaces the deleted weighted lease — now driven by a value
     Node actually computes, not a flag the sidecar couldn't set.
  3. Else **enqueue** (visible in the pill) and retry via a **bounded
     capacity-poll wake loop**: re-attempt on a short interval (e.g. 2 s, capped)
     and immediately whenever any in-process synth completes. Because the sidecar
     frees VRAM on its own watchdogs invisibly, Node cannot be *pushed* — it polls
     `/capacity` cheaply while its queue is non-empty.
  4. **Terminal state (round-3 decision):** at the poll cap, when nothing will
     free VRAM (this op is the only GPU work — no analysis, no other synth), **fail
     the op with an actionable toast** ("Not enough GPU memory for `<engine>` —
     free VRAM or attach the eGPU"), never a permanent "Queued" pill. Failing is
     strictly better than an OOM and gives the user a real next step; the frontend
     e2e asserts the terminal toast, not merely "no spinner-forever." Note a
     queued op holds **no** reservation (it 503'd; its peak released in `finally`),
     so two queued heavy ops can't deadlock each other — worst case is FIFO
     ordering, not mutual wait.

- **Temporal separation of analyzer vs heavy TTS (round-3, the F6/OOM-window
  fix).** The evict-or-queue policy above is one half; the other is the
  **symmetric guard on the analyzer side**. Before Node lets Ollama start a *new*
  model load on a device, it checks the same `/capacity` + resident-TTS state and
  holds the analyzer load off while a heavy TTS forward is ramping on that device
  (and vice versa). This closes the admit→peak window where an Ollama load, opaque
  to the sidecar ledger, could OOM an in-flight TTS forward — the two big consumers
  never ramp concurrently on one card. The gate at **per-call** granularity: a long
  multi-chunk analysis clears between Ollama calls, so TTS gets windows; a queued
  render does **not** preempt an in-flight analysis (analysis finishes, then TTS
  drains). A heavy render can therefore visibly queue behind an active analysis
  phase on a single 8 GB card — the accepted, honest trade (the 16 GB eGPU removes
  it).

- **503 interception.** `sidecar.ts`'s `throwForResponse` classifies all 5xx as
  transient-throw *before* the body is read. The no-capacity 503 must be
  intercepted and JSON-parsed **before** that throw, and disambiguated from
  poison/recycle 503s by the `noCapacity:true` discriminator.

- **Cross-book eviction barrier.** Today `synthesise-chapter.ts:819` and
  `persona-gpu-plan.ts:36` use `gpuSemaphore.acquire(budget)` as a full-budget
  mutex so a concurrent cross-book synth can't race a mid-chapter Qwen→Coqui
  `/unload` or a VoiceDesign load. With admission in the sidecar, that mutual
  exclusion moves to the **sidecar's single-flight load locks** — the *threading*
  `_base_load_lock`/`_base17_load_lock` (and each engine's load path), **not** the
  `asyncio` `_load_lock` (which a `to_thread` worker cannot acquire — the
  round-3-gate correction to the earlier draft). Removing the Node barrier is safe
  only once the admission-driven evict runs under those threading load locks so it
  serializes against a concurrent cold load. This is explicit work, not a free
  deletion.

- **Analyzer lease** — the K limiter runs on `CountSemaphore`; the analyzer's
  footprint is read from `/api/ps`; the per-model lease no longer takes a VRAM
  slot. Node's only analyzer VRAM action is the evict above.

- **`GET /api/gpu/queue`** — payload `{ devices, residentByDevice, queueDepth }`.
  `diagnostics.ts` (`readGpuQueueState`) and the frontend pill are migrated in the
  same change.

### Why footprint = peak, not weight

Qwen 0.6B weights ~1.2 GB but **decode peak at the default `32/3600` is ~5.6 GB**;
4800 → ~6.9 GB (`tts-performance.md`). The seed is the peak (6144), not 4 GB — the
distinction is the whole point, and the acceptance test drives the **real**
`FootprintTable`, never an injected number.

## Multi-device & eGPU hot-plug

Live enumeration on each cold-load decision (resident synths don't re-probe).
Attach → 16 GB device appears, next cold load prefers it. Drop → device omitted
from `/capacity`; in-flight op fails fast (existing "GPU is lost" path), its
per-call reservation releases in `finally`; Node surfaces a toast + re-queues.
Apple/CPU-only collapse to one device.

## Failure modes & mitigations

| Failure | Mitigation |
|---|---|
| **Transient decode-peak double-book** | Sidecar holds the `peak` reservation for the op's duration under the ledger lock; admits against `min(torch_free, total−Σreserved) − reserve`. |
| **Under-reserved seed (0.6B @ 3600)** | Seed = measured **decode peak** 6144, not 4 GB weight/resident; up-only ratchet from `max_memory_allocated`. |
| **Wide batch under-reserve** | `batchWidth`/`tokenBudget` threaded into both synth routes; peak scales with width. |
| **Concurrent same-engine double-book** | Prevented by the **ledger reservation** (each admit sees the other's peak in `Σ reserved`), not a mutex — so Coqui/Kokoro keep their tested parallel forwards and Qwen keeps `_synth_lock` for thread-safety. |
| **Admission stuck behind a multi-min forward** | Admission is a SHORT ledger-lock critical section (decide+reserve), released before the forward — so a `503` is always prompt and queue-able. |
| **Ollama loads in the admit→peak window (OOM)** | **Temporal separation:** Node holds a new Ollama load off a device while a heavy TTS forward is ramping there, and holds heavy TTS off a loading/resident analyzer — the two big consumers never ramp concurrently on one card (per-call granularity). |
| **Ledger read-decide-hold race** | Dedicated ledger lock; not reliant on the GIL. |
| **Lock-order deadlock (admit ↔ evict ↔ synth)** | Published global order (ledger → threading load lock → `_synth_lock`/`_infer_lock`); admission never holds `_synth_lock` or the `asyncio` `_load_lock`; evict never up-orders. |
| **Queue never terminates** | At the poll cap with nothing to free, the op **fails with an actionable toast**, never an infinite "Queued" pill; queued ops hold no reservation so they can't mutually deadlock. |
| **Orphaned evict flag / analyzer unprotected** | Node computes `evictWouldHelp` from `/api/ps`+`/capacity`; evict path Node-driven, replacing the deleted lease. |
| **Queued op never wakes** | Node bounded `/capacity`-poll loop while queue non-empty + wake on each synth completion. |
| **503 mis-handled** | Intercept + JSON-parse the `noCapacity:true` body before `throwForResponse`; disambiguate from poison/recycle. |
| **Cross-book evict race** | Sidecar *threading* `_base_load_lock`/`_base17_load_lock` (NOT the `asyncio` `_load_lock`) cover the admission-driven evict; Node barrier removed only once that's in place. |
| **Sidecar down** | Node `nvidia-smi`/`rocm-smi` fallback; CPU-only only if no probe works. |
| **Fragmentation OOM** | `GPU_RESERVE_MB` (768) **+** shipped `expandable_segments:True`. |
| **eGPU drops mid-load** | Device omitted; in-flight fails fast; per-call reservation releases; toast + re-queue. |
| **poolWidth misuse** | Node pool width for GPU engines stays **1** (a constant, not `generationWorkers`); the Qwen throughput lever is `/synthesize-batch`, not concurrent `/synthesize`. |

## The one knob

- **`GPU_RESERVE_MB`** (default `768`, `apply: live`, read by both the sidecar env
  and Node). The only survivor. A real cushion (peaks brush 6.9 GB on 8 GB; the
  codec-GPU experiment poisoned the context near the ceiling); works with, not
  instead of, `expandable_segments`.

## What gets deleted / migrated

**Deleted:** the four budget knobs + six weights + `safeCoexistMb`; the weighted
math in `GpuSemaphore`; `engine-vram-cost.ts`; `gpu-semaphore-gate.ts`;
`device-total.ts`; `scripts/check-no-budget-poll.mjs` (+ tests).
**Extracted:** `CountSemaphore` (count core) for the analyzer K limiter.
**Every direct consumer reconciled (explicit tasks):** `synthesise-chapter.ts`
(the `acquire(budget)` cross-book barrier **and** the `maxConcurrency` pool-width,
now the constant 1), `persona-gpu-plan.ts` (VoiceDesign barrier → sidecar
`_load_lock`), `embed-client.ts` (`budget>=2` gate → a capacity check or drop),
`ollama.ts` (module-load log → K-only), `diagnostics.ts` + test (payload shape).
**Kept/re-pointed:** analyzer K limiter + `syncAnalyzerConcurrency` on
`CountSemaphore`; `tts.*.device` pins as an optional override the sidecar honors;
`/api/gpu/queue`. Deleted knobs' inert handling verified against how `ANALYZER`
was actually retired (grep the real mechanism first, no assumed `removed:` field).

## Testing

- **Primary acceptance (no OOM):** a **sidecar** pytest driving the **real**
  `FootprintTable` (not an injected peak) across (a) 8 GB, (b) 8+16 GB, (c) `mps`,
  (d) CPU — asserts `Σ reserved per device ≤ total − reserve` at every admission,
  including a **wide Qwen batch** whose threaded `batchWidth` pushes the peak, and
  a Kokoro co-admit that must be refused when the true peak (6144) leaves no room.
- **Concurrency:** two parallel same-engine admits (Coqui) can't double-book —
  the second sees the first's peak in `Σ reserved` and is refused/queued (exercises
  the **ledger lock**, no cross-forward mutex), while their forwards still run in
  parallel and Kokoro+Qwen still overlap.
- **Temporal separation:** with a heavy TTS forward reserved on a device, a new
  Ollama load is held off that device (and vice versa); asserts the two never
  co-admit on one card at per-call granularity.
- **Reservation lifecycle:** released in `finally` on success/error/mid-evict.
- **Device honoring:** cold load places on the assigned device via the **real**
  handlers; resident models not migrated.
- **Footprint parity + up-only:** parse `local-llm.md` numbers; higher observation
  raises, lower doesn't.
- **Evict & wake (Node):** `evictWouldHelp` computed true → evict+retry; false or
  analysis-in-flight → enqueue + wake on poll/completion, never hang; the poll
  loop terminates, and **at the cap with nothing to free it fails with a toast**
  (not an infinite pill).
- **503 handling:** `noCapacity:true` parsed before the transient-throw; poison /
  recycle 503s still throw as today.
- **Consumer migrations:** `synthesise-chapter` width=1 + no barrier regression,
  `diagnostics` payload, `embed-client` gate each stay green.
- **Capacity fallback:** `/capacity` down → `nvidia-smi`; no probe → CPU-only.
- **Frontend e2e:** queued op shows "Queued (N ahead)", never spinner-forever;
  eGPU-drop → toast + re-queue.

## Implementation notes

- **Own worktree + `feat/…` branch off `main`.** No work on `main`.
- Reverses the 2026-06-16 MB-accounting deferral (void once a 16 GB eGPU / AMD /
  Apple device is in play).
- **Three hardening rounds folded.** The third gate (kickoff) verified the sidecar
  locking against `main.py` and forced: dropping `_admission_lock`, the published
  global lock order, the threading-load-lock (not `asyncio` `_load_lock`) eviction
  barrier, analyzer↔TTS temporal separation to close the Ollama admit→peak OOM
  window, and the poll-cap fail-with-toast terminal state.

## Resolved decisions

1. Capacity read sidecar-owned (`/capacity`) + Node vendor fallback.
2. **TTS admission sidecar-owned (Option A).**
3. **Evict decision Node-owned** (computes `evictWouldHelp` from `/api/ps` +
   `/capacity`); the sidecar 503 only reports `{noCapacity, neededMb, deviceKey}`.
4. Footprint = measured **decode peak** (qwen 0.6B seed **6144**, not 4 GB),
   keyed by (engine, model) + batch/token-budget threaded per call, up-only.
5. **Admission is a short `ReservationLedger`-lock critical section, not a
   forward-spanning lock** (round-3). `_admission_lock` dropped. Same-engine
   thread-safety stays on the existing locks (Qwen `_synth_lock`; Coqui/Kokoro
   parallel); the ledger reservation alone prevents VRAM double-book.
6. **Published global lock order** (round-3): ledger lock → threading load lock
   (`_base_load_lock`/`_base17_load_lock`) → `_synth_lock`/`_infer_lock`; the
   eviction barrier uses the threading load locks, never the `asyncio` `_load_lock`.
7. **Analyzer ↔ heavy TTS take turns per device** (round-3) — Node serializes the
   two big consumers so an Ollama load can't OOM a TTS forward in the admit→peak
   window; per-call granularity; render does not preempt analysis.
8. Node bounded `/capacity`-poll wake loop for queued ops; **at the cap, fail with
   an actionable toast** (round-3), never a permanent "Queued" pill.
9. eGPU drop → toast + auto-requeue.

## Remaining open questions

- Non-blocking: `/capacity` cache TTL; whether the sidecar persists the learned
  footprint high-water across restarts or re-learns from the seed (both OOM-safe —
  seed is the floor); the exact poll interval + backoff cap for the wake loop.
