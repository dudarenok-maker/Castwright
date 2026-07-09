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
`res.on('close')` aborts it" to the same **sticky, detached-from-the-request** pattern `analysis.ts`
already uses for book analysis, including its split **main/subset registries** — `inFlightAnalysisByManuscript`
(whole-book) and `inFlightSubsetByManuscript` (chapter-scoped) — so a subset job can never be mistaken
for, or silently joined by, a whole-book request. This split is a mirror of `analysis.ts`; the
**cross-scope 409 below is not** — `analysis.ts` actually lets a main and a subset job run concurrently
for the same manuscript (it just has a tiebreak selector, `snapshotInFlightAnalysis`, for reporting status
when both are live) because two independent analyses don't conflict with each other's output. Script
review can't allow that: two concurrent jobs would both be checkpointing into the *same* per-chapter
ledger (§4.2), and an overlapping-chapter case has no obvious reconciliation rule the way "report whichever
analysis is more relevant" does for `analysis.ts`. So script review adds a stricter rule `analysis.ts`
doesn't need:

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
  - Today's `script-review.ts` has no registry at all (each request is independent and non-sticky), so
    there's no prior "one active review per book" behavior being preserved here — this is a new rule this
    spec introduces, justified by the shared-ledger conflict above, not a carryover from either the old
    script-review behavior or from `analysis.ts`.
- `res.on('close')` no longer aborts the controller — it only removes that one subscriber. The LLM work
  keeps running server-side even with zero clients attached.
- A reconnecting client (reload, or a second tab) attaches as a new subscriber to whichever map/entry
  matches its requested scope, and is replayed the buffered events before continuing to receive live
  ones, so it catches up instantly.
- If the server process itself restarts, both maps are gone and any in-flight job is genuinely lost (§3).
- **Deliberately no `fresh:true` displacement path.** `analysis.ts`'s POST is a three-way dispatch
  (join / abort-and-displace via `fresh:true` / create) because a user can legitimately want to force a
  brand-new analysis while one is running. Script review has no equivalent user-reachable need: the
  client-side gate (§6.4, case 1) already disables the button for a scope with a running job, so there is
  no path that would ever need to abort and replace an in-flight run. This is an intentional
  simplification, not a gap.

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

A JSON file in the book's workspace, `.script-review-pending.json`:

```
{
  "nextVersion": <integer>,
  "entries": {
    "<chapterId>": {
      "manuscriptId": "<id>",
      "version": <integer>,
      "ops": ReviewOp[],
      "selected": Record<opKey, boolean>,
      "completedAt": "<ISO timestamp>"
    },
    ...
  }
}
```

`selected` stores only **explicit user overrides**, not a fully-populated map — see the note on
`DEFAULT_OFF` below.

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
- **Each entry also carries `manuscriptId` and a `version` nonce.**
  - `manuscriptId`: the manuscript this entry's sentence ids belong to. If a book is reparsed
    (`manuscriptId` changes, sentences renumbered), an entry whose stored `manuscriptId` no longer matches
    the book's current one is dropped entirely on the next hydration — its ops reference ids that no
    longer exist, so there's nothing to recover, and without this check a fully-stale entry would never
    self-delete (its `ops` array isn't empty, it's just permanently unappliable) and would sit forever as
    a phantom badge count.
  - `version`: **must be unique across an entry's entire create/delete/re-create history, not just unique
    at a point in time** — a per-entry counter that resets to 1 on every re-creation would defeat the
    whole mechanism, since two incarnations of the same chapter's entry could easily mint the same value
    and a stale write from the first would then pass validation against the second. So `version` is drawn
    from a single **book-scoped monotonic counter** stored at the top level of the ledger file
    (`nextVersion` above, not inside any one entry) — every entry creation or re-creation reads and
    increments it under the same write queue (below) that guards every other mutation, so no two entries
    for the same book (across any chapter, across any re-creation) ever share a value. `/resolve` and the
    selection-sync `PATCH` (§5) must include the `version` they last saw; the server no-ops the call if it
    doesn't match the entry's *current* version. This is stronger than a bare existence check (§7's
    original "no-op if missing" rule): existence alone can't distinguish "this entry" from "a different
    entry that now happens to occupy the same chapter key" — e.g. discard-then-immediately-re-review the
    same chapter — which a bare existence check would let a stale in-flight write silently poison. The
    client learns an entry's current `version` the same way it learns everything else about the ledger:
    it's part of the entry shape returned by `GET .../script-review/state` (§4.3) and carried alongside
    `ops`/`selected` in `byBook[bookId]` (§6.1), and echoed back on every `/resolve`/`PATCH` call for that
    chapter.
  - **`selected` never needs a server-side default.** The fs-58 `DEFAULT_OFF` set
    (`reattribute`/`flag_nonstory` default unchecked, `script-review-slice.ts:64`) is a purely
    client-side, non-persisted display rule — it's computed at render/hydration time from `DEFAULT_OFF`
    plus whatever the `selected` map (explicit overrides only) contains, the same way `setReview` computes
    it live today. The server-written checkpoint never has to know `DEFAULT_OFF` or invent a default: a
    chapter checkpointed by a run with zero clients attached simply has an empty `selected` map (no
    overrides yet), and the client applies `DEFAULT_OFF` to it identically to a chapter that streamed in
    live. This closes the "what does the server write for `selected` at checkpoint time" gap without
    needing the server to duplicate a client-side constant.
- **Op-key collisions are a pre-existing constraint, now load-bearing.** `opKey`
  (`` `${chapterId}:${id}:${op}` ``, `script-review-slice.ts:29-31`) has no disambiguator beyond sentence
  id + op class, so two ops of the same class on the same sentence in one run already collide in today's
  client-only `selected` map. Persistence raises the stakes: `/resolve` now uses this key to mutate server
  state, so a collision would resolve/keep the wrong finding rather than just mis-render a checkbox. This
  spec doesn't change the key format or add analyzer-side uniqueness enforcement — it inherits the
  existing one-op-per-class-per-sentence-per-run invariant as-is; a violation of that invariant is a
  pre-existing analyzer-output bug outside this spec's scope.
- **Every mutation to a book's ledger file — all four of them — goes through one in-process per-book write
  queue**, keyed by `bookId`: the per-chapter completion upsert (during a run), the debounced
  selection-sync `PATCH`, `/resolve`, and `/discard` (§5). All four read-modify-write the same file, and
  they aren't mutually exclusive in time — e.g. a user can discard chapter 2's findings while chapters
  10–20 of the same whole-book run are still being checkpointed. Since all four originate from the same
  Node process, a simple async queue (not a cross-process file lock — nothing else writes this file) is
  enough to serialize them and avoid one write clobbering another. The `nextVersion` counter increment
  above rides through this same queue.

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
and re-runs `planApply` against the current live manuscript to derive `unappliable` for display — exactly
the computation that already happens when ops first arrive live, just re-run against whatever the
manuscript looks like now (see §4.2 on why this can't be a persisted, cached value). Any entry whose
`manuscriptId` doesn't match the book's current manuscript is dropped instead of being run through
`planApply` at all (§4.2).

**This `planApply` re-derivation must happen after *both* `manuscript.sentences` and the cast roster for
the book are loaded, not on a bare view-mount timer.** `planApply(ops, live, roster)` takes the cast
roster as a third argument and marks an on-roster `reattribute` op unappliable if its `characterId` isn't
in `roster` yet (`script-review-apply.ts`) — so sequencing only after manuscript sentences load half-fixes
the problem: an early re-derivation that races the *cast* load would still misclassify on-roster
reattribute ops as unappliable and undercount the badge, the same class of "did I lose my work?" false
negative this fix targets for sentences. The hydration thunk must therefore be sequenced to run after (or
re-run once) *both* the existing manuscript-load and cast-load thunks for that book resolve, not fired
independently from a `useEffect` on mount.

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
- `POST /api/books/:bookId/script-review/resolve` — new. Body: `{ chapterId, version, appliedOpKeys:
  string[] }`. Removes just those op keys from the chapter's ledger entry; deletes the entry once it's
  empty. No-ops if `version` doesn't match the entry's current version (§4.2). This is the "apply"
  counterpart to discard — without it the server has no way to learn an op was resolved, since applying
  is a purely client-side action (§4.2). Called once per synchronous apply batch, or per-op for the async
  off-roster `reattribute` path — see §6.5 for why that path can't use a single end-of-batch call.
- Selection-state sync rides on a debounced `PATCH`-style update to the ledger (exact wire shape is an
  implementation detail for the plan), body including the chapter's last-seen `version`. The server no-ops
  the update if `version` doesn't match current (§4.2) — this covers both a PATCH landing after a discard
  (no entry exists → no-op) and a PATCH landing after a discard-and-re-review of the same chapter (an
  entry exists again, but with a new `version` → no-op), which a bare existence check alone cannot tell
  apart (§7).

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

1. **A job is already running for this scope, or for a scope that conflicts with it** (§4.1 — a
   whole-book click while any single-chapter job is running for this book, or vice versa, in addition to
   the literal same-scope case) → no-op beyond showing the existing "Reviewing…" progress state (button
   stays disabled, same as today). Checking conflicts client-side too, not just relying on the server's
   409, means the UI never has to surface a raw rejection — the 409 (§4.1, §7) becomes a defensive
   backend-only backstop for a race between two near-simultaneous clicks (e.g. two tabs), not a state this
   click handler needs to render.
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

This is a deliberate behavior change from today: currently, both apply paths — `handleApply`
(`script-review-diff.tsx:349`) for the seven synchronous op classes, and `runProposed`'s success branch
(`:263`) for the async off-roster `reattribute` flow — call `clearReview` afterward, which discards the
*entire* bucket, including whatever the user left unchecked. Under persistence, silently discarding
unactioned findings on Apply would defeat the point of this feature, so both call sites are rescoped:

- **Synchronous op classes** (`strip_tag`, `split`, `extract_dialogue`, `merge`, `fix_emotion`,
  `validate_instruct`, `flag_nonstory`): dispatching the manual-edit reducers for the selected ops is a
  single synchronous action, so `/resolve` is called once, immediately after, with all of that batch's op
  keys.
- **Async off-roster `reattribute`** (`runProposed`, `script-review-diff.tsx:225-264`, backed by
  `applyProposedReattributions` in `apply-proposed.ts`): the confirm queue (`advanceConfirm`) only
  *collects* the user's per-op decisions; the actual `createCharacter`/`setSentenceCharacter` calls fire
  afterward in **one batch call** to `applyProposedReattributions`, which today returns only aggregate
  counts — there is no per-op success signal to hang a resolve call off, and a deduped-name op
  (`apply-proposed.ts`, the `if (!id)` branch) applies via `setSentenceCharacter` with **no create call at
  all**, so "resolve after the create call succeeds" wouldn't even fire for it. Calling `/resolve` once
  for the whole selected set (as if the batch were all-or-nothing) would let a mid-batch failure delete
  ledger entries for ops that were never actually applied — reintroducing the exact silent-loss failure
  this spec exists to eliminate. Closing this requires a small, scoped change to
  `applyProposedReattributions` itself: instead of (or in addition to) aggregate counts, it must report
  **which specific ops succeeded**, including deduped-name ones, as each is applied — not only ops that
  went through a `createCharacter` call — so the caller can call `/resolve` per op as that per-op result
  arrives, not once at the end. If the batch throws or partially fails, every op already reported
  succeeded stays resolved (correctly removed); anything not reported as succeeded is never resolved and
  remains in the ledger as still-unresolved, exactly as if it had never been attempted. **Retrying a
  batch that left some ops resolved and others not must not re-create characters for ops that already
  applied** — `applyProposedReattributions`' existing dedupe-by-proposed-name check (the same `if (!id)`
  branch) already prevents creating a second character for the same proposed name within a run; a retry
  after a partial resolve failure relies on that same check recognizing the character already exists
  rather than creating a duplicate, so only the previously-failed ops' `/resolve` calls need to actually
  go out again.
- **Cancelling the confirm queue mid-batch** (`cancelConfirm`, `:301-305`), or the batch's own
  book-switch guard returning `{aborted: true}` without throwing (`apply-proposed.ts`), no longer calls
  `clearReview`. Both dispatch `hideReview` only: whatever was already resolved before the cancel/abort
  stays resolved; the cancelled-and-remaining ops stay in the ledger as unresolved, consistent with the
  rest of this section.
- Ops the user left **unselected** in the first place are never touched by any of the above — they remain
  in the ledger as still-unresolved findings, and the badge (§6.3) reflects them on the next load/render.
- To clear unresolved leftovers (unselected, or left over from a cancelled batch), the user uses "Dismiss
  all" (§6.2, now an explicit discard) or applies them in a later pass.

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
- **A debounced selection PATCH lands after a discard-and-re-review of the same chapter:** an entry exists
  again by the time the stale PATCH arrives, so a bare existence check would incorrectly let it through
  and poison the new run with stale checkbox state. The `version` nonce (§4.2, §5) catches this case
  specifically — the stale PATCH's version won't match the new entry's version, so it still no-ops.
- **A whole-book POST while a same-book single-chapter job is running (or vice versa):** rejected with 409
  rather than silently joining mismatched-scope data (§4.1). The client-side gate (§6.4, case 1) already
  checks for this before ever sending the request, so the 409 in practice only fires on a genuine race
  (e.g. two tabs clicking within the same moment) — when it does, the client surfaces it as "a review is
  already running for [scope]; wait for it to finish."
- **A book is reparsed while a ledger has pending entries:** entries are scoped by `manuscriptId` (§4.2);
  on the next hydration, any entry whose `manuscriptId` doesn't match the book's current one is dropped
  outright rather than run through `planApply` (which would otherwise mark everything permanently
  unappliable and leave a zero-count phantom entry that never self-deletes).
- **Concurrent writes to the ledger file:** all four mutating paths (completion upsert, selection PATCH,
  `/resolve`, `/discard`) read-modify-write `.script-review-pending.json`; all four are serialized through
  the per-book in-process write queue (§4.2) so none clobbers another.
- **A `/resolve` call fails (network blip) after its op was already successfully applied client-side:**
  for the synchronous op classes this is harmless — the op reappears as unresolved on next load and
  re-applying a manual-edit reducer is idempotent (it just re-sets the same field). For the async
  off-roster `reattribute` path it's not automatically harmless, since re-applying means calling
  `api.createCharacter` again — but §6.5's retry behavior relies on `applyProposedReattributions`'
  existing dedupe-by-proposed-name check to recognize the character already exists and skip re-creating
  it, so only the failed `/resolve` call itself needs to be retried, not the character creation.
- **A whole-book review chapter spans multiple analyzer chunks** (`script-review.ts` emits ops per chunk,
  not once per chapter) **and one chunk fails while its siblings succeed:** the per-chapter ledger upsert
  accumulates whichever chunks' ops did land before checkpointing that chapter — a partially-failed
  chapter is checkpointed with whatever succeeded, not held back entirely, consistent with "a chapter's
  findings survive independently of chapters around it" (§2).

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
    a re-creation. A `PATCH` or `/resolve` call carrying a stale `version` (entry was discarded and a new
    review re-created it) is also a no-op, even though an entry now exists again — the version-mismatch
    case a bare existence check can't catch (§4.2, §7).
  - Concurrent writes across all four mutating paths (completion upsert, selection PATCH, `/resolve`,
    `/discard` — not just the first two) land correctly against each other — the per-book write queue
    (§4.2) serializes all of them.
  - `nextVersion` is a single book-scoped counter: discarding a chapter and immediately re-reviewing it
    produces a *new* entry whose `version` differs from the discarded one's, even though both used the
    same chapter key — proving the mint can't collide across an entry's create/delete/re-create history.
  - An entry whose `manuscriptId` doesn't match the book's current manuscript is dropped on read rather
    than surfaced (§4.2, §7).
  - `GET .../script-review/state` returns the right shape for: job running, ledger-only (no job), neither
    — and the ledger-only shape includes each entry's `version` and `manuscriptId`.
- **Client:**
  - `hideReview` never mutates `ops`/`selected`; `discardReview` does and calls the server.
  - On hydration from a persisted ledger, `unappliable` is (re-)computed via `planApply` against current
    manuscript state, not read from the ledger (there is nothing to read — §4.2) — and this recompute is
    proven to happen only after *both* `manuscript.sentences` and the cast roster for the book have loaded
    (a test that hydrates the ledger before either arrives must not show a false 0-count badge or
    misclassify an on-roster `reattribute` op as unappliable, per §4.3).
  - Badge count excludes ops `planApply` currently classifies as unappliable.
  - The click behavior in §6.4 (running-or-conflicting-scope → no-op progress; unresolved → confirm
    dialog; neither → start new) is covered for both single-chapter and whole-book scopes, including the
    cross-scope conflict case (whole-book click while a single-chapter job is running, and vice versa).
  - Applying selected ops from a synchronous op class calls `/resolve` once with exactly that batch's op
    keys; unselected ops remain in `byBook[bookId]` afterward (§6.5) — a regression test for the "Apply
    used to discard everything" behavior change.
  - Applying an off-roster `reattribute` batch that fails partway through calls `/resolve` per-op as each
    op is reported successful by `applyProposedReattributions` (including a deduped-name op that applies
    with no `createCharacter` call), not once at the end; ops after the failure point remain in the ledger
    as unresolved, and cancelling the confirm queue — or the batch's silent `{aborted: true}` book-switch
    guard — dispatches `hideReview`, not `discardReview` (§6.5).
  - Retrying a `reattribute` batch after a `/resolve` call failed post-apply does not create a duplicate
    character for an op that already succeeded — the existing dedupe-by-proposed-name check is exercised
    on retry, not bypassed (§7).
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
