---
status: stable
shipped: 2026-05-22
owner: null
---

# GPU-arbitration semaphore for parallel sessions

> Status: stable
> Key files: `server/src/gpu/semaphore.ts`, `server/src/routes/gpu-queue.ts`, `server/src/analyzer/ollama.ts`, `server/src/tts/sidecar.ts`, `src/lib/use-tts-lifecycle.ts`, `src/components/layout.tsx`
> URL surface: none (top-bar pill — visible on every view)
> OpenAPI ops: `GET /api/gpu/queue` → `GpuQueueState { depth, inFlight, max }`

## Benefit / Rationale

- **User:** parallel Claude Code sessions (e.g. one drafting a plan + another running `/analyse`) no longer thrash an 8 GB GPU. The second GPU-touching call waits in queue instead of fighting the first for VRAM, and the top-bar pill in the waiting session shows `"Queued (N ahead) · …"` so the user knows *why* the second call hasn't started yet. Removes the silent 5–10× slowdown the BACKLOG entry called out.
- **Technical:** every analyzer chat completion (`OllamaAnalyzer.chat`) and every sidecar synth (`SidecarTtsProvider.synthesize`) now passes through a single in-process `GpuSemaphore` singleton. Default concurrency is 1; `GPU_CONCURRENCY` env var bumps it for hardware that can survive concurrent ops. No new npm dep — hand-rolled FIFO queue with double-release guard, ~40 lines.
- **Architectural:** establishes the seam future GPU consumers will sit behind. Today only two call sites; adding a third (e.g. plan 14's parallel sentence dispatch inside one chapter, or an embedding model) is a 2-line wrap. The shape — outer `try { … } finally { release() }` around the network call — preserves every existing abort / classify-connect-error path verbatim.

## Architectural impact

- **New seam:** `server/src/gpu/semaphore.ts` exports a `GpuSemaphore` class and a singleton `gpuSemaphore` instance, both consumed via `await gpuSemaphore.acquire()` → release function. Caller invokes the release in `finally` — abort, throw, and timeout paths all release cleanly.
- **New endpoint:** `GET /api/gpu/queue` returns `GpuQueueState { depth, inFlight, max }`. Polled by `useTtsLifecycle()` on the same 30 s interval that already polls `/api/sidecar/health`. Graceful degradation: a 404 (older server) leaves `gpuQueueDepth` undefined and the pill renders unchanged.
- **Pill rendering:** `src/components/layout.tsx` mounts a sibling `<span>` with the `"Queued (N ahead) · "` prefix when `gpuQueueDepth > 0`. The `ModelControlPill` component is untouched — the pill state machine doesn't change, just gets a prefix label.
- **Invariants preserved:**
  - Concurrent-multibook workflow (per `project_concurrent_multibook_workflow` memory): the semaphore is workspace-wide, not per-book, so analyzing Book A + generating Book B on the same GPU queue cleanly rather than racing.
  - Eviction wiring (CLAUDE.md "Suggested follow-ups"): the existing Ollama-evicts-on-XTTS-load and XTTS-evicts-on-Ollama-load paths run independently of the semaphore. Eviction happens *outside* the semaphore acquire (during model load/unload), so a queued waiter doesn't block eviction.
- **Migration:** none. Pure additive — no on-disk shape change, no contract break.
- **Reversibility:** revert the PR. The semaphore's two wrap sites are the only behaviour change; removing them returns the prior "fire-and-fight" path. The new `/api/gpu/queue` endpoint dropping doesn't break the frontend (graceful undefined handling).

## Invariants to preserve

1. **Release-in-finally rule** — every `acquire()` is paired with a `release()` inside a `try { … } finally { release() }`. The release function carries an internal `released = false` guard so accidental double-release is a no-op rather than a slot leak. Cited in `server/src/gpu/semaphore.ts` `makeRelease()`.
2. **FIFO order** — the queue is a plain `Array` with `push()` + `shift()`. Anyone refactoring to a heap / priority structure breaks the fairness pinned by `server/src/gpu/semaphore.test.ts > "FIFO order"`.
3. **Slot accounting** — when a release hands off to a waiter, slot count stays constant; only decrements when the queue is empty. Pinned by `server/src/gpu/semaphore.test.ts > "Queue depth"`.
4. **No streaming sidecar response** — `SidecarTtsProvider.synthesize` buffers the entire PCM via `arrayBuffer()` before returning. If the sidecar ever switches to chunked response, the release point must move from "after arrayBuffer" to "after stream close" or the semaphore will leak.
5. **Ollama outer-finally** — the wrap in `server/src/analyzer/ollama.ts` is an OUTER `try { … } finally { release() }` covering fetch + reader-lock. The existing inner finally for reader-lock cleanup stays in place. The outer finally must remain the outermost frame around the fetch.

## Test plan

### Automated coverage

- **Vitest server (`server/src/gpu/semaphore.test.ts`)** — 4 cases:
  1. Capacity (`max=2`, three concurrent acquires; third waits for one of the first two to release).
  2. FIFO order (`max=1`, four acquires; release order is `A, B, C, D`).
  3. Queue depth tracking (`queueDepth` increments + decrements correctly across the lifecycle).
  4. Double-release guard (calling `release()` twice is a no-op, not a slot leak).
- **Frontend Vitest (`src/lib/use-tts-lifecycle.test.ts`)** — extended to assert `gpuQueueDepth` is plumbed through the hook's return shape and that a 404 from `/api/gpu/queue` leaves it `undefined` (graceful degradation).
- **Frontend Vitest (`src/components/layout.test.tsx`)** — pins the pill prefix render: with `gpuQueueDepth > 0` the pill label includes `"Queued (N ahead) · "`.
- **No new e2e spec** — the pill prefix is a single span insertion driven by hook state; no router/redux seam crossed. Existing e2e suite passing covers the regression net for the wrap sites.

### Manual acceptance walkthrough

1. Start the app: `npm start`. Confirm top-bar pill renders normally (no prefix when nothing is queued).
2. Open two browser tabs against the same workspace. In tab A start a long `/analyse` operation; in tab B start a chapter generation.
3. **Expected:** tab B's pill briefly shows `"Queued (1 ahead) · Coqui XTTS …"` or similar, until tab A's analyzer call releases. Then tab B's synth proceeds and tab B's pill drops the prefix.
4. Hit `GET /api/gpu/queue` directly at rest: returns `{ depth: 0, inFlight: 0, max: 1 }`.
5. Set `GPU_CONCURRENCY=2` in `server/.env`, restart server. Two concurrent ops now run side-by-side without queue prefix. (Only do this if you've verified VRAM headroom for the engines involved — default 1 is conservative.)

## Out of scope

- **Priority queueing** — current FIFO is fair. Inserting a priority axis (e.g. "interactive synth jumps ahead of bulk regen") is a future enhancement gated by a real use case.
- **Per-engine semaphores** — today a single semaphore serialises *all* GPU work (analyzer + sidecar combined). Splitting into per-engine queues (Ollama queue vs sidecar queue) only matters if a future hardware spec can run one analyzer + one synth concurrently without VRAM contention. The single semaphore is the safe v1.
- **Prometheus / Grafana metrics endpoint** — the semaphore tracks `depth`, `inFlight`, and `max`; a `/metrics` text body would feed observability tools with no extra plumbing, but no current consumer needs it.
- **Per-session position display** — every waiting session sees the same depth number, not "you're 2nd of 3." A per-call ticket would surface ordinal position; deferred unless usage grows.
- **Rejection past a ceiling** — the queue is unbounded today. A pathological N-session pile-up queues forever. Not a real risk at 1–2 parallel sessions but worth a follow-up if usage scales.

## Ship notes

- **Shipped:** 2026-05-22 via PR [#171](https://github.com/dudarenok-maker/AudioBook-Generator/pull/171) (`feat/gpu-arbitration-semaphore`, commit `ae8c22b`).
- **Wave context:** Wave 2 of the post-Wave-1 round (Wave 1 = PR #136 e2e reliability). Wave 2 originally scoped 4 PRs (B, C, D, E); reduced to 2 (B + D) during planning because PR C (`ci/non-blocking-mobile-e2e`) shipped same-day via PR [#166](https://github.com/dudarenok-maker/AudioBook-Generator/pull/166) and PR E (`feat/cross-book-voice-compare`) shipped same-day via PR [#147](https://github.com/dudarenok-maker/AudioBook-Generator/pull/147) (plan 96). Wave 2 plan file: `~/.claude/plans/wave-2-frolicking-whale.md`.
- **Deltas from original BACKLOG spec:**
  - BACKLOG cited `server/src/routes/sidecar-synth.ts` for the synth proxy wrap; actual call site lives in `server/src/tts/sidecar.ts` (the `SidecarTtsProvider` class). No proxy route file exists; the wrap goes on the TTS provider class.
  - OpenAPI schema named `GpuQueueState` rather than the originally-planned `GpuQueue` — `-State` suffix matches sibling probe-shape conventions (`SidecarHealth` etc.) and pairs more naturally with the `getGpuQueueState` hook reader.
  - Pill prefix lands as a sibling `<span>` inside the existing flex container rather than mutating `engineLabel` inside `ModelControlPill`. Keeps the pill component untouched and respects the no-component-mutation rule.
- **Suggested follow-up backlog items** (filed against future rounds, not v1 blockers):
  - Prometheus-style `/metrics` endpoint exposing depth + in-flight + max.
  - Per-session queue position display ("you're 2nd of 3").
  - Reject-past-ceiling for the queue (configurable max queue length).
