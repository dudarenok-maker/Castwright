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
  unaffected by this restriction — see §5.2.)
- Cross-tab live sync of findings/selection state. Each tab reconciles with the server independently on
  load (§5.3); two tabs editing the same review concurrently is last-write-wins on the server ledger, same
  as any other unsynchronized-tabs edge case in this codebase today.
- Restructuring the modal's z-index/layering. Once closing is non-destructive, an accidental
  click-through just costs an extra click to navigate — a minor inconvenience, not data loss — so the
  stacking bug itself is left as-is.
- Any change to what the review analyzes or which op classes exist (`strip_tag`, `split`,
  `extract_dialogue`, `merge`, `fix_emotion`, `validate_instruct`, `reattribute`, `flag_nonstory`) or to
  staleness invalidation logic — this spec is purely about persistence and UI guardrails around the
  existing findings.

## 4. Architecture

### 4.1 Server-side job registry (sticky, join-or-create)

`POST /api/books/:bookId/script-review` changes from "one request handler runs the whole loop and
`res.on('close')` aborts it" to the same sticky pattern `analysis.ts` already uses for book analysis:

- A module-level `Map<bookId, ScriptReviewJob>` (mirrors `inFlightAnalysisByManuscript`). At most one
  active review job per book, regardless of scope (single chapter or whole book) — a second POST for a
  book that already has a running job joins that job rather than starting a new one.
- Each `ScriptReviewJob` holds an `AbortController`, a `Set` of subscribers (each an open SSE response),
  and a replay buffer of `phase`/`ops` events emitted so far this run.
- `res.on('close')` no longer aborts the controller — it only removes that one subscriber. The LLM work
  keeps running server-side even with zero clients attached.
- A reconnecting client (reload, or a second tab) attaches as a new subscriber and is replayed the buffered
  events before continuing to receive live ones, so it catches up instantly.
- If the server process itself restarts, the in-memory map is gone and the job is genuinely lost (§3).

### 4.2 Per-chapter checkpointed persistence ledger

A JSON file in the book's workspace, `.script-review-pending.json`, keyed by `chapterId`:

```
{
  "<chapterId>": {
    "ops": ReviewOp[],
    "unappliable": Array<{ op, reason }>,
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
- When every op in a chapter's entry is resolved (applied or explicitly discarded), that chapter's entry
  is removed from the ledger entirely — this is also what makes the "unresolved findings" badge (§6)
  correct with no separate bookkeeping.
- If an existing staleness check (boundary-move invalidation) prunes an op because the underlying text
  changed, the same prune applies to the ledger entry, not just the in-memory Redux copy.

### 4.3 Client reconciliation on load

A new `GET /api/books/:bookId/script-review/state` endpoint (mirrors the existing
`GET /api/books/:bookId/analysis/state`), checked once when the Manuscript view mounts for a book:

- If a job is currently running for this book, returns its replay buffer + progress; the client attaches
  as a subscriber and the "Reviewing…" progress UI picks back up with no user action needed.
- Otherwise, returns the current contents of `.script-review-pending.json`; the client hydrates
  `byBook[bookId]` from that instead of assuming it starts empty.

This replaces the current assumption that `scriptReview` Redux state is only ever populated by a live SSE
session within the current tab.

## 5. API changes

- `POST /api/books/:bookId/script-review` — behavior changes to join-or-create (§4.1); request/response
  shape for starting a new review is unchanged.
- `GET /api/books/:bookId/script-review/state` — new (§4.3).
- `POST /api/books/:bookId/script-review/discard` — new. Body identifies the chapter(s) in scope to
  discard (mirrors the granularity of a review run — a single chapter or a list for whole-book). Removes
  those chapters' entries from the ledger and, if a job is currently running for one of those chapters,
  has no effect on the running job itself (discard only ever targets completed/persisted findings, never
  an in-flight run).
- Selection-state sync rides on the existing apply/selection flow (debounced `PATCH`-style update to the
  ledger) rather than a new endpoint family — exact wire shape is an implementation detail for the plan.

## 6. Client-side changes

### 6.1 `scriptReview` slice

- `clearReview` splits into two actions: `hideReview` (local-only, sets a `visible: false` flag on the
  bucket — never touches `ops`/`unappliable`/`selected`, never calls the server) and `discardReview`
  (calls `POST .../script-review/discard`, then removes the entry from `byBook`).
- On mount, dispatch a thunk that calls `GET .../script-review/state` and hydrates `byBook[bookId]`
  and/or `activeStreams[bookId]` accordingly (§4.3).
- Selection toggles dispatch the existing local reducer immediately (for responsive UI) and enqueue a
  debounced sync to the server.

### 6.2 `ScriptReviewDiff` modal

- The X button and clicking the backdrop dispatch `hideReview` — the modal closes, nothing is lost.
- "Dismiss all" is now the only destructive action left; it gets a confirmation prompt ("Discard N
  unresolved suggestions for this chapter? This can't be undone") before dispatching `discardReview`.
- The z-index/backdrop-over-nav layering is unchanged (§3) — an accidental click-through now just hides
  (harmlessly) instead of discarding.

### 6.3 Unresolved-findings badge

The "Review Script" button shows a count when the relevant scope has unresolved ledger entries:

- Single-chapter button: count of unresolved ops in the *current* chapter only.
- Whole-book button: count summed across all chapters with unresolved entries.

Clicking the button when its scope has a badge reopens the hidden modal (`visible: true`) to the existing
findings rather than starting a new run.

### 6.4 Re-run gate

Clicking "Review Script" for a scope that has unresolved findings triggers a confirm dialog: "You have N
unresolved suggestions in [chapter(s)]. Review them, or discard and start a new review?" — one button
reopens the existing findings, the other calls `discardReview` for exactly the in-scope chapters (leaving
any other chapter's unresolved findings untouched, per the per-chapter granularity in §4.2) and then starts
the new run.

Gate granularity is per-chapter: a chapter-scoped review only checks that one chapter; a whole-book review
checks every chapter it's about to touch.

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

## 8. Testing plan

- **Server:**
  - Two connections to the same book's review join the same job; the second gets replayed the events it
    missed.
  - `res.on('close')` removes a subscriber without aborting the controller; the job completes and
    checkpoints remaining chapters with zero subscribers attached.
  - Ledger upsert/removal: a chapter's entry appears after it completes, persists across a simulated
    process restart of the *reading* code path (i.e., a fresh read of the file), and disappears once all
    its ops are resolved.
  - `GET .../script-review/state` returns the right shape for: job running, ledger-only (no job), neither.
- **Client:**
  - `hideReview` never mutates `ops`/`unappliable`/`selected`; `discardReview` does and calls the server.
  - Badge count reflects per-chapter vs. whole-book scope correctly.
  - Re-run confirm dialog appears only when the target scope overlaps unresolved findings; "discard and
    start new" only clears in-scope chapters.
- **E2E (Playwright), regression-focused:**
  - Complete a review, click a nav tab (simulating the backdrop click-through), confirm findings are
    still present and reachable via the badge afterward — this is the direct regression test for the bug
    that motivated this spec.
  - Reload mid-review: progress UI resumes without user action.
  - Reload after a completed-but-unactioned review: findings and prior selection state are restored.

## 9. Follow-ups (not this spec)

- Surviving a full server restart mid-review (§3) — would need a new on-disk ledger of
  partially-emitted, sub-chapter progress; deferred until there's evidence it's worth the added
  complexity.
- Cross-tab live sync of findings/selection (§3).
- Revisiting the modal's z-index/layering for its own sake, independent of the data-loss concern this
  spec fixes.
