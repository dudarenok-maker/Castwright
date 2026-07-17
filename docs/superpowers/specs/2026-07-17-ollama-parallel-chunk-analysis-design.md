# Design: concurrent Ollama calls in the analyzer (overnight-batch throughput)

_Date: 2026-07-17 · Issue: TBD (filed at handover) · Status: green (3 adversarial-review rounds; M1–M5 folded)_

## Problem

The analyzer processes an entire book **one Ollama request at a time**, even
though book analysis is embarrassingly parallel. On the target hardware Ollama
decode is **memory-bandwidth-bound**: producing each token for one request reads
all ~11 GB of model weights, and that read is the bottleneck. With
`OLLAMA_NUM_PARALLEL = N`, the *same* weight read serves N tokens across N
concurrent requests — throughput (chapters/hour), the metric that matters for an
overnight batch, rises an estimated **2–3×** for effectively no extra VRAM beyond
a larger KV cache. See `Downloads/ollama-gpu-split-context.md` for the bandwidth
analysis and the two-GPU split context.

**The lever is not `OLLAMA_NUM_PARALLEL` alone.** Every analyzer `/api/chat` call
acquires `gpuSemaphore.acquire(costForEngine('analyzer'))` per-call
(`server/src/analyzer/ollama.ts:635`, released in the `finally` ~`:779`). The
analyzer costs **4** (`server/src/tts/engine-vram-cost.ts:20`) against a
**default budget of 1** (`gpu.concurrency` default 1; `gpu.vramBudget` default 0
→ falls back — `registry.ts:656/666`), so `clampCost(4)` pins to the whole budget
and the analyzer **runs alone**. The existing stage-2 fan-out
(`STAGE2_CONCURRENCY` default 2, `routes/analysis.ts:917`) spawns 2 workers, but
each worker's chat call clamps to budget-1 and serializes — the extra Ollama
slots sit idle no matter what `OLLAMA_NUM_PARALLEL` is.

## Goal

Let up to **K analyzer `/api/chat` calls run concurrently**, where K is a
configured knob, **without changing the cross-engine arbitration the
`gpuSemaphore` already does correctly per-call** (analyzer vs TTS vs a second
session/book still interleave at call granularity via FIFO). Local Ollama path
only.

## Design evolution (why the simple design)

Two richer schemes were designed and **rejected under adversarial review**;
recorded here so the plan doesn't re-propose them:

- **Whole-book outer reservation** (hold one `gpuSemaphore` slot for the entire
  analysis job): rejected — monopolizes the budget-1 slot for ~30 min, starving a
  concurrently-analysing second book or a concurrent TTS generation. Regresses
  the first-class **concurrent-multi-book / concurrent-generation invariant**
  (today's per-call acquire interleaves those; the reservation would not).
- **Per-wave reservation** (hold the slot around each batch of ≤K calls):
  rejected — a chapter is *not* one chat call. `runStage2ChapterChunked`
  (`stage2-chunk.ts`) loops internally over chunks + coverage-guard retries +
  recursive truncation-splits + escalation, each its own chat call. "Wave =
  chapter" holds the slot for minutes (starvation again); "wave = one chat call"
  requires inverting those internal loops (a large control-flow refactor).

Both failed for the same root reason: **a held cross-engine reservation of any
duration trades away the per-call interleaving the semaphore already gets right.**
The `gpuSemaphore`'s per-call FIFO arbitration is not the problem — the only
defect is that it admits **1** analyzer call by default. So this design adds a
concurrency *ceiling* and lets the operator raise the *budget*; it adds **no
reservation abstraction at all.**

## Approach — global analyzer concurrency limiter + widened worker pool

Three parts, each small and independently testable:

1. **Global analyzer concurrency limiter, width K.** A single process-wide FIFO
   count semaphore (`analyzerConcurrency`). Every analyzer `/api/chat` acquires
   it **before** the existing `gpuSemaphore` acquire, releases it in the same
   `finally`. It caps **total in-flight analyzer chat calls at K across all jobs**
   (main + subset), so two concurrent job bodies can never exceed K combined and
   overrun `OLLAMA_NUM_PARALLEL`. It is analyzer-only — it never gates TTS.
   **Coverage note (M3):** all `OllamaAnalyzer.chat` callers (stage-1/2,
   script-review, emotion, instruct, escalation) are gated by acquiring inside
   `chat`. `generatePersonaViaOllama` (`ollama.ts:793`) is a **separate** function
   with its own `fetch` — the plan MUST add the limiter there too, or the global
   cap leaks by one caller.

2. **Unify the analysis worker pool under one K.** Both stage-2
   (`STAGE2_CONCURRENCY`, `analysis.ts:917`) **and stage-1 / Phase 0a** already
   run at `readStage2Concurrency()` width today (`castConcurrency`,
   `analysis.ts:3060`); this change renames that shared knob to
   `analyzer.ollama.concurrency` (= K) so both stages are driven by one value.
   Each chapter pipeline keeps its existing **sequential** internal fan-out
   (chunks, coverage retries, escalation) — no internal-loop inversion. K
   chapters in flight ⇒ ≤ K analyzer calls in flight, which the global limiter
   (1) also enforces as a ceiling. (Because stage-1 already fans out at width 2
   today, the determinism invariant below is already exercised at width 2 — this
   change widens it, it does not introduce concurrency to a serial path.)

3. **`gpuSemaphore` unchanged; operator sizes the budget.** The per-call
   `gpuSemaphore.acquire/release` in `ollama.ts` is **untouched**. Cross-engine
   fairness is preserved: a queued TTS / second-book acquire is still granted at
   the next per-call release under FIFO, so the analyzer contributes ≤K entries
   to the same fair queue and **never holds a slot across calls** — any reordering
   is bounded to ~one analyzer-call duration and cannot starve (M1). For K
   analyzer calls to actually run concurrently rather than clamp to budget-1, the
   operator raises `GPU_VRAM_BUDGET` so `K × costForEngine('analyzer')` fits
   (calibrated empirically — see below). On the default budget-1 box, K collapses
   to an effective 1: **no regression, no concurrency until opted in.**

### Why this preserves every invariant

- **Concurrent multi-book / TTS:** `gpuSemaphore` is still acquired and released
  **per call**, so a second book's or a TTS op's queued acquire is granted at the
  very next per-call release under strict FIFO (`semaphore.ts:121-131`). The
  analyzer contributes up to K calls to the same fair queue instead of 1.
  Cadence is *near*-identical to today, not byte-identical (M1): because the
  width-K limiter is taken **before** `gpuSemaphore`, up to K−1 analyzer calls
  can sit in limiter slots blocked pre-`gpuSemaphore`, which can reorder a second
  book's call behind a later TTS op **by at most one slot**. Bounded to one
  analyzer-call duration; no starvation — limiter slots free serially as calls
  complete, so the second book always makes progress with live pills.
- **No hard-deadlock surface:** no held outer slot exists, so no in-job call can
  deadlock against "the job's own reservation." Every call self-acquires and
  self-releases in one `try/finally`, exactly as today. The F2/F3/NEW-1/NEW-2
  hazards of the reservation schemes simply do not arise.
- **Two job bodies (main + subset):** both are naturally bounded by the *global*
  limiter (1); nothing special is needed for main-alongside-subset.
- **CPU analyzer (M2):** `costForEngine('analyzer')` returns 0 for a confirmed-CPU
  analyzer (`engine-vram-cost.ts:52-57`), but `clampCost(0)` **floors to 1**
  (`semaphore.ts:98`) and `chat()` acquires `gpuSemaphore` unconditionally
  (`ollama.ts:635` — the zero-skip only exists in `generatePersonaViaOllama` via
  `acquireGpuTokenIfOnGpu`). So a CPU analyzer call already takes 1 token and
  serializes at budget-1 **today**. The width-K limiter (K ≥ 1) never restricts
  below that effective floor, so it does **not** throttle CPU below today's — and
  it incidentally *protects* the CPU box: raising `GPU_VRAM_BUDGET` there would
  otherwise admit budget-many 1-token CPU calls and thrash; the limiter caps them
  at K.

## Configuration

| Knob | Env | Type | Default | Apply | Notes |
|---|---|---|---|---|---|
| `analyzer.ollama.concurrency` (new) | `ANALYZER_OLLAMA_CONCURRENCY` | integer ≥ 1 | **2** | restart-server | K: the width of both the global limiter and the worker pool. Supersedes `STAGE2_CONCURRENCY` (which is folded in / kept as a back-compat alias per the plan). |
| `gpu.vramBudget` (exists) | `GPU_VRAM_BUDGET` | integer | 0 (→ falls back to `gpu.concurrency` 1) | restart-server | Operator raises this so `K × 4` analyzer tokens fit for real concurrency. Coupling documented (below). |
| `analyzer.ollama.numCtx` (exists) | — | integer | 32768 | — | Reused for KV calibration below. |

- **K default 2** preserves today's stage-2 worker width while being safe on any
  box: at default budget-1 the extra workers still serialize on `gpuSemaphore`
  (no behavior change) until the operator raises `GPU_VRAM_BUDGET`.
- **`OLLAMA_NUM_PARALLEL ≥ K`** (Ollama-side, server-external): `.env.example`
  guidance + a startup warning if a mismatch is detectable.
- **Budget-coupling caveat (documented, not hidden):** `GPU_VRAM_BUDGET` is a
  *global* token budget across all engines, and the analyzer's flat cost (4)
  **overcounts** K shared-weight calls (they are 1× weights + K× KV, not K× the
  full footprint). So the operator sizes the budget **empirically** (below), not
  by arithmetic; and raising it also loosens TTS co-residency (correct on a box
  that genuinely has the VRAM). A precise marginal-cost model is a deliberate
  **non-goal for v1** (YAGNI) — the empirical walk is sufficient.

## Non-goals / already-handled

| Item | Disposition |
|---|---|
| `keep_alive` (8h for batch) | **Out.** Separate parallel workstream; `keepAliveFor` untouched. |
| `think: false` | **Already done.** Sent unconditionally (`ollama.ts:593`). |
| Registering `qwen36-cw-iq3-32k` | **No work.** Ollama models auto-discovered on next call. |
| Cloud / Gemini path | **Untouched.** `costForEngine('gemini') = 0`; concurrency bounded by `rate-limit.ts`. |
| Marginal shared-weight VRAM cost model | **Out (YAGNI).** Flat cost + empirical budget for v1. |
| Auto-derived K from VRAM headroom | **Out (YAGNI).** K is a configured knob. |

## KV-cache calibration (ops step, not a code branch)

Ollama's `num_ctx` is **per slot** (leading theory), so total KV ≈
`num_ctx × OLLAMA_NUM_PARALLEL`. No code decision hangs on the answer — only the
operator's chosen K / `num_ctx` / budget. Procedure, run once per box:

1. Set `OLLAMA_NUM_PARALLEL=2`, restart Ollama, load the model.
2. `GET /api/ps`, read `size`; compare to the single-slot baseline (~12.7 GB
   @ 32K on the target box).
3. If KV scales per-slot and pressures VRAM, drop `num_ctx` to **16384** and rely
   on the existing stage-1/stage-2 chunkers.
4. Walk `OLLAMA_NUM_PARALLEL` / K / `GPU_VRAM_BUDGET` up together (2 → 4) measuring
   **chapters/hour**, not tok/s. Stop when `/api/ps size` approaches VRAM or
   throughput plateaus.

On the target two-card box (~7 GB idle on the 5070 Ti) the per-slot KV likely
just fits at 32K × 2.

## Determinism invariant

Roster merge and cross-chapter carry-forward must remain **order-independent**
under concurrency. Stage-2 already runs at worker width 2, so the merge path is
*already* exercised concurrently — the spec calls this out as an invariant to
**re-verify**, not assume, when K grows beyond 2 and stage-1 also widens.

## Testing

- **Unit — global limiter:** caps in-flight analyzer calls at K across
  interleaved acquire/release; releases on success, throw, and abort (mirrors the
  FIFO/abort tests in `server/src/gpu/semaphore.ts`).
- **Unit — acquire order:** an analyzer call acquires the width-K limiter
  **before** `gpuSemaphore` and releases both in one `finally` (guards against a
  half-held slot on the error path).
- **Unit — cross-engine unchanged (guards fairness/F1):** with K>1 and a budget
  admitting >1 analyzer call, a queued TTS/second acquire is still granted at the
  next per-call release — i.e. the analyzer contributes K entries to the same
  FIFO, it does not hold a slot across calls.
- **Unit — CPU analyzer not throttled:** a confirmed-CPU analyzer's throughput is
  not reduced below today's by the width-K limiter.
- **Integration (mocked Ollama):** with K workers, N chapter calls run ≤ K in
  flight, each response is its own (no cross-request bleed) — mirrors
  `server/tts-sidecar/tests/test_concurrent_synthesis.py`.
- **Regression — behavior-preserving at K=1 (stubbed analyzer):** with a
  **deterministic stubbed analyzer**, single-book analysis output is
  byte-identical to pre-change at K=1 (limiter width 1 = strictly serial = same
  merge order). *Not* a live-model assertion — first-attempt temperature is 0.2
  with a temperature-bumping retry loop (`ollama.ts:110, 502-522`), so real output
  is non-deterministic.

## Risks

| Risk | Mitigation |
|---|---|
| Concurrency silently does nothing (operator raised K but not `GPU_VRAM_BUDGET`) | Startup log states the effective analyzer concurrency = `min(K, max(1, floor(budget / analyzerCost)))` (M4 — the `max(1,…)` matches `clampCost`'s ≥1 floor, so it never logs a misleading "0"); `.env.example` documents the trio (K, budget, `OLLAMA_NUM_PARALLEL`). |
| `num_ctx × K` VRAM overflow | K default 2 + calibration; `numCtx` drop to 16K escape valve. |
| Merge non-determinism surfacing only at K>2 | Determinism invariant re-verified as K widens; K=1 stubbed regression anchors correctness (stage-1 already runs width-2 today, so this is widening a concurrent path, not making a serial one concurrent). |
| Raising the global budget loosens TTS co-residency too | Documented budget-coupling caveat; correct on a box with the VRAM, and the width-K limiter still caps analyzer calls independently. |
| VRAM-sampler over-cap trim race (M5, NIT) | `model-vram-stats.ts:76-91` read-then-`writeFile` is not concurrency-safe; K-wide calls make interleaved rewrites likelier. Best-effort telemetry, try/catch-wrapped, never throws — worst case a torn/dropped sample line. No correctness impact; plan notes it, no fix required for v1. |

## Rollout

Ship with **K=2** and **budget unchanged** — a no-op by default. The batch
operator raises `ANALYZER_OLLAMA_CONCURRENCY`, `GPU_VRAM_BUDGET`, and
`OLLAMA_NUM_PARALLEL` together after the calibration walk. If concurrency proves
insufficient for a commercial production batch, **vLLM** (continuous batching,
paged attention, native FP4 on Blackwell) is the documented v2 path — out of
scope here.
