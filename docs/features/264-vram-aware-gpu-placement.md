---
status: active
shipped: null
owner: null
---

# Capacity-aware GPU placement (replaces the hand-set GPU token budget)

> Status: ACTIVE — capacity admission is now default-ON, and the last code-side
> readiness follow-up (#1721, device-targeted `idle_evict`) has landed, but the
> plan stays `active` (not yet archivable) pending on-box acceptance.
> `SEG_CAPACITY_ADMISSION` defaults **ON** as of the #1720 flag flip
> (2026-07-20); `=0` is the opt-out that restores the pre-admission serialized
> path. The flip was made on the strength of the full automated admission
> coverage (sidecar + Node) plus the on-box **synthesis-path** acceptance
> (S1/S2/S4 below). The manual **evict-under-contention** rows (6–8: cold
> `/load` steer, `design_voice` evicts Ollama, GPU-ASR 503→evict→retry) were
> **not** force-driven on-box — they rest on automated coverage for now. The
> former multi-GPU `idle_evict` over-eviction gap is now fixed and covered
> (**#1721** — it only ever over-evicted an idle engine on the wrong card, never
> OOMed). This plan flips to `stable` (and archives) once the evict-under-contention
> rows 6–8 are driven on-box on the dual-GPU box.
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
  idiom); env flag `SEG_CAPACITY_ADMISSION` (default ON since #1720; `=0` opts out); env knob
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

Run with `SEG_CAPACITY_ADMISSION=1` on current `main`, where admission covers
**every heavy GPU op** — synth, cold `/load`, `design_voice`, `mint_variant`,
ASR `/transcribe`, SPK `/embed` (#1720 / PR #1731) — and the multi-GPU
device-steer is atomic through both the load **and** the forward (#1730 /
PR #1732). So an OOM, a wrong-card op, or a silent CPU demotion in *any* of those
paths is now a real failure here, not an expected gap. **This is the acceptance
the whole feature exists to satisfy.**

> **Hardware note (OcuLink eGPU).** The 16 GB eGPU is added/removed only across a
> **reboot** — it is not hot-pluggable like Thunderbolt. So the everyday config is
> the 8 GB card alone, and the 2-card config is a separate boot with the card
> connected. The steps below are written for reboot-to-switch hardware — there is
> no live attach (old step 2) or forced live drop (old step 3).

1. **8 GB card alone, render a book** → no OOM; if the analyzer is resident, a
   heavy synth (or a cold `/load` / `design_voice`) 503s → Node evicts Ollama
   (idle) → retries → succeeds; the pill shows "Queued" briefly, never spins forever.
2. **Boot with the 16 GB eGPU attached (2-card), render with no config change** →
   `GET /capacity` lists both cards; the next cold load steers to the roomier
   (16 GB) device — **no env/settings change vs. the 1-card run** (the headline
   goal). *OcuLink: reach this state by rebooting with the card connected; there
   is no hot-attach.*
3. **eGPU fault-drop — observe-only (cannot be forced on OcuLink)** → IF the eGPU
   ever drops off the CUDA bus on its own mid-run ("GPU is lost"), the in-flight
   op fails fast, its reservation releases, a toast fires, and it re-queues onto
   the 8 GB card. You **cannot** safely trigger this on OcuLink (add/remove is
   reboot-only; yanking the cable is a hard crash) — mark it **Blocked / N-A**.
   The recovery path is unit-covered; it is not required for sign-off.
4. **Analysis + render pressure** → analyzer and heavy TTS take turns per device;
   no OOM, no permanent hang; at the poll cap an actionable toast, not a spinner.
5. **Flip `SEG_CAPACITY_ADMISSION=0`** → generation behaves exactly as before the
   feature (dormant admission); `poolWidth=1` keeps a single render serialized and
   the flag-OFF `withGpuLoad` evict still prevents an 8 GB OOM on a resident analyzer.
6. **2-card boot, cold `/load`** → loading Coqui (or Kokoro/Qwen) steers to the
   roomier of the two cards; `GET /capacity` shows the reservation landing on the
   expected device.
7. **`design_voice` on a full 8 GB card** → the idle Ollama analyzer is evicted
   and the design proceeds; if there's still no room, the actionable
   busy/no-capacity toast surfaces instead of a hang.
8. **GPU-configured ASR (`ASR_DEVICE=cuda`) `/transcribe` under contention** →
   503s with `noCapacity`, Node evicts the idle analyzer and retries, and the
   transcription completes rather than silently falling back to CPU.
9. **(#1730) 2-card boot, concurrent cross-card ops keep to their card** → with
   both cards up, run `design_voice` + `mint_variant` (and, if `ASR_DEVICE=cuda`,
   a `/transcribe` + `/embed`) concurrently so they land on *different* admitted
   cards. Each op's entire run — load **and** forward — stays on its own card; no
   cross-card clobber, no OOM. This is the on-box confirmation of the #1730 fix
   still owed before the concurrent-multi-card flag flip. *Single-8 GB-card runs
   never hit this path — it is a 2-card-only check.*

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

`SEG_CAPACITY_ADMISSION` was flipped ON by default in #1720 (2026-07-20). These
gaps (safe while the flag is off) were the readiness checklist for that flip;
the items below marked "CLOSED by #1720" landed with it, and the remaining open
one (multi-GPU `idle_evict` over-eviction, #1721) is efficiency-only, never an
OOM — see the status header:

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

  > **CLOSED (#1721).** Fixed on branch `fix/sidecar-idle-evict-device-target`:
  > `_idle_evict_steps(device_key, engine)` now gates each candidate (Qwen
  > VoiceDesign + 1.7B-Base share `qwen._device`, ASR on `ASR._device`, ECAPA on
  > `SPK.device`) through a new `_same_card()` helper, so it only includes an
  > eviction step for an engine whose resident card matches the admitting op's
  > target — a multi-GPU box no longer evicts an idle engine on a *different*
  > card, and a cpu-resident engine (which holds no VRAM on the target card) is
  > skipped entirely. `_same_card` is `shares_device`'s card-comparison tail
  > without the torch import / auto-resolution (both inputs are already
  > concrete in this path). Regression coverage: `test_devices.py`
  > (`test_idle_evict_*`, `test_same_card_*`). Efficiency-only, never an OOM.
  > **Renamed to `_idle_evict_steps` and changed from "evict + return bool" to
  > "return an ordered list of `EvictStep` candidates" by #1920** (2026-07-28
  > sidecar-evict-hardening) — see
  > `docs/superpowers/specs/2026-07-28-sidecar-evict-hardening-design.md` §4.
- **`_observed_mb` reads `max_memory_allocated` without `reset_peak_memory_stats`**
  → the learned footprint drifts to the device-wide high-water (over-conservative,
  never an OOM).

  > **CLOSED (#1737).** Fixed on branch `fix/sidecar-footprint-percentile`:
  > `PlacementController._reset_peak_mb` calls `torch.cuda.reset_peak_memory_stats`
  > right before each op starts, so the paired `_observed_mb` read at release
  > reflects that op's own peak instead of the process-lifetime high-water mark
  > (previously a one-off ~9 GB voice-design co-residency spike poisoned every
  > later reading). `FootprintTable` also no longer ratchets up-only: it now
  > reserves the **windowed p95** of the last 64 real per-op observations (once
  > ≥5 samples exist), so a stale outlier ages out of the window instead of
  > pinning the reservation forever, and the seed is a cold-start prior only
  > (`qwen` 6144→3072, `qwen.1.7b` 7168→6144, re-grounded on measured real
  > decode peaks: 0.6B synth ~1952 MB, 1.7B mint ~5654 MB). The VRAM reserve
  > cushion also moved from a flat `GPU_RESERVE_MB` subtraction to a per-device
  > one — `min(5% of that card's own VRAM, GPU_RESERVE_MB)`, cap lowered
  > 768→500. On-box result: the 1.7B Qwen op that the stale high-water estimate
  > previously refused with `503 noCapacity` on an 8 GB card now admits and
  > runs, using the measured real peaks above. Regression coverage:
  > `test_footprints.py` (p95 windowing, seed-as-prior-not-floor, non-positive
  > observations ignored), `test_placement.py`, `test_design_mint_admission.py`.
  > The multi-op on-box acceptance walkthrough above is still owed before
  > `SEG_CAPACITY_ADMISSION` is defaulted ON.
  >
  > **Follow-up CLOSED (#1738).** #1737 left both 1.7B design-family ops
  > (`design_voice`, `mint_variant`) sharing the plain-synth `qwen.1.7b`
  > footprint key. Since synths outnumber designs/mints by orders of magnitude,
  > the shared p95 window tracked the ~3915 MB synth and the far heavier mint
  > (~5654 MB measured) inherited that under-sized reservation. Fixed on branch
  > `fix/sidecar-mint-footprint-key`: each design-family route tags its
  > reservation cfg with an `op` (`design`/`mint`) so `FootprintTable._key`
  > routes them to their own `qwen.1.7b.design` / `qwen.1.7b.mint` keys, each
  > learning an independent windowed p95. Both cold-start seeds are 6144 MB and
  > measured on-box (mint ~5654 MB, design ~5440 MB via #1742 — design_voice
  > loads VoiceDesign-1.7B + a 0.6B-Base audition), so each admits on a bare
  > 8 GB card's ~6659 MB headroom before its window warms. Coverage:
  > `test_footprints.py` (key separation, independent windows, bare-8 GB fit) +
  > `test_design_mint_admission.py` (route-level `op`-tag wiring).
  >
  > **Follow-up #1742 CLOSED.** Measured the real `/qwen/design-voice` peak
  > on-box (8 GB 4070, per-op allocated) at ~5440 MB — below mint's ~5654 and
  > well under the ~6659 headroom — so the interim conservative 7168 design seed
  > was dropped back to 6144. Refutes the review's "design might exceed 6144 →
  > OOM" concern with a real number.
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

## Coqui residency policy (side-18)

<!-- COQUI-RESIDENCY-POLICY -->

Two independent mechanisms free VRAM held by a resident Coqui XTTS model (~3.5 GB).
Both are correct, both are tested, and neither knows the other exists. The fork
#1932 offered — collapse to one, or keep both with explicit cross-references —
is **closed: both are kept**, for the two reasons below. This section is the
single statement of that ruling so the question is not reopened.

### Mechanism A — Node, plan-driven, proactive

`evictEngineForPhase` (`server/src/tts/synthesise-chapter.ts:1015`) POSTs
`/unload` to the sidecar for a named engine. The Coqui-facing wrappers are
`evictCoquiForQwenPhase` (`:1049`) and the symmetric `evictQwenForCoquiPhase`
(`:1029`). 

The eviction wrappers have **four call sites**, not two:

1. **Pre-pass invocations (memoised, resolver-mediated):** `beforeFirstCoquiDerive`
   (`:1882-1899`) evicts `evictQwenForCoquiPhase` before the first Coqui derive
   in the chapter; `beforeFirstQwenDerive` (`:1943-1953`) evicts
   `evictCoquiForQwenPhase` before the first Qwen derive (when Coqui is present).
   **Two of the three pre-pass sites are called from *inside* voice-resolver
   try/catch blocks (`clone-voice-resolver.ts`), inheriting the resolver's own
   fail-loud (cloned voices) / fail-soft (designed voices) semantics — no local
   try/catch wraps them at those call sites.** However, **a third pre-pass site**
   exists at `:2114-2122`, also in `synthesise-chapter.ts`, which primes
   `beforeFirstQwenDerive` before any Qwen render-phase work when only Qwen
   voices with no derive are present (no resolver call to hang the hook off).
   This third site **is wrapped in a local try/catch** (lines 2114-2122) that
   unconditionally swallows the error and logs a warning — deliberately best-effort
   fail-soft, covering the "Qwen render with no derive needed" case where a
   sidecar recycle window at this priming call cannot abort the chapter.

2. **Render-phase pair (top-level, plan-driven):** The leading evict fires at
   `:2920` before a mixed chapter's Coqui phase; the trailing evict fires at
   `:2988` at its end. Each call is bounded by `withCallTimeout` and carries
   the chapter's abort signal.

The render-phase pair is driven by the **generation plan** — Node knows which
engine the **current dispatch** needs, so it can free the VRAM at a boundary
where "no further Coqui work is queued" is a *fact* rather than a prediction
(this scope applies to the **render-phase pair only** and the current dispatch,
not future chapters or the pre-pass pair, which is memoised and runs *before*
any derive). The render-phase evicts are deliberately **fail-soft** on non-abort
errors: socket errors and timeouts are logged as warnings and execution
continues. The leading evict additionally rethrows abort signals for pause
detection (`routes/generation.ts` names its own `AbortError`); the trailing
evict swallows aborts too, since by the time it fires the chapter's synthesis
work is already complete. This asymmetry is correct: the trailing evict's abort
swallow does not lose synthesised work (all groups are done), while the leading
evict's abort rethrow ensures a paused generation is visible to the pause-detection
path.

### Mechanism B — sidecar, demand-driven, reactive

`_idle_evict_steps` (`server/tts-sidecar/main.py:4989-5064`) is a
**five-step, cross-engine ladder** — `spk`, `asr`, `qwen.design`,
`qwen.base17`, `coqui` — run by `PlacementController` on the admission path
when an op is VRAM-starved. Coqui is *one step of it* (`:5063`), calling
`CoquiEngine.maybe_free_idle` (`:2273`). This is **not** a Coqui-specific
idle evict: it is one entry in a generic ladder that every engine has a step
in.

Two Coqui-specific qualifications distinguish the Coqui step from the others:

1. **Self-admission skip.** The step is omitted entirely when the admitting
   op is itself Coqui (`server/tts-sidecar/main.py:5053`, `if engine !=
   "coqui"`) — evicting would unload the model that op is about to reload.
2. **Real idle TTL.** It is the only step that uses a non-zero idle TTL —
   `_coqui_idle_ttl()` (`:8288`, 30 s default, env `COQUI_IDLE_TTL`,
   registry key `sidecar.coquiIdleTtl` at `server/src/config/registry.ts:848`)
   — rather than the `0.0` the transient models (SPK, ASR, Qwen design,
   Qwen base17) take. Coqui deliberately has **no** background watchdog,
   unlike Qwen/ASR/ECAPA, so this only ever runs under genuine VRAM
   pressure.

### Ownership

**A owns known plan boundaries; B owns unpredicted demand pressure. Neither
is a superset of the other.**

A fires at the exact points where Node's generation plan guarantees no
further Coqui work remains in the current dispatch. B fires whenever an
unrelated admission is VRAM-starved and Coqui happens to be idle long enough
to reclaim — a situation Node's plan cannot predict because it arrives from
outside the current book's render.

### Why both are kept

1. **Removing B** would delete one step from a five-step cross-engine ladder
   that stays regardless. The only effect is that a starved *non-Coqui*
   admission can no longer reclaim XTTS's ~3.5 GB on an 8 GB card. That is a
   regression, not a consolidation.

2. **Removing A** would require the sidecar to know Node's generation plan
   across a process boundary, which it cannot. And B cannot substitute for
   A: B fires only *after* an admission is already starved, and only past a
   30 s TTL — so a Qwen load arriving 5 s after the Coqui phase ends finds
   Coqui resident, the step returns `False`, and nothing is reclaimed.

### Lock caveats — invariants any future change must preserve

1. **Mechanism A's failure semantics differ by call site.**
   
   - **Render-phase pair (bounded by `withCallTimeout`, fail-soft):** Each
     `/unload` call carries the chapter's abort signal. Both evicts must remain
     fail-soft on transient errors (socket errors, timeouts are logged as
     warnings and execution continues). They differ on aborts: the leading
     evict rethrows `AbortError` for pause detection (`routes/generation.ts`
     names its own `AbortError`), while the trailing evict swallows abort
     signals too since by that point all synthesis work is done. The trailing
     evict cannot lose synthesised audio by failing, and the leading evict must
     signal a pause through its abort path if the generation is cancelled
     mid-evict.
   
   - **Pre-pass pair — two resolver-mediated, one render-prep best-effort:**
     `beforeFirstCoquiDerive` and `beforeFirstQwenDerive` have **three distinct
     invocation patterns**, each with different failure semantics that must be
     preserved independently:
     
     - **Two resolver-mediated sites (voice-type-dependent):** Called from
       *inside* voice-resolver try/catch blocks in `clone-voice-resolver.ts`,
       with no separate local try/catch wrapping them. A failure is reported
       through the resolver's own existing, already-differentiated policy: the
       cloned resolver's catch treats it as an ordinary derive failure (fail-loud —
       `broken` accumulates, `UnresolvableClonedVoiceError` still throws), while
       the designed resolver's catch treats it as an ordinary self-heal failure
       (fail-soft — `softFailedUuids`/keep-stale, never rethrown). This voice-type-dependent
       semantics is intentional: a pre-pass evict failure on a cloned voice is
       unrecoverable (the cloned resolver's own identity depends on that model
       running), while a failure on a designed voice can be healed by keeping
       the stale version.
     
     - **One render-prep best-effort site (unconditional fail-soft):** A third
       pre-pass invocation at `:2114-2122` in `synthesise-chapter.ts` primes
       `beforeFirstQwenDerive` before any Qwen render-phase work when only
       healthy/catalogue Qwen voices are present (no resolver call to hang the
       hook off). This site **is deliberately wrapped in a local try/catch**
       that unconditionally swallows errors and logs warnings, covering the case
       where a sidecar recycle window at this priming call cannot abort the
       chapter (fix for a §2.3 chapter-abort regression). This best-effort wrapper
       is distinct from the resolver-mediated invocations and correct by design.
     
     Any future change to the pre-pass evicts must **preserve all three
     invocation patterns independently**: the two resolver-mediated sites must
     remain unwrapped at those call sites (inheriting resolver semantics), and
     the render-prep site must retain its local fail-soft wrapper to prevent
     chapter aborts on transient sidecar errors.

2. **Mechanism B's lock-guarded idle check.** `maybe_free_idle`
   (`server/tts-sidecar/main.py:2273`) re-validates the idle condition under
   `_synth_lock` and skips while a synth is in flight, so admission can
   never free the model out from under an active forward. Any change to
   `maybe_free_idle` must preserve this re-validation-under-lock.

3. **Mechanism B's non-reentrant lock.** `_drop_model_locked()` MUST be
   called while already holding `_synth_lock` (it is a non-reentrant
   `threading.Lock`); by contrast, the public `unload()` method MUST NOT be
   called while holding the lock — it acquires the lock itself. Internal
   callers that need the same teardown (e.g., `maybe_free_idle` at
   `server/tts-sidecar/main.py:2273`) acquire the lock, call
   `_drop_model_locked()` inside it, then release the lock and call
   `_reclaim_after_drop()` afterwards. This sequence is critical: releasing
   the lock BEFORE reclaim is necessary for throughput — holding `_synth_lock`
   across the multi-second `gc.collect()` + `torch.cuda.empty_cache()` in
   `_reclaim_after_drop()` would unnecessarily block concurrent synth calls that
   only need the lock briefly, for no correctness benefit (the reference-drop
   whose safety depends on the lock is guaranteed by ACQUIRING it, not
   releasing it — `_synth_lock` waits for any in-flight forward to finish and
   release its own reference before `_drop_model_locked()` runs). See
   `_reclaim_after_drop()`'s docstring at `server/tts-sidecar/main.py:2127-2134`
   for the full rationale.
   Any future internal caller must follow the same acquire-drop-release-reclaim
   sequence; any future code that nulls or reassigns a model field must mirror
   `_drop_model_locked()`'s full teardown (including the device restoration
   that `_drop_model_locked()` already handles) to avoid the double-allocation
   race documented in `unload()`'s own docstring
   (`server/tts-sidecar/main.py:2040-2049`).

## Ship notes

(Filled when status flips to `stable` after the on-box acceptance above passes and
`SEG_CAPACITY_ADMISSION` is defaulted ON.)

**Outcome, 2026-08-21 (Castwright#2553, wave 4 of the on-box acceptance
register campaign, #2435).** Register row A2's rows-6-8 debt (the
evict-under-contention walkthrough: cold-`/load` device steer, `design_voice`
evicts Ollama, GPU-ASR 503→evict→retry) is **ruled not owed** — this plan's
own closing sentence already frames them as "deferred by choice, not
blocked," resting on automated coverage for now, runnable on demand. The
repo owner confirmed this reading 2026-08-21. A2's remaining scope narrows
to walkthrough step 9 alone (the #1730 cross-card device-steer on-box
confirmation) — see `docs/testing/onbox-acceptance-register.md`'s A2 row.
Separately, Castwright#2559 fixed this plan's own self-contradiction (`S6`
had been listed as both force-driven and not, in the same paragraph) by
removing `S6` from the force-driven list, ahead of this outcome note.
