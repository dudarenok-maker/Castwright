---
status: active
shipped: null
owner: null
---

# 107 — Within-chapter sentence parallelism

> Status: active
> Key files: `server/src/tts/synthesise-chapter.ts`, `server/src/gpu/semaphore.ts`, `server/src/tts/sidecar.ts`
> URL surface: indirect — `POST /api/books/{id}/generate` SSE stream (see [16-generation-stream.md](16-generation-stream.md))
> OpenAPI ops: none (server-internal synth pipeline)

Stacks on [87 — Parallel chapter synthesis](archive/87-parallel-chapter-synth.md) (bounded worker pool *across* chapters) and references [70d — Per-sentence synth](70d-per-sentence-synth-and-tag-strip.md) (one group per sentence). Plan 87 parallelised chapters; this plan parallelises the sentence groups *within* a single chapter.

## Benefit / Rationale

- **User:** when only one chapter is in flight (single-chapter books, the tail of a run, or any moment plan 87's chapter pool can't fill every GPU slot), a single chapter can now fan its sentence groups across idle GPU slots instead of leaving them empty — up to another ~2× per chapter on top of plan 87 when `GPU_CONCURRENCY > 1`.
- **Technical:** the dispatch is **dormant at the default**. Pool width defaults to `gpuSemaphore.maxConcurrency`, which reads `GPU_CONCURRENCY` once at module load (default `1`). At width 1 the new code path is byte-identical to the old serial loop — pinned by a width-2-vs-width-1 byte-equality test. Real GPU concurrency stays bounded by the global `gpuSemaphore` every `provider.synthesize` already acquires (`server/src/tts/sidecar.ts`), so a wide pool never oversubscribes VRAM; it only queues at the Node layer.
- **Architectural:** locks in the rule that parallel synth dispatch must be **order- and rate-deterministic** — completion order can never reorder PCM or shuffle segment timing, and the chapter's sample-rate anchor is fixed before dispatch (lowest-index group / title beat), not by whichever group finishes first.

## Architectural impact

- **New seam:** `SynthesiseChapterOpts.sentenceConcurrency?: number` — optional pool width, defaults to `gpuSemaphore.maxConcurrency`. The route caller passes nothing (uses the default); tests pass an explicit value to exercise width > 1 without touching `process.env`. Clamped to `>= 1`.
- **No new env var.** The width is governed by the existing `GPU_CONCURRENCY` (via the semaphore's `maxConcurrency` getter), matching plan 87's "one knob" intent. The synth function deliberately does NOT read `process.env.GPU_CONCURRENCY` directly — the semaphore reads it once at load; the option param keeps `synthesiseChapter` pure and testable.
- **Dispatch shape:** the serial `for (const group of groups)` body loop is replaced by an index-pulling worker pool that mirrors plan 87's chapter pool in `server/src/routes/generation.ts` (shared `nextIndex` cursor; `poolWidth` workers; `await Promise.all(workers)`). Each worker stores its RAW provider result into a pre-sized `results[group.index]` slot. A single index-order pass AFTER all workers settle does the `Buffer.concat` + segment-timing computation.
- **Preserved:** the chapter-title prelude stays BEFORE the dispatch (unchanged); `withTtsRetry` wrapping, `normaliseForTts` scrubbing, voice picking via `pickVoiceForEngine`, and the `onGroupRetry` wiring are factored into a shared `synthGroup` helper so the up-front anchor synth and the pool share one code path.
- **Reversibility:** set `GPU_CONCURRENCY=1` (the default) → width 1 → behaviour reverts to the serial loop exactly. No on-disk shape changed (`segments.json` / PCM layout identical).

## Invariants to preserve

1. **PCM order preserved** — each worker writes to `results[group.index]`; the final `chunks`/`segments` are built by walking `results` in index order, NOT completion order (`synthesise-chapter.ts`, the index-order pass after `Promise.all`). `Buffer.concat` stays order-correct.
2. **Deterministic sample-rate anchor** — the anchor is fixed BEFORE the pool runs: the title rate when a title beat ran (`chunks.length !== 0`), else `groups[0]`'s rate (synthesised up front). Never the first group to *complete* (the old `chunks.length === 0` rule was non-deterministic under parallelism). Mismatched groups are resampled to the anchor in the index-order pass.
3. **Stall watchdog** — `onGroupStart` fires inside `synthGroup`, BEFORE each `provider.synthesize`, so the 30 s client watchdog (`STALL_THRESHOLD_MS`, `src/store/chapters-slice.ts:32`) keeps resetting as each group begins. `onGroupComplete` fires per group as it finishes. Final per-segment `startSec`/`endSec` are computed only in the index-order pass, once order is known.
4. **Abort** — each worker checks `signal?.aborted` before claiming the next group and throws `AbortError`; the anchor synth checks before its call; `signal` is forwarded into every `synthesize` call.
5. **Title beat unchanged** — the chapter-title prelude (lead silence + narrator-voiced title + post silence) runs before the dispatch loop and anchors the chapter rate when present.
6. **Progress reporting is monotonic** — `onGroupStart`/`onGroupComplete` carry a `completed: number` field: a single counter incremented only on completion, shared by every in-flight worker (`synthesise-chapter.ts`, `fireComplete`/`withHeartbeat`). The route (`generation.ts`) MUST derive the SSE `currentLine`/`progress` from `completed`, NOT from `group.index`. Under parallel dispatch (poolWidth > 1) + Qwen batching the in-flight items tick at different narrative positions and the 10 s heartbeat re-fires `onGroupStart`, so a position-based `currentLine` ping-pongs backward (the "17 ↔ 25, stalled" bug). The shared count only ever climbs, so the displayed line/bar never regresses regardless of completion order.

Per-sentence groups are already independent (`buildSentenceGroups`, one group per sentence — plan 70d) and the sidecar handles concurrent calls with no cross-request bleed (`server/tts-sidecar/tests/test_concurrent_synthesis.py`), so parallel dispatch changes timing only, not per-sentence audio.

## Test plan

### Automated coverage

- Vitest server (`server/src/tts/synthesise-chapter.test.ts`, `describe('synthesiseChapter within-chapter parallelism (plan 107)')`):
  - **byte-identical** — width-2 output `.pcm.equals(serial.pcm)`, same `sampleRate`/`durationSec`/`segments`, with a deterministic fake provider whose completion order is forced OUT of dispatch order (longer text → shorter delay) and `peakInFlight >= 2` proving overlap.
  - **deterministic anchor** — `groups[0]` returns 24 kHz but finishes last; a later group returns 22.05 kHz and finishes first → chapter anchors on 24 kHz.
  - **stall watchdog** — every group fires `onGroupStart` (and `onGroupComplete`) at width 2.
  - **monotonic progress** — at width 2 with forced out-of-order completion, the `completed` value captured across both callbacks (in fire order) is monotonic non-decreasing and ends at `groups.length`, while the group's 1-based position bounces in the same fire order — pinning invariant 6 (the progress-bounce fix).
  - **abort** — aborting mid-run rejects with `AbortError` and stops dispatching further groups.
  - **title beat** — title rate anchors the chapter; body groups run in parallel at a mismatched rate and stay contiguous.
- Vitest server (regression) — all 23 pre-existing `synthesise-chapter.test.ts` cases stay green (default width 1 ⇒ byte-identical to the old serial loop), including the voice-routing, abort-between-groups, signal-forwarding, `onGroupStart` ordering, normalisation, resample, retry, and chapter-title suites.
- Pytest sidecar (`server/tts-sidecar/tests/test_concurrent_synthesis.py::test_kokoro_same_input_twice_is_deterministic`) — same (model, voice, text) → byte-identical PCM + same sample-rate header across two calls, with a non-degeneracy round-trip check. Complements the existing N-parallel no-cross-bleed + per-response-rate cases the plan-107 reorder relies on.

### Manual acceptance walkthrough

1. **Default (`GPU_CONCURRENCY` unset/`1`)** — generate any book; behaviour identical to today (width 1, serial dispatch). No audio artefacts; SSE "line N of M" caption advances per sentence.
2. **`GPU_CONCURRENCY=2`, single-chapter Kokoro book** — generate; wall-clock per chapter drops vs. width 1 with no audible drift or reordering, and the stall watchdog still trips on a genuine stall (kill the sidecar mid-chapter → "Worker has gone quiet" within 30 s).
3. **Stop mid-chapter at `GPU_CONCURRENCY=2`** — the in-flight groups abort within seconds; the chapter does not run to completion.

## Out of scope

- Raising the `GPU_CONCURRENCY` default — stays `1` (conservative for an 8 GB GPU). Operators opt in after measuring VRAM headroom.
- Both-engines-resident VRAM tuning — tracked separately (BACKLOG Could "Both TTS engines resident").
- Reconciling plan 70d's `status: active`/`shipped: null` doc state — its code is on `main`; out of scope here, just referenced.

## Ship notes

(Filled in when status flips to `stable`.)
