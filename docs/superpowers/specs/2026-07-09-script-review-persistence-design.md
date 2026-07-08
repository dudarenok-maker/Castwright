---
title: 'Script Review — persist findings & guard against blind re-runs'
status: active
date: 2026-07-09
related:
  - 2026-06-23-fs58-llm-script-review-design.md (§5.5, §9 — explicitly deferred "persist suggestions across reload" as follow-up #5; this spec delivers it)
  - 2026-06-25-phase3-prosody-and-scriptreview-chunking-design.md
  - 2026-07-02-prosody-review-progress-detail-design.md
---

# Script Review — persist findings & guard against blind re-runs

## 1. Summary

Script Review (fs-58) findings live only in an in-memory Redux slice today. Two problems fall out of
that:

1. **A UI bug silently destroys completed findings.** The results modal renders as a full-viewport
   backdrop (`z-50`) above the sticky top nav (`z-40`). When a review finishes, the modal auto-opens; if
   the user clicks a nav tab while it's up, the click lands on the modal backdrop instead of the tab, which
   today fires the same `clearReview` action as an explicit "Dismiss all" — permanently deleting the
   findings. There is also no non-destructive way to close the modal at all: the X button and "Dismiss
   all" do the same destructive thing.
2. **Nothing survives a reload or tab close.** Even without the bug above, the `scriptReview` slice is
   deliberately excluded from `persistReducer`, and a review in progress is aborted outright on client
   disconnect (`res.on('close')` calls `controller.abort()` server-side). This was a known, accepted gap
   at fs-58 ship time (spec's own non-goals: "no suggestion persistence").

This spec fixes both: findings are checkpointed server-side per chapter as a review runs, survive
reload/disconnect (both mid-run and after completion), and the UI clearly separates "hide" from "discard"
so closing the modal is never destructive. A visible badge and a re-run confirmation stop a user from
starting a fresh review over a chapter that already has unresolved findings sitting untouched.

## 2. Goals

- Closing the results modal (X, backdrop click, or navigating away) never discards findings.
- Findings for a chapter that has already been analyzed survive a page reload or tab close.
- If the server process stays alive, reloading mid-review reattaches to the same in-flight run instead of
  losing it; the run keeps making progress even with no client attached.
- If a review crashes/disconnects mid-chapter, only that in-progress chapter's work is lost — chapters
  already completed and checkpointed before the crash remain intact.
- The user can see, per chapter, that unresolved findings exist, without having to remember or reopen the
  modal.
- Starting a new review over a chapter that already has unresolved findings requires an explicit choice
  (review the existing ones, or discard and start fresh) — never a silent overwrite.

## 3. Non-goals

- Surviving a full server-process restart mid-review. If the server itself restarts while a review is
  running, that in-flight run is lost, same as it is today — no new on-disk ledger for
  partially-emitted, not-yet-checkpointed chapter data. (Completed, already-checkpointed chapters are
  unaffected by this restriction — see §4.2.)
- Cross-tab live sync of findings/selection state. Each tab reconciles with the server independently on
  load (§4.3); two tabs editing the same review concurrently is last-write-wins on the server ledger, same
  as any other unsynchronized-tabs edge case in this codebase today.
- Restructuring the modal's z-index/layering. Once closing is non-destructive, an accidental
  click-through just costs an extra click to navigate — a minor inconvenience, not data loss — so the
  stacking bug itself is left as-is.
- Any change to what the review analyzes or which op classes exist (`strip_tag`, `split`,
  `extract_dialogue`, `merge`, `fix_emotion`, `validate_instruct`, `reattribute`, `flag_nonstory`) or to
  staleness invalidation logic — this spec is purely about persistence and UI guardrails around the
  existing findings.

## 4. Architecture

### 4.1 Server-side job registry (sticky, join-or-create, scope-safe)

`POST /api/books/:bookId/script-review` changes from "one request handler runs the whole loop and
`res.on('close')` aborts it" to the same sticky pattern `analysis.ts` already uses for book analysis —
including mirroring its **split main/subset registries**, not a single map. `analysis.ts` deliberately
keeps `inFlightAnalysisByManuscript` (whole-book) and `inFlightSubsetByManuscript` (chapter-scoped)
separate precisely so a subset job can never be mistaken for — or silently joined by — a whole-book
request. Script review needs the same split, or a whole-book POST could join an existing single-chapter
job and return that chapter's findings as if they were a complete whole-book pass.

- Two module-level maps: `mainScriptReviewJobByBook: Map<bookId, ScriptReviewJob>` (whole-book runs) and
  `subsetScriptReviewJobByBook: Map<bookId, ScriptReviewJob>` (single-chapter runs; the job carries its
  target `chapterId`).
- Each `ScriptReviewJob` holds an `AbortController`, a `Set` of subscribers (each an open SSE response),
  and a replay buffer of `phase`/`ops` events emitted so far this run.
- **Join/conflict rule**, checked before creating a new job:
  - Whole-book POST: joins an existing entry in `mainScriptReviewJobByBook` for this book if present.
    If `subsetScriptReviewJobByBook` has an active job for this book (any chapter), reject with 409 —
    "a single-chapter review is already running for this book."
  - Single-chapter POST: joins an existing `subsetScriptReviewJobByBook` entry for this book **only if
    its `chapterId` matches**. If it exists for a *different* chapter, or `mainScriptReviewJobByBook` has
    an active whole-book job for this book, reject with 409 with a message naming the conflicting scope.
  - This keeps the original "at most one active review per book" intent while making a scope mismatch a
    visible, explicit error instead of a silent wrong-data join.
- `res.on('close')` no longer aborts the controller — it only removes that one subscriber. The LLM work
  keeps running server-side even with zero clients attached.
- A reconnecting client (reload, or a second tab) attaches as a new subscriber to whichever map/entry
  matches its requested scope, and is replayed the buffered events before continuing to receive live
  ones, so it catches up instantly.
- If the server process itself restarts, both maps are gone and any in-flight job is genuinely lost (§3).

### 4.2 Per-chapter checkpointed persistence ledger

**The server persists raw findings only — never appliability.** Whether an op is `appliable` or
`unappliable` is computed by `planApply` (`src/lib/script-review-apply.ts`), which runs client-side
against the *live* Redux `manuscript.sentences` — the server never applies anything and has no view of
current sentence text, so it structurally cannot compute or own that classification. The ledger stores
exactly what the run emitted, plus the user's own triage clicks; appliability is re-derived by the client
every time the ledger is loaded, the same way it's derived today when ops first stream in live. This also
means there is no "staleness prune to keep in sync with the ledger" (no such reducer exists in
`script-review-slice.ts` today) — since appliability is never persisted, there's nothing about it to keep
in sync.

A JSON file in the book's workspace, `.script-review-pending.json`, keyed by `chapterId`:

```
{
  "<chapterId>": {
    "ops": ReviewOp[],
    "selected": Record<opKey, boolean>,
    "completedAt": "<ISO timestamp>"
  },
  ...
}
```

- Written incrementally: as each chapter finishes during a run, its entry is upserted into the ledger —
  not one wholesale write at the end of the whole run. This is what makes the "crash mid-chapter loses
  only that chapter" guarantee in §2 possible: a 20-chapter whole-book review that dies at chapter 14 has
  already checkpointed chapters 1–13.
- The user's triage state (`selected` — which ops are checked/unchecked in the diff view) is included and
  kept in sync: the client debounces writes back to the server whenever the user toggles a checkbox, so a
  reload restores not just "what was found" but "what you'd already decided about it."
- **Entry removal requires an explicit client signal — the server cannot infer "resolved" on its own.**
  Two paths remove (or shrink) a chapter's entry:
  - **Discard** (§5, §6.2) removes the whole entry.
  - **Apply** (§6.5, new) removes just the applied ops' keys from the entry, once the client has
    successfully applied them; any ops the user left unselected stay in the entry as still-unresolved.
  - An entry is deleted once its `ops` array is empty (all ops either applied or discarded).

### 4.3 Client reconciliation on load

A new `GET /api/books/:bookId/script-review/state` endpoint (mirrors the existing
`GET /api/books/:bookId/analysis/state`), checked once when the Manuscript view mounts for a book:

- If a job is currently running for this book (either map, §4.1), returns which scope it's running
  (whole-book or the specific chapter) plus its replay buffer + progress.
- Otherwise, returns the current contents of `.script-review-pending.json`.

**Reattaching to a running job does not re-invoke the existing `runReviewScript` thunk** (which starts
from `setActive(progress: 0)` and would visibly reset the progress pill). Instead, a dedicated
`attachToRunningReview(bookId)` thunk seeds `activeStreams[bookId]` directly from the state response's
progress, then opens an SSE connection that receives only *new* events from this point (the replay buffer
already backfilled history into the initial payload). It dispatches `updateProgress`/appends `ops` as they
arrive, same as the live path, and dispatches `setReview` + clears the active stream when the job's
terminal event arrives — so a completed-while-you-were-reconnecting run still ends up populating
`byBook[bookId]` correctly.

When there's no running job, the client hydrates `byBook[bookId]` from the ledger's raw `ops`/`selected`
and immediately re-runs `planApply` against the current live manuscript to derive `unappliable` for
display — exactly the computation that already happens when ops first arrive live, just re-run against
whatever the manuscript looks like now (see §4.2 on why this can't be a persisted, cached value).

This replaces the current assumption that `scriptReview` Redux state is only ever populated by a live SSE
session within the current tab.

## 5. API changes

- `POST /api/books/:bookId/script-review` — behavior changes to join-or-create against the correct
  scope-matched map, with a 409 on scope conflict (§4.1); request/response shape for starting a new
  review is unchanged.
- `GET /api/books/:bookId/script-review/state` — new (§4.3).
- `POST /api/books/:bookId/script-review/discard` — new. Body identifies the chapter(s) in scope to
  discard (mirrors the granularity of a review run — a single chapter or a list for whole-book). Removes
  those chapters' entries from the ledger entirely and, if a job is currently running for one of those
  chapters, has no effect on the running job itself (discard only ever targets completed/persisted
  findings, never an in-flight run).
- `POST /api/books/:bookId/script-review/resolve` — new. Body: `{ chapterId, appliedOpKeys: string[] }`,
  sent by the client immediately after it successfully applies those ops locally (§6.5). Removes just
  those op keys from the chapter's ledger entry; deletes the entry once it's empty. This is the "apply"
  counterpart to discard — without it the server has no way to learn an op was resolved, since applying
  is a purely client-side action (§4.2).
- Selection-state sync rides on a debounced `PATCH`-style update to the ledger (exact wire shape is an
  implementation detail for the plan) with one safety rule: **the PATCH is a no-op if the chapter's ledger
  entry no longer exists.** This prevents a selection-toggle sent just before a discard from landing just
  after it and resurrecting a deleted entry (§7).

## 6. Client-side changes

### 6.1 `scriptReview` slice

- `clearReview` splits into two actions: `hideReview` (local-only, sets a `visible: false` flag on the
  bucket — never touches `ops`/`selected`, never calls the server) and `discardReview` (calls
  `POST .../script-review/discard`, then removes the entry from `byBook`).
- On mount, dispatch a thunk that calls `GET .../script-review/state` and hydrates `byBook[bookId]`
  and/or `activeStreams[bookId]` accordingly (§4.3), re-deriving `unappliable` via `planApply` for any
  hydrated ops.
- Selection toggles dispatch the existing local reducer immediately (for responsive UI) and enqueue a
  debounced sync to the server (§5).

### 6.2 `ScriptReviewDiff` modal

- The X button and clicking the backdrop dispatch `hideReview` — the modal closes, nothing is lost.
- "Dismiss all" is now the only destructive discard action; it gets a confirmation prompt ("Discard N
  unresolved suggestions for this chapter? This can't be undone") before dispatching `discardReview`.
- The z-index/backdrop-over-nav layering is unchanged (§3) — an accidental click-through now just hides
  (harmlessly) instead of discarding.

### 6.3 Unresolved-findings badge

The "Review Script" button shows a count when the relevant scope has unresolved, currently-appliable
findings:

- Single-chapter button: count of unresolved *appliable* ops in the *current* chapter only (ops
  `planApply` currently classifies as `unappliable` — e.g. because the manuscript changed since the run —
  are excluded from the count, though they're still visible inside the reopened modal for transparency).
- Whole-book button: count summed the same way across all chapters with unresolved entries.

The badge is a display-only computation (§4.3) — it does not change what clicking the button does; that's
defined once, in §6.4, so there's a single answer for "what happens when I click Review Script," not one
per section.

### 6.4 Review Script click behavior (single state machine)

Clicking "Review Script" for a given scope (one chapter, or whole-book) does exactly one of three things,
checked in order:

1. **A job is already running for this scope** (§4.1) → no-op beyond showing the existing "Reviewing…"
   progress state (button stays disabled, same as today).
2. **Unresolved findings exist for this scope** (§6.3's badge is non-zero, counting only chapters the
   requested scope actually touches) → a confirm dialog: "You have N unresolved suggestions in
   [chapter(s)]. Review them, or discard and start a new review?" — "Review existing" reopens the hidden
   modal (`visible: true`) to show them; "Discard and start new" calls `discardReview` for exactly the
   in-scope chapters (leaving any chapter outside this scope untouched, per §4.2's per-chapter keying)
   and then starts the new run.
3. **Neither** → starts a new review immediately, as today.

Gate granularity is per-chapter: a chapter-scoped click only checks that one chapter; a whole-book click
checks every chapter it's about to touch.

### 6.5 What "Apply" does to the ledger

This is a deliberate behavior change from today: currently, applying selected ops calls `clearReview`
afterward, which discards the *entire* bucket — including whatever the user left unchecked. Under
persistence, silently discarding unactioned findings on Apply would defeat the point of this feature, so:

- Applying dispatches the existing manual-edit reducers for the selected ops (unchanged), then calls
  `POST .../script-review/resolve` with just those ops' keys (§5).
- Ops the user left **unselected** are *not* discarded — they remain in the ledger as still-unresolved
  findings, and the badge (§6.3) reflects them on the next load/render.
- To clear the unselected leftovers, the user uses "Dismiss all" (§6.2, now an explicit discard) or
  applies them in a later pass.

## 7. Error handling & edge cases

- **Corrupted/unreadable ledger file:** treated as empty (log a warning), never a hard failure — same
  defensive-read posture as other workspace JSON files in this codebase.
- **Debounced selection-sync fails (network blip):** retried silently; worst case the user's most recent
  triage clicks aren't reflected in the ledger yet, but the findings themselves are never at risk since
  they were already checkpointed at chapter-completion time.
- **Two tabs open on the same book:** each reconciles independently on its own mount; no live cross-tab
  merge (§3 non-goals) — last write to the ledger wins, matching how `byBook` already isn't broadcast
  cross-tab today (only the progress pill is).
- **Discarding while a job is running for a different chapter:** allowed — discard only ever touches the
  persisted ledger, never an in-flight job's in-memory state.
- **A debounced selection PATCH lands after a discard:** the PATCH is a no-op against a nonexistent ledger
  entry (§5) — it must never re-create the entry, or a discarded chapter's findings would silently
  reappear.
- **A whole-book POST while a same-book single-chapter job is running (or vice versa):** rejected with 409
  rather than silently joining mismatched-scope data (§4.1) — the client surfaces this as "a review is
  already running for [scope]; wait for it to finish."

## 8. Testing plan

- **Server:**
  - Two connections to the same book **and same scope** join the same job; the second gets replayed the
    events it missed.
  - A whole-book POST while a single-chapter job is running for that book (and vice versa) is rejected
    with 409, not silently joined (§4.1).
  - `res.on('close')` removes a subscriber without aborting the controller; the job completes and
    checkpoints remaining chapters with zero subscribers attached.
  - Ledger upsert/removal: a chapter's entry appears after it completes, persists across a simulated
    process restart of the *reading* code path (i.e., a fresh read of the file), shrinks correctly when
    `/resolve` removes a subset of its ops, and disappears once its `ops` array is empty.
  - `/resolve` never removes ops the caller didn't name; `/discard` removes the whole entry regardless.
  - A `PATCH` selection update against a chapter with no ledger entry (already discarded) is a no-op, not
    a re-creation.
  - `GET .../script-review/state` returns the right shape for: job running, ledger-only (no job), neither.
- **Client:**
  - `hideReview` never mutates `ops`/`selected`; `discardReview` does and calls the server.
  - On hydration from a persisted ledger, `unappliable` is (re-)computed via `planApply` against current
    manuscript state, not read from the ledger (there is nothing to read — §4.2).
  - Badge count excludes ops `planApply` currently classifies as unappliable.
  - The three-way click behavior in §6.4 (running → no-op progress; unresolved → confirm dialog;
    neither → start new) is covered for both single-chapter and whole-book scopes.
  - Applying selected ops calls `/resolve` with exactly those ops' keys; unselected ops remain in
    `byBook[bookId]` afterward (§6.5) — a regression test for the "Apply used to discard everything"
    behavior change.
- **E2E (Playwright), regression-focused, run at a ≥1280px (`xl`) viewport** (the nav tab strip this test
  depends on clicking is `hidden xl:flex` and collapses into a hamburger below that — see
  `docs/superpowers/specs/2026-06-19-responsive-topbar-nav-design.md`; the test must pin `xl` or it won't
  reproduce the click-through it exists to guard):
  - Complete a review, click a nav tab (simulating the backdrop click-through), confirm findings are
    still present and reachable via the badge afterward — this is the direct regression test for the bug
    that motivated this spec.
  - Reload mid-review: progress UI resumes without user action, without resetting to 0%.
  - Reload after a completed-but-unactioned review: findings and prior selection state are restored, and
    unappliable ops (if the manuscript changed) are correctly excluded from the badge count.

## 9. Follow-ups (not this spec)

- Surviving a full server restart mid-review (§3) — would need a new on-disk ledger of
  partially-emitted, sub-chapter progress; deferred until there's evidence it's worth the added
  complexity.
- Cross-tab live sync of findings/selection (§3).
- Revisiting the modal's z-index/layering for its own sake, independent of the data-loss concern this
  spec fixes.
