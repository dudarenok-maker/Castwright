---
status: stable
date: 2026-08-20
issue: 2515
---

# Wiring audio generation into the language guard (#2246 site 2)

Design of record for **#2515** — the decision request surfaced by the independent
review of PR #2492 (finding S5): should `server/src/routes/generation.ts`'s
audio-render path join the language-guard mechanism the rest of #2246 already
wires, or is a bare failure the accepted outcome there?

**Answer: wire it now (owner-confirmed, 2026-08-20).**

> **Revision history — three assumption-checker passes (Premium tier), each
> against the prior round's revision, each finding the prior fix correct
> where it looked and wrong about how far it reached:**
> - **Pass 1** (against the first draft): a concurrency fan-in bug, a
>   dispatcher state bug, a compile break, a contradiction with the parent
>   design doc.
> - **Pass 2** (against pass 1's fix): the fix was a no-op — the stream never
>   closes on an early bail-out, so nothing the fix wrote was ever read, and
>   a worker slot leaked permanently. Plus a streak-breaker interaction and a
>   suppression-set leak.
> - **Pass 3** (against pass 2's fix): the stream-closure fix named 5 of the
>   9 sites that actually share the no-`idle` shape, missed 3 existing tests
>   that hard-pin tick counts at the un-fixed sites, and — the deepest
>   finding — the real re-trigger risk once the stream *does* close isn't
>   reconnects (which pass 2's fix eliminated) but the dispatcher's own
>   refill loop, which claims the book's next queued chapter in the same
>   reconcile tick a failure is recorded in. The streak-breaker exemption
>   pass 2 added removed the only thing bounding that drain. Also: `onRetry`
>   calling `runner.open()` directly desyncs the dispatcher's own bookkeeping
>   when the established `retryQueueEntry` idiom already exists and doesn't;
>   the `FailureCode` addition touches 7 files, not 3, with an ordering
>   dependency; and a same-round self-contradiction (declared change item 12
>   would touch "the whole block" then verifiably fixed a third of it).
>
> All three rounds' findings are folded into this document, which reflects
> the final state — not a diff a reader needs to reconstruct. Full
> disposition tables are in "Assumption-checker passes" at the end.
> **A fourth blind pass was deliberately not run** — three rounds each
> finding real defects one level deeper than the last is a genuine signal
> of diminishing returns on solo review; the remaining surface is now well
> enough understood that implementation-time task review (per
> `subagent-driven-development`) is the right place to catch anything left,
> not another full adversarial pass on the document.

This document **amends the parent design doc's tier table**
(`docs/superpowers/specs/2026-08-13-language-recurrence-and-prompt-design.md:324-331`,
the `generation:796` row specifically at `:327`), which assigned generation
the same `{ type: 'error', code: 'language_unset' }` envelope as
`cast-design`/`single-design`/`qwen-voice`. That assignment is wrong for
generation specifically — see "Why generation doesn't get the shared
envelope" below.

## What's already built (verified against `feat/server-2246-language-recurrence`)

- `src/lib/language-guard-bus.ts` — `emitLanguageGuard(req)` (`:67-70`)
  routes a language-unset failure to the modal handler registered by
  `useLanguageGuard`; returns whether a handler accepted it (`false` when no
  handler is mounted, or the selector resolves no library book).
- `src/modals/edit-book-meta.tsx` — `EditBookMetaModal`'s guard mode
  (`LanguageGuardShape = '409' | 'sse' | 'batch'`, `:35-41`). The shape only
  selects copy — open/retry behaviour is identical across all three.
- **Eight** existing `emitLanguageGuard` call sites, by actual shape (the
  first two drafts each mis-stated part of this list): `shape: '409'` —
  `src/lib/api.ts:2126` (qwen voice-design), `:2861` (analysis,
  manuscript-scoped per the comment at `:2847`), `:5943` (chapter-splice),
  `:6032` (chapter-QA-repair); `shape: 'sse'` —
  `src/store/analysis-stream-middleware.ts:198`,
  `src/store/cast-design-stream-middleware.ts:165` (cast-design) and `:282`
  (single-design); `shape: 'batch'` — `src/store/script-review-thunk.ts:163`.
  **qwen voice-design is `'409'`, not `'sse'`** — it only ever emits a 409;
  a prior revision of this document put it in the `'sse'` list in error while
  correcting a different mistake in the same sentence.
- `server/src/routes/generation.ts:800-805` **already calls
  `requireBookStateLanguage(state)`** and bails on throw — Task 6 of the
  parent plan shipped this part. It sends `{ type: 'chapter_failed',
  errorReason }` with **no `errorCode`, no `chapterId`, and no `idle`
  follow-up**.
- **Nine** sites in `generation.ts` share that exact shape — one
  `chapter_failed` (or, at one, nothing) then `return res.end()` with no
  `idle`: `:732-736` (invalid modelKey), `:754` (provider selection),
  `:760` (book not found), `:769-775` (cast not confirmed), `:803`
  (language unset — this design's target), `:833` (sidecar language
  lookup), `:924` (further down the non-English branch), `:1002-1005` (no
  analysed sentences), `:1052-1059` (disk-full block). Note `:1052` already
  carries `errorCode: 'disk-full'` today — it is a bail-out **and** already
  taxonomy-classified, so it doesn't fit neatly into either "early bail-out"
  or "mid-loop classified failure" as separate buckets; both categories
  overlap here.
- `server/src/routes/generation.ts:1168-1171` — the existing
  zero-target-chapters early-out: `send({ type: 'idle' }); return res.end();`.
  This is the precedent the fix below extends to all nine bail-outs.
- **Three existing tests hard-pin a tick count of 1** at three of those nine
  sites and will need updating alongside the fix:
  `server/src/routes/generation.test.ts:510` (invalid modelKey, `:732`),
  `:539` (disk-full, `:1052`), `:1040` (no analysed sentences, `:1002`).
- `server/src/routes/failure-taxonomy.ts` (fs-19) — the `FailureCode` union +
  `classifyFailure`.
- `src/store/generation-stream-runner.ts:364-372` — the `chapterId != null`
  branch. Records `chapterFailures` **unconditionally** — but this write is
  never read for a stream whose handle never closes.
- `src/store/generation-stream-runner.ts:407-414` — the `chapterId == null`
  branch ("stream-level halt"), gated on `sliceMatchesHandle`. This is the
  branch every current bail-out (including language-unset today) hits.
- `src/store/generation-stream-runner.ts:472-476` — a handle is removed
  **only** on an `idle` tick. `close()` deletes the handle but does **not**
  touch `chapterFailures` (`:186-215`, documented there).
- `src/store/queue-dispatcher-middleware.ts:123` — reconcile STEP 1 only
  calls `takeChapterFailure` inside `if
  (!runner.hasOpenStreamForChapter(bookId, chapterId))` — only after the
  handle has closed.
- `src/store/queue-dispatcher-middleware.ts:216-260` — reconcile STEP 2, in
  the **same tick**: `slots = workers - inFlight.size`, then a `for` loop
  over `queue.entries` claiming the next `status: 'queued'` entries up to
  `slots`, calling `runner.open(...)` for each. A slot freed by STEP 1
  in this tick is refillable by STEP 2 in the same tick, for **any** queued
  entry of the book, not just siblings already in flight when the guard
  opened.
- `src/store/queue-dispatcher-middleware.ts:158-190` — the srv-11 streak
  breaker. Three consecutive **identical** failure reasons for a book trip
  `setQueuePaused(true)` **globally**. `voice-not-designed` is exempt
  (`:164`), with a stated rationale: a deterministic per-book issue, not the
  systemic signal the breaker exists to catch.
- `src/store/queue-thunks.ts:260-269` — `retryQueueEntry(entryId)`, the
  established retry idiom: `POST /api/queue/:entryId/retry`, dispatches the
  returned snapshot. The dispatcher's normal reconcile then re-claims it
  through the ordinary STEP 2 path above — no direct `runner.open()` call
  needed or wanted from calling code.
- `src/modals/queue-modal.tsx:576-589` — the queue UI's per-entry Retry
  action, gated `!isInFlight && entry.status === 'failed'`, wired to
  `retryQueueEntry`.
- `runner.open` has exactly one production caller,
  `queue-dispatcher-middleware.ts:255`, always with `spec.chapterIds`
  containing the single chapter that worker slot owns. `DEFAULT_WORKERS = 2`
  (`:65`, user-raisable), so an unset-language book opens **N concurrent**
  chapter streams that all fail the same way, before any drain even starts.
- `src/lib/api.ts:5784` (`RECONNECT_MAX_ATTEMPTS = 5`) reconnects any stream
  that saw a tick but no `idle` — every one of the nine sites today.
- `src/hooks/use-language-guard.tsx` holds **one app-wide `pending` slot**. A
  second `emitLanguageGuard` call while one is pending overwrites it,
  dropping the first caller's callbacks.
- `src/store/generation-stream-runner.ts:72` — `IMMEDIATE_TOAST_ERROR_CODES`,
  the existing per-code immediate-toast set (`voice-not-designed`,
  `cloned-voice-broken`), dispatched at `:395-406` unconditionally on those
  codes. Does not currently include `language-unset`.
- `src/data/help-categories.ts:9` — the Help category list already includes
  `{ id: 'voices', label: 'Voices & languages' }` — an existing category
  literally about languages, not a category to be introduced.
- `src/data/help-failures.ts:54,79` — two exhaustive compile-time pins
  (`CATEGORIES`/`TITLES` `satisfies Record<FailureCode, …>`), typed off
  `components['schemas']['FailureCode']` (`:13`) — i.e. **generated from
  `openapi.yaml`**, not from `failure-taxonomy.ts` directly. This is an
  ordering dependency: `openapi.yaml` must be edited and
  `api-types.ts` regenerated **before** `help-failures.ts` can type-check
  against the new member.
- `server/src/routes/failure-taxonomy.test.ts:400-425` — a **separate**
  hard-coded literal array asserting `Object.keys(FAILURE_REMEDIATIONS)`
  against 22 named strings. A new `FailureCode` needs a matching edit here
  too — a file the first two drafts never named.
- `src/data/help-failures.test.ts:13` (`HELP_FAILURE_ENTRIES.length` = 22)
  and `src/data/help-categories.test.ts:24` (combined total = 48, including
  in its own test-title string) — two more hard-coded counts.
- **The full file list for adding one `FailureCode` member is seven**:
  `openapi.yaml` (source of truth, edit first), `src/lib/api-types.ts`
  (regenerated), `server/src/routes/failure-taxonomy.ts`,
  `server/src/routes/failure-remediations.ts`,
  `server/src/routes/failure-taxonomy.test.ts`, `src/data/help-failures.ts`,
  `src/data/help-failures.test.ts`, `src/data/help-categories.test.ts` — eight
  files, corrected count (a prior revision said three, then found four more
  and said seven without re-adding the one it had already found; the true
  total folding every round's finding is eight).

## The stream never closes — the defect that made the pass-1 fix a no-op

Pass 1's fix (attach `chapterId` so the tick routes through the unconditional
`:364-372` branch) writes `chapterFailures` correctly, but nothing ever reads
it, because `takeChapterFailure` is only consulted once the stream's handle
closes, and a handle only closes on `idle`. None of the nine early bail-outs
sends one. So today, independent of this design:

1. The dispatcher never reconciles the entry.
2. The client reconnects (`sawAnyTick && !sawIdle`) up to 5 more times,
   identically, because the failure is deterministic.
3. After the 5th attempt the reconnect loop stops silently. The handle is
   never removed. The entry stays counted `inFlight` forever. With
   `DEFAULT_WORKERS = 2`, two simultaneously-failing chapters (of the same
   or different books) wedge the entire queue until the page reloads.

**Fix, folded into this design per the owner's 2026-08-20 decision:** at all
nine early-bail-out sites (`:732`, `:754`, `:760`, `:769`, `:803`, `:833`,
`:924`, `:1002`, `:1052`), send `{ type: 'idle' }` immediately before `return
res.end()` — the identical idiom already used at `:1168-1171`. Update the
three tests that hard-pin a 1-tick count at three of those sites to expect
the added `idle`. This is one mechanical change repeated nine times, not
nine separate designs, and it closes the reconnect-churn scope of #2516 for
the entire family (comment posted there 2026-08-20 narrowing its remaining
scope to mid-loop failures that are not also early bail-outs).

## Why generation doesn't get the shared `type:'error'` envelope

`cast-design`/`single-design`/`qwen-voice` are each a single request-scoped
stream with no per-item failure taxonomy, so a bare `{type:'error', code}`
is their only failure shape. Generation already has a richer one —
`chapter_failed` + `errorCode` (fs-19) — used by fifteen other failure
classes, with its own remediation copy, Help-page entries, and queue
integration. Change item 13 corrects the parent doc's tier table to say so.

## The streak breaker, and what actually bounds the drain

Once the stream-closure fix lands, every unset-language chapter of the same
book reaches the dispatcher with the identical error reason. Three
consecutive hits would trip the global pause. **Owner-confirmed: `language-unset`
joins `voice-not-designed`'s exemption** (`:164`) — same rationale, a
deterministic per-book configuration gap, not a systemic signal.

**That exemption alone removes the only thing bounding how far the
dispatcher drains a book once chapters start failing** — STEP 2 refills a
freed slot with the book's next queued chapter in the same reconcile tick
(`:216-260`), so without a bound, every remaining queued chapter of the book
fails in sequence before the user can act, and (per the fan-in section below)
each failure would re-open the guard the user just dismissed.

**Owner-confirmed fix: gate dispatch on the pending guard.** The runner
exposes one more query method on the existing `StreamRunner` interface —
`hasPendingLanguageGuard(bookId: string): boolean` — reading the same
per-book `Set` the fan-in fix below already maintains. The dispatcher's STEP
2 claim loop (`:219-224`) gains one more skip condition alongside its
existing four (`e.status !== 'queued'`, `inFlight.has`, `completed.has`,
`runner.hasOpenStreamForChapter`):

```ts
if (runner.hasPendingLanguageGuard(e.bookId)) continue;
```

This bounds the drain to at most `DEFAULT_WORKERS` chapters — the ones
already claimed and in flight when the first failure opened the guard — not
the whole book. Once the guard resolves (`onRetry`) or is dismissed
(`onDismiss`), the book leaves the pending set and normal claiming resumes.

**Residual, named rather than silently accepted:** because `onDismiss`
clears the pending set (unchanged from the fan-in design below), a user who
repeatedly dismisses without setting the language will see the guard re-open
once per remaining chapter, one at a time, as the dispatcher resumes
claiming and each newly-claimed chapter fails again — bounded and
one-at-a-time rather than an unbounded silent drain, but still a repeat
prompt. The alternative (suppress-until-the-language-actually-changes,
regardless of dismiss) was considered and not chosen — the owner's decision
was to bound via dispatch gating, which keeps `onDismiss`'s existing
"toast and move on" semantics intact rather than introducing a new
suppressed-book state that outlives the modal.

## The fan-in problem, and where the fix lives

With reconnects eliminated by the stream-closure fix, the fan-in that
remains is `DEFAULT_WORKERS` concurrent chapter streams of the same book
independently hitting the guard at roughly the same time — smaller than the
"N × 5" shape earlier drafts had to defend against, but still real against
`use-language-guard.tsx`'s single app-wide `pending` slot.

**Resolved here, not an owner decision.** The fix lives in
`generation-stream-runner.ts`, not the shared `language-guard-bus.ts` /
`use-language-guard.tsx` host — none of the other eight call sites has this
shape.

Mechanism: a `Set<string>` of book ids with an unresolved language guard,
local to `createStreamRunner`'s closure. Doubles as the dispatch-gate's data
source (`hasPendingLanguageGuard` above reads the same set).

- On a `chapter_failed` tick with `errorCode === 'language-unset'` and
  `chapterId != null`: record the chapter failure as today. If the book is
  **not** already in the set, call `emitLanguageGuard` for this one stream —
  mirroring `cast-design-stream-middleware.ts:161-169`, including its
  `onDismiss` fallback. **Add the book to the set only if `emitLanguageGuard`
  returns `true`.** If it returns `false` (no handler mounted, or the
  selector doesn't resolve), do **not** add the book to the set — instead,
  dispatch the same toast `IMMEDIATE_TOAST_ERROR_CODES` already produces for
  `voice-not-designed`/`cloned-voice-broken`
  (`generation-stream-runner.ts:395-406`) by adding `'language-unset'` to
  that set. This makes the fallback concrete instead of an unspecified "the
  existing toast" — a gap the second draft left open.
- If the book **is** already pending: do nothing further this tick — the
  chapter is still correctly recorded `failed` in the queue.
- `onRetry`: remove the book from the set (this alone lifts the dispatch
  gate above), dispatch `chaptersActions.clearLastError()` (defensive — see
  the replay-hazard section), then call `retryQueueEntry(capturedOpts.queueEntryId)`
  for the entry that opened the guard — **not** `runner.open()` directly.
  The dispatcher's own normal reconcile re-claims it through the ordinary
  STEP 2 path; nothing needs to duplicate that logic in the runner. The
  other chapters already in flight when the guard opened, if they also
  failed, are already `failed` queue entries with their own existing
  per-entry Retry.
- `onDismiss`: remove the book from the set and fall back to the same toast
  as the rejected-guard case above.

Per-book (not per-stream) is the right unit — the underlying cause is a
book-level fact. Known, unfixed-here gap: the `pending` slot itself is still
app-wide, so two *different* books failing at overlapping times can still
collide — pre-existing to the shared host, not introduced or worsened here.

## The replay hazard, resolved by not replaying

The second draft solved `onRetry` by capturing `spec`/`opts` on `OpenHandle`
so it could call `runner.open()` again directly. That call bypasses the
dispatcher's own `inFlight`/`completed` bookkeeping: STEP 1 has already run
`inFlight.delete(entryId)` and completed the entry as `failed` by the time
`onRetry` fires, so a direct re-open creates a stream the dispatcher doesn't
know about — `inFlight.size` under-counts (STEP 2 can over-subscribe past
`workers`), and when that stream eventually closes, STEP 1's `inFlight`
iteration finds no matching entry, so nothing ever marks the queue entry
complete — a chapter that rendered successfully leaves a stale `failed` row
behind.

**Fixed by using `retryQueueEntry(entryId)` instead** (see "The fan-in
problem" above) — the entry only needs `queueEntryId`, already threaded onto
`OpenHandle` via `opts.queueEntryId`. This makes the `OpenHandle`
`spec`/`opts`-capture change unnecessary for retry specifically; it is kept
only for `queueEntryId`, the one field `onRetry` actually needs. `state.lastError`
is not set by this failure once `chapterId` is attached (verified:
`chapters-slice.ts:438-450`'s `lastError` assignment sits only inside the
`ev.chapterId == null` branch) — the `clearLastError()` dispatch is a
defensive no-op for this path, kept because it costs nothing and guards the
legacy no-`chapterId` open path (out of scope here) against the same
hazard.

## The change

### Server

1. **`generation.ts`** — at all nine early bail-out sites (`:732`, `:754`,
   `:760`, `:769`, `:803`, `:833`, `:924`, `:1002`, `:1052`), send `{ type:
   'idle' }` immediately before `return res.end()`.
2. **`generation.test.ts`** — update the three tests that assert a 1-tick
   count at three of those sites (`:510`, `:539`, `:1040`) to expect the
   added `idle`.
3. **`generation.ts:800-805`** — on the `requireBookStateLanguage` throw:
   send `errorCode: 'language-unset'` always, and `chapterId:
   requestedIds[0]` when `requestedIds` (`:741-743`) has exactly one
   element (the queue-dispatched path). The legacy/back-compat multi-chapter
   or no-id open still omits `chapterId` — pre-existing gap shared by every
   sibling bail-out, out of scope here.
4. **`openapi.yaml`** — add `'language-unset'` to the `FailureCode` enum.
   Land this first — `help-failures.ts` types off the generated
   `api-types.ts`, not off `failure-taxonomy.ts`.
5. **`src/lib/api-types.ts`** — regenerate (`npm run openapi:types`).
6. **`failure-taxonomy.ts`** — add `'language-unset'` to the `FailureCode`
   union. Kebab-case, matching every existing member; the `'language_unset'`
   snake_case wire marker the four `'409'`/`'sse'`-shape sites match lives in
   a separate mechanism (`isLanguageUnsetBody`, HTTP-body-only, never
   inspects an SSE tick) that doesn't collide with it.
7. **`failure-remediations.ts`** — copy for the new key: *"This book's
   language has not been set. Choose it in Book settings before
   continuing."*
8. **`failure-taxonomy.test.ts:400-425`** — add `'language-unset'` to the
   hard-coded `FAILURE_REMEDIATIONS` key list.
9. **`src/data/help-failures.ts`** — add `'language-unset'` to `CATEGORIES`
   (**`'voices'`** — the existing "Voices & languages" category, not a new
   one) and `TITLES`.
10. **`src/data/help-failures.test.ts`** and **`src/data/help-categories.test.ts`**
    — bump the hard-coded counts (22 and 48, including the count embedded in
    the latter's test-title string) by one each.
11. **`queue-dispatcher-middleware.ts:164`** — widen the streak-breaker
    exemption: `if (failure.errorCode !== 'voice-not-designed' &&
    failure.errorCode !== 'language-unset') { … }`.
12. **`queue-dispatcher-middleware.ts:219-224`** — add the dispatch gate:
    `if (runner.hasPendingLanguageGuard(e.bookId)) continue;` alongside the
    existing four skip conditions.
13. **`generation-stream-runner.ts`** — add `hasPendingLanguageGuard(bookId):
    boolean` to the `StreamRunner` interface and its implementation, reading
    the fan-in fix's per-book `Set`.
14. **Android companion — verified, not assumed.** `grep -r
    "errorCode\|FailureCode\|chapter_failed" apps/android/lib` returns zero
    hits: the companion doesn't parse this surface, so an enum addition
    carries no risk for it specifically.

### Frontend

15. **`generation-stream-runner.ts`** — in the `chapterId != null` branch
    (`:364-372`): after recording the chapter failure, if `ev.errorCode ===
    'language-unset'`, run the fan-in logic above.
16. **`IMMEDIATE_TOAST_ERROR_CODES`** (`generation-stream-runner.ts:72`) —
    add `'language-unset'`, used only via the explicit fallback dispatch in
    the fan-in logic's rejected-guard/dismiss paths, not as an unconditional
    toast alongside a successfully-opened modal.
17. **`OpenHandle`** — add `opts.queueEntryId` (only field actually needed;
    see "The replay hazard, resolved by not replaying").
18. **`src/modals/edit-book-meta.tsx:35-41`** — fix the shape doc comment.
    Correct sets, verified above: `'409'` = qwen-voice, analysis, splice,
    QA-repair; `'sse'` = analysis, cast-design, single-design, **and now
    generation** (with generation's actual envelope named —
    `chapter_failed` + `errorCode: 'language-unset'`, not the shared
    `type:'error'` shape the other three `'sse'` sites use). The comment
    previously omitted analysis from both lists, included `cast-merge`
    (which has no emit site at all), and put qwen-voice under `'sse'`
    instead of `'409'` — fixed as one edit, not partially.
19. **Parent design doc**
    (`docs/superpowers/specs/2026-08-13-…-design.md:327`) — correct the
    `generation:796` tier-table row to point at this document.
20. **Issue #2516** — already updated 2026-08-20 to narrow its scope to
    mid-loop, non-bail-out `errorCode`-bearing failures now that change item
    1 resolves the early-bail-out case.

## Non-goals

- No new SSE event type — reuses `chapter_failed`.
- No mid-render resume mechanism — `requireBookStateLanguage` fires before
  the per-chapter loop starts.
- No bulk-replay logic for sibling failed chapters beyond the one
  `retryQueueEntry` call in `onRetry` — the queue's existing per-entry Retry
  covers the rest.
- No Book Settings language-editing UI work — already built.
- No fix to the cross-book collision on the shared app-wide `pending` slot —
  pre-existing to the shared guard host, affecting all eight existing sites
  equally, not introduced or worsened here.
- No change to `onDismiss` beyond what's specified — a repeatedly-dismissing
  user sees a bounded, one-at-a-time re-prompt (see "The streak breaker"),
  accepted as the cost of the owner's chosen bound (dispatch-gating over a
  suppress-until-resolved model).
- No fix to mid-loop reconnect policy for other `errorCode`s — narrowed
  remaining scope of #2516.

## Acceptance and coverage

- **Server test**: an unset-language generation request with a single
  requested chapter emits `errorCode: 'language-unset'` and `chapterId` on
  the `chapter_failed` tick, followed by `idle`. The legacy no-id path omits
  `chapterId` but still sends `idle`. A book **with** a language is
  unaffected.
- **Server test — all nine sites**: each of the nine bail-outs now ends with
  an `idle` tick; the three existing tick-count tests updated accordingly.
- **Server test — streak breaker**: three consecutive language-unset
  failures for the same book do not trip `setQueuePaused`.
- **Frontend test — stream closes**: language-unset tick + `idle` removes
  the handle; no reconnect attempt occurs.
- **Frontend test — dispatcher state**: the affected queue entry reaches
  `status: 'failed'` and is retryable from the queue UI.
- **Frontend test — drain bound**: with a pending guard on a book, the
  dispatcher's STEP 2 does not claim further queued entries of that book
  until the guard resolves or is dismissed.
- **Frontend test — dominant path**: a language-unset tick for a
  non-viewed book still opens the guard.
- **Frontend test — fan-in**: two concurrent chapter streams of the same
  book failing with `language-unset` produce exactly one `emitLanguageGuard`
  call; the second stream's failure still lands in the queue as `failed`.
- **Frontend test — rejected guard**: `emitLanguageGuard` returning `false`
  dispatches the fallback toast and does not add the book to the pending
  set.
- **Frontend test — retry**: guard save → `onRetry` clears the pending set,
  dispatches `clearLastError`, calls `retryQueueEntry` with the captured
  `queueEntryId` — not a direct `runner.open()`.
- **`failure-taxonomy.test.ts`**, **`help-failures.test.ts`**,
  **`help-categories.test.ts`**: updated literal/count assertions.
- **e2e**: out of scope, consistent with `cast-design`'s own SSE guard
  wiring.
- **Release notes**: both files, per CLAUDE.md step 5.

## Ship notes

Shipped 2026-08-22 on branch `feat/server-2246-language-recurrence`, HEAD `594d7d28`.

## Assumption-checker passes

**Pass 1** — three CRITICAL, six SIGNIFICANT against the first draft: the
`chapterId == null` branch's viewed-book gate, the dispatcher done-pruning a
null-`chapterId` failure as success, the `help-failures.ts` compile break,
the fan-in bug, the stale `edit-book-meta.tsx` non-goal, the undercounted
site list, the weak Android-compat reasoning, the `OpenHandle` replay
hazards, and a line-number citation error. All accepted; folded into pass 1's
revision.

**Pass 2** — three CRITICAL, three SIGNIFICANT against pass 1's revision:
the stream-closure defect that made pass 1's fix unobservable (root-caused
to no site sending `idle`), the streak-breaker pause risk, the
suppression-set leak on a rejected `emitLanguageGuard` call, an
`onDismiss`-during-reconnect hazard (resolved as a side effect of the
closure fix), the `help-failures.ts` file-count undercount, and two citation
errors pass 1's own revision introduced (`#2521` vs `#2516`, a wrong parent-
doc line range) plus a stray thinking artifact. All accepted; folded into
pass 2's revision, including two owner decisions: fold the stream-closure
fix in for all named bail-outs, and exempt `language-unset` from the streak
breaker.

**Pass 3** — against pass 2's revision:

| # | Finding | Disposition |
|---|---|---|
| 1 | "All five" bail-out sites was six named, five counted, and 4 of the real 9 sites were left unfixed, with 3 existing tests hard-pinning tick counts at three of them | **ACCEPTED.** All nine now named; three tests added to the change list |
| 2 | The real re-trigger source once reconnects are gone is the dispatcher's own same-tick refill (STEP 2), not reconnects — the streak-breaker exemption removed the only bound on it, and an unset-language book would drain its full remaining queue | **ACCEPTED — owner decision: gate dispatch on the pending guard.** New `hasPendingLanguageGuard` query + STEP 2 skip condition |
| 3 | `onRetry` calling `runner.open()` directly desyncs the dispatcher's `inFlight`/`completed` bookkeeping; the established `retryQueueEntry` idiom exists and wasn't used | **ACCEPTED.** Retry now goes through `retryQueueEntry`; `OpenHandle` only needs `queueEntryId` captured, not full `spec`/`opts` |
| 4 | `FailureCode` addition touches 7 files not 3 (missed `failure-taxonomy.test.ts`'s literal array), with an unstated ordering dependency (`openapi.yaml` must land before `help-failures.ts` type-checks) | **ACCEPTED.** File list restated (eight total, folding every round's finds) with ordering stated |
| 5 | The rejected-`emitLanguageGuard` fallback "the same toast" was never specified — `language-unset` isn't in `IMMEDIATE_TOAST_ERROR_CODES` and the reachable branch was gone once `chapterId` is attached, so the actual result was silence | **ACCEPTED.** A `fallbackToast()` closure dispatches the message "This book's language has not been set" in the `onDismiss` callback and when `emitLanguageGuard` returns `false`; `IMMEDIATE_TOAST_ERROR_CODES` remains unchanged |
| 6 | `'setup'` category claimed "closest fit" when `'voices'` ("Voices & languages") already exists and fits better | **ACCEPTED.** Category changed to `'voices'` |
| 7 | Change item 12 (`edit-book-meta.tsx` comment fix) declared "the same block, not half of it" then verifiably fixed roughly a third — both the `'409'` and `'sse'` lists were wrong in multiple ways (omitted analysis from both, listed a non-existent `cast-merge` site, misplaced qwen-voice) | **ACCEPTED.** Both lists corrected against a fresh grep of all eight `emitLanguageGuard` call sites |
| 8 | Minor citation drift (`language-guard-bus.ts:68-71` vs actual `:67-70`; `edit-book-meta.tsx:34-41` vs actual `:35-41`) | **ACCEPTED.** Corrected |

**Confirmed clean by pass 3, not re-litigated**: the `idle`-emission
mechanics (same `send` closure, same response state, no per-site
difference); the full `chapter_failed` → `idle` → `close()` →
`clearActiveStream` → dispatcher-reads-`chapterFailures` chain, traced
end-to-end against source; the streak-breaker exemption's line reference and
type-compatibility (given the ordering dependency in finding 4); the "one
production caller of `runner.open`" claim.

**Not accepted, any pass:** none.
