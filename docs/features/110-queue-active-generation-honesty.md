---
status: active
shipped: null
owner: null
---

# Queue modal reflects active generation + GPU badge disambiguation

> Status: active (Part A shipped; Part B — authoritative queue — is a follow-up, see BACKLOG)
> Key files: `src/store/queue-slice.ts`, `src/modals/queue-modal.tsx`, `src/views/generation.tsx`, `src/components/layout.tsx`
> URL surface: `#/books/<id>/generate` (Generate view), global top-bar queue chip + modal
> OpenAPI ops: none new (reads existing `GET /api/queue`, `GET /api/gpu/queue`)

## Benefit / Rationale

A book mid-generation showed three contradictory "queue" readouts: the Generate
header said `IN PROGRESS 2 / QUEUED 42` (live), the "Generation Queue" modal said
`Empty — No chapters queued`, and the top bar said `Queued (3 ahead)`. Three
_independent_ subsystems share the word "queue".

- **User:** the queue modal + "Queue · N" chip no longer claim "Empty"/0 while a
  book is visibly generating; the top-bar GPU-contention badge no longer reads
  "Queued (N ahead)" right next to an empty generation queue.
- **Technical:** the modal/chip read the live `chapters.activeStream` snapshot
  when the workspace queue has no real entries, via two pure selectors.
- **Architectural:** documents that the workspace queue (`.queue.json`) is
  populated ONLY by explicit regenerate / "Add to queue" actions, while the
  PRIMARY generation path (first generation after analysis, and resume-on-reopen)
  opens its SSE through the `generation-stream-middleware` reconcile
  (`hasWork(chapters)`) and writes NO queue entry. Part B (BACKLOG) closes that
  gap by making the queue authoritative.

## Architectural impact

Three distinct subsystems were colliding on the word "queue":

1. **Per-book SSE generation state** (`chapters-slice`) — Generate-view header +
   per-chapter badges. Real, live.
2. **Cross-book workspace queue** (`queue-slice` ↔ `.queue.json`) — the modal +
   "Queue · N" chip. Populated only by explicit regen / Add-to-queue.
3. **GPU semaphore depth** (`/api/gpu/queue`, plan 100) — top-bar contention
   badge. Unrelated; just shared the word.

Part A is read-side only:

- **New seam:** `selectActiveGenerationView` + `selectGenerationActivityCount`
  in `queue-slice.ts`. Both read `chapters` via an OPTIONAL field so lean stores
  that omit the slice stay valid (mirrors the defensive `queue?` read in
  generation-stream-middleware). The real queue always wins — the overlay only
  appears when `queue.entries` is empty AND a stream is live.
- **GPU badge copy:** `layout.tsx` renders `GPU busy · N waiting ·` (was
  `Queued (N ahead) ·`); aria-label `GPU busy: N waiting`. `openapi.yaml`
  `GpuQueueState.depth` prose updated + `api-types.ts` regenerated.
- **Reversibility:** pure selector + copy change; revert restores the prior
  behaviour. No data-shape or storage change.

## Invariants to preserve

- `selectQueueCount` (`src/store/queue-slice.ts`) stays the REAL entry count —
  the modal header + pause-button gate operate on real entries. Only the chip /
  "View queue · N" button use `selectGenerationActivityCount`.
- The active-generation section rows are SYNTHETIC (derived from
  `chapters.activeStream` + the viewed book's rows) and carry NO
  reorder/cancel/drag controls — there is nothing on the server to mutate until
  Part B lands.
- Same-book streams list per-chapter rows; a cross-book stream (slice holds a
  different book) shows only the done/total summary (`view.chapters === null`).
- Excluded chapters are filtered out of the rows + count, mirroring
  `snapshotFromChapters` (runner) and `hasWork` (middleware).
- The top-bar generation pill's `done/total` is computed per BOOK, not per
  stream. Each `activeStreams` snapshot is book-wide (`snapshotFromChapters`
  counts every active chapter of its book), so two concurrent same-book
  chapter streams each report the book's full `done/total`. `layout.tsx` MUST
  aggregate via `aggregateStreamsByBook` (`chapters-slice.ts`) — dedupe per
  `bookId` (per-book max), then sum across DISTINCT books — never a naive
  `reduce` sum across streams, which double-counts (`5/7` + `5/7` → `10/14`).
  The queue-overlay selector (`selectActiveGenerationView`) already picks a
  single representative stream, so only the pill needed this.
- **No orphaned `in_progress` entries survive a restart.** The frontend
  dispatcher is the sole entry-lifecycle owner (POST `/start` on claim, POST
  `/complete` on chapter-stream close) and reconciles only its in-memory
  `inFlight` map; a server restart / crash / browser reload empties that map
  while `.queue.json` still lists the entry as `in_progress`, so it would be
  neither re-run (FILL claims only `queued`) nor reconciled — wedging the
  chapter forever with an idle GPU. The server therefore sweeps
  `in_progress` → `queued` on boot (`server/src/workspace/queue-boot.ts`,
  `resetInProgressToQueued` in `queue-io.ts`), AWAITED before `listen()` so no
  freshly-connecting client can have a just-claimed entry clobbered. This is
  server-side + once because two browser tabs each run the dispatcher with
  independent in-memory maps and a frontend reclaim would double-claim. The
  narrower browser-refresh-while-server-stays-up orphan is left to Part B
  (the server owning the entry lifecycle).

## Test plan

### Automated coverage

- Vitest unit (`src/store/queue-slice.test.ts`) — selector matrix: real entries
  win (overlay null, count = entries.length); same-book stream lists
  in_progress+queued rows (done/failed/excluded filtered); cross-book stream →
  `chapters: null`, count = `max(total−done, inProgress, 1)`; no stream → null/0;
  missing `chapters` slice → null/0 (defensive read).
- Vitest RTL (`src/modals/queue-modal.test.tsx`) — modal shows the
  active-generation section + "Generating…" header (not "Empty") when the queue
  is empty but a stream is live; real entries suppress the overlay.
- Vitest unit (`src/store/chapters-slice.test.ts`) — `aggregateStreamsByBook`:
  two same-book streams reporting `5/7` each collapse to `5/7` (not `10/14`);
  per-book max absorbs tick skew; distinct books sum (`book-A 1/5` + `book-B
2/7` → `3/12`); empty → zeros.
- Playwright e2e (`e2e/queue-modal.spec.ts`) — drives a real mock generation
  (queue stubbed empty) and asserts the modal renders
  `queue-modal-active-generation` + "Generating…" instead of "No chapters queued".
- Vitest unit (`server/src/workspace/queue-io.test.ts`) — `resetInProgressToQueued`:
  flips every `in_progress` → `queued`, leaves `queued`/`failed` untouched,
  preserves contiguous order, no-ops on an empty queue.
- Vitest integration (`server/src/workspace/queue-boot.test.ts`) —
  `resetOrphanedQueueEntries` against a real `.queue.json`: 3 orphaned
  `in_progress` entries reset to `queued` (reports `{reset:3}`, order stays
  contiguous), no-op when nothing is `in_progress`, `paused` flag preserved.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`):

1. Cold boot → analyse a book → confirm cast → land on `#/books/<id>/generate`.
   Generation auto-starts (reconcile path).
2. While chapters show "Generating", click **View queue** → modal header reads
   "Generating…", the book's in-progress + queued chapters are listed (no
   reorder/cancel controls), and the empty CTA is gone.
3. Top-bar "Queue · N" chip is reachable on non-Generate views (Cast, Listen)
   during the run.
4. Under GPU contention (two sessions), the top-bar prefix reads
   "GPU busy · N waiting ·", not "Queued (N ahead)".

## Out of scope

- **Part B — authoritative queue** (BACKLOG): have the reconcile auto-open path
  silent-enqueue the in_progress+queued chapters into `.queue.json` (so the modal
  shows REAL reorderable/cancelable entries) with completion-driven dequeue keyed
  on `chapter_complete` ticks in `generation-stream-runner.ts`, guarded against
  the dispatcher re-driving already-done chapters (infinite-loop trap). Frontend
  only; no server route changes. See the BACKLOG entry for the full design +
  termination proof.

## Ship notes

(Part A) Shipped: TBD — fill commit SHA on merge of
`fix/frontend-queue-modal-active-generation`. Part B remains active/follow-up;
this plan flips to `stable` + archives once Part B lands.
