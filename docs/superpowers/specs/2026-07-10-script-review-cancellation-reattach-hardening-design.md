---
status: active
---

# Script Review — job cancellation and reattach-window hardening

## 1. Summary

fs-58's persistence work (#1479, spec `docs/superpowers/specs/2026-07-09-script-review-persistence-design.md`)
made script-review jobs **sticky**: a client disconnect only drops that connection's subscriber, it
never aborts the server-side job. That fixed reload-survival but left two narrow, deliberately-accepted
gaps, tracked in #1481:

1. **No cancel affordance.** If a user starts a review by mistake and closes the tab (rather than
   clicking the disabled button again), the job runs to completion server-side with no way to stop
   it — consuming local analyzer compute for the whole run, and blocking a same-scope request via 409
   until it finishes naturally.
2. **A narrow TOCTOU race in the reattach path.** `attachToRunningReview`'s join POST has a window
   between the `GET /state` call that reports a job is running and the subsequent join: if the job
   finishes in that gap, the join POST falls through to *create* a fresh job instead of attaching,
   silently starting a full re-review instead of reattaching to (now-complete) results.

This spec closes both gaps. It reuses existing patterns already proven elsewhere in the codebase rather
than inventing new mechanisms: cancellation mirrors `analysis.ts`'s `POST /:id/analysis/pause`
(idempotent, aborts whichever job(s) are running, reuses the job's existing `AbortController`); the
reattach fix mirrors the issue's own suggested shape (a dedicated attach-only endpoint that 404s instead
of falling through to create).

## 2. Goals

- A user can cancel an in-flight script review from the UI, freeing analyzer compute and clearing the
  409 conflict-lock for that book immediately.
- Cancelling never discards already-checkpointed findings — only chapters not yet reviewed are affected.
- The reattach path can no longer silently start a duplicate full re-review when the TOCTOU race is hit;
  it falls back to a plain ledger re-read instead.
- Both fixes reuse existing plumbing (`AbortController`, the SSE replay/broadcast mechanism, the ledger
  hydration path) rather than introducing new job-registry state.

## 3. Non-goals

- **No pause/resume.** Cancel is a one-way stop, not `analysis.ts`'s pause-then-resume-from-snapshot
  model. There is no "Resume" affordance after a cancel — starting again re-runs from scratch for any
  chapter that wasn't already checkpointed, same as it does today after a browser crash (§3 of the
  persistence design spec).
- **No chapter-scoped cancel.** Cancel is book-level (see §4.1) — it stops whatever is running for the
  book, not a specific chapter's job in isolation. The issue's own sketch proposed a chapter-scoped
  endpoint; this spec deliberately simplifies to match the single per-book progress pill the UI actually
  has (`activeStreams` is keyed by `bookId` only).
- **No grace-period/tombstone for the reattach race.** The fix is a 404 plus a client-side re-fetch, not
  a time-bounded window where a finished job stays joinable. See §4.2 for why.
- **No change to the create-or-join route's behavior** (`POST /:bookId/script-review`). It keeps serving
  the "click Review Script" flow exactly as today; only the reattach path (`attachToRunningReview`)
  switches to the new attach-only endpoint.

## 4. Architecture

### 4.1 Cancellation — book-level, reusing the existing `AbortController`

`POST /api/books/:bookId/script-review/cancel` (no body) aborts whichever job(s) are running for that
book:

```ts
const main = mainScriptReviewJobByBook.get(bookId);
const subsets = [...subsetScriptReviewJobByChapter.values()].filter((j) => j.bookId === bookId);
let cancelled = false;
for (const job of [main, ...subsets]) {
  if (!job || job.controller.signal.aborted) continue;
  job.controller.abort();
  cancelled = true;
}
res.status(200).json({ ok: true, cancelled });
```

This is deliberately **book-level, not chapter-scoped**: the client's progress pill is keyed by `bookId`
only (`activeStreams[bookId]`), so there is no UI surface today that knows "which specific chapterId to
cancel" when multiple subset jobs could concurrently be running for the same book (a legitimate state —
see the persistence spec's finding on concurrent per-chapter reviews). Book-level cancel matches the one
pill the user actually sees, and mirrors `analysis.ts`'s `POST /:id/analysis/pause`, which aborts both
its main and subset maps for a manuscript in one idempotent call.

A pure client-side abort (mirroring `detect-emotions-button.tsx`'s `abortRef.current?.abort()`) was
considered and rejected: `res.on('close')` deliberately never aborts the server job — that is the entire
point of "sticky" from the persistence design. A client-only abort would stop *displaying* progress
without stopping the job or releasing the 409 lock, which is the actual complaint in #1481.

**Already-checkpointed chapters are kept.** This requires no explicit code: cancelling only stops the
per-chapter loop early (via the existing `if (job.controller.signal.aborted) break;` checks already
present at both the chapter-loop and chunk-loop level in `runScriptReviewJob`), and nothing calls
`discardChapters`. Chapters already `upsertChapterEntry`'d into the ledger before the abort simply stay
there as ordinary unresolved findings.

**Terminal event on abort.** Today, `runScriptReviewJob`'s tail only sends a `result` event when the run
completes un-aborted; an aborted run currently ends the stream with no terminal event at all (a latent
gap, never hit today since nothing currently calls `.abort()`). This changes to:

```ts
if (job.controller.signal.aborted) {
  send({ kind: 'error', code: 'cancelled', message: 'Review cancelled.' });
} else {
  send({ kind: 'phase', phaseId: 0, progress: 1, label: 'Done' });
  send({ kind: 'result', done: true, reviewedChapters, totalOps });
}
for (const sub of job.subscribers) sub.res.end();
```

Routing this through the existing `send()` wrapper means it's captured into `job.replay.errorEvent`
automatically, so any subscriber that attaches mid-teardown (e.g. a cancel racing an attach — see §7)
still receives it via the normal replay path.

### 4.2 Reattach-only endpoint — 404 instead of fall-through-to-create

`POST /api/books/:bookId/script-review/attach` (body: `{ chapterId? }`, same shape as the create route)
performs only the join half of today's logic — the same scope resolution (main map vs. `subsetKey`'d
subset map) and the same `setUpSse` + `attachSubscriber` + `res.on('close')` cleanup as the existing join
branch. The difference: if no job matches the requested scope, it responds `404 { error: 'No running
review to attach to.' }` instead of creating a new job.

`attachToRunningReview` (`src/store/script-review-thunk.ts`) — the only caller that ever reattaches —
switches from POSTing the create route to POSTing this new one. The create route itself is untouched and
keeps serving the "click Review Script" flow.

On a 404, the client does not error out. It re-fetches `GET .../script-review/state` once and dispatches
`hydrateBucket` again with whatever is now in the ledger — the same call `hydrateScriptReview` already
makes at the top of the function. Calling it a second time is safe: `hydrateBucket` merges per-chapter,
so this simply picks up whichever chapter(s) finished checkpointing in the TOCTOU gap. No new client
state, no toast — the user sees the now-complete results appear, the same as if they had reloaded a
second later.

Two alternatives were considered and rejected:

- **Client-side heuristic** (infer "this is a fresh job, not a replay" from the stream itself — e.g. by
  noticing progress starts at 0). Rejected: the server has no clean way to signal created-vs-joined
  before the SSE stream commits, so this would be guessing at a symptom instead of fixing the cause.
- **Grace-period tombstone** (keep a finished job in the registry for a few seconds so a race-losing
  attach still joins it and gets a clean replay instead of a 404). Rejected as disproportionate: the
  issue itself frames this race as low-probability (a network round-trip plus
  `waitForManuscriptAndCast`, not the whole review duration) and low-impact (no data loss — every
  checkpointed chapter is already safe). A tombstone adds new TTL state and timer cleanup to the job
  registry for a case the 404-plus-re-fetch path already handles correctly with zero new state.

## 5. API changes

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/api/books/:bookId/script-review/cancel` | *(none)* | `200 { ok: true, cancelled: boolean }` — idempotent; `cancelled: false` when nothing was running. |
| `POST` | `/api/books/:bookId/script-review/attach` | `{ chapterId?: number }` | SSE stream (join + replay), same shape as the create route's join branch, on a match. `404 { error: string }` on no match — headers/SSE never sent. |

Both are added under `scriptReviewRouter` alongside the existing `/discard`, `/resolve`, `/selection`
routes. `openapi.yaml` gains both operations; `npm run openapi:types` regenerates `api-types.ts`.

## 6. Client-side changes

- **`src/lib/api.ts`**
  - `api.cancelScriptReview(bookId): Promise<{ ok: boolean; cancelled: boolean }>` — plain POST, no
    streaming.
  - `api.attachScriptReview(bookId, { chapterId? })` — shares `realReviewScript`'s existing SSE-parsing
    loop against the new URL. A `404` resolves to `null` (a distinguishable, handled outcome) rather than
    throwing.
- **`src/store/script-review-thunk.ts`**
  - `attachToRunningReview` calls `api.attachScriptReview` instead of `api.reviewScript`. On a `null`
    result, it calls `api.getScriptReviewState(bookId)` once more and dispatches `hydrateBucket` with the
    fresh entries, then returns — no toast.
  - Both `runReviewScript` and `attachToRunningReview`'s catch blocks special-case
    `err instanceof ReviewScriptError && err.code === 'cancelled'` to skip the error toast entirely —
    mirrors `analysis-stream-middleware.ts`'s `code === 'aborted'` handling and
    `detect-emotions-button.tsx`'s silent `AbortError` handling. `finally` still dispatches
    `clear({ bookId })` as today, so the pill disappears and the button re-enables identically to any
    other terminal outcome.
- **`src/views/manuscript.tsx`**
  - New `handleCancelReview`, wired to the existing `onCancel` prop on `SubstageProgressPill`
    (`substage-progress-pill.tsx` already supports it — script-review is the one call site documented as
    not using it yet). Fire-and-forget, matching the `void handleReviewScript(...)` convention already
    used on the same button.

## 7. Error handling & edge cases

- **Cancel with nothing running:** `cancelled: false`, `200` — matches `/analysis/pause`'s idempotent
  shape, so a double-click or a stale pill never 404s.
- **Cancel races the job's own natural completion:** every abort call is guarded by
  `!job.controller.signal.aborted`, so cancelling an already-finished job is a no-op; that job's
  subscribers already received their normal `result` event moments earlier.
- **Attach races cancel:** if a cancel lands between the attach endpoint's lookup and its subscriber
  attach, the newly-attached subscriber still receives the buffered replay plus the `cancelled` error
  event via the existing broadcast/replay path (§4.1's `send()` wrapper already records it into
  `job.replay.errorEvent`) — no special-casing needed; this is the same mechanism that already delivers a
  `result` event to a late joiner.
- **Two tabs, one cancels:** every subscriber (both tabs) receives the same broadcast `cancelled` event;
  both pills clear identically.
- **Attach's post-404 re-fetch itself finds nothing new** (e.g. the job produced zero ops for its
  remaining chapters): `hydrateBucket` with an unchanged entry set is a safe no-op.

## 8. Testing plan

- **Server (`script-review.test.ts`):**
  - Cancel aborts a running main job.
  - Cancel aborts a running subset job.
  - Cancel aborts all running subset jobs for a book independently of the main job.
  - Cancel is idempotent: no job running → `{ cancelled: false }`, `200`.
  - A cancelled job's subscribers receive `{ kind: 'error', code: 'cancelled' }` before the stream ends.
  - Attach joins a live job and replays its buffered events.
  - Attach 404s when no job matches the requested scope (both wrong-`chapterId` and no-job-at-all cases).
- **Client (`script-review-thunk.test.ts`):**
  - `attachToRunningReview` on a `null`/404 result re-fetches state and dispatches `hydrateBucket`
    instead of throwing.
  - A `cancelled`-coded `ReviewScriptError` suppresses the toast in both `runReviewScript` and
    `attachToRunningReview`, and still dispatches `clear`.
- **E2E:** one spec driving the real Cancel button mid-review — assert the pill disappears, the button
  re-enables, and a fresh review can start immediately after. This is the one part of the fix that's
  meaningfully hard to fake in Vitest+jsdom, since it exercises real button → SSE → store wiring
  end-to-end.
- The reattach-race window itself is unit-testable (mock the 404) but not meaningfully e2e-testable — it
  is a network-timing race that cannot be reliably reproduced against a real server in Playwright. The
  unit test on the 404-handling path is the coverage for this fix.

## 9. Follow-ups (not this spec)

- Chapter-scoped cancel (leaving sibling subset jobs for other chapters of the same book running) — only
  worth building if concurrent multi-chapter reviews for one book turn out to be a common pattern in
  practice; today's book-level cancel matches the one progress pill the UI has.
- A "Resume" affordance that continues a cancelled run from its last checkpoint rather than starting the
  remaining chapters from scratch — out of scope per §3; not requested by #1481.
