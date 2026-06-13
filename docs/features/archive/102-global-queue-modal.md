---
status: stable
shipped: 2026-05-23
owner: null
---

# Global queue modal for chapter generation

> Status: active (Round 1 of 1; six waves — see `~/.claude/plans/a-large-piece-of-refactored-bird.md` for the wave decomposition)
> Key files: `src/store/queue-slice.ts` (Wave 2b), `src/store/queue-thunks.ts` (Wave 2b), `src/store/generation-stream-middleware.ts` (Wave 2b — rewrite), `src/modals/queue-modal.tsx` (Wave 3), `src/components/queue-entry-row.tsx` (Wave 3), `server/src/workspace/queue-io.ts` (Wave 2a), `server/src/routes/queue.ts` (Wave 2a), `server/src/routes/generation.ts` (Wave 2a — `resume_from` ack)
> URL surface: Modal mounted globally in `src/components/layout.tsx`; clicking a queue entry pushes `#/books/<bookId>/generate?chapter=<chapterId>` and the Generate view scroll consumer reacts to `currentChapterId`.
> OpenAPI ops: `GET /api/queue`, `POST /api/queue/enqueue`, `POST /api/queue/reorder`, `POST /api/queue/pause`, `DELETE /api/queue/{entryId}` + new `resume_from` SSE event on `POST /api/books/{bookId}/generation`.

## Benefit / Rationale

- **User:** closes two cited bugs that the v1 chapter-queue model cannot fix structurally. (1) **Regenerate-during-regenerate no longer drops in-flight work** — today's middleware closes the SSE handle on every `regenerateChapter*` action (`src/store/generation-stream-middleware.ts:325-347`), abandoning the partial chapter audio. The FIFO replaces the hard interrupt with append-and-wait, so the current chapter completes before the next one starts. (2) **Cross-book voice-drift fixes stop racing** — batch regenerate across multiple books today fires N `pendingRegen` dispatches that fight over the single-book `currentBookId` guard at `generation-stream-middleware.ts:279`. The cross-book queue with explicit `order` removes the race; the user can mix-and-match "regenerate these 2 chapters of Book 1, then these 5 of Book 5, then all of Book 6" in one queue and the dispatcher drains in the chosen order.
- **Technical:** decouples scheduling from book-active state. The queue is the source of truth, not the chapter-slice's implicit `state ∈ {queued, in_progress}` ordering. SSE survives `tsx watch` hot-reload during dev AND production server bounce / Node OOM — the consumer reconnects, the server emits a `resume_from` ack on every new subscriber, no replay of already-completed work. Same seam handles both paths (absorbs former BACKLOG Should #1).
- **Architectural:** locks in the standing memory's concurrent-multibook invariant (`project_concurrent_multibook_workflow.md`) as a tested property of the queue dispatcher instead of a fragile cross-slice handshake. Lays the seam for future "Schedule overnight" / "Generate when GPU is idle" / "Pause this book, prioritise that one" affordances that are out of scope for v1 but trivial to layer on once the queue exists. Foundation also enables Could-#13 (within-chapter sentence parallelism) — the queue dispatcher is the natural place to gate K-wide synth dispatch per entry.

## Architectural impact

### New seams / extension points

- New `queue-slice` (`src/store/queue-slice.ts`) is the **single source of truth for scheduling**. Every regenerate trigger site dispatches `queueActions.enqueue` (via `queue-thunks.ts`) rather than `chaptersActions.regenerate*`. The 10 existing trigger sites enumerated in BACKLOG Must #3 and the per-wave key-files list are all rewired to this seam in Wave 4.
- New workspace-level `<workspace>/.queue.json` (one file holds the cross-book queue, NOT per-book) persisted via the existing `writeJsonAtomic` contract from `server/src/workspace/state-io.ts`. Chosen over per-book `<bookDir>/.audiobook/queue.json` because the user's first-class operation is cross-book reordering — keeping ordering in one file removes the need to aggregate-and-reconcile on every read and makes the reorder API trivially atomic.
- New `resume_from` SSE event type on the generation stream. Emitted as the FIRST event on every new subscriber connection (cold connect AND post-reconnect). Carries `resumeFromCompletedChapterIds: number[]` for the active queue entry so the frontend can skip the existing per-chapter catch-up replay (today's `chapter_complete` catch-up at `server/src/routes/generation.ts:19` for already-done chapters) when it already has those rows in state.
- New `QUEUE_BROADCAST_ACTIONS` set in `src/store/broadcast-middleware.ts` for cross-tab queue mutations. Per-entry progress ticks stay non-broadcast (single-user-per-workspace contract, plan 63 invariant intact).
- New cross-book sequencing rule in the generation-stream middleware FIFO drainer: one SSE handle per book at a time (existing contract), books with queued work alternate at chapter boundaries based on `queue.order` regardless of which book is currently viewed.

### Invariants preserved

- **Per-book SSE contract (plan 16).** One handle per book — the queue dispatcher opens a handle only when a queued entry's book matches the slice's `currentBookId` for that handle's stream, AND the active handle for that book is the one carrying the current queue entry. No two handles per book.
- **Sticky generation across navigation (plan 31, invariant 1a).** The server-side `RunningJob` (`server/src/routes/generation.ts:1-78`) keeps a generation alive across SSE subscribers; reload mid-generation re-subscribes the new client. This contract is unchanged — the queue layer sits on top and chooses *which* `RunningJob` is current, but each job's stream-handle behaviour is identical.
- **Reverse-local-analyzer guard (`generation-stream-middleware.ts:284-320`).** When a local Ollama analysis is running on the same book, the middleware auto-pauses generation to avoid GPU contention. Preserved verbatim — the queue dispatcher consults this guard before opening a handle, same as today.
- **Single-user-per-workspace cross-tab contract (plan 63).** Per-chapter ticks are not broadcast across tabs; queue mutations ARE broadcast (a queue is shared workspace state, not per-tab UI state). Net: opening the modal in two tabs shows the same queue in both; pausing in one pauses in both.
- **Audio-on-disk completion semantic (plan 16).** "A chapter is complete iff `.mp3` exists for it on disk." Queue `status: 'done'` mirrors this — flips to `done` when the corresponding `chapter_complete` tick fires (which itself implies the `.mp3` is on disk).
- **Engine-drift detection (plan 35).** Drift detection compares `chapter.audioModelKey !== currentModelKey` at render time and surfaces the "Regenerate all" banner. The drift banner's regen path is one of the 10 trigger sites rewired in Wave 4; the drift detection itself is unchanged.

### Migration story

- `<workspace>/.queue.json` is **net-new**. On first read after upgrade, an empty queue is materialised. No existing user data needs migration. A schema-version stamp follows the `server/src/workspace/state-migrate.ts:33-100` pattern (Wave 2a: `server/src/workspace/queue-migrate.ts`) so future shape changes are migratable, and the file slots into Must-#1 (in-app upgrade pathway)'s broader migration family when that ships.
- `src/store/chapters-slice.ts` loses three fields: `pendingRegen` (no longer needed — the queue holds pending regens), `regenEpoch` (no longer needed — the middleware drives off queue mutations, not slice mutations), `paused` (migrated to queue-global on `queue-slice`). The per-chapter `state` field is preserved as-is so the UI keeps rendering per-chapter status the same way.
- All 10 existing regenerate trigger sites switch from `chaptersActions.regenerate*` to `queueActions.enqueue`. The dispatch shape changes; the UI affordances are unchanged at each site except Generate view's per-chapter button which gains a paired "Add to queue" + "View queue" affordance.
- `src/components/generation-view`'s Resume / Pause control (`src/views/generation.tsx:587-607`) is **relocated** to the queue modal — it does not move to a different button on the Generate view. The Generate view header gains a "View queue" affordance instead.

### Reversibility

- If the modal UI ships and proves a poor mental model: the slice + dispatcher + persistence stay (they're a strict superset of today's implicit queue); the modal is replaced or hidden behind a feature flag.
- If the cross-book ordering proves more flexibility than the user wants: a UI-only constraint enforcing per-book grouping in the modal is cheap to add. The on-disk model already supports cross-book ordering, so the constraint is purely cosmetic.
- The `<workspace>/.queue.json` file can be safely deleted at any time to reset the queue — the server treats absence as empty queue, the frontend re-renders the modal as empty.

## Invariants to preserve

1. **`QueueEntry` shape** (`openapi.yaml` lines added by Wave 1; mirrored in `src/lib/api-types.ts`): `{ id, bookId, chapterId, scope, characterId?, addedAt, status, order, progress?, errorReason? }`. The `scope` enum is `'this' | 'character'` only — the BACKLOG-cited `'forward'` scope is **expanded at enqueue time** by the frontend into multiple `'this'` entries, one per affected chapter, so the slice and on-disk shape never carry `'forward'` as a single row.
2. **The in-flight queue entry is non-draggable.** Reorder requests that move the `in_progress` entry return 409 from `POST /api/queue/reorder`. The frontend's drag-handle grays out / disappears on `status === 'in_progress'`. The reorder request body sends the desired order **excluding** the in-flight entry; the server validates this constraint.
3. **`paused` is queue-global, not per-book.** One Pause stops every book's drain at its next chapter boundary; Resume restarts the whole queue. Per-book pause is explicitly out of scope (see Out of scope below).
4. **FIFO with cross-book interleave.** The dispatcher walks entries in `order` ascending. When the active entry's book has more queued entries (e.g. `A.ch5` then `A.ch7`), it stays on Book A until those drain OR the user reorders a different-book entry to the top. No round-robin enforcement; the user owns the ordering.
5. **Book-delete prunes queue entries atomically.** The existing book-deletion route gains a queue-prune step that removes entries matching the deleted `bookId` in the same write transaction as the directory drop. No orphaned entries can persist.
6. **`resume_from` is emitted FIRST on every new subscriber.** Before any `progress` / `chapter_assembling` / `chapter_complete` tick. Reconnect after `tsx watch` restart or server bounce — first event the frontend sees is the resume snapshot, then the per-entry catch-up follows.
7. **Regenerate dispatches NEVER close the active SSE handle.** This is the structural fix for the user-cited "loses all progress" bug. The middleware's hard-interrupt path at `src/store/generation-stream-middleware.ts:325-347` is replaced with an enqueue-only flow that appends to the queue and lets the in-flight entry complete naturally.
8. **The queue auto-drains when unpaused — there is NO "start" gate.** A queue is a queue: if it has work and `paused === false`, the dispatcher starts the head entry. The server initialises a fresh `.queue.json` with `paused: false` (`queue-migrate.ts`), so enqueuing work (or rehydrating a queue with leftover entries on app boot) begins draining immediately — on any view, without an explicit Resume/Start click. `Pause` (queue modal) is the only opt-out; `Resume` un-pauses a paused queue, it does not "start" an idle one. Plan 102 Should #6 (cross-book dispatcher) extended this so the drain runs regardless of which book is currently viewed (see the Ship notes' deferred-follow-ups list below). (Decision confirmed 2026-05-24: auto-drain is the intended contract; the earlier walkthrough wording implying "Resume to start" was inaccurate and is corrected below.)

## Test plan

### Automated coverage

Per CLAUDE.md "Testing discipline (REQUIRED for every change)": every wave ships paired tests in the same PR as the code.

- **Wave 2a:** new `queue-io.test.ts` (round-trip + atomic write + concurrent read on the workspace file), new `queue.test.ts` (route handlers including enqueue + reorder + cancel + pause), new `generation-resume-from.test.ts` (subscriber gets `resume_from` ack before progress ticks; the snapshot lists exactly the chapter ids on disk), new `queue-migrate.test.ts` (absence-means-v1 back-compat, refuses future schemas), new `book-delete-prune.test.ts` (deleting a book with N queue entries drops all N from `.queue.json` atomically).
- **Wave 2b:** new `queue-slice.test.ts` (reducers + selectors + persistence + cross-book ordering + forward-expansion at enqueue time), new `queue-thunks.test.ts` (enqueue + reorder + cancel + toast dispatch via `notifications-slice.pushToast`), `generation-stream-middleware.test.ts` updated (FIFO drain order, in-flight pinning, regen-as-enqueue does NOT close the handle, cross-book alternation at chapter boundaries, reconnect-with-`resume_from` honoured), `chapters-slice.test.ts` updates (existing tests still pass after `pendingRegen` / `regenEpoch` / `paused` removal), `broadcast-middleware.test.ts` extension for queue actions.
- **Wave 3:** new `queue-modal.test.tsx` (renders entries grouped by book, in-flight entry non-draggable, click → router push to `#/books/<bookId>/generate?chapter=<chapterId>`), new `queue-entry-row.test.tsx` (drag + tap pills, both code paths), `generation.test.tsx` updates (Resume / Pause removed, View queue + Add to queue buttons present, scroll-to-chapter fires on `currentChapterId` change), `layout.test.tsx` extension (modal mount + Resume / Pause relocation), `top-bar.test.tsx` extension (queue count chip).
- **Wave 4:** existing per-site regen-trigger tests updated — each asserts the new `queueActions.enqueue` dispatch shape and the per-site toast assertion.
- **Wave 5:** new `e2e/queue-modal.spec.ts` driving enqueue → reorder → pause → resume → reconnect across all three responsive projects (chromium + mobile-chrome + tablet-chrome) per CLAUDE.md mobile protocol. `e2e/responsive/coverage.spec.ts` extended with the queue modal case so it auto-runs at every viewport.

### Manual acceptance walkthrough

Run with the canonical full-pipeline manuscript `server/src/__fixtures__/the-coalfall-commission.md` (CLAUDE.md "Canonical end-to-end manuscript"). Reboot before any timing assertion (`feedback_reboot_before_perf_baselines.md`).

1. **Cold boot at `#/`** → expected stage `{ kind: 'books' }`, library view, top-bar shows no queue chip (queue is empty).
2. **Upload Marlow + a Pushkin short-story stub.** Analyse both books to completion.
3. **Enqueue chapter 3 of Book A** from the Generate view's per-chapter "Add to queue" button → toast "Added to queue · 1 entry pending" with a "View queue" CTA. Top-bar queue chip shows `1`.
4. **Switch to Book B**, enqueue chapter 1 of Book B → toast "Added to queue · 2 entries pending". Queue chip shows `2`.
5. **Click the queue chip → View queue modal opens.** Two entries visible: `A.ch3` (order 0), `B.ch1` (order 1). The queue auto-drains when unpaused (invariant 8), so `A.ch3` has **already** flipped to `in_progress` and pinned to the top (non-draggable); `B.ch1` is queued behind it. The modal's top-level control is **Pause** (the queue is running) — there is no "start" button.
6. **`A.ch3` is mid-flight without any click** — its progress bar advances. (To stop it, you would click Pause; see step 15. Resume un-pauses; it is not needed to begin.)
7. **While `A.ch3` is mid-flight, enqueue `A.ch7`** from Book A's Generate view → toast fires, `A.ch7` appears at order 2 (bottom), `A.ch3`'s progress bar unaffected (no drop).
8. **Drag `A.ch7` above `B.ch1` in the modal** → confirmed visual feedback, the next entry to dispatch after `A.ch3` completes is now `A.ch7`.
9. **`A.ch3` completes** → status flips to `done`, toast "A.ch3 completed". Dispatcher pops `A.ch7`, which flips to `in_progress`.
10. **Click an entry's "Open in Generate view" affordance** (or the row itself) → router lands on `#/books/<A>/generate?chapter=7`, the Generate view auto-scrolls to chapter 7's row.
11. **Edit any file under `server/src/`** → `tsx watch` restarts the Node server → within ~3 s the frontend reconnects, `resume_from` ack restores the progress bar without replaying completed chapters, the queue keeps draining. "Worker has gone quiet" banner does NOT appear.
12. **Browser hard-refresh mid-queue** → queue restores from `<workspace>/.queue.json`, the in-flight entry resumes its SSE, no progress lost.
13. **Delete Book A from the library** → modal warns the user that 2 queue entries (`A.ch7`, plus any already-done `A.ch3`) will be dropped; on confirm, the entries vanish from the modal in the same write that drops the book directory. `B.ch1` remains.
14. **Voice-drift batch scenario:** with Books A + B both having drift, open `DriftReportModal` and batch-regenerate 3 chapters spanning both books → 3 queue entries land in order, drain sequentially, no in-flight work dropped.
15. **Pause-global:** Click Pause in the modal → both books stop at next chapter boundary. Resume → drain continues from where it stopped.
16. **Phone + tablet (LAN HTTPS, plan 81):** `npm run dev:lan`, open LAN URL on phone → modal renders full-screen, drag handles replaced with tap "Move up / Move down" pills. Tablet → dialog rendering with drag handles. Touch targets ≥44×44 px.

## Out of scope

- **Per-book pause inside the modal** — queue-global Pause is the v1 contract. Per-book Pause is a UI-only refinement on top of the same dispatcher; deferred to BACKLOG.
- **"Schedule overnight" / "Generate when GPU is idle"** — the queue dispatcher is the seam; UI lands separately when the user asks for it.
- **Within-chapter sentence parallelism (Could-#13)** — orthogonal to queue scheduling; the queue dispatcher is the natural place to gate K-wide dispatch, but plan 87 is the prerequisite.
- **Per-segment regen (Could-#1)** — entry shape stays "whole chapter or whole character-in-chapter" for v1.
- **Schema-version migration coordination with Must-#1 (in-app upgrade)** — plan 102's `queue-migrate.ts` is structured to slot into Must-#1's migration family when that ships; no cross-coordination required during v1 of the queue.

## Ship notes

**Shipped 2026-05-23 across seven PRs (#181-#188):**

- **PR #181** `docs(docs)` — BACKLOG entry filed as Must #3; former Should #1 (SSE hot-reload survival) folded into this plan.
- **PR #182** `feat(openapi,docs)` — design doc + OpenAPI shape (`QueueEntry`, 5 routes, `resume_from` SSE event). Wave 1.
- **PR #183** `feat(server)` — `queue-io.ts` mutators, `queue-migrate.ts`, `queue.ts` routes, `generation.ts` `resume_from` ack + `queueEntryId` plumbing, book-delete queue-prune hook. 27 new test cases. Wave 2a.
- **PR #184** `feat(frontend)` — `queue-slice.ts`, `queue-thunks.ts`, `realStreamGeneration` auto-reconnect with exponential backoff (absorbs former Should #1). 22 new test cases. Wave 2b.
- **PR #185** `feat(frontend)` — `queue-modal.tsx` (responsive — full-screen sheet on phone, dialog on desktop), top-bar queue chip, Layout mount + mount-time loadQueue. 12 new test cases. Wave 3.
- **PR #187** (commit `01641c5`) `feat(frontend)` — `queue-dispatcher-middleware.ts` (same-book FIFO drain), Generate view rewire (Resume/Pause → View queue, chapter-row id + scroll consumer), per-chapter Regenerate enqueue. 6 new test cases. Wave 4a.
- **PR #188** (commit `5867a74`) `feat(frontend)` — dispatcher `scope='character'` branch, rewire of drift bulk regen + CharacterRegenerateModal + BatchCharacterRegenerateModal + drift-report auto-queue + StaleAudioBanner to enqueue. 1 new + 2 updated test cases. Wave 4b.
- **PR #189 (this PR)** `test(e2e)` — `e2e/queue-modal.spec.ts` (3 cases — chip + count, cancel round-trip, View queue button) + `e2e/responsive/coverage.spec.ts` extended with queue modal viewport test. Wave 5.

**Bug fix verification:** bug #1 (regenerate-during-regenerate drops in-flight progress) closes across all 10 same-book entry points enumerated in the plan. The queue dispatcher serialises every regen action so the in-flight chapter completes before the next one starts.

**Deferred to follow-up plans (filed on BACKLOG):**

- Cross-book dispatcher (bug #2) — dispatcher gates on `chapters.currentBookId === head.bookId`. Cross-book sequencing requires either a cross-book SSE arbitration layer or direct fetch bypass of the existing generation-stream-middleware's gate. **SHIPPED 2026-05-23 (BACKLOG Should #6):** extracted a shared `generation-stream-runner.ts` driven by both the generation-stream-middleware (same-book) and the queue-dispatcher-middleware (cross-book open), so the same-book gate is lifted and the "one SSE at a time" invariant lives in one place.
- `chapters-slice` strip of `pendingRegen` / `regenEpoch` / `paused` — keep until the existing generation-stream-middleware is rewritten to consume queue state directly. Removing prematurely breaks the slice→middleware handshake the dispatcher relies on. **SHIPPED 2026-05-23 (BACKLOG Should #5):** `regenEpoch` was write-only (removed outright); the regen spec moved to a middleware-local `pendingSpec` (computed from the regen action, handed to the shared runner); `chapters.paused` was removed and the open-side gate now reads `queue.paused`. The literal "read `queue.paused` for the pill" extended into a full re-home of both local-analyzer guards — the reverse guard became a pure dispatcher/reconcile gate (no flag flip) and the forward guard now dispatches a `haltActiveGeneration` thunk (`requestStreamHalt` one-shot to close the in-flight SSE + `setQueuePaused(true)`), because `queue.paused`'s "finish the in-flight chapter" semantics can't substitute for the analyzer's halt-now-free-VRAM need.
- Drag-to-reorder in modal — tap-pill (Move up / Move down) covers both desktop and mobile in one path; pointer-event drag is a polish item.
- Visual baselines for queue modal — Wave 5 didn't regen baselines (Windows host flake per `feedback_visual_baselines_flaky_on_windows.md`). Linux CI run picks them up next push, or trigger explicitly via `npm run test:e2e:visual -- --update-snapshots`.

**Behaviour delta vs. original spec:**

- `forward` scope is expanded into per-chapter entries client-side at enqueue time (as designed) — the server-side queue file never carries a `forward` row, only `'this'` or `'character'`.
- Dispatcher uses local in-memory `inFlightEntryId` tracking instead of server-side `startEntry` route mutations. Reason: simpler, fewer round-trips, no risk of orphan in_progress state if the SSE closes uncleanly. Server-side `startEntry` / `completeEntry` mutators stay available in `queue-io.ts` for a future cross-book dispatcher that needs them.
