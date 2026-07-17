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

## Approach — per-wave two-level concurrency

> **Revised after adversarial review (F1/F2).** An earlier draft held the outer
> reservation for the **whole book**. That was wrong: `gpuSemaphore` is budget-1
> / analyzer-cost-4, and today's acquire/release is **per `/api/chat` call**
> (`ollama.ts:635` / release `~779`), so two concurrent books — or a book plus a
> TTS generation on another — **interleave at call granularity** under FIFO
> drain. Holding one budget-1 slot for a ~30-min run would starve the second
> book and any TTS op for the entire run, regressing the first-class
> concurrent-multi-book / concurrent-generation invariant (pills must reflect
> real-time progress). The design below holds the slot **per wave**, not per
> book.

The single `gpuSemaphore` conflates cross-engine VRAM arbitration with per-call
serialization. Add a second level, held at wave granularity:

- **Outer (cross-engine, coarse) — held per WAVE.** The analyzer dispatches work
  in waves of up to K calls. Around each wave it acquires
  `gpuSemaphore.acquire(costForEngine('analyzer'))` **once**, runs the wave's
  ≤K calls concurrently under that single held slot, then **releases before the
  next wave**. Between waves, FIFO drain (`semaphore.ts:121-131`) grants a
  queued second-book wave or a TTS op, so cross-engine / cross-book work
  interleaves at **wave granularity** — coarser than today's per-call, but
  bounded to ~one chunk's runtime, never the whole book. On an uncontended
  overnight batch the analyzer simply re-acquires immediately and runs waves
  back-to-back (≈ continuous K-concurrency).

- **Inner (intra-analyzer) — the wave width K.** Up to K `/api/chat` calls run
  concurrently within a wave; the one held outer slot covers all K, because
  they share the resident model's weights and so do **not** overcommit VRAM
  beyond the single slot's accounting (1× weights + K× smaller KV). `think:false`
  and identical `num_ctx`/`num_gpu` are already sent per call, so the slots are
  homogeneous. `OLLAMA_NUM_PARALLEL` (Ollama-side) must be ≥ K.

Because the outer acquire is per-wave (not per-book), the **two** analyzer job
bodies — the main job (`runMainAnalyzerJob`, `analysis.ts:2487`) and the
subset/retry job (`POST /:id/analysis/chapters`, `:4714`, its own
`inFlightSubsetByManuscript` map, designed to run **alongside** a main run) —
both dispatch through the same per-wave mechanism and interleave cleanly. There
is no "single wrappable whole-book scope," which is correct because none exists
(F2).

**Known throughput tradeoff:** a wave barrier means each wave waits for its
slowest-of-K call before the next wave starts. For similarly-sized chunks at
K=2–4 the overhead is small; a future optimization could pipeline wave refills.
Acceptable for v1.

### Unified work queue

Stage-1 chunks, stage-2 chunks, and whole chapters are all "one LLM call" fed
to the wave dispatcher — no distinction (the "both, unified" decision). The
existing `STAGE2_CONCURRENCY` knob (a no-op today because the per-call semaphore
serializes underneath it) is **superseded** by the single width-K wave, so
there is one concurrency number rather than two fighting.

### Call-site inventory (deadlock- and starvation-critical)

Every analyzer `/api/chat` reaches `ollama.ts`'s chat path. Each call is one of
two kinds, threaded by an explicit context flag (not ambient state) so both
modes are unambiguous and unit-testable:

**In-job (dispatched via the wave mechanism; must NOT take `gpuSemaphore`
per-call — the wave already holds it).** A missed conversion here is a **hard
deadlock**: a per-call `acquire(4)` can never be granted while its own wave
holds the only slot. Full set the plan MUST cover:
- `runStage1Chapter` → `runStage` (Phase 0a cast) — `ollama.ts:263-279, ~456/516`
- `runStage2Chapter` / `runStage2ChapterChunked` (Phase 1) — `analysis.ts:1746/1753/4060`
- `runAttributionEscalation` **local** path — a *separate* chat path
  (`ollama.ts:374-417`), taken when `analyzer.structure.escalation` ≠ `'cloud'`
  (`analysis.ts:2553-2554`); easy to miss
- `runNonStoryClassification` — main job (`analysis.ts:4357-4361`) **and** subset
  job (`:5471`)
- subset job's `attributeChapterStage2` (`:5361`)

A test MUST fail if any in-job local call path takes `gpuSemaphore` directly.

**Out-of-band (single detached route calls; keep per-call `gpuSemaphore` — under
the per-wave outer this no longer stalls, it just queues one wave):**
- persona generation (`voice-style.ts`) — routes through
  `acquireGpuTokenIfOnGpu` (`gpu-semaphore-gate.ts:20-26`), which **skips** the
  semaphore entirely when `onCpu`; preserve that.
- script-review, annotate-emotion (`runEmotionChapter`, `annotate-emotion.ts:186`),
  instruct-annotation (`runStage3Chapter`, `instruct-annotation.ts:185`)

**CPU-analyzer preservation.** A confirmed-CPU analyzer costs 0
(`engine-vram-cost.ts:52-57`) and must **not** be gated by the wave/inner width
either — the wave mechanism applies only when the analyzer is on the GPU, or CPU
throughput regresses.

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
**re-verify**, not assume, when the wave width K grows beyond 2.

## Testing

- **Unit — wave dispatcher:** caps in-flight at K; acquires exactly **one**
  `gpuSemaphore` slot per wave and **releases it between waves** (mirrors the
  FIFO/abort tests in `server/src/gpu/semaphore.ts`).
- **Unit — interleave (guards F1):** while a wave holds the slot, a second
  waiter (second book / TTS op) is granted on the **wave's release**, not held
  for the run's duration. This is the regression test for the concurrent-
  multi-book invariant.
- **Unit — in-job flag coverage (guards F3):** every in-job local chat path
  (stage1, stage2, chunked internals, attribution-escalation-local,
  non-story, subset) does **not** take `gpuSemaphore` per-call. Test fails if
  any in-job path acquires the semaphore directly (the hard-deadlock trap).
- **Unit — out-of-band unchanged:** a standalone call still takes per-call
  `gpuSemaphore`; a CPU persona-gen call still **skips** it via
  `acquireGpuTokenIfOnGpu`.
- **Integration (mocked Ollama):** N chapter calls under one job run ≤ K in
  flight, each response is its own (no cross-request bleed) — mirrors the
  sidecar contract in `server/tts-sidecar/tests/test_concurrent_synthesis.py`.
- **Regression — behavior-preserving at K=1 (stubbed analyzer):** with a
  **deterministic stubbed analyzer**, single-book analysis output is
  byte-identical to pre-change at K=1 (wave width 1 = strictly serial = same
  merge order). *Not* a live-model assertion — first-attempt temperature is 0.2
  with a temperature-bumping retry loop (`ollama.ts:110, 502-522`), so real
  output is non-deterministic (F5).

## Risks

| Risk | Mitigation |
|---|---|
| **Concurrent-book / TTS starvation (F1)** | Per-**wave** hold (not per-book) + FIFO release between waves; interleave unit test guards it. |
| **Missed in-job call site → hard deadlock (F3)** | Full call-site inventory above; a test fails if any in-job local path takes `gpuSemaphore` directly. |
| Two job bodies, no single scope (F2) | Both main and subset jobs dispatch through the same per-wave mechanism; no whole-book wrap needed. |
| `num_ctx × K` VRAM overflow on smaller/single-GPU boxes | K default 2 + the calibration step; `numCtx` drop to 16K as the escape valve. |
| Merge non-determinism surfacing only at K>2 | Determinism invariant re-verified as K widens; K=1 stubbed regression anchors correctness. |
| Wave-barrier throughput loss (slowest-of-K per wave) | Accepted for v1; K=2 default keeps barrier cheap; pipelined refill noted as a future optimization. |

## Rollout

Ship with **K=2**. The operator raises `ANALYZER_OLLAMA_CONCURRENCY` and
`OLLAMA_NUM_PARALLEL` together after the calibration walk. If concurrency
proves insufficient for a commercial production batch, **vLLM** (continuous
batching, paged attention, native FP4 on Blackwell) is the documented v2 path —
out of scope here.
