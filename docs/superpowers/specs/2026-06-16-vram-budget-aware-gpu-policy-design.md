# GPU residency safety + analysing-view honesty — design

> Status: draft (spec) — 2026-06-16. Rewritten after a two-lens adversarial
> review that verified claims against source (see §11 for what the review
> overturned).
> Scope: server (analyzer residency, GPU eviction before sidecar loads) +
> frontend (analysing chip label, per-chapter progress). Delivered as **waves**,
> not one PR.

## 1. Problem

On the live 8 GB box the analyzer in use is `qwen3.5:9b`. Three problems:

1. **Reload tax.** The 9B fell to `keep_alive: 0`, so Ollama unloaded+reloaded
   ~6.35 GB on **every chapter section** — a VRAM sawtooth, mid-stream "no
   response" stalls, degraded wall-clock. Worst on **Cyrillic** manuscripts,
   which need the larger model.
2. **Eviction blind spot.** The analyzer↔TTS eviction that frees VRAM before a
   voice engine loads is driven by the **frontend** Load button only. The
   **server-side** generation preload and **the voice-design path** load sidecar
   models with **no** Ollama eviction. Harmless under `keep_alive: 0` (9B
   already gone); an **OOM risk** the moment the 9B is kept resident.
3. **Opaque / dishonest UI.** The analysing chip shows the local default
   ("Qwen3.5 4B") even when the server resolved 9B via `ANALYZER_PHASE0_MODEL`;
   progress reads "GPU is busy" with no legible forward signal.

## 2. Decomposition (the spec's primary correction)

This is **not one cohesive change.** It ships as independent waves, each its own
branch/PR, `npm run verify` green between. Order matters only where noted.

| Wave | What | Depends on |
|---|---|---|
| **0** | Stray-key tolerance (done, stranded on its branch) | — |
| **1** | **Eviction-gap fix + `keep_alive` flip**, behind a simple VRAM threshold | — |
| **2** | Model-label honesty | — |
| **3** | Progress explainer (section-based) | — |
| **4 (deferred)** | Full MB-accounting policy + split-guard UI | a real 12/16 GB user |

The label (2) and progress (3) are independent of the VRAM work and of each
other. The MB-accounting engine (4) is **deferred** — on 8 GB the eviction
decision is always "evict," so a cost table buys nothing and adds OOM risk via
coarse estimates. Build it when 12/16 GB hardware is real.

## 3. Already done this session

- **Stray-key tolerance** (Wave 0) — `parseAndValidate` salvages an
  `unrecognized_keys`-only schema failure (the qwen3.5:9b `chapterId` drop).
  Committed on `fix/server-analyzer-tolerate-unrecognized-keys`. Independent;
  merge first.
- **`keep_alive` flip** — `qwen3.5:9b` added to `RESIDENT_MODELS` ('5m'). Done +
  green on `feat/analysing-residency-label-progress`. **MUST NOT ship until
  Wave 1's eviction lands in the same build** — otherwise analysis→generate
  within 5 min OOMs the 8 GB box. Rebase the flip onto Wave 1.

## 4. Wave 1 — eviction-gap fix (the real safety fix)

### 4.1 Decision: a single threshold, not a cost engine
```
// server/src/gpu/residency.ts
const SAFE_COEXIST_MB = registry('gpu.safeCoexistMb', 11000); // below → evict

function shouldEvictBeforeSidecarLoad(v: VramState): boolean {
  if (v.accelerator === 'cpu') return false;            // no VRAM contention
  if (v.totalMb == null) return true;                   // GPU, unknown → safe: evict
  return v.totalMb < SAFE_COEXIST_MB;                   // 8 GB → evict; 12/16 → coexist
}
```
One knob expresses the whole 8/12/16 GB story (`8192 < 11000` → evict; `12288`,
`16384` ≥ 11000 → coexist) without a per-model table, mode detection, or live
correction. The MB engine (Wave 4) refines this *only when* a coexistence box
exists.

### 4.2 VRAM state, resilient to sidecar respawn
- `vramTotalMb` + a CUDA-presence flag come **only** from the sidecar `/health`
  body, and the sidecar self-exits/respawns (`ensure-sidecar-loaded.ts:8-24`),
  so a live probe is null exactly when eviction must run.
- **Fix:** cache the last reachable `/health` VRAM figures (mirror the existing
  `setLastKnownQwenInstallState` pattern, `sidecar-health.ts:244`). The policy
  reads the **cache**, never a fresh probe. `accelerator` is `'cuda'` when a CUDA
  total was ever seen, `'cpu'` when health reported no CUDA, else `'unknown'`
  (treated as the conservative GPU branch → evict).

### 4.3 Shared eviction helper
- Extract the `/api/ollama/unload` unload-all logic into
  `unloadResidentOllama(targets?)` (`ollama-health.ts:289` →
  `probeOllamaHealth().resident` → `callOllamaGenerate(keep_alive:0)`), reused by
  the route and the new server-side callers.
- **Scope it to this run's analyzer model(s), not blanket-all-residents**, so a
  second concurrent session's resident analyzer isn't stomped (the box is shared;
  `semaphore.ts:1-7`). Blanket-all stays only on the explicit user Stop path.

### 4.4 The two server-side hooks (this is the actual gap)
Both points are **server-initiated**, so the eviction lives there — it does *not*
need to hook the sidecar's lazy internal load:
1. **Generation preload.** In `ensureSidecarEngineReady`, **once before the poll
   loop** (not per attempt, `ensure-sidecar-loaded.ts:115`), if
   `shouldEvictBeforeSidecarLoad(state)` → `unloadResidentOllama()` then proceed.
2. **Voice design.** In `designQwenVoiceForCharacter`
   (`qwen-voice.ts:270-316`), **before** the `/qwen/design-voice` fetch, run the
   same evict. The sidecar then lazily loads VoiceDesign (~5 GB) into freed VRAM.
   (The sidecar's own exclusion only evicts Kokoro, `main.py:1519`; Ollama is a
   separate process only the server can evict.)

### 4.5 Atomicity (load-mutex, not the GpuSemaphore)
The `GpuSemaphore` is a token FIFO around **execution**, not loads, and cannot
evict (`semaphore.ts:55-103`). Evict-then-load must be atomic under a **new
dedicated async mutex** (`gpuLoadMutex`) so two concurrent design/gen starts
can't both evict then both overcommit. The token semaphore is unchanged and
orthogonal.

### 4.6 In-flight analysis is non-evictable
An analyzer model actively serving an analysis must not be evicted mid-run (that
*is* the sawtooth, and would corrupt the run). In practice analysis and
generation/design are **sequential pipeline phases**: assert "no sidecar
TTS/design load is requested while an analysis job is active" via the existing
`isAnyAnalysisBusy()` (`design-lock.ts:83`). That makes the evict-an-active-model
case impossible by construction; the hooks in §4.4 only run post-analysis.

### 4.7 CPU residency guard
The flip added 9B to `RESIDENT_MODELS` unconditionally; on a CPU-only box that
keeps ~6.4 GB warm in **RAM** for 5 min with no guard (RAM exhaustion is out of
scope, but the flip *creates* the exposure). **Gate big-model residency on a
GPU:** `keepAliveFor` returns '5m' for the 9B only when the cached accelerator is
a GPU, else the prior behaviour. Unit-test `keepAliveFor` × accelerator.

## 5. Wave 2 — model-label honesty
- **Premise corrected:** the chip (`src/components/analysing/phase-model-chip.tsx`)
  reads Redux `account.analyzerPhase0Model`, **not** a server field. So this is a
  real (small) vertical slice, not a rewire.
- **Server:** ensure the resolved effective per-phase model id is emitted on the
  progress stream (today `activeModelId = selection.model` exists at
  `analysis.ts:2075` and is sent at `:2747`; confirm it's on the first event, add
  it if not).
- **Frontend:** the chip mirrors the server-reported model once streaming starts;
  falls back to the Redux selection pre-stream. When phase0≠phase1, show the
  active phase's model (phase0 during detection, phase1 during attribution).
- **Tests:** jsdom unit (chip reflects server `model`) **+ a mandatory e2e**
  (crosses the streaming seam).

## 6. Wave 3 — progress explainer (section-based)
- **Data corrected:** `charsDone/charsTotal` do **not** exist in the SSE
  protocol; `sectionsDone`/`sectionsTotal` do. Ship the honest minimum first:
  surface the existing section counts as "Chapter 2 · section 3/4" with a thin
  sub-bar that advances on each section completion.
- **Optional follow-up (only if wanted):** add per-section char accumulation
  (`charsDone` summed as sections complete; `charsTotal` known up front) for
  "56k / 80k words." Called out as **new server bookkeeping**, not free.
- **Tests:** server emits section progress; frontend renders + advances the
  sub-bar; **mandatory e2e** (streaming seam).

## 7. Wave 4 (deferred) — MB-accounting policy + split guard
Build only when a 12/16 GB user exists.
- Per-(engine, mode) MB cost table (registry `gpu.modelCostMb.*`, additive-
  optional with defaults), **non-additive Qwen modes** (synth ~3700 vs design
  ~5000 — design value biased **upward** since it's the OOM-critical path; tie to
  Base-stays-resident-during-design, `main.py:1525`). Each cell carries a
  measured-on-box provenance note. `planLoad(state, residents[], incomingMb)`
  stays **pure** (caller injects residents' MB; no internal live probe — tests
  stay deterministic; `vram_reserved_mb` is observability-only, aggregate and
  cross-process-blind). `splitFits` collapses into `planLoad`.
- **Split guard UI = pre-flight only.** Per-phase models are set in settings
  (`ANALYZER_PHASE0_MODEL`/`PHASE1_MODEL` / account). When two different local
  models won't co-fit, show a budget-worded warning **at the settings surface**
  ("won't both fit in your <N> GB GPU — they'll reload between phases"). No
  mid-run pause (the `ui.stage` union has no mid-analysis-confirm state, and
  adding one is unjustified). The server silently evicts between phases to
  function.

## 8. Testing (per wave)
- **W1:** `shouldEvictBeforeSidecarLoad` across cpu/null/8/12/16; VRAM-cache
  survives a simulated respawn; `unloadResidentOllama` evicts the scoped
  model(s); the two hooks evict before load on 8 GB and skip on 12/16 GB / CPU;
  **regression: no sidecar `/load` fires while an over-budget Ollama model is
  resident**; `keepAliveFor` × accelerator; the `isAnyAnalysisBusy` interlock.
- **W2:** chip reflects server model not Redux default (unit) + e2e.
- **W3:** section progress emit + render/advance (unit) + e2e.
- **W4:** cost table + registry + unknown→high fallback (with tag
  canonicalization, `ollama-health.ts:143`); `planLoad` fits/evict 8/12/16;
  non-additive modes; split pre-flight warning render.

## 9. Risks / assumptions (post-review)
- **R1 (closed by §4.4+§4.6):** every server-initiated sidecar load now evicts;
  in-flight analysis can't be evicted because no load is requested during it.
- **R2 — threshold mis-set.** `SAFE_COEXIST_MB` default 11000 assumes
  analyzer+TTS ≈ 10 GB; a 12 GB card with a heavier combo could still OOM. The
  conservative direction (raise the threshold) just evicts more. Tune per box.
- **R3 — cached VRAM staleness.** If the GPU/driver changes under a long-lived
  server, the cache is stale until the next reachable `/health`. Acceptable; a
  restart re-probes.
- **R4 — Wave 4 estimates** remain coarse; that's precisely why it's deferred.

## 10. Branch / merge plan
- W0: merge `fix/server-analyzer-tolerate-unrecognized-keys`.
- W1: `feat/analysing-residency-label-progress` → narrow to **eviction + flip**;
  rename to `fix/server-gpu-eviction-before-sidecar-load`. Flip rides with it.
- W2: `fix/frontend-analyser-model-label`.
- W3: `feat/analysing-progress-sections`.
- W4: deferred; own spec/plan when scheduled.

## 11. What the adversarial review overturned (audit trail)
- "Voice-design path does the same eviction" — **false** (no server load to
  hook); rewritten as a server-side evict before the design fetch (§4.4).
- "Run eviction inside the GpuSemaphore critical section" — **unsupported** (the
  semaphore is an execution token FIFO); replaced with a dedicated load-mutex
  (§4.5).
- "`VramState.accelerator` available to the policy" — **no source**; added a
  last-known-good cache and a defined fallback (§4.2).
- "One delivery" — **rejected**; decomposed into waves (§2), MB engine deferred.
- "Server already emits the model the chip can mirror" — **false** (chip reads
  Redux); reframed as a real slice (§5).
- "`charsDone/charsTotal` already exist" — **false**; section-based minimum (§6).
- keep_alive flip + CPU → unguarded RAM residency — added the GPU gate (§4.7).
