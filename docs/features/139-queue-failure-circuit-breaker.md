---
status: active
shipped: null
owner: null
---

# Queue robustness: failure circuit-breaker + orphaned-entry recovery

> Status: active
> Key files: `src/store/queue-dispatcher-middleware.ts`, `server/src/workspace/queue-io.ts`, `server/src/routes/generation.ts`
> URL surface: indirect — the queue modal (`#/...` any view, `View queue`) reflects the paused state + toast
> OpenAPI ops: none new (reuses `POST /api/queue/pause`, the generation SSE close)

Two independent robustness fixes for the persisted generation queue (plan 102 / plan 111):

- **srv-11 — consecutive-identical-failure circuit breaker (frontend dispatcher).**
- **srv-12 — orphaned `in_progress` recovery on SSE last-subscriber disconnect (server).**

## Benefit / Rationale

- **User (srv-11):** a wedged sidecar / bad config no longer silently burns through every queued chapter producing the same failure. After 3 identical-in-a-row failures for a book, the queue pauses and a toast names the book + the repeated error, so the user fixes the root cause once instead of retrying N failed entries.
- **User (srv-12):** closing the tab (or a network drop) mid-generation no longer leaves a chapter stuck "generating" forever. The orphaned queue entry resets to `queued` and the dispatcher re-claims it on the next snapshot/boot; the now-unwatched synthesis is aborted so the GPU is freed.
- **Technical:** srv-11 is in-memory (per-book streak) — a reload naturally resets it, and failed entries already persist as `failed`+`errorReason` (PR #254), so nothing extra needs persisting. srv-12 adds a single-entry mutator `resetEntryToQueued` mirroring the bulk boot sweep `resetInProgressToQueued`.
- **Architectural:** srv-12 establishes `res.on('close')` (not `req.on('close')`) as the reliable client-gone signal on the generation SSE — once `express.json()` consumes the request body the `req` stream is already ended, so `req.on('close')` can miss a mid-stream disconnect.

## Architectural impact

- **srv-11 (`queue-dispatcher-middleware.ts`):** new in-memory `failureStreakByBook: Map<string, { reason, count }>` alongside the existing `inFlight` / `completed` local state. The reconcile-loop failure branch increments the streak on an *identical* repeated reason (resets to 1 on a differing reason); crossing `CONSECUTIVE_FAILURE_THRESHOLD` (3) dispatches `setQueuePaused(true)` + a `pushToast`. The success branch deletes the book's streak. Pause granularity is **global** (`setQueuePaused`) — the queue has no per-book/per-entry pause shape (`queue-io.setPaused` flips one global flag; `QueueFile.paused` is a single boolean), so the toast names the book + reason instead.
- **srv-12 (`queue-io.ts` + `generation.ts`):** `resetEntryToQueued(file, entryId)` flips a single `in_progress` entry → `queued`, guarded to a no-op for a missing / non-`in_progress` id (never resurrects a done/failed/queued entry). The generation route's starter close handler, when it's the **last** subscriber (`job.subscribers.size === 0`), the job is queue-driven (`job.queueEntryId != null`), and the job is still **registered** (`inFlightByChapter.get(key) === job`, i.e. the loop hasn't reached `deregisterJob`), reads the queue file → `resetEntryToQueued` → writes it back, then `job.controller.abort()`s the unwatched synthesis.
- **Invariants preserved:** the frontend owns the success lifecycle (it POSTs `/complete` BEFORE the SSE closes), so a clean disconnect-after-completion hits a *deregistered* job and the registration guard skips it — orphan recovery only ever touches genuine orphans. RTK Immer drafts untouched (the streak map is plain middleware-local state, not slice state).
- **Reversibility:** both are additive. Removing srv-11 = drop the streak map + its two branches. Removing srv-12 = drop `resetEntryToQueued` + the close-handler block (revert the `res.on('close')` rename back to `req.on('close')`).

## Invariants to preserve

- `CONSECUTIVE_FAILURE_THRESHOLD` in `src/store/queue-dispatcher-middleware.ts` is `3`. Only an *identical* repeated `errorReason` increments the streak; a differing reason resets to 1; a success deletes the book's entry.
- `resetEntryToQueued` in `server/src/workspace/queue-io.ts` is a no-op (returns the input `file` by reference) for a missing id or any non-`in_progress` status; it `renumber()`s like the sibling `resetInProgressToQueued`.
- The generation route's starter-connection close handler in `server/src/routes/generation.ts` is bound to `res.on('close')` (not `req.on('close')`), and orphan recovery is gated on `subscribers.size === 0 && queueEntryId != null && inFlightByChapter.get(key) === job`.

## Test plan

### Automated coverage

- Vitest unit (`src/store/queue-dispatcher-middleware.test.ts`, `describe('consecutive-failure circuit breaker (srv-11)')`) — asserts: no trip on a single transient failure; no trip on three *differing*-reason failures; trip after 3 *identical* failures → queue paused + an `error` toast (`dedupeKey` `queue-failure-breaker:<book>`) naming the book + reason; a success resets the streak so prior failures don't accumulate.
- Vitest server (`server/src/workspace/queue-io.test.ts`, `describe('queue-io.resetEntryToQueued ...')`) — asserts: flips only the targeted `in_progress` entry (siblings untouched); no-op (returns input by reference) for a missing id; no-op for a non-`in_progress` (queued/failed) entry.
- Vitest server (`server/src/routes/generation-orphan-recovery.test.ts`) — boots a real `http.Server`, opens the SSE via `fetch`+`AbortController`: a mid-run abort (last subscriber) resets the entry `in_progress`→`queued` AND aborts synth; a run that completes before the socket closes leaves the entry untouched (registration guard skips the deregistered job).

### Manual acceptance walkthrough

1. Queue 3+ chapters for one book with a broken engine (e.g. stop the sidecar) → each chapter fails with the same reason. After the 3rd identical failure the queue flips to **Paused** and a red toast reads *Paused the queue — book "…" failed 3 times in a row: …*.
2. Start a generation, then close the browser tab mid-chapter. Reopen → the chapter's queue entry is `queued` again (not stuck `in_progress`) and the dispatcher re-claims it; the GPU was freed at disconnect.

## Out of scope

- Per-book / per-entry queue pause (the queue has only a global pause flag). srv-11 uses the global pause + a book-naming toast.
- Persisting the srv-11 streak across reloads (intentionally in-memory; failed entries already persist with their reason).
- The subscribe-path close handler (`generation.ts` ~L628) still uses `req.on('close')` — pre-existing, unrelated to srv-12; left as-is per surgical-change discipline.

## Ship notes

(Filled in when status flips to `stable`.)
