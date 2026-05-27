---
status: stable
shipped: 2026-05-27
owner: null
---

# Generate-view enqueue gate + Clear-queue control

> Status: stable
> Key files: `src/store/generation-stream-middleware.ts`, `src/modals/queue-modal.tsx`, `src/store/queue-thunks.ts`, `src/mocks/mock-queue.ts`, `server/src/workspace/queue-io.ts`, `server/src/routes/queue.ts`
> URL surface: indirect — the global queue modal (`ui.queueModalOpen`), reached from the top-bar queue chip / Generate-view "View queue"
> OpenAPI ops: `POST /api/queue/clear`

## Benefit / Rationale

- **User:** a freshly-analysed book no longer silently starts generating. It enters the queue only when the user reaches the Generate view ("Approve cast & start generating"), so cast approval + manuscript review come first. And the queue modal gains a one-click **Clear queue** (with an optional "also stop generation in progress") instead of forcing the user to delete entries one at a time.
- **Technical:** `enqueueOnWork` is now gated on `stage.kind === 'ready' && stage.view === 'generate'`, replacing an unconditional auto-enqueue that fired on `chapters/hydrateFromAnalysis` / `ui/confirmCast`. A new pure `clearQueue` mutator + `POST /api/queue/clear` route add bulk-clear with a `force` escape hatch.
- **Architectural:** keeps the persisted queue (plan 111) the sole generation trigger; the gate is a single guard at the top of `enqueueOnWork`, so every trigger type honours it uniformly. `Clear queue + stop` reuses the existing `chapters/requestStreamHalt` teardown rather than inventing a second stop path.

## Architectural impact

- **New seams:** `clearQueue(file, { force })` in `server/src/workspace/queue-io.ts`; `POST /api/queue/clear` route; `clearQueue` thunk in `src/store/queue-thunks.ts`; `/clear` branch in the mock queue (`src/mocks/mock-queue.ts`).
- **Invariants preserved:** the queue dispatcher (`queue-dispatcher-middleware`) remains the sole stream-opener (plan 111); the concurrent multi-book workflow invariant holds — the gate only constrains *when the viewed book* auto-enqueues, never the dispatcher's cross-book drain. `requestStreamHalt` leaves `queue.paused` untouched, so a clear-and-stop yields a clean empty, un-paused queue.
- **Migration story:** none — `clearQueue` is a pure filter over the existing `.queue.json` shape; no field changes.
- **Reversibility:** delete the gate line to restore the old (buggy) eager enqueue; delete the `/clear` route + button to drop bulk-clear.

## Invariants to preserve

- `enqueueOnWork` in `src/store/generation-stream-middleware.ts` bails unless `after.ui.stage.kind === 'ready' && after.ui.stage.view === 'generate'` — the first guard, ahead of the pause/analyzer guards.
- `clearQueue(file)` keeps `in_progress` entries (drops `queued` + `failed`); `clearQueue(file, { force: true })` drops everything. Both leave `paused` untouched and renumber `order` contiguously.
- The modal's "Clear queue" only force-clears (and dispatches `requestStreamHalt`) when there are no pending entries OR the user ticks "Also stop generation in progress" — see `handleClear` in `src/modals/queue-modal.tsx`.

## Test plan

### Automated coverage

- Vitest unit (`src/store/generation-stream-middleware.test.ts`) — walks `analysing → confirm → ready/manuscript → ready/generate`: no enqueue until the Generate view; enqueues there. Existing enqueue-on-work cases (which open at `status: 'generating'` ⇒ Generate view) stay green.
- Vitest unit (`src/modals/queue-modal.test.tsx`) — Clear button visibility; confirm dialog dispatches `clearQueue` with `force:false` (no in-flight) and `force:true` (when "Also stop" is ticked).
- Vitest server (`server/src/workspace/queue-io.test.ts`) — `clearQueue` default keeps in_progress, `force` drops all, leaves `paused`, idempotent on empty.
- Vitest server (`server/src/routes/queue.test.ts`) — `POST /api/queue/clear` default + `force` snapshots; paused flag untouched.
- Playwright e2e (`e2e/queue-modal.spec.ts`) — "queue stays empty until the user starts generating" (reads `window.__store__`); "Clear queue empties the queue via the confirm dialog".

### Manual acceptance walkthrough

1. Upload a manuscript → analysis completes → open the queue modal: **Empty** (book at confirm). Confirm cast → still **Empty** on the manuscript view.
2. Click "Approve cast & start generating" → chapters appear in the queue and generation starts.
3. With work queued/generating, open the modal → **Clear queue** → confirm without the checkbox: pending entries gone, an in-flight chapter finishes. With "Also stop generation in progress" ticked: queue empties and the live run tears down.

## Out of scope

- Per-book "clear this book" (the button clears the whole workspace queue). Filed nowhere yet; add to BACKLOG if requested.
- Changing the two-step confirm-cast → start-generating flow itself (plans 03/12).

## Ship notes

Shipped 2026-05-27 via PR #281 (merge commit `acf2602`). Fixes the "book queues at analysis time" report and the missing bulk-clear control. Cross-links: plan 102 (global queue modal), plan 110 (active-generation honesty), plan 111 (persisted-queue worker migration).
