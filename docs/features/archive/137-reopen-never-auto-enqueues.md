---
status: stable
shipped: 2026-05-29
owner: dudarenok-maker
---

# Opening a book never auto-starts generation (explicit-start enqueue)

> Status: stable
> Key files: `src/store/generation-stream-middleware.ts`, `src/store/ui-slice.ts`, `src/routes/index.tsx`
> URL surface: `#/books/<id>/generate` (the gate fires on the `ui/requestStartGeneration` action, not on any route transition)
> OpenAPI ops: none (frontend-only enqueue gate; the persisted-queue contract is unchanged — see 111)

## Benefit / Rationale

- **User:** Opening — or re-opening — a book never adds its chapters to the
  generation queue. Generation starts **only** when the user clicks "Approve
  cast & start generating." Previously, re-opening a book that the library
  marked `generating` (or deep-linking to its Generate view) silently re-queued
  every unfinished chapter on every open, restarting generation before the user
  had finished designing voices. That is exactly the reported bug ("clicking on
  The Drowning Bell automatically adds all chapters to generation").
- **Technical:** Auto-enqueue is now driven by a single explicit-intent action
  (`ui/requestStartGeneration`) instead of inferring intent from "the viewed
  book is on the Generate view." The view heuristic could not distinguish "user
  clicked Start" from "user navigated to / re-opened the Generate view," because
  the same `changeView('generate')` backs both.
- **Architectural:** Locks the invariant that *navigation never mutates the
  queue.* Opening, URL hydration, view-switching, per-book hydration, and
  queue-snapshot loads are all side-effect-free with respect to enqueue.

## Architectural impact

- **Supersedes plan 119's auto-resume intent.** Plan 119
  (`archive/119-generate-view-enqueue-gate-clear-queue.md`) gated auto-enqueue on
  `stage.kind==='ready' && stage.view==='generate'` and *deliberately* let
  "re-opening a generating book auto-resume." That intent is reversed here; plan
  119's Clear-queue control is untouched and still valid.
- **New seam:** `uiActions.requestStartGeneration()` — a pure-signal, no-state,
  non-persisted action (mirrors `chapters/requestStreamHalt`). It is the sole
  member of `ENQUEUE_TRIGGER_TYPES`.
- **Server unaffected:** genuinely in-flight runs keep draining the persisted
  `.queue.json` server-side (plan 111) regardless of the frontend, so progress
  still displays on re-open — the frontend simply never *adds* entries on a
  passive open. The defence-in-depth guards inside `enqueueOnWork`
  (Generate-view, global-pause, reverse-local-analyzer) are preserved.
- **Reversibility:** revert is mechanical — restore the old
  `ENQUEUE_TRIGGER_TYPES` set and drop the action + button wiring.

## Invariants to preserve

1. `ENQUEUE_TRIGGER_TYPES` in `src/store/generation-stream-middleware.ts` is
   exactly `new Set(['ui/requestStartGeneration'])` — no passive/navigation/
   hydration/snapshot action may auto-enqueue.
2. `enqueueOnWork` still bails unless `stage.kind==='ready' && stage.view==='generate'`,
   on global pause (`queue.paused`), and on a live local analysis for the same
   book (reverse-analyzer guard). These are belt-and-braces on top of the
   explicit-intent trigger.
3. `uiSlice.reducers.requestStartGeneration` is a no-op `() => {}` — it holds no
   state and is never persisted or written to the URL.
4. The ONLY dispatcher of `requestStartGeneration` is `onStartGenerating` in
   `src/routes/index.tsx` (the "Approve cast & start generating" CTA). The five
   regen `changeView('generate')` callsites in `src/components/layout.tsx` must
   NOT dispatch it — each already enqueues its own targeted entries, and adding
   the whole-book start signal there would double-enqueue.

## Test plan

### Automated coverage

- Vitest unit (`src/store/generation-stream-middleware.test.ts`):
  - "reopen never re-enqueues (plan 137)" — `openBook(status:'generating')` →
    real `hydrateFromBookState` (all non-done chapters → `'queued'`) → asserts
    **0** enqueue; and a follow-up `changeView('generate')` (tab click) → still 0.
  - "explicit-start enqueue gate" — reaching the Generate view via `changeView`
    alone enqueues nothing; only `requestStartGeneration` enqueues `[1,2]`.
  - The enqueue-on-work suite now dispatches `requestStartGeneration` to drive
    the path, and the pause / reverse-analyzer guards are asserted to hold even
    on explicit start.
- Vitest integration (`src/store/queue-generation-integration.test.ts`) — the
  end-to-end queue chain fires on `requestStartGeneration`, dispatcher opens one
  stream per chapter, no regen loop.
- Playwright e2e (`e2e/queue-modal.spec.ts`):
  - "queue stays empty until the user explicitly starts generating (plan 137)" —
    confirm → manuscript (queue 0) → click the top-nav **Generate tab** (passive
    `changeView`, queue stays 0) → return to Manuscript → click **Approve cast &
    start generating** → queue fills.
  - "the queue is authoritative …" now starts generation via the CTA.

### Manual acceptance walkthrough

Mock mode (`VITE_USE_MOCKS=true`):

1. Open any book at `#/books/<id>/generate` (or click a `generating`-status
   library card) → Generate view paints, queue modal reads **Empty**, no
   `POST /api/queue/enqueue` in DevTools.
2. Re-open the same book (navigate away and back, or click the Generate nav tab)
   → still Empty, still no enqueue.
3. From the Manuscript review, click **Approve cast & start generating** →
   chapters enqueue and generation begins.
4. A genuinely mid-flight server run still shows live progress on re-open
   (plan 110 overlay) with the frontend adding nothing.

## Out of scope

- **A "Resume generation" button on the Generate view** — a recovery affordance
  for deliberately continuing an interrupted run with one click. Deferred to the
  backlog per the user's "never auto-start" decision; not required for this fix
  since the explicit CTA covers first-time start and server workers continue
  truly in-flight runs on their own. **(Shipped since — backlog `fe-17`. The
  button is live in `src/views/generation.tsx`, gated `queued > 0 &&
  inProgressCnt === 0 && !lastError`, dispatching the same `requestStartGeneration`
  intent; dedicated coverage landed 2026-06-01: unit cases in
  `src/views/generation.test.tsx` + e2e `e2e/generation-resume.spec.ts`.)**

## Ship notes

Shipped 2026-05-29 on branch `fix/frontend-reopen-auto-enqueue`. Reverses the
plan-119 auto-resume-on-reopen behaviour: auto-enqueue now fires solely on the
explicit `ui/requestStartGeneration` intent. No data-shape or OpenAPI change.
