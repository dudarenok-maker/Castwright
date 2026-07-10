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
  409 conflict-lock for that book promptly — bounded by the current in-flight analyzer call, the same
  signal-checked-between-tokens plumbing `/analysis/pause` already relies on, not literally instant.
- Cancelling never discards a chapter that finished checkpointing before the cancel. A chapter that was
  still being reviewed at the moment of cancellation is **not** checkpointed at all — see §4.1 — so the
  ledger never ends up with a partial chapter silently marked as fully reviewed.
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

**Chapters that finished checkpointing before the cancel are kept; the chapter that was still in flight
is not.** This distinction matters and is not free — it needs one new check, not zero. Reading
`runScriptReviewJob` (script-review.ts:611–701) shows the existing `if (job.controller.signal.aborted)
break;` at the top of the chunk loop only breaks that inner loop; control then falls through to
`accumulateChapterPacing`, `reviewedChapters += 1`, and — if any earlier chunk of *this same chapter*
already produced ops — `upsertChapterEntry` + a `checkpoint` broadcast. Left as-is, a cancel mid-chapter
on the default local-analyzer path (chapters are routinely split into multiple chunks via
`chunkSentencesByBudget`) would checkpoint that chapter with only its completed chunks' ops, indistinguishable
in the ledger from a fully-reviewed chapter. This spec adds an explicit check right after the chunk loop
so a mid-flight cancel skips the checkpoint for that one chapter entirely, instead of persisting a
partial result:

```ts
for (let index = 0; index < chunks.length; index += 1) {
  /* ...unchanged chunk loop... */
}
if (job.controller.signal.aborted) {
  // Cancelled mid-chapter: skip the checkpoint for this one chapter
  // entirely rather than persisting a partial result under a
  // "reviewed" chapter id. Mirrors the existing crash-recovery
  // invariant (a chapter only checkpoints once every one of its
  // chunks has been reviewed) — a cancel and a crash now leave the
  // ledger in the same shape for whichever chapter was in flight.
  break;
}
({ actualMsTotal, actualCharsTotal } = accumulateChapterPacing(/* unchanged */));
reviewedChapters += 1;
/* ...unchanged checkpoint block... */
```

This also keeps the client consistent for free, with no client-side change needed: any `ops` events
already broadcast live for that in-flight chapter's completed chunks are accumulated locally into
`allOps` by `runReviewScript`/`attachToRunningReview`, but `setReview`/`hydrateBucket` is only dispatched
*after* `api.reviewScript`/`attachScriptReview` resolves successfully — a thrown `cancelled` error skips
straight to the catch block, so those partial ops are simply never dispatched to Redux either. Server and
client agree: nothing about the in-flight chapter survives a cancel.

**Chapters that fully completed before the cancel are kept.** This part requires no new code: they were
already `upsertChapterEntry`'d into the ledger by an earlier, un-aborted iteration of the outer loop, and
nothing calls `discardChapters` on cancel.

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

**404 vs. book-not-found are conflated on purpose.** The attach route reaches the same `findBookByBookId`
404 as the create route if the book itself vanished, as well as the new "no job matches this scope" 404.
The client treats any 404 from this endpoint identically (re-fetch the ledger — see below); this is safe
because attach is only ever called moments after a `GET /state` call that already proved the book exists,
so in practice the only 404 that can actually fire here is "no job."

On a 404, the client does not error out — it falls back to a plain ledger re-read. This is **not** a call
to an existing reusable function: the ledger-hydration logic at the top of `hydrateScriptReview`
(`src/store/script-review-thunk.ts:295–324`, roughly 30 lines — iterate ledger entries, run `planApply`,
compute `selected` via `DEFAULT_OFF`, dispatch `hydrateBucket`) is inline in that function today, not a
standalone helper. This spec extracts it into a small shared function, e.g. `hydrateLedgerIntoBucket(bookId,
opts)`, called both from the top of `hydrateScriptReview` (unchanged behavior) and from
`attachToRunningReview`'s 404 branch (new). Calling it twice in one hydration pass is safe:
`hydrateBucket` merges per-chapter, so a second call simply picks up whichever chapter(s) finished
checkpointing in the TOCTOU gap. No new client state, no toast — the user sees the now-complete results
appear, the same as if they had reloaded a second later.

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
  - `api.attachScriptReview(bookId, { chapterId? }): Promise<ReviewScriptResult | null>` — a **separate**
    function from `realReviewScript`, reusing the same SSE-parsing *approach* (the `fetch` + reader +
    `data:` line-splitting loop) against the new URL, but with its own response handling: `realReviewScript`
    hardcodes `if (res.status === 404) throw new ReviewScriptError('Book not found.', 'not_found')`
    (`api.ts:3147`), which is the wrong behavior here — `attachScriptReview` instead treats a `404` as an
    expected outcome and resolves to `null` rather than throwing.
  - **Mock mode**, since `e2e` always runs against `api.mock`, never the real server
    (`playwright.config.ts`): `mockCancelScriptReview` clears the sessionStorage-backed
    `MockScriptReviewState`'s `running` field (`api.ts:3224–3260`), simulating a stopped job so a
    subsequent mock `GET /state` reports no job running. `mockAttachScriptReview` mirrors the real
    endpoint's shape against that same shim — returns buffered mock ops when `running` is set, `null`
    when it isn't — so both the Cancel e2e spec and the reattach-race unit coverage below have something
    to actually call.
- **`src/store/script-review-thunk.ts`**
  - New shared helper `hydrateLedgerIntoBucket` (see §4.2), extracted from the inline logic at the top of
    `hydrateScriptReview`, called from both that original call site (unchanged behavior) and from
    `attachToRunningReview`'s new 404 branch.
  - `attachToRunningReview` calls `api.attachScriptReview` instead of `api.reviewScript`. On a `null`
    result, it calls `hydrateLedgerIntoBucket` and returns — no toast, no `setReview` dispatch (the helper
    already dispatches `hydrateBucket` itself).
  - `runReviewScript`'s existing `finally` keeps dispatching `clear({ bookId })` exactly as today — this
    spec does not touch that. `attachToRunningReview` gains **no** `finally` and no `clear` call of its
    own: `clear` deliberately stays hoisted into `hydrateScriptReview`'s `Promise.all(...)`-wrapping
    `finally` (`script-review-thunk.ts:371–379`), which the round-5 PR review fix put there specifically
    so the *last* of several concurrently-reattaching jobs — not the fastest — clears the shared
    `activeStreams[bookId]` flag. Adding a `finally`/`clear` to `attachToRunningReview` itself would
    reopen that exact bug; this spec must not do it.
  - Both `runReviewScript` and `attachToRunningReview`'s catch blocks special-case
    `err instanceof ReviewScriptError && err.code === 'cancelled'` to skip the error toast entirely —
    mirrors `analysis-stream-middleware.ts`'s `code === 'aborted'` handling and
    `detect-emotions-button.tsx`'s silent `AbortError` handling. Each function's existing cleanup
    (`runReviewScript`'s `finally`; `hydrateScriptReview`'s wrapping `finally` for the attach path) still
    runs unchanged, so the pill disappears and the button re-enables identically to any other terminal
    outcome.
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
- **Cancel lands mid-chapter, on the chapter's later chunks:** per §4.1, that one chapter is not
  checkpointed at all, on either the server (no `upsertChapterEntry`) or the client (no `setReview`/
  `hydrateBucket` dispatch, since the stream throws before either function reaches that call). The
  analyzer time already spent on that chapter's completed chunks is lost — an accepted cost of the
  simpler "cancel = crash-shaped" semantics over persisting a result a user could mistake for complete.
- **Attach 404 for "book not found" vs. "no job for this scope":** both cases return the same 404 shape
  and the client handles them identically (re-fetch ledger state). This is safe in practice — see §4.2 —
  but is a deliberate simplification, not an oversight: a genuinely-vanished book would then fail loudly
  on the client's own `GET /state` re-fetch instead of at the attach call itself.

## 8. Testing plan

- **Server (`script-review.test.ts`):**
  - Cancel aborts a running main job.
  - Cancel aborts a running subset job.
  - Cancel aborts all running subset jobs for a book independently of the main job.
  - Cancel is idempotent: no job running → `{ cancelled: false }`, `200`.
  - A cancelled job's subscribers receive `{ kind: 'error', code: 'cancelled' }` before the stream ends.
  - A cancel mid-chapter does **not** checkpoint that chapter: no `upsertChapterEntry` call, no
    `checkpoint` event, and the chapter is absent from a subsequent `GET /state`'s `entries` — this is
    the regression test that pins §4.1's fix and would have failed against the pre-fix code.
  - Attach joins a live job and replays its buffered events.
  - Attach 404s when no job matches the requested scope (both wrong-`chapterId` and no-job-at-all cases).
- **Client (`script-review-thunk.test.ts`):**
  - `attachToRunningReview` on a `null`/404 result calls `hydrateLedgerIntoBucket` instead of throwing,
    and dispatches no `setReview` of its own.
  - A `cancelled`-coded `ReviewScriptError` suppresses the toast in both `runReviewScript` and
    `attachToRunningReview`.
  - `attachToRunningReview` itself never dispatches `clear` — a regression test asserting this pins the
    round-5 fix this spec must not reopen (see §6).
  - Two concurrently-reattaching subset jobs for the same book: the faster one finishing does not clear
    `activeStreams[bookId]` while the slower one is still running (existing round-5 coverage — re-run
    unchanged to confirm this spec doesn't regress it).
- **E2E:** one spec driving the real Cancel button mid-review against the new mock implementations (§6)
  — assert the pill disappears, the button re-enables, and a fresh review can start immediately after.
  This is the one part of the fix that's meaningfully hard to fake in Vitest+jsdom, since it exercises
  real button → SSE → store wiring end-to-end.
- The reattach-race window itself is unit-testable (mock the 404) but not meaningfully e2e-testable — it
  is a network-timing race that cannot be reliably reproduced against a real server in Playwright. The
  unit test on the 404-handling path is the coverage for this fix.

## 9. Follow-ups (not this spec)

- Chapter-scoped cancel (leaving sibling subset jobs for other chapters of the same book running) — only
  worth building if concurrent multi-chapter reviews for one book turn out to be a common pattern in
  practice; today's book-level cancel matches the one progress pill the UI has.
- A "Resume" affordance that continues a cancelled run from its last checkpoint rather than starting the
  remaining chapters from scratch — out of scope per §3; not requested by #1481.
