# Design: concurrent Ollama calls in the analyzer (overnight-batch throughput)

_Date: 2026-07-17 · Issue: TBD (filed at handover) · Status: draft v3 (per-model lease — awaiting re-review)_

## Problem

The analyzer processes an entire book **one Ollama request at a time**, even
though book analysis is embarrassingly parallel. Ollama decode is
**memory-bandwidth-bound**: producing each token reads all of the model weights,
and that read is the bottleneck. With N concurrent requests the *same* weight
read serves N tokens — throughput (chapters/hour), the metric that matters for an
overnight batch, rises an estimated **2–3×** for little extra VRAM beyond a larger
KV cache. See `Downloads/ollama-gpu-split-context.md`.

**The lever is not `OLLAMA_NUM_PARALLEL` alone.** Every analyzer `/api/chat`
acquires `gpuSemaphore.acquire(costForEngine('analyzer'))` **per call**
(`server/src/analyzer/ollama.ts:635`, released in the `finally` ~`:779`).
Analyzer cost is **4** (`engine-vram-cost.ts:20`) against a low budget
(`gpu.vramBudget`; registry default 0 → falls back to `gpu.concurrency` 1; the
target box overrides to **2**). `clampCost(4)` pins to the whole budget → the
analyzer **runs alone**. The `STAGE2_CONCURRENCY` worker pool spawns N chapter
workers, but each worker's chat call clamps to the budget and serializes.

## Goal

Let up to **K analyzer `/api/chat` calls run concurrently** (K a configured
knob), such that:

1. Raising K is **decoupled from TTS** — it must not change TTS synthesis width.
2. It is **safe by construction on an 8 GB or 6 GB primary GPU**, where the
   operator actively wants **K≥2** for small-model analysis (e.g. gemma-4b). It
   must never let two things that can't co-reside be admitted onto the card
   together.
3. `STAGE2_CONCURRENCY` is **removed** and replaced by the one K knob; stage
   **pipelining** (Phase 0 stage-1 overlapping Phase 1 stage-2, enabling
   different models / cloud-vs-local per stage) is **kept untouched**.

Local Ollama path only.

## Design evolution (why a per-model lease)

Four approaches were rejected under review before this one:

- **Whole-book reservation** — one slot held for the whole job. F1: starves a
  concurrent book / generation.
- **Per-wave reservation** — slot held per batch of ≤K. NEW-1: a chapter isn't
  one chat call; the "wave" is undefinable.
- **Global limiter + operator raises the shared `GPU_VRAM_BUDGET`** (v1). Unsafe
  on a small card: raising the budget to fit K analyzer calls also lets the
  semaphore admit analyzer + TTS together, but they can't co-reside → thrash/OOM.
- **Single global refcount lease** (v2). Two blockers: (L2) it under-counts when
  stage-1 and stage-2 run **different local models** (kept pipelining feature) —
  two models, one slot → OOM; (L1) at K≥2 the single lease is held continuously,
  reintroducing the F1 concurrent-generation starvation.

This design keys the lease **by resident model**, which fixes L2 and bounds L1 to
physically-correct behavior (below).

## Approach — width-K limiter + per-model lease

### 1. Width-K limiter (the throughput knob)
A process-global FIFO count semaphore of width **K** (`analyzerConcurrency`,
`GpuSemaphore(K)`, cost-1 acquires). Every analyzer chat call takes it first. It
caps **total in-flight analyzer calls at K across all jobs and models** — bounding
Ollama-slot pressure. It is **independent of `GPU_VRAM_BUDGET`**, so raising K
never touches TTS width.

### 2. Per-model cross-engine lease (replaces the per-call analyzer acquire)
The analyzer stops acquiring `gpuSemaphore` per call. Instead, **one refcounted
lease per resident model id** holds exactly one `gpuSemaphore` slot
(cost = `costForEngine('analyzer')`) while *that model* has any call in flight:

```
enter(modelId):
  lease = leases.get(modelId) ?? leases.set(modelId, {count:0, p:null, release:null})
  lease.count++
  if (lease.count === 1) {
    lease.p = gpuSemaphore.acquire(cost)   // ← store the promise SYNCHRONOUSLY, before any await
    lease.release = await lease.p
  } else {
    await lease.p                          // join: block until the holder's acquire resolves
  }
leave(modelId):
  lease.count--
  if (lease.count === 0) { const r = lease.release; leases.delete(modelId); r?.() }
```

The **synchronous store** of `lease.p` before the first `await` is the entire
correctness crux (L-race): a joiner running after the holder's synchronous prefix
sees `count≥2` and a non-null `lease.p`, so it blocks on the same promise and
cannot run a chat before the slot is held. An impl that `await`s before storing
(`const r = await acquire(); lease.p = ...`) would let a joiner hit `await
undefined` and proceed with no slot — the plan MUST pin the ordering. (`enter`
also decrements on the unreachable-today acquire-throw path so a failed 0→1 can't
wedge the lease at count 1.)

**Why per-model is correct:**
- **Same model, K calls / multiple books:** share one lease + the K-limiter → K
  concurrency, one slot, no per-book hold (resolves F1 for the common case).
- **Different local models concurrently** (pipelined stage-1 gemma ‖ stage-2
  qwen): two *different* leases, each cost 4. On a small card (budget 2) the
  second can't acquire until the first releases → they **serialize**, which is
  correct because they can't co-reside anyway (fixes L2). On a big card sized to
  fit both (budget ≥ 8) they co-run — operator's choice.
- **Cloud stage (gemini, cost 0):** no lease/slot → overlaps a local stage
  freely. This is the pipelining value the owner named ("shift between cloud and
  local"), preserved.

### 3. Cross-engine hold behavior — surfaced and decided (L1)
At K≥2 a model's lease is held ~continuously during that model's active span
(as one call finishes another enters). Consequence, stated plainly:

- **Small card (budget 2):** while analysis runs, a concurrent TTS generation (or
  a *different*-model analysis) **waits** until the active model drains. This is
  **correct** — those models physically can't co-reside on the card; today's
  per-call interleave "works" only by evict-thrashing (reloading the model on
  every switch), which is slower. Clean serialization is the better trade.
- **Big card (budget ≥ 5):** the lease holds 4; TTS (cost 1) co-admits (4+1 ≤
  budget) → no starvation, same as today.
- **K=1:** identical to today (release between every call).

So the earlier "cross-engine arbitration unchanged in effect" claim is **not**
accurate and is replaced by this explicit decision: hold-while-active is intended;
it degrades to today at K=1 and to correct-serialization on a contended small
card.

### 4. Delete `STAGE2_CONCURRENCY`; K drives the pool (read live); pipelining kept
`STAGE2_CONCURRENCY` (env + `readStage2Concurrency`, `analysis.ts:917`) is
**removed**. The pool width at its two consumers — Phase 0a cast
(`analysis.ts:3060`) and the Phase 1 stage-2 pool (`~:3775`) — is read **live via
`configValue<number>('analyzer.ollama.concurrency')`** (not the module-load
limiter singleton), so tests can set the width per-case. Stage **pipelining**
(Phase 0 ‖ Phase 1, `analysis.ts:2458–2827`, `awaitPhase1Dispatch`, per-stage
model selection via `selectAnalyzerForPhase`) is a separate mechanism and is
**untouched**.

### 5. Call-site coverage (must be exhaustive)
Both the limiter and the model-lease wrap **every** analyzer call:
- **In-job, via `OllamaAnalyzer.chat`:** `runStage1Chapter[Chunked]` (Phase 0a,
  main `:3179` + subset `:5129`), `runStage2Chapter[Chunked]` (Phase 1, main +
  subset `:5361`), `runAttributionEscalation` local (`ollama.ts:374-417`),
  `runNonStoryClassification` (main `:4357` + subset `:5471`). Wrapping inside
  `chat` (keyed on `this.model`) covers all.
- **Out-of-band, same `chat` path:** script-review, annotate-emotion, instruct.
- **Out-of-band, separate fetch:** `generatePersonaViaOllama` (`ollama.ts:793`) —
  wrapped explicitly, keyed on its `model` arg.

**CPU-analyzer skip:** `getLastKnownAnalyzerDevice()` (`gpu/analyzer-device-state.ts`)
returns `'cuda'|'cpu'|'unknown'`, set per job after `detectOllamaDevice`
(`analysis.ts:2581`). On confirmed `'cpu'` the lease's shared-slot acquire is a
**no-op** (a CPU analyzer takes no GPU slot, mirroring `acquireGpuTokenIfOnGpu`);
the width-K limiter still applies. `'unknown'` stays charged (conservative).

**No self-deadlock:** the lease is refcounted, so a call never *waits on* a lease
another analyzer call holds — it joins it. Fixed acquire order everywhere:
**limiter → model-lease → (shared slot inside lease)**.

## Configuration

| Knob | Env | Type | Default | Apply | Notes |
|---|---|---|---|---|---|
| `analyzer.ollama.concurrency` (new) | `ANALYZER_OLLAMA_CONCURRENCY` | integer ≥ 1 | **2** | restart-server | K: width of the limiter **and** the chapter/chunk pool. The single concurrency control. Read **live** by the pool. |
| `gpu.vramBudget` (exists) | `GPU_VRAM_BUDGET` | integer | **0** (→ falls back to `gpu.concurrency` 1; the box overrides to 2) | restart-server | **Not raised for analyzer concurrency.** Governs cross-engine admission + TTS width only; left as-is. |
| `analyzer.ollama.numCtx` (exists) | — | integer | 32768 | — | Reused for KV calibration. |

**`STAGE2_CONCURRENCY` is deleted** (env + reader). No back-compat alias
(owner-confirmed: its value was per-stage pipelining, which is separate and kept).

- **K is bounded by the resident model's spare VRAM** (K calls share weights but
  each needs its own KV): `K ≲ (VRAM − weights) / KV_per_slot`. Targets: **6 GB →
  K=1–2** (small model), **8 GB → K=2**, **dual-card → K=4**. Default 2 is safe
  for a small model on 8 GB; on 6 GB with a larger model set K=1 (no-op vs today).
- **`OLLAMA_NUM_PARALLEL ≥ K`** (Ollama-side): `.env.example` guidance + a startup
  warning if detectable.

## Progress / UX under concurrency

Already largely handled — no redesign:
- The analysing view renders **every concurrently-processing chapter** via
  `LiveChapterTicker` (`src/views/analysing.tsx` → `phase-card.tsx`), fed a 500 ms
  `live` payload of all in-flight chapters. Stage-1 already runs 2-wide today, so
  the multi-chapter ticker is already exercised; K=4 shows 4 rows instead of 2.
- The per-chunk `HeartbeatRow` is a **resume-time fallback** (single stream), not
  the steady-state display — unaffected.
- **Acceptance (not a redesign):** verify the ticker reads well at K=4 and the
  per-phase progress bar stays **monotonic** (the server's completed-count must
  not regress under out-of-order chapter completion — confirm the phase-progress
  fraction is completed/total, mirroring the TTS "shared completed count" pattern).
  One e2e/screenshot check at K=4; add a note to the analysing regression plan.

## Non-goals / already-handled

| Item | Disposition |
|---|---|
| `keep_alive` (8h batch) | Out — separate workstream; `keepAliveFor` untouched. |
| `think: false` | Already sent (`ollama.ts:593`). |
| Registering the 27B model | Ollama auto-discovers on next call. |
| Cloud / Gemini path | Untouched (`costForEngine('gemini')=0`; rate-limiter-bound). |
| Stage pipelining (Phase 0 ‖ Phase 1) | **Kept** — orthogonal. |
| Per-model K (each co-resident model its own K) | Out (YAGNI) — global K bounds total; refine later if needed. |
| Precise marginal-VRAM cost model | Out — the per-model lease makes it unnecessary. |

## KV calibration (ops step)

`num_ctx` is per slot → total KV ≈ `num_ctx × OLLAMA_NUM_PARALLEL`. Per box: set
`OLLAMA_NUM_PARALLEL=K`, `GET /api/ps`, compare `size` to the single-slot
baseline; if per-slot KV strains the card, drop `num_ctx` to 16384. Walk K up
measuring chapters/hour; stop when `size` nears VRAM or throughput plateaus.

## Determinism invariant

Roster merge / cross-chapter carry-forward must stay order-independent. Stage-1
already fans out at width 2 today (already concurrency-exercised) — re-verify as K
grows past 2.

## Testing

- **Unit — width-K limiter:** caps in-flight at K; releases on success/throw/abort.
- **Unit — per-model lease:** (a) same model, 0→1 acquires exactly one slot, a
  concurrent join does **not** acquire a second and does not resolve until the
  holder's acquire completes (0→1 barrier), 1→0 releases; (b) **two different
  models** each acquire their own slot → on a budget-2 semaphore the second
  **queues** until the first releases (proves L2 fix / small-card serialization);
  (c) release on throw and on last-of-many throw; (d) `leave` at count>1 does not
  release.
- **Unit — CPU analyzer:** confirmed-cpu lease acquires **no** shared slot; limiter
  still applies; CPU throughput not throttled below today.
- **Unit — TTS decoupling:** with K>1, `gpuSemaphore.budget` and a
  `synthesise-chapter` poolWidth (`= gpuSemaphore.maxConcurrency`) are unchanged.
- **Unit — call-site coverage:** `generatePersonaViaOllama` takes the limiter +
  model-lease.
- **Integration (mocked Ollama):** K workers → ≤ K in flight, each response its
  own (no cross-request bleed).
- **Regression — STAGE2 removal:** migrate the `analysis-pipelining.test.ts`
  references — delete at `:52`; env set to `'1'` at **407/484/562/744** and `'2'`
  at **628/687** → move to `ANALYZER_OLLAMA_CONCURRENCY` (works because the pool
  reads the knob live). Update the orphaned doc refs in
  `docs/superpowers/specs/2026-06-17-flaky-test-release-hardening-design.md:31/107/242`.
  Pipelining (Phase 0 ‖ 1) behavior unchanged; full server suite green.
- **Regression — K=1 (stubbed analyzer):** single-book output byte-identical to
  pre-change at K=1. Stubbed, not live (temp 0.2 + retries → non-deterministic).
- **UX:** one e2e/screenshot at K=4 confirming the LiveChapterTicker + monotonic
  phase bar.

## Risks

| Risk | Mitigation |
|---|---|
| Lease 0→1 race (joiner runs before slot held) | Store the acquire promise **synchronously** before `await`; joiners await it; unit-tested. Plan pins the ordering. |
| Slot leak on abort/throw | `leave()` in `finally` on every wrapped path; refcount throw-case unit tests. |
| Multi-model OOM (L2) | Per-model lease → different local models serialize on a small card; unit-tested with two models on a budget-2 semaphore. |
| Concurrent-generation starvation at K≥2 (L1) | Decided, not hidden: correct on a small card (can't co-reside; beats thrash), co-admits on a big card, = today at K=1. Documented in §3. |
| STAGE2 removal breaks pipelining tests | All 7 refs (52/407/484/562/628/687/744) + the design doc migrated in the same change; pool reads the knob **live**. |
| Missed call site → cap/occupant leak | Exhaustive list; persona-gen test; wrapping inside `chat` covers the in-job set. |
| K too high for a small card (KV overflow) | K bounded by model VRAM; default 2; calibration walk; 6 GB big-model → K=1. |

## Rollout

Ship with **K=2**, `GPU_VRAM_BUDGET` untouched. 6 GB → K=1–2, 8 GB → K=2,
dual-card → K=4; `OLLAMA_NUM_PARALLEL ≥ K`. vLLM is the documented v2 path if
concurrency proves insufficient for a production batch.
