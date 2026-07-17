# Design: concurrent Ollama calls in the analyzer (overnight-batch throughput)

_Date: 2026-07-17 · Issue: TBD (filed at handover) · Status: draft v2 (decoupled lease + STAGE2 removal — awaiting re-review)_

## Problem

The analyzer processes an entire book **one Ollama request at a time**, even
though book analysis is embarrassingly parallel. On the target hardware Ollama
decode is **memory-bandwidth-bound**: producing each token for one request reads
all of the model weights (~11 GB for the 27B batch model), and that read is the
bottleneck. With N concurrent requests, the *same* weight read serves N tokens —
throughput (chapters/hour), the metric that matters for an overnight batch, rises
an estimated **2–3×** for little extra VRAM beyond a larger KV cache. See
`Downloads/ollama-gpu-split-context.md` for the bandwidth analysis.

**The lever is not `OLLAMA_NUM_PARALLEL` alone.** Every analyzer `/api/chat`
acquires `gpuSemaphore.acquire(costForEngine('analyzer'))` **per call**
(`server/src/analyzer/ollama.ts:635`, released in the `finally` ~`:779`).
Analyzer cost is **4** (`engine-vram-cost.ts:20`) against a low budget
(`gpu.vramBudget`, currently **2** on the target box; default 0 → falls back to
`gpu.concurrency` 1), so `clampCost(4)` pins to the whole budget and the analyzer
**runs alone**. The existing `STAGE2_CONCURRENCY` worker pool spawns N chapter
workers, but each worker's chat call clamps to the budget and serializes.

## Goal

Let up to **K analyzer `/api/chat` calls run concurrently** (K a configured
knob), such that:

1. Raising K is **decoupled from TTS** — it must not change how many TTS
   synthesis calls run at once.
2. It is **safe on an 8 GB or 6 GB primary GPU** (the analyzer's main target,
   not just the dual-card dev box) — it must not weaken the cross-engine
   serialization that stops the analyzer model and a TTS model from being
   admitted onto a card that can't hold both.
3. `STAGE2_CONCURRENCY` is **removed** and replaced by the one K knob; stage
   **pipelining** (Phase 0 stage-1 overlapping Phase 1 stage-2, which enables
   different models / cloud-vs-local per stage) is **kept untouched**.

Local Ollama path only.

## Design evolution (why the lease)

Three approaches were rejected under review before this one; recorded so the
plan doesn't re-propose them:

- **Whole-book reservation** — hold one `gpuSemaphore` slot for the entire job.
  Rejected (F1): monopolizes the slot for ~30 min, starving a concurrent second
  book / TTS; breaks the concurrent-multi-book invariant.
- **Per-wave reservation** — hold the slot around each batch of ≤K calls.
  Rejected (NEW-1): a chapter is not one chat call (it fans out into chunks +
  coverage retries + escalation), so the "wave" unit is undefinable without a
  large refactor.
- **Global limiter + operator raises the shared `GPU_VRAM_BUDGET`** — the prior
  v1 green design. Rejected on the **8/6 GB requirement**: the shared budget also
  governs cross-engine *admission*. Raising it to fit K analyzer calls (e.g. 8)
  would also let the semaphore admit an analyzer call **and** a TTS call together
  (4+1 ≤ 8) — but on a small card the analyzer model + a TTS model physically
  can't co-reside (they evict each other → thrash/OOM). It also coupled TTS
  synthesis width to the same budget. Safe only on a big card; unsafe on the
  primary target.

Root lesson: intra-analyzer concurrency must be controlled **separately** from
the cross-engine budget, and the analyzer must count as **one** cross-engine
occupant no matter how many internal calls it runs (they share one resident
model's weights).

## Approach — per-engine lease + width-K limiter

Three parts:

### 1. Width-K limiter (the throughput knob)
A process-global FIFO count semaphore of width **K** (`analyzerConcurrency`,
reusing `GpuSemaphore(K)` with cost-1 acquires). Every analyzer chat call takes
it first. It caps **total in-flight analyzer calls at K across all jobs** (main +
subset) — this is the concurrency lever, and it is **independent of
`GPU_VRAM_BUDGET`**, so raising K never touches TTS.

### 2. Per-engine cross-engine lease (replaces the per-call analyzer acquire)
The analyzer stops acquiring `gpuSemaphore` **per call**. Instead a refcounted
**lease** holds exactly one `gpuSemaphore` slot (cost = `costForEngine('analyzer')`,
unchanged) while the analyzer has **any** call in flight:

- `enter()`: increment the refcount. On the **0→1** transition, acquire the
  shared slot and store the release fn + the acquire promise. On a **join** (>1),
  `await` that same promise so the caller does not proceed until the slot is
  provably held (closes the 0→1 race — a joiner must not run before the holder's
  async acquire resolves).
- `leave()`: decrement. On the **1→0** transition, release the shared slot.

All analyzer calls — every book, every stage, in-job and out-of-band — share this
**one** lease, because they share **one** resident model. Consequences:

- **Cross-engine arbitration is unchanged in effect.** The lease holds cost 4
  against the *unchanged* low budget, exactly as the per-call acquire did — so on
  an 8/6 GB card (budget 2) the analyzer still serializes against TTS (they evict
  each other; correct), and on a big card sized to fit both (budget ≥ 5) TTS is
  admitted alongside (4+1 ≤ budget), same as today.
- **Concurrent multi-book does not starve** (resolves F1). A second book uses the
  *same* analyzer model → shares the *same* lease + limiter → its calls just join
  the width-K FIFO. There is no per-book hold.
- **TTS is decoupled.** The analyzer occupies **one** cost-4 slot regardless of
  K, so raising K never changes the shared budget and never changes TTS
  synthesis width.

**CPU-analyzer skip preserved.** `costForEngine('analyzer')` returns 0 for a
confirmed-CPU analyzer, and today the CPU persona path skips the semaphore via
`acquireGpuTokenIfOnGpu`. The lease must mirror this: on a confirmed-CPU analyzer
the lease's shared-slot acquire is a no-op (a CPU analyzer takes no GPU slot); the
width-K limiter still applies (it bounds Ollama-slot pressure, not VRAM).

### 3. Delete `STAGE2_CONCURRENCY`; K drives the pool; pipelining untouched
`readStage2Concurrency` (`analysis.ts:917`) and the `STAGE2_CONCURRENCY` env are
**removed**. The chapter worker-pool width (Phase 0a cast at `analysis.ts:3060`;
the Phase 1 stage-2 pool at ~`:3775`) is driven by `analyzer.ollama.concurrency`
(= K). Stage **pipelining** (Phase 0 || Phase 1, `analysis.ts:2458–2827`, its
`awaitPhase1Dispatch` gate, per-stage model / cloud-vs-local selection) is a
**separate mechanism and is not touched**. K chapters/chunks are dispatched to
feed the K concurrent Ollama calls the limiter admits.

### Call-site coverage (must be exhaustive)
Both the limiter and the lease must wrap **every** analyzer Ollama call, or the
global cap / single-occupant guarantee leaks:

- **In-job** (all reach `OllamaAnalyzer.chat`): `runStage1Chapter` /
  `runStage1ChapterChunked` (Phase 0a, main `:3179` + subset `:5129`),
  `runStage2Chapter` / `runStage2ChapterChunked` (Phase 1, main + subset `:5361`),
  `runAttributionEscalation` local path (`ollama.ts:374-417`),
  `runNonStoryClassification` (main `:4357` + subset `:5471`). Wrapping inside
  `chat` covers all of them in one place.
- **Out-of-band, same `chat` path**: script-review, annotate-emotion, instruct.
- **Out-of-band, separate fetch** (`generatePersonaViaOllama`, `ollama.ts:793`):
  must be wrapped explicitly — it does not call `chat`.

**No self-deadlock:** the lease is refcounted, so a call never *waits on* a lease
another analyzer call holds — it joins it. The only blocking waits are the
width-K limiter (analyzer-only) and the shared-slot acquire on the 0→1 edge
(a normal cross-engine wait). Acquire order is fixed everywhere: **limiter →
lease → (shared slot inside lease)**; nothing acquires in the opposite order.

## Configuration

| Knob | Env | Type | Default | Apply | Notes |
|---|---|---|---|---|---|
| `analyzer.ollama.concurrency` (new) | `ANALYZER_OLLAMA_CONCURRENCY` | integer ≥ 1 | **2** | restart-server | K: width of the limiter **and** the chapter/chunk pool. The single concurrency control. |
| `gpu.vramBudget` (exists) | `GPU_VRAM_BUDGET` | integer | (box: 2) | restart-server | **Not raised for analyzer concurrency.** Governs cross-engine admission + TTS width only; left as-is. |
| `analyzer.ollama.numCtx` (exists) | — | integer | 32768 | — | Reused for KV calibration. |

**`STAGE2_CONCURRENCY` is deleted** (env + `readStage2Concurrency`). No
back-compat alias (confirmed with the owner: it was never used for chapter
concurrency; its value was per-stage pipelining, which is separate and kept).

- **K is bounded by the resident model's spare VRAM**, since K calls share the
  weights but each needs its own KV: `K ≲ (card VRAM − weights) / KV_per_slot`.
  Rough targets: **6 GB → K=1** (a big-ish model barely fits; concurrency off,
  same as today), **8 GB → K=2**, **dual-card / 16 GB+ → K=4**. The operator
  picks K to fit; default 2 is safe on 8 GB, a no-op relative to today on a box
  where the model already fills VRAM.
- **`OLLAMA_NUM_PARALLEL ≥ K`** (Ollama-side env): `.env.example` guidance + a
  startup warning if detectable.

## Non-goals / already-handled

| Item | Disposition |
|---|---|
| `keep_alive` (8h batch) | Out — separate workstream; `keepAliveFor` untouched. |
| `think: false` | Already sent (`ollama.ts:593`). |
| Registering the 27B model | Ollama auto-discovers on next call. |
| Cloud / Gemini path | Untouched (`costForEngine('gemini')=0`; rate-limiter-bound). |
| Stage pipelining (Phase 0 || Phase 1) | **Kept** — orthogonal to this change. |
| Precise marginal-VRAM cost model | Out (YAGNI) — the lease makes it unnecessary: one occupant regardless of K. |

## KV calibration (ops step)

Ollama's `num_ctx` is **per slot**, so total KV ≈ `num_ctx × OLLAMA_NUM_PARALLEL`.
Per box: set `OLLAMA_NUM_PARALLEL=K`, `GET /api/ps`, compare `size` to the
single-slot baseline; if per-slot KV strains the card, drop `num_ctx` to 16384
(the chunkers already size inputs to a fraction of `num_ctx`). Walk K up measuring
chapters/hour; stop when `/api/ps size` nears VRAM or throughput plateaus.

## Determinism invariant

Roster merge / cross-chapter carry-forward must stay **order-independent** under
concurrency. Stage-1 already fans out at width 2 today, so this path is already
concurrency-exercised — re-verify (not assume) as K grows past 2.

## Testing

- **Unit — width-K limiter:** caps in-flight at K; releases on success/throw/abort
  (mirrors `gpu/semaphore.ts` tests).
- **Unit — lease refcount:** 0→1 `enter` acquires exactly one `gpuSemaphore`
  slot; a concurrent join does **not** acquire a second and does **not** resolve
  until the holder's acquire completes (the 0→1 barrier); 1→0 `leave` releases;
  a mid-flight `leave` at count>1 does not release.
- **Unit — lease release on throw/abort:** the shared slot is freed when a wrapped
  call throws, and when the last of several concurrent calls throws.
- **Unit — CPU analyzer:** a confirmed-CPU analyzer's lease acquires **no** shared
  slot; the limiter still applies; CPU throughput not throttled below today.
- **Unit — decoupling:** with K>1, `gpuSemaphore.budget` is unchanged and a TTS
  `synthesise-chapter` poolWidth (`= gpuSemaphore.maxConcurrency`) is unchanged —
  i.e. raising K provably does not widen TTS.
- **Unit — call-site coverage:** `generatePersonaViaOllama` takes the limiter +
  lease (guards the separate-fetch leak).
- **Integration (mocked Ollama):** K workers → ≤ K calls in flight, each response
  its own (no cross-request bleed).
- **Regression — STAGE2 removal:** the pipelining tests that set
  `STAGE2_CONCURRENCY=1` (`analysis-pipelining.test.ts:403/554`) are updated to the
  new knob; Phase 0 || Phase 1 behavior is unchanged. Full server suite green.
- **Regression — K=1 (stubbed analyzer):** single-book output byte-identical to
  pre-change at K=1 (limiter width 1 = serial; lease = one slot = today's per-call
  effect). Stubbed, not live (temp 0.2 + retries → non-deterministic).

## Risks

| Risk | Mitigation |
|---|---|
| Lease 0→1 acquire race (joiner runs before slot held) | Joiners `await` the holder's stored acquire promise; unit-tested. |
| Lease slot leak on abort/throw | `leave()` in `finally` on every wrapped path; refcount unit tests for the throw case. |
| Missed call site → cap/occupant leak (not deadlock — lease is refcounted) | Exhaustive call-site list; test that persona-gen is wrapped; wrapping inside `chat` covers the in-job set. |
| STAGE2 removal breaks pipelining tests | Those tests migrated to the K knob in the same change; pipelining code untouched. |
| K too high for a small card (KV overflow) | K bounded by model VRAM; default 2 (safe on 8 GB); calibration walk; 6 GB → K=1. |
| Merge non-determinism at K>2 | Re-verify invariant; K=1 stubbed regression anchors correctness. |

## Rollout

Ship with **K=2**, `GPU_VRAM_BUDGET` untouched. On 6 GB set K=1 (no-op vs today);
on 8 GB K=2; on the dual card K=4 — with `OLLAMA_NUM_PARALLEL ≥ K`. If concurrency
proves insufficient for a production batch, **vLLM** is the documented v2 path.
