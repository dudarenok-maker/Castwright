# Design: concurrent Ollama calls in the analyzer (overnight-batch throughput)

_Date: 2026-07-17 · Issue: TBD (filed at handover) · Status: draft (awaiting user review)_

## Problem

The analyzer processes an entire book **one Ollama request at a time**, even
though book analysis is embarrassingly parallel (chapters and chunks are
independent LLM calls). On the target hardware Ollama decode is
**memory-bandwidth-bound**: producing each token for one request reads all
~11 GB of model weights, and that read is the bottleneck. With
`OLLAMA_NUM_PARALLEL = N`, the *same* weight read serves N tokens across N
concurrent requests — throughput (chapters/hour), the metric that matters for
an overnight batch, rises an estimated **2–3×** for effectively no extra VRAM
beyond a larger KV cache. See
`Downloads/ollama-gpu-split-context.md` (hardware/measurement handoff) for the
bandwidth analysis and the GPU-split context.

**The lever is not `OLLAMA_NUM_PARALLEL` alone.** Two app-level facts block it:

1. Every analyzer `/api/chat` call acquires
   `gpuSemaphore.acquire(costForEngine('analyzer'))` (`server/src/analyzer/ollama.ts:635`).
   The analyzer costs **4** tokens (`server/src/tts/engine-vram-cost.ts:20`)
   against a **default budget of 1** (`gpu.concurrency` default 1;
   `gpu.vramBudget` default 0 → falls back — `registry.ts:656/666`), so
   `clampCost(4)` pins to the whole budget and the analyzer **runs alone**.
   Even the existing stage-2 fan-out (`STAGE2_CONCURRENCY` default 2,
   `routes/analysis.ts:917`) serializes underneath it — the extra Ollama slots
   sit idle no matter what `OLLAMA_NUM_PARALLEL` is set to.

2. The weighted semaphore **mismodels intra-model concurrency.** It charges 4
   tokens per analyzer call on the assumption each call is an independent heavy
   VRAM consumer that evicts the others — true for analyzer-vs-TTS or
   analyzer-vs-second-session, **false** for two chunks hitting the *same
   resident Ollama model*: that is 1× shared weights + N× (smaller) KV cache.
   The architecture has no concept of "these N GPU ops share one model's
   weights," so it serializes precisely the case that is cheap.

## Goal

Let the analyzer issue **K concurrent Ollama `/api/chat` calls** within a
single book's analysis, where K is a configured knob, while preserving the
cross-engine arbitration the `gpuSemaphore` exists to provide (analysis still
serializes against TTS and a second session). Local Ollama path only.

## Non-goals / already-handled

Stated explicitly so scope cannot silently expand:

| Item | Disposition |
|---|---|
| `keep_alive` (8h for batch) | **Out.** Owned by a separate parallel workstream; `keepAliveFor` untouched. |
| `think: false` | **Already done.** Sent unconditionally on every analyzer call (`ollama.ts:593`); Ollama ignores it on non-thinking models. No change. |
| Registering `qwen36-cw-iq3-32k` | **No work.** Ollama models are auto-discovered on next call; the model appears without a registry entry. |
| Cloud / Gemini path | **Untouched.** `costForEngine('gemini') = 0` — not semaphore-gated; its concurrency is bounded by `rate-limit.ts`, not the GPU. |
| Auto-derived K from VRAM headroom | **Out (YAGNI).** VRAM weights are provisional/unmeasured; K is a configured knob. A future auto-sizer can compute K without touching the fan-out plumbing. |

## Approach — two-level concurrency

The single `gpuSemaphore` currently conflates two jobs. Split them:

- **Outer (cross-engine, coarse) — unchanged semantics.** Acquire
  `gpuSemaphore.acquire(costForEngine('analyzer'))` **once for the whole
  analysis job** (per book), release when the book finishes. Wraps the job
  orchestration in `routes/analysis.ts` (the Phase 0 / Phase 1 region around
  `:2458–2827`). Analysis serializes against TTS / a second session exactly as
  today — they genuinely thrash, so co-residence is not wanted.

- **Inner (intra-analyzer, new).** A lightweight FIFO counting semaphore of
  width **K**. Every analyzer `/api/chat` on the job path acquires the *inner*
  pool instead of taking `gpuSemaphore` per-call. This caps concurrent Ollama
  requests at K; `OLLAMA_NUM_PARALLEL` (Ollama-side) must be ≥ K to actually
  service them in parallel.

### Unified work queue

Stage-1 chunks, stage-2 chunks, and whole chapters are all "one LLM call" to
the inner pool — no distinction (the "both, unified" decision). The existing
`STAGE2_CONCURRENCY` knob (a no-op today because the semaphore serializes
underneath it) is **superseded** by the single width-K inner pool, so there is
one concurrency number rather than two fighting.

### The shared-method seam (main integration risk)

`ollama.ts`'s chat method is shared between the job pipeline and out-of-band
callers (persona generation in `voice-style.ts`, script-review). The method
must know which mode it is in:

- **Under a job reservation →** use the inner pool (the outer `gpuSemaphore` is
  already held once at job level; taking it per-call would deadlock against the
  job's own held reservation).
- **Standalone (no job reservation) →** keep the current per-call
  `gpuSemaphore.acquire` behavior unchanged.

This is threaded as an explicit context flag/parameter (not ambient state) so
the two modes are unambiguous and unit-testable. The plan pins down the exact
signature.

## Configuration

| Knob | Env | Type | Default | Apply | Notes |
|---|---|---|---|---|---|
| `analyzer.ollama.concurrency` (new) | `ANALYZER_OLLAMA_CONCURRENCY` | integer ≥ 1 | **2** | restart-server | This is K. Every new env var is a registry knob + `.env.example` entry. |
| `analyzer.ollama.numCtx` (exists) | — | integer | 32768 | — | Reused for KV calibration below. |

- **K default 2** preserves today's stage-2 fan-out *width* (which currently
  serializes) — a modest, safe improvement on any box, including single-GPU
  8 GB. The operator walks K up to ~4 empirically.
- **`OLLAMA_NUM_PARALLEL ≥ K` coupling** is Ollama-side (server-external), so
  it lives in `.env.example` guidance plus a **startup warning** if a mismatch
  is detectable.

## KV-cache calibration (ops step, not a code branch)

Ollama's `num_ctx` is **per slot** (leading theory; confirmed empirically
below), so total KV ≈ `num_ctx × OLLAMA_NUM_PARALLEL`. No code decision hangs
on the answer — only the default values of K and `num_ctx`. The spec ships a
procedure, run once per box:

1. Set `OLLAMA_NUM_PARALLEL=2`, restart Ollama, load the model.
2. `GET /api/ps`, read `size`; compare to the single-slot baseline (~12.7 GB
   @ 32K on the target box).
3. If KV scales per-slot and pressures VRAM, drop `num_ctx` to **16384** and
   rely on the existing stage-1/stage-2 chunkers (which already size inputs to
   a *fraction* of `num_ctx`).
4. Walk `OLLAMA_NUM_PARALLEL`/K up (2 → 4) measuring **chapters/hour**, not
   tok/s. Stop when `/api/ps size` approaches VRAM or throughput plateaus.

On the target two-card box (~7 GB idle on the 5070 Ti) the per-slot KV likely
just fits at 32K × 2.

## Determinism invariant

Roster merge and cross-chapter carry-forward must remain **order-independent**
under concurrency. Stage-2 already runs at concurrency 2, so the merge path is
*already* exercised concurrently — the spec calls this out as an invariant to
**re-verify**, not assume, when the inner pool widens K beyond 2.

## Testing

- **Unit — inner pool:** caps in-flight at K; releases on success, throw, and
  abort (mirrors the `gpuSemaphore` FIFO/abort tests in
  `server/src/gpu/semaphore.ts`).
- **Unit — reservation mode:** a job-path call takes the inner pool and does
  **not** take `gpuSemaphore`; a standalone call still takes `gpuSemaphore`
  per-call.
- **Unit — one outer reservation per job:** the job acquires exactly one
  `gpuSemaphore` slot for its lifetime.
- **Integration (mocked Ollama):** N chapter calls under one job run ≤ K in
  flight, each response is its own (no cross-request bleed) — mirrors the
  sidecar contract in `server/tts-sidecar/tests/test_concurrent_synthesis.py`.
- **Regression — behavior-preserving at K=1:** single-book analysis output is
  byte-identical to pre-change when K=1, proving the refactor changes only
  concurrency, not results.

## Risks

| Risk | Mitigation |
|---|---|
| Shared chat-method seam (job vs standalone) | Explicit context flag, unit-tested both ways; the one deadlock trap (per-call acquire under a held job reservation) is the reason the flag exists. |
| `num_ctx × K` VRAM overflow on smaller/single-GPU boxes | K default 2 + the calibration step; `numCtx` drop to 16K as the escape valve. |
| Merge non-determinism surfacing only at K>2 | Determinism invariant re-verified as K widens; regression test at K=1 anchors correctness. |

## Rollout

Ship with **K=2**. The operator raises `ANALYZER_OLLAMA_CONCURRENCY` and
`OLLAMA_NUM_PARALLEL` together after the calibration walk. If concurrency
proves insufficient for a commercial production batch, **vLLM** (continuous
batching, paged attention, native FP4 on Blackwell) is the documented v2 path —
out of scope here.
