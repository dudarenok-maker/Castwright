---
status: active
shipped: null
owner: null
---

# Capacity-aware GPU placement (replaces the hand-set GPU token budget)

> Status: KNOWN: operational dependency — the capacity-admission path is behind
> `SEG_CAPACITY_ADMISSION` (default OFF); flip on after the on-box acceptance
> walkthrough below.
> Key files (sidecar): `server/tts-sidecar/main.py` (`probe_capacity`,
> `FootprintTable`, `ReservationLedger`, `PlacementController`).
> Key files (server): `server/src/gpu/count-semaphore.ts`,
> `server/src/gpu/capacity-probe.ts`, `server/src/analyzer/ollama-residency.ts`,
> `server/src/tts/sidecar.ts`, `server/src/routes/gpu-queue.ts`.
> URL surface: indirect (the "Queued (N ahead)" pill in `src/components/layout.tsx`).
> OpenAPI ops: `GET /api/capacity` (sidecar), `GET /api/gpu/queue` (payload changed).
>
> Design of record: `docs/superpowers/specs/2026-07-18-vram-aware-gpu-placement-design.md`.
> Implementation plan: `docs/superpowers/plans/2026-07-18-vram-aware-gpu-placement.md`.

## Benefit / Rationale

- **User:** the four confusing GPU knobs (`GPU_VRAM_BUDGET`, `GPU_CONCURRENCY`,
  six `GPU_WEIGHT_*`, `GPU_SAFE_COEXIST_MB`) are gone. Placement is driven by
  **measured free VRAM**, so switching between the 8 GB laptop card and the
  8 + 16 GB eGPU setup needs **no config change** — the goal that started this
  work.
- **Technical:** admission reserves each op's **measured decode peak** (not
  weight size) against live per-device free VRAM, so a second op can't
  double-book VRAM the first already claimed → no OOM. Cross-vendor
  (CUDA/ROCm/Apple-MPS/CPU) via `torch.cuda.mem_get_info`/psutil.
- **Architectural:** the placement authority moved to where residency lives —
  **the Python sidecar owns TTS admission**; Node owns the analyzer (K limiter)
  + the evict decision. The weighted `GpuSemaphore` is deleted; one knob
  survives (`GPU_RESERVE_MB`, default 768).

## Architectural impact

- **New seams:** sidecar `GET /capacity` + `FootprintTable`/`ReservationLedger`/
  `PlacementController`; Node `CountSemaphore` (count core of the old semaphore),
  `CapacityProbe` (sidecar `/capacity` client + `nvidia-smi`/`rocm-smi` fallback),
  `ollama-residency.ts` (`/api/ps` read + `evictOllama` via the keep_alive:0
  idiom); env flag `SEG_CAPACITY_ADMISSION` (default OFF); env knob
  `GPU_RESERVE_MB`.
- **Invariants preserved:** the discriminated `ui.stage`, the hash router, and
  OpenAPI-as-type-source are untouched. The sidecar's own `_synth_lock` (Qwen
  thread-safety) and the `test_concurrent_synthesis` contract (Coqui/Kokoro run
  parallel) are preserved — admission is a *ledger* reservation, not a new mutex.
- **Migration story:** `GET /api/gpu/queue` payload changed from
  `{depth,inFlight,max,budget,usedTokens}` to `{queueDepth, devices}`; frontend +
  `openapi.yaml` + generated `api-types.ts` migrated in the same PR. Deleted env
  vars are inert on read (unknown vars are simply never consumed — same mechanism
  that retired `ANALYZER`), so a stale `.env` doesn't error.
- **Reversibility:** `SEG_CAPACITY_ADMISSION=0` (the default) makes the sidecar
  never emit the no-capacity 503, so the Node evict-or-poll orchestration on the
  *synth* path is dormant. The **load** path is still protected in both flag
  states: `withGpuLoad` (`gpu-load.ts`) reads measured free VRAM
  (`capacityProbe`) and, on a tight card with an idle analyzer, evicts the
  resident Ollama before a heavy TTS load — the capacity-based replacement for
  the retired `safeCoexistMb` heuristic, so a default (flag-OFF) 8 GB render
  does NOT OOM on a resident analyzer. There is no fallback to the old budget;
  `poolWidth=1` (below) keeps a render serialized.

## Invariants to preserve

1. **No OOM:** every admission holds `Σ reserved peak per device ≤ totalMb −
   GPU_RESERVE_MB`. Enforced by `ReservationLedger.try_hold` /
   `PlacementController.admit` (`server/tts-sidecar/main.py`). A test that admits
   past this is a defect.
2. **Decide + hold is atomic:** `try_hold` fit-checks AND holds under ONE lock
   acquire — two concurrent admits can't both pass and double-book.
3. **Footprint = measured decode peak, not weight size:** `SEED_FOOTPRINTS_MB`
   (`qwen=6144` ≈ 5.6 GB peak, `qwen.1.7b=7168`, `coqui=3584`, `kokoro=1200`,
   `asr=400`, `spk=200`), parity-tested against `docs/local-llm.md`
   `<!-- footprint:X=Y -->` anchors; learned estimate is up-only (`max(seed,
   observed)`).
4. **Resident model is fit-checked, never migrated:** a resident engine is pinned
   to its own device and still fit-checks its peak (a co-resident analyzer that
   grew into its VRAM must not let it admit and OOM).
5. **`poolWidth = 1` for GPU engines** (`synthesise-chapter.ts`) — one synth at a
   time per render. This is the flag-OFF safety net (the batch is the throughput
   lever, not concurrent `/synthesize`).
6. **The wake loop terminates:** the Node poll loop advances `attempt` every
   iteration, evicts at most once, and throws `NoCapacityError` (a toast, not a
   hang) at `GPU_CAPACITY_MAX_ATTEMPTS`.
7. **No live consumer of the deleted budget:** grep `server/src` — `gpuSemaphore`,
   `acquireGpuTokenIfOnGpu`, `safeCoexistMb`, `gpu.weight*`, `gpu.vramBudget` have
   only comment/test mentions.

## Test plan

### Automated coverage

- **Sidecar (pytest):** `test_capacity.py` (probe never raises, always-cpu, dead
  device omitted, psutil-None degrade), `test_footprints.py` (peak≥5600, up-only,
  doc parity), `test_placement.py` (the OOM invariant, atomic 16-thread race,
  resident fit-check, idle-evict, cpu fallback), `test_devices.py` (503 on no-fit
  behind the flag; flag-off unchanged).
- **Server (Vitest):** `count-semaphore.test.ts`, `capacity-probe.test.ts`
  (sidecar→vendor→cpu fallback, last-known-good cache), `ollama-residency.test.ts`
  (`/api/ps` parse, evict, would-help), `sidecar.test.ts` (evict-then-succeed,
  poll-while-analysis, `NoCapacityError` at cap, poison still throws),
  `analyzer-concurrency.test.ts` (K limiter on CountSemaphore),
  `gpu-queue.test.ts` / `diagnostics.test.ts` (new payload), `registry.test.ts`
  (budget knobs absent, `gpu.reserveMb` present).
- **Op admission (#1720):** `test_load_admission.py` (cold `/load` across
  coqui/kokoro/qwen-0.6b/qwen-1.7b), `test_design_mint_admission.py`
  (`design_voice` + `mint_variant`), `test_transcribe_embed_admission.py`
  (GPU-configured ASR/SPK), and `_engine_env_pin` cases in `test_placement.py`
  (the `pinned` operator-device constraint) — all sidecar (pytest). Server:
  `src/gpu/capacity-retry.test.ts` (the extracted retry helper) plus the five
  updated callers.
- **Frontend (Vitest):** `layout.test.tsx` (the "Queued (N ahead)" pill on
  `queueDepth>0`), `api`/`use-tts-lifecycle` payload consumers.

### Manual acceptance walkthrough (owed on-box — the "no OOM" bar)

Run with `SEG_CAPACITY_ADMISSION=1` on the real hardware. **This is the
acceptance the whole feature exists to satisfy.**

1. **8 GB card alone, render a book** → no OOM; if the analyzer is resident, a
   heavy synth 503s → Node evicts Ollama (idle) → retries → succeeds; the pill
   shows "Queued" briefly, never spins forever.
2. **Attach the 16 GB eGPU mid-session, render again** → next cold load prefers
   the roomier card (`GET /capacity` shows both); no config change.
3. **Drop the eGPU mid-run** → the in-flight op fails fast ("GPU is lost"), its
   reservation releases, a toast fires, the op re-queues onto the remaining card.
4. **Analysis + render pressure** → analyzer and heavy TTS take turns per device;
   no OOM, no permanent hang; at the poll cap an actionable toast, not a spinner.
5. **Flip `SEG_CAPACITY_ADMISSION=0`** → generation behaves exactly as before the
   feature (dormant admission), `poolWidth=1` keeps a single render serialized.
6. **(#1720) 2-card box, cold `/load`** → loading Coqui (or Kokoro/Qwen) steers
   to the roomier of the two cards; `GET /capacity` shows the reservation
   landing on the expected device.
7. **(#1720) `design_voice` on a full 8 GB card** → the idle Ollama analyzer
   is evicted and the design proceeds; if there's still no room, the actionable
   busy/no-capacity toast surfaces instead of a hang.
8. **(#1720) GPU-configured ASR (`ASR_DEVICE=cuda`) `/transcribe` under
   contention** → 503s with `noCapacity`, Node evicts the idle analyzer and
   retries, and the transcription completes rather than silently falling back
   to CPU.

## Op admission (#1720)

Capacity admission originally covered `/synthesize` only; #1720 extends it to
every heavy GPU op:

- **Five op families (+ `mint_variant`) now admitted:** cold `/load`
  (coqui/kokoro/qwen-0.6b/qwen-1.7b), `design_voice`, `mint_variant`,
  `/transcribe` (ASR, GPU-configured only), and `/embed` (SPK, GPU-configured
  only) all run inside `PlacementController.reservation()` with multi-GPU
  device steering — the admitted card is threaded into the cold load. The
  three Qwen cold-loads (design/mint/synth) share one `_cold_load_lock` so
  device-steer set→resolve→load is atomic.
- **`pinned` operator-device constraint:** an `ASR_DEVICE=cuda:1`-style env
  pin restricts admission to that card; `noCapacity.deviceKey` prefers the
  pin over the general placement search.
- **Single admission authority, single eviction authority:** `withGpuLoad`
  (`server/src/gpu/gpu-load.ts`) defers to sidecar admission (a lock-free
  passthrough) when `SEG_CAPACITY_ADMISSION` is ON, so Node no longer runs a
  second, independent admission check on top of the sidecar's — one source of
  truth for "does it fit," one source of truth for "who gets evicted." The
  retry/eviction logic itself was extracted into `withCapacityRetry`
  (`server/src/gpu/capacity-retry.ts`): retry a `noCapacity` 503 (evict idle
  Ollama once, then bounded poll), pass through every other response. Wired
  into all five callers (design, mint, the `/api/sidecar/load` proxy,
  transcribe-client, embed-client).
- **Flag-ON behavior change:** a tight card + analysis-in-flight now yields a
  bounded-poll → `NoCapacityError` (an actionable 503/toast) instead of the
  instant `GpuBusyError` 409 the old coarse `withGpuLoad` produced.
- **`cpu_capable=False` for asr/spk:** a GPU-configured ASR/SPK that can't fit
  returns a 503 → Node evicts the idle analyzer and retries (honoring the
  explicit `ASR_DEVICE=cuda` opt-in), rather than silently demoting to CPU.

## Out of scope (flag-on-readiness follow-ups)

Before `SEG_CAPACITY_ADMISSION` is flipped ON by default, these gaps (safe while
the flag is OFF) should close so admission covers everything the budget did:

- **CLOSED by #1720:** cold `/load` (coqui/kokoro/qwen-0.6b/qwen-1.7b),
  `design_voice`, `mint_variant`, `/transcribe` (ASR), and `/embed` (SPK) are
  now all wrapped in the sidecar's `PlacementController.reservation()` with
  multi-GPU device steering, alongside `/synthesize`. Node handles the
  `noCapacity` 503 for every one of these callers via the extracted
  `withCapacityRetry` (`server/src/gpu/capacity-retry.ts`), and `withGpuLoad`
  now defers to sidecar admission (lock-free passthrough) when the flag is
  ON — one admission authority (sidecar), one eviction authority (Node). A
  new `pinned` operator-device constraint (an `ASR_DEVICE=cuda:1`-style env
  pin) restricts admission to that card, with `noCapacity.deviceKey`
  preferring the pin. Flag-ON behavior change: a tight card now yields a
  bounded-poll → `NoCapacityError` (actionable 503/toast) instead of the old
  coarse `withGpuLoad`'s instant `GpuBusyError` 409. asr/spk decisions are
  `cpu_capable=False`, so a GPU-configured ASR/SPK that can't fit 503s →
  Node evicts the idle analyzer and retries, rather than silently demoting
  to CPU.
- **`idle_evict` ignores the target device** (over-evicts on a true multi-GPU box).
- **`_observed_mb` reads `max_memory_allocated` without `reset_peak_memory_stats`**
  → the learned footprint drifts to the device-wide high-water (over-conservative,
  never an OOM).
- **`persona-gpu-plan.ts`'s `unloadResidentSidecar` + `GpuBusyForPersonaError`
  are now dead code** (the reverse-evict was removed); deletion candidates.
- **`engine-vram-cost.ts` is provably dead** (its registry weights are deleted) —
  a candidate for deletion in a follow-up.
- **Per-device pill + eGPU-drop toast e2e** are deferred polish.
- **(#1720, flag-ON only, flag-OFF safe) Qwen forward-clobber:** device-steer
  is atomic through the model LOAD but not the later FORWARD —
  `QwenEngine._device` is one field per engine, read unlocked at synthesis
  time (e.g. mint's `rc.to(self._device)`). A concurrent flag-ON
  design(card1) + mint(card0) against the single Qwen engine can land a
  *forward* on the wrong card. Deferred remedy: thread the resolved device
  into `_load_qwen_model`/the forward instead of reading the shared
  `self._device`. Gates the concurrent-multi-card flag flip.
- **(#1720, flag-ON only, flag-OFF safe) ASR/SPK cold-load steer unlocked:**
  the `/transcribe` + `/embed` handlers set the engine device attr unlocked
  before the cold load; a concurrent multi-GPU *first* cold-load could land
  on the wrong card (benign on a single-GPU box; once resident, `is_resident`
  pins subsequent calls to the same card). Deferred remedy: thread the device
  into transcribe/embed/`ensure_loaded` under the engine load lock. Gates the
  concurrent-multi-card flag flip.
- **(#1720, flag-ON only, flag-OFF safe) Coqui load-steer leaves `self._device`
  stale:** `CoquiEngine._resolve_runtime_options(device_override=…)` uses the
  admitted device for the local load (`.to(device)`) but never updates
  `self._device`. On a multi-GPU box with `COQUI_DEVICE` unset/`auto` and the
  flag ON, a later forward referencing `self._device` for input-tensor placement
  could mismatch the model's actual card — the same stale-device class as the
  Qwen/ASR/SPK items above (benign single-GPU; a pinned `COQUI_DEVICE=cuda:N`
  aligns via `_engine_env_pin`). Deferred remedy: same as the others.

The three flag-ON stale-`self._device` items above (Qwen forward, ASR/SPK
cold-load, Coqui load-steer) are tracked together in **#1730**.

> **CLOSED (#1730).** All three are fixed: the Qwen 1.7B forward now moves its
> ref_code onto the resident wrapper's own `self._base17.device` (published with
> the model at load, immune to a shared-field clobber); `/transcribe` + `/embed`
> thread the admitted card into `transcribe`/`_ensure_loaded` / `ensure_loaded`
> as a parameter (applied under the load lock, no pre-mutation across the
> unlocked gap); and Coqui's `_ensure_loaded` keeps `self._device` in step with
> the card the model is actually on (restored to the requested pref on
> `unload()`). Regression coverage: `test_design_mint_admission.py`,
> `test_transcribe_embed_admission.py`, `test_coqui_device.py`. On-box 2-card
> acceptance (with `SEG_CAPACITY_ADMISSION=1`) still owed before the
> concurrent-multi-card flag flip.

## Ship notes

(Filled when status flips to `stable` after the on-box acceptance above passes and
`SEG_CAPACITY_ADMISSION` is defaulted ON.)
