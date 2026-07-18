---
status: draft
date: 2026-07-18
supersedes:
  - docs/superpowers/specs/2026-06-16-vram-budget-aware-gpu-policy-design.md (deferred MB-accounting — this reverses that deferral)
related:
  - docs/superpowers/specs/2026-07-17-ollama-parallel-chunk-analysis-design.md (per-model lease / K limiter)
  - docs/features/223-vram-telemetry-substrate.md (fs-45 telemetry this consumes)
  - docs/superpowers/plans/2026-06-14-amd-gpu-phase2-enablement.md (AMD groundwork)
  - docs/local-llm.md (measured analyzer + sidecar footprints — the seed table)
  - docs/tts-performance.md (measured peak-under-load VRAM)
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

None of these read the hardware. The one `nvidia-smi` probe that exists
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
  when the eGPU is present. The weighted-token model charges the analyzer a
  single "cost 4" against one pooled budget — it structurally **cannot represent
  an opaque process that spreads itself across two physical cards.**
- **Non-NVIDIA hardware.** Castwright must also run on AMD (ROCm) and Apple
  Silicon (Metal/unified memory), plus pure CPU. `nvidia-smi` and a token budget
  say nothing about those.

The result is a per-machine hand-tuning treadmill with no upside, and a
"effective N" number that actively misleads operators into raising the budget —
which enables model co-residence and causes the exact OOM the feature exists to
prevent.

## Goals

1. **No OOM in any hardware state** — 1-card (8 GB), 2-card (8 + 16 GB), AMD,
   Apple, or CPU-only — **without any config change between them.** This is the
   primary acceptance criterion.
2. **Zero hand-tuning.** The system reads real free capacity per device and its
   own measured footprint history; the operator sets nothing per machine.
3. **Cross-vendor.** NVIDIA (VRAM), AMD (ROCm VRAM), Apple (unified memory),
   and CPU fallback are all first-class.
4. **Survive eGPU hot-plug/unplug.** An attached eGPU is used automatically; a
   dropped eGPU degrades to the remaining device without a restart.
5. **Use every available device** — heavy models prefer the roomier one — rather
   than piling onto the smallest card.
6. **Delete the confusing surface.** Remove `GPU_VRAM_BUDGET`, `GPU_CONCURRENCY`,
   and all six `GPU_WEIGHT_*` knobs plus the weighted-token math. Keep exactly
   **one** safety knob.

## Non-goals

- **Controlling Ollama's placement.** Analyzer layer-splitting across cards is
  fine for analysis and stays as-is. We read the capacity it leaves behind; we
  never pin or reshape it.
- **Rebalancing already-resident models.** Placement is decided at *load* time;
  we do not migrate a loaded model between devices.
- **Perfect footprint prediction.** Estimates are measured-then-learned and
  deliberately conservative, not exact. The reserve knob + measured-truth
  admission absorb the slack.
- **Replacing the analyzer K limiter** (`ANALYZER_OLLAMA_CONCURRENCY`). That
  governs *how many analyzer calls* run against a resident model; orthogonal to
  *where models are placed*, and it stays (its per-model GPU lease is re-pointed
  at the new admission controller — see Migration).
- **Making every engine run on every accelerator.** Where an engine can't use
  the local accelerator (e.g. faster-whisper has no Metal path), it degrades to
  CPU — the placement layer just needs to *know* that and account it as a CPU op.

## Governing principle

> **Real free capacity per compute device, measured live, is the only source of
> truth. Every external process (Ollama especially) is an opaque consumer we read
> but never model. We never start a model load unless its measured
> peak-under-load footprint provably fits the real free capacity on some device,
> minus a reserve.**

Everything below follows from that sentence.

## Architecture

### Components

- **`CapacityProbe` — sidecar-hosted, exposed via `GET /capacity`.** The probe
  lives in the Python sidecar (`server/tts-sidecar/main.py`) because torch gives
  a *portable* global-free read across CUDA and ROCm in one API; the server (and
  any other consumer) reads it over HTTP. It returns a live list of
  `ComputeDevice`: `{ kind: 'cuda'|'rocm'|'mps'|'cpu', index, label, totalMb,
  freeMb }`. Backends:
  - **NVIDIA / AMD-ROCm** — `torch.cuda.mem_get_info(i)` per device (driver-global
    free, so it sees Ollama too); torch reports ROCm as `cuda`. `nvidia-smi` /
    `rocm-smi` are a fallback when torch isn't the loader for a device.
  - **Apple** — unified memory: one `mps` device whose `freeMb` is *available
    system RAM* (there is no separate VRAM); OS memory APIs.
  - **CPU** — always present; `freeMb` = available system RAM.

  Re-enumerates every call (server-side ~1–2 s cache, forced-fresh at a heavy
  load's decision point), so an attached eGPU appears as a new device and a
  dropped one disappears — no boot-time snapshot. A thin server client caches the
  last-known-good read the same way `sidecar-health.ts` already does. Supersedes
  the single-GPU `device-total.ts`. `GET /capacity` is a public sidecar endpoint
  other tools (admin console, benchmarks) can consult too.

  **Sidecar-down fallback (important).** The TTS sidecar is *not* always up — it's
  button-driven during the analysis phase and transiently down during an RSS
  process-recycle (plan 143). GPU truth is still needed then (the analyzer is on
  the card; an evict decision may be pending). So when `/capacity` is unreachable
  the server does **not** collapse to CPU-only — it falls back to a **server-side
  vendor probe** (`nvidia-smi` / `rocm-smi`, the NVIDIA/AMD common case) for the
  device totals/free, and only degrades to CPU-only when *no* probe of any kind
  succeeds. This keeps GPU decisions correct during sidecar churn instead of
  silently disabling the feature exactly when the analyzer owns the card.

- **`GpuAdmission`** (`server/src/gpu/admission.ts`, new) — the single authority
  that replaces `GpuSemaphore` + the weighted-token math. Given an engine and run
  config, it decides **place-here / evict-then-place / run-on-CPU / queue**, and
  serializes concurrent decisions so two loads can't both claim the same free
  capacity (the placement mutex — see Races).

- **`ReservationLedger`** (inside `GpuAdmission`) — the fix for the transient-peak
  hazard. **Measured free VRAM alone is NOT a safe admission signal**, because a
  model's peak is a *decode-time* spike (Qwen 0.6B: ~1.2 GB weights at load, but
  ~5.6 GB peak during synthesis). If admission read only instantaneous free, a
  second op admitted between the first's load and its decode peak would see room
  that doesn't exist once both peak → OOM. So each admitted op **holds a
  reservation of its full `peak` MB on its device for its whole
  resident-and-callable lifetime** (not released at load). Admission fits against
  the **more conservative of measured and reserved**:

  > `admittable(device) = min(measured_free, total − Σ held_reservations) − GPU_RESERVE_MB`

  `min(...)` (not a sum) avoids double-counting a peak that measured free already
  reflects, while still guarding a peak that hasn't spiked yet. The ledger is
  reconciled on **evict** (release the reservation) and on **device
  disappearance** (eGPU drop → drop that device's reservations so the ledger
  can't leak into permanent under-admission).

- **`FootprintTable`** (`server/src/gpu/footprints.ts`, new) — **peak-under-load**
  MB per (engine, model, run-config), *not* resident weight size (see below).
  **Covers only the sidecar-loaded engines** (Qwen / Coqui / Kokoro / ASR / spk),
  whose peak can't be known until the model loads. The **analyzer is never
  estimated**: Ollama reports its true resident size live via `/api/ps` (already
  surfaced by `server/src/routes/ollama-health.ts`), so both its live footprint
  (for the evict-gain decision) and its effect on free capacity (for placement)
  are *read*, not predicted — which is why the 3.0 → 6.6 GB model-swing + KV
  variance needs no table entry. Seeded from the **measured** tables already in
  the repo, refined from on-box history when present:
  - Seed: **`docs/local-llm.md` is the maintained source of truth** for per-model
    VRAM (the analyzer weights+KV table and the sidecar-engine resident-size
    table). The `footprints.ts` seed is a **code mirror of those tables, held in
    parity by a test** — same discipline as the "sidecar `main.py` default MUST
    match the registry default" rule — so when a measured size changes, the doc
    is updated and the mirror (and its test) move with it; neither drifts.
    `docs/tts-performance.md` supplies the measured decode-*peak* rows (batch /
    token-budget) that turn a resident size into a peak, and the operator-confirmed
    peaks — **Qwen 0.6B ≈ 4 GB, Qwen 1.7B ≈ 7 GB max** — are reconciled into the
    same table (seed rounds up to the higher of doc vs. operator number).
  - Refine — **up-only ratchet.** The on-box `resource-telemetry.jsonl`
    (`vramReservedMb`/`vramTotalMb`, `server/src/tts/resource-telemetry.ts`) and
    `model-vram-stats.ts` (fs-45) give the learned per-box high-water mark. The
    effective estimate is **`max(committed_seed, on-box_high_water)`** — history
    can only push the guard *up*, never below the `local-llm.md` seed. A low
    observation (a small batch that never reached true peak) therefore cannot
    weaken the guard; only a *higher* observed peak moves it. The seed is the
    floor; on-box history is the upward correction (the capture plumbing already
    exists, so a runtime peak is cheap to record). `local-llm.md` is the initial
    seed, not the runtime authority once history exists.

- **Sidecar device honoring** (`server/tts-sidecar/main.py`) — the synth/load
  path accepts an assigned `device` and loads the model there instead of choosing
  on its own.

- **Server-owned analyzer evict** (`server/src/gpu/residency.ts`) — unchanged
  ownership, new trigger: evict the analyzer only when `GpuAdmission` reports no
  device can fit an incoming heavy model, replacing the blunt `SAFE_COEXIST_MB`
  "8 GB → always evict" rule.

### Why footprint = peak-under-load, not weight size

The number we admit against must be the model's **peak VRAM under its actual run
config**, because that is what OOMs. Measured evidence already in the repo:

- Qwen 0.6B **weights ~1.2 GB**, but **decode peak** at the shipped
  `QWEN_BATCH_SIZE=32 / QWEN_BATCH_TOKEN_BUDGET=3600` is **~5.6 GB**; at 4800
  it's ~6.9 GB — "too hot" on 8 GB (`docs/tts-performance.md`). Activation + KV
  dominate, not weights.
- Analyzer weights + KV: qwen3.5:4b ~3.0 GB + ~1.0–1.5 GB KV at 16K ctx
  (`docs/local-llm.md`).

So `FootprintTable` is keyed by the levers that move the peak (engine, model, and
for Qwen the batch/token-budget), seeded from those measured rows, and the reserve
knob covers the residual.

### Data flow (one GPU op)

```
op needs GPU (engine E, resident? R)
      │
      ▼
GpuAdmission.admit(E, runConfig)  ── acquires placement mutex ──┐
      │                                                         │
   peak = max(FootprintTable.seed(E,model,cfg), onBoxHighWater) │
      │                                                         │
      ├─ R resident on device D? ─ yes ─► ensure a peak reservation is held
      │                                    on D (place it if not); admit on D
      ▼ no                                                      │
   devices = CapacityProbe.fresh()   (per-device measured freeMb)
   admittable(D) = min(freeMb(D), total(D) − Σ reserved(D)) − RESERVE
      │                                                         │
      ├─ some device D: admittable(D) ≥ peak ─► reserve peak on D, assign, load
      │                                                         │
      ├─ E is cheap+CPU-capable (kokoro/asr/spk) ─► assign cpu, admit
      │                                                         │
      ├─ an evictable resident model exists ──────► evict (release its
      │        reservation), re-probe, retry        │
      │        (idle transient → analyzer → never the actively-generating model)
      │                                                         │
      └─ else ──────────────────────────────────► queue; wake on next release
                                                                │
   ◄── release mutex ────────────────────────────────────────────┘
   reservation is HELD for the model's resident-and-callable lifetime;
   released on evict or on device disappearance (eGPU drop).
   (after a real synth, record the actual peak → up-only ratchet the estimate)
```

## Admission algorithm (detail)

For a GPU op of engine `E` under `runConfig`:

1. **Resident short-circuit — only safe because the reservation is held.** If
   `E`'s model is loaded on device `D` *and* its peak reservation is still held
   on `D`, run there directly. The short-circuit is safe **only** because that
   reservation was never released (it guards the decode peak of this very
   re-invocation); it is not "skip the capacity check because it's already
   loaded." If the model is resident but somehow unreserved (edge case after a
   ledger reconcile), fall through to step 2.
2. **Estimate peak.** `peak = max(FootprintTable.seed(E, model, runConfig),
   onBoxHighWater)` — the up-only ratchet. Seeds round *up* so a cold engine
   never under-counts into an OOM.
3. **Probe.** `CapacityProbe.fresh()` → per-device measured `freeMb`. Admittable
   per device = `min(freeMb, total − Σ held_reservations) − GPU_RESERVE_MB`. The
   `min` guards a not-yet-spiked peak (via reservations) without double-counting
   one already reflected in measured free.
4. **Fit.** Choose the device with the **most headroom** among those where
   admittable ≥ `peak` (heavy models gravitate to the 16 GB eGPU when present,
   leaving the 8 GB card for the analyzer split + Kokoro). **Reserve `peak` on the
   chosen device**, then assign, load, admit. On Apple there is one `mps` device;
   the same test applies to unified memory.
5. **CPU fallback (cheap engines only).** If nothing fits and `E ∈ {kokoro, asr,
   spk}`, assign `cpu`. Slower but low memory, and these are CPU-capable.
6. **Evict-then-retry (heavy engines).** If nothing fits and `E ∈ {qwen, coqui}`,
   evict the lowest-priority evictable resident model (**release its
   reservation**), re-probe, retry from (4). Eviction priority: **idle transient
   first** (Qwen VoiceDesign / Base17 past idle-TTL, idle ASR/ECAPA) → **then the
   analyzer** → **never the model actively generating.** **The analyzer cannot be
   evicted while an analysis is mid-flight** (`local-llm.md`: the load path returns
   409). So on a single small card, a heavy TTS op that can't fit alongside a
   running analysis neither evicts nor fits → it **queues until analysis
   completes** (step 7). That is correct and OOM-safe, but it is a behavior change
   from the old "semaphore just serializes" and must be surfaced to the user as a
   queued state, not a hang.
7. **Queue.** If nothing is evictable, queue; re-run admission when any holder
   releases (a load finishes / a model is evicted / an analysis completes / an
   eGPU attaches). The queued op shows in the existing "Queued (N ahead)" pill.
8. **Record truth (up-only).** After a real synth, measure the actual peak; if it
   exceeds the current estimate for that (engine, model, runConfig), ratchet the
   stored high-water mark **up**. A lower measurement never lowers the guard.

## Multi-device & eGPU hot-plug

- **Detection is live, never cached across the decision.** Each heavy admission
  forces a fresh probe, so an attached eGPU (two devices) or a docked/dropped one
  (one device) is picked up with no restart.
- **eGPU attach** → a new device with ~16 GB free appears; the next heavy
  admission places there and queued ops wake.
- **eGPU drop mid-session** (the "GPU is lost" poison) → the device vanishes from
  the probe. Any op *in flight* on it is already dead; the sidecar's existing
  meta-tensor / "GPU is lost" handling reports the failure, the op is marked
  failed (not silently retried into a wedge), and subsequent admissions see only
  the remaining device. We do **not** try to rescue in-flight work off a vanished
  bus — that is the documented hang.
- **Apple / CPU-only** collapse to a single device; the algorithm is unchanged
  (one candidate, unified-memory or RAM free).

## Ollama as an opaque consumer

- We **never** set `CUDA_VISIBLE_DEVICES`, `OLLAMA_SCHED_SPREAD`, or `num_gpu`
  for placement purposes. The analyzer splits as it sees fit.
- Its footprint is invisible to torch's *own* allocation accounting but **fully
  visible to the capacity probe** (`nvidia-smi`/`rocm-smi` see every process;
  `torch.cuda.mem_get_info` reports driver-global free, which also includes it).
  So the per-device `freeMb` we admit against already reflects Ollama's split. No
  modeling required.
- The only lever we keep over Ollama is **eviction** (server-owned, already
  exists), triggered only at admission step (6). With a roomy device present this
  rarely fires — the heavy model just lands on the device with room.

## Failure modes & mitigations

| Failure | Mitigation |
|---|---|
| **Transient decode-peak double-book** (the killer) | Each op holds a `peak` **reservation** for its resident lifetime; admission fits against `min(measured_free, total − Σreserved) − reserve`, so a peak that hasn't spiked yet is still reserved. This is the core invariant — see `ReservationLedger`. |
| **Probe unreachable because the sidecar is down** (analysis phase / RSS recycle) | Server-side vendor fallback (`nvidia-smi`/`rocm-smi`) keeps GPU truth; CPU-only only when *no* probe succeeds. |
| **Free MB non-contiguous (fragmentation OOM despite "fit")** | `GPU_RESERVE_MB` headroom per device, **plus** the sidecar's already-shipped `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` (plan 144) — the reserve alone is not the frag fix, `expandable_segments` is; the reserve is the last-MB cushion on top. |
| **Two concurrent admissions race on the same free capacity** | Placement mutex serializes probe→decide→reserve→load; the second decision re-probes *and* sees the first's reservation. |
| **Peak estimate too low → OOM** | Seed = measured, rounded up; on-box history ratchets the guard **up-only** (a lower observation never lowers it). |
| **eGPU drops mid-load / mid-session** | Vanished device removed from enumeration; in-flight op fails fast via existing poison handling; **its reservations are dropped from the ledger** so the freed-by-loss capacity can't leak into permanent under-admission; no new placement on a non-enumerated device. |
| **Apple unified memory pressure** | `freeMb` = live available RAM, so admission tightens as the OS eats RAM; CPU and `mps` draw the same pool, modeled as one device. |
| **Queue starvation** (a heavy op never fits — incl. can't-evict-mid-analysis) | FIFO head-of-line fairness (inherited from the semaphore's drain discipline); the op sits in the visible "Queued (N ahead)" pill until analysis/eviction frees room — a queued state, never a silent hang. |

## The one knob

- **`GPU_RESERVE_MB`** — per-device capacity held back from admission (default
  `768`). `apply: live`. The only GPU-arbitration knob that survives. Default is
  `768`, not a token 512: `tts-performance.md` shows peaks brushing 6.9 GB on an
  8 GB card, and the codec-GPU experiment poisoned the CUDA context near the
  ceiling — the cushion has to be real. It works *with*, not instead of, the
  shipped `expandable_segments` frag mitigation. Registry help: "Headroom kept
  free on each device so a load never fills memory to the brim and trips
  fragmentation OOM. Raise if you still see OOM despite apparently-free memory."

## What gets deleted / migrated

**Deleted** (registry knobs + code):
- `gpu.vramBudget` / `GPU_VRAM_BUDGET`
- `gpu.concurrency` / `GPU_CONCURRENCY`
- `gpu.weight.{kokoro,qwen,coqui,analyzer,asr,spk}` (all six)
- `gpu.safeCoexistMb` / `GPU_SAFE_COEXIST_MB` (superseded by "evict only when
  nothing fits")
- The weighted-token math in `GpuSemaphore` + `engine-vram-cost.ts`
  (`ENGINE_VRAM_COST` / `costForEngine` / `DEFAULT_GPU_VRAM_BUDGET`), and
  `scripts/check-no-budget-poll.mjs` (the lint guard that existed only because
  the budget was a footgun).

**Kept / re-pointed:**
- `ANALYZER_OLLAMA_CONCURRENCY` (K) and its limiter stay; its per-model GPU
  **lease** re-points from the weighted `gpuSemaphore` slot to `GpuAdmission`
  (the analyzer "is resident" rather than "costs 4 tokens").
- Existing per-engine device pins (`tts.{coqui,kokoro,qwen}.device`) become an
  **optional manual override** that auto-placement honors when set, and ignores
  (auto-picks) when left at `auto`.
- `acquireGpuTokenIfOnGpu` / the off-GPU-skip idiom becomes
  `GpuAdmission.admit`; call sites in `tts/sidecar.ts` updated in place.
- `GET /api/gpu/queue` + the "Queued" pill stay; the status payload gains
  **per-device free capacity + what's resident where** (read-only), replacing the
  now-meaningless "budget / effective N" display.

**Registry migration:** deleted knobs get a `removed`/alias entry so a stray
`GPU_VRAM_BUDGET=4` in an old `.env` is inert (same pattern as the retired
`ANALYZER=gemini`), not a hard error.

## Testing

- **Primary acceptance (the goal):** a server-side integration test with a
  **mocked `CapacityProbe`** driving each hardware state — (a) single 8 GB CUDA
  card, (b) 8 GB + 16 GB, (c) single Apple `mps` device, (d) CPU-only — asserts a
  sequence of loads (Kokoro + analyzer + Qwen + Coqui) is **never admitted past
  real free capacity** on any device — the invariant is **Σ held peak
  reservations per device ≤ `total − reserve`**, checked at every admission, not
  merely "instantaneous measured free ≥ next peak." This is the "no OOM anywhere"
  guarantee, made mechanical.
- **Transient-peak reservation (the OOM regression that motivated the rework):**
  two heavy ops (the `generationWorkers=2` case) admit sequentially onto one 8 GB
  card while their *loads* fit but their *peaks* don't; assert the second is
  queued, **not** admitted — i.e. admission counts the first's held `peak`
  reservation even before it has spiked. This is the test that would fail against
  a naive "read free at load time" implementation.
- **Reservation lifecycle:** reservation released on evict; reservation for a
  vanished (eGPU-dropped) device dropped from the ledger; resident short-circuit
  only fires while the reservation is held.
- **Sidecar-down capacity:** `/capacity` unreachable → server vendor-probe
  fallback still reports the GPU (not CPU-only); only no-probe-at-all → CPU-only.
- **eGPU hot-plug:** probe flips 2 devices → 1 between admissions; assert
  queue/fail handling, ledger reconcile, and no placement on the vanished index.
- **Ollama opacity:** probe reports a device with reduced free (an Ollama split);
  assert admission respects the *reduced* free, not a modeled cost.
- **Can't-evict-mid-analysis:** heavy TTS op + mid-flight analysis on one small
  card → op queues (not 500, not hang), then admits when analysis completes.
- **Eviction ladder:** idle-transient evicts before the analyzer; the
  actively-generating model is never chosen.
- **CPU fallback:** heavy engine with no room → queue; cheap engine with no room
  → CPU.
- **Footprint peak vs weight:** assert Qwen at 32/3600 admits against the ~5.6 GB
  measured peak, not the ~1.2 GB weight size (guards the exact under-count OOM).
- **Footprint learning (up-only):** a *higher* measured peak raises the estimate
  for the next admission of the same (engine, model, runConfig); a *lower* one
  leaves the guard unchanged. Seed floor from `local-llm.md` is enforced by the
  parity test.
- **Sidecar:** pytest that `device=cuda:N` / `mps` / `cpu` is honored on load
  (extends `test_runtime_wiring.py` / `test_devices.py`).
- Regression plan under `docs/features/` created per the before-shipping checklist.

## Implementation notes

- **Runs on its own worktree + branch off `main`** (`feat/server-…`) — no direct
  work on `main`, per the operator's standing instruction and the branching
  workflow.
- This reverses the 2026-06-16 deferral of MB-accounting; that doc's reasoning
  ("on 8 GB the answer is always evict") was correct *for a fixed single 8 GB
  card* and no longer holds once a 16 GB eGPU / AMD / Apple device is in play.

## Resolved decisions

1. **Capacity read is sidecar-owned, exposed via `GET /capacity`** for the server
   and any other consumer (admin console, benchmarks). The sidecar's torch view
   is the portable cross-vendor read; the server still owns the evict decision.
2. **Footprint keyed by (engine, model) — plus the Qwen batch/token-budget
   levers**, which measurably swing its peak (5.6 → 6.9 GB). All other engines
   stay flat (engine, model). On-box telemetry history refines every entry.
3. **eGPU drop → toast + auto-requeue.** The in-flight op fails fast (no rescue
   off a vanished bus), a toast tells the user the eGPU disconnected, and the
   chapter auto-requeues onto the remaining device.

## Remaining open questions

- None blocking the plan. Two tuning details deferred to implementation: the
  exact `/capacity` cache TTL, and whether a first-run micro-probe should
  pre-populate `FootprintTable` before the first real load (vs. relying on the
  committed seed until telemetry accrues).
