# Mock-mode script-review dedup against a concurrent in-flight timeline

- **Issue:** [#1496](https://github.com/dudarenok-maker/Castwright/issues/1496)
  (fs-58 follow-up)
- **Date:** 2026-07-14
- **Status:** draft
- **Area:** frontend (mock API layer) — `area:fs`, `type:chore`
- **Scope:** mock/dev/e2e only; zero production impact.

## Problem

`src/views/manuscript.tsx`'s script-review hydration effect is deliberately
cleanup-free. Its comment credits "the sticky job registry (server Task 2)"
for making a duplicate in-flight POST from `attachToRunningReview` safe to
abandon — true for **real-backend** mode, where the server's job registry lets
a second POST *join* the existing job.

**Mock mode has no equivalent registry.** If the hydration effect re-fires for
the same `bookId` while a mock review is still running (the user navigates away
from Manuscript and quickly back before the ~1.5s canned timeline finishes),
`hydrateScriptReview` → `attachToRunningReview` → `mockAttachScriptReview`,
which only checks `state.running !== null` and — seeing it non-null — starts a
**second, independent `mockReviewScript` execution racing the first**. Both
writers hit the same `sessionStorage` key; both dispatch their own `setReview`
with the same hardcoded ops, so the progress pill can jump between two
percentages and the ledger snapshot reflects whichever writer finished last.

### Related bug (same root cause) — cancellation identity

Re-confirmed on #1494's review (round 5): `mockReviewScript`'s
`throwIfCancelled` is keyed only on the book-level `running !== null`
`sessionStorage` flag, with **no per-invocation identity**. A cancel can be
silently undone by an unrelated concurrent invocation for the same book: after
`mockCancelScriptReview` writes `running: null`, a still-alive
supposedly-cancelled timeline whose next `throwIfCancelled()` runs *after* a
fresh "Review Script" click (or attach) has re-written `running` non-null
wrongly concludes it was never cancelled and keeps running.

Both symptoms share one root cause: **multiple concurrent timelines with no
per-invocation identity, all sharing one `sessionStorage` key.**

## Impact

Mock / dev / e2e only. Production always talks to the real server, which is
already protected by its job registry. Affects local dev against
`VITE_USE_MOCKS` and is a latent flake source for any future Playwright spec
that navigates away and back to a book mid-review.

## The load-bearing constraint (from adversarial review)

`attachToRunningReview` (`src/store/script-review-thunk.ts:308-322`)
**deliberately does not seed `allOps`/`versionByChapter` from the GET/state
snapshot.** It relies on the join to *replay every already-emitted
`ops`/`checkpoint` event* through the same `onOps`/`onCheckpoint` callbacks —
that is how the real server's `attachSubscriber` behaves. On success it then
calls `setReview(allOps)`, which is a **per-chapter preserve-the-rest replace**
(`preserveUntouchedChapters` in `script-review-slice.ts`): the payload's
chapters are replaced wholesale, other chapters preserved.

**Consequence for the mock:** a joiner that receives only *future* events ends
up with an incomplete `allOps`, and its `setReview` then **replaces a chapter's
ops with a shorter list, dropping ops the original run already set.** Therefore
the mock join MUST replay the accumulated ops/checkpoints to the joiner, not
just forward future ones. This is what makes the fix correct independently of
the canned fixture's emit timing, and makes the dedup unit test meaningful
rather than self-certifying.

## Design

A module-level in-memory registry gives each live mock run a stable identity
(the entry object itself), an accumulator, and a subscriber list — so a
concurrent caller *joins* the single ongoing timeline (replaying what it
missed, then receiving live events) instead of starting a second one.

### Registry (module-level in `src/lib/api.ts`)

```ts
interface InFlightMockReview {
  subscribers: Set<ReviewScriptOpts>;   // every caller observing this run
  opsAccum: Record<number, ReviewOp[]>; // chapterId -> merged ops so far (replay + finalize)
  versionAccum: Record<number, number>; // chapterId -> latest checkpoint version
  promise: Promise<ReviewScriptResult>; // the single shared timeline
}
const inFlightMockReviews = new Map<string, InFlightMockReview>();
```

**Identity is the entry object reference** — no separate token needed. A run is
"still current" iff `inFlightMockReviews.get(bookId) === entry`. The registry
lives only within one JS context (cleared on reload), which is exactly right:
it governs *live* in-memory runs, while `sessionStorage` remains the durable
cross-reload snapshot. The mock ignores `chapterId` (see Scope boundary), so
there is exactly one logical review per book — matching
`mockGetScriptReviewState`'s one-element `running` array — and keying by
`bookId` alone is complete.

### `mockReviewScript` — thin dedup wrapper + timeline body

`mockReviewScript(bookId, opts)` becomes a wrapper.

**Join path** — an entry already exists:

```ts
const existing = inFlightMockReviews.get(bookId);
if (existing) {
  // Replay what this joiner missed, faithfully mirroring the server's
  // attachSubscriber replay (see "load-bearing constraint" above). NO await
  // between replay and subscribe, so no live emit can interleave and be missed.
  for (const [chIdStr, ops] of Object.entries(existing.opsAccum)) {
    opts.onOps?.({ chapterId: Number(chIdStr), ops });
  }
  for (const [chIdStr, version] of Object.entries(existing.versionAccum)) {
    opts.onCheckpoint?.({ chapterId: Number(chIdStr), version });
  }
  existing.subscribers.add(opts);
  try {
    return await existing.promise;
  } finally {
    existing.subscribers.delete(opts);
  }
}
```

Replaying the *accumulated* (`opsAccum`/`versionAccum`) state — rather than an
ordered event log — is faithful because the joiner only pushes ops into its own
`allOps` and takes the last version per chapter; the final accumulated state is
what `setReview` consumes. A joiner therefore ends with the **complete** op set
(replay of pre-join + live post-join), identical to the original caller's — so
the unavoidable double `setReview` (original's `runReviewScript.finally` and the
joiner's `hydrateScriptReview.finally`, both firing when the shared promise
settles) is an **idempotent replace of identical per-chapter sets**, not a
doubling.

**Start path** — no entry yet:

```ts
const entry: InFlightMockReview = {
  subscribers: new Set([opts]),
  opsAccum: {},
  versionAccum: {},
  // Placeholder, assigned on the very next line. Registering the entry BEFORE
  // starting the timeline lets the body reference `entry` for identity/accum;
  // the body never reads `entry.promise`, and the first `throwIfCancelled`
  // runs only after the first `await`, by which point this is assigned.
  promise: undefined as unknown as Promise<ReviewScriptResult>,
};
inFlightMockReviews.set(bookId, entry);            // register FIRST (no await before this)
entry.promise = runMockReviewTimeline(bookId, entry);
try {
  return await entry.promise;
} finally {
  // Evict only if still the current entry — a cancel (which evicts) followed by
  // a fresh run may have replaced us; never evict a successor.
  if (inFlightMockReviews.get(bookId) === entry) inFlightMockReviews.delete(bookId);
}
```

Registering **before** running (and with no `await` between `set()` and the
timeline call) is the correct, implementable order: the body's synchronous
prefix runs, yields at the first `await wait(60)`, and only *then* does the
first `throwIfCancelled` fire — with `entry` already registered, so it never
fires spuriously on startup.

### Timeline body — `runMockReviewTimeline(bookId, entry)`

Today's canned sequence with three changes:

1. **Accumulate into the entry.** `noteOps`/`noteCheckpoint` push into
   `entry.opsAccum` / `entry.versionAccum` (replacing the old function-local
   accumulators, which `finalize` now reads from the entry).
2. **Fan out to all live subscribers.** Each emit iterates the *live* set:
   `for (const s of entry.subscribers) s.onOps?.(evt)` (and the same for
   `onPhase` / `onCheckpoint` / `onHeartbeat`). Reading the set at emit time
   means a joiner added after replay receives every subsequent event.
   Heartbeats and phase are live-only (transient — not replayed on join), which
   matches the server: `attachToRunningReview` seeds the pill from the state
   snapshot's `lastPhase` and relies on the join only for ops/checkpoint replay.
3. **Entry-identity cancellation:**

   ```ts
   const throwIfCancelled = () => {
     if (inFlightMockReviews.get(bookId) !== entry) {
       throw new ReviewScriptError('Review cancelled.', 'cancelled');
     }
   };
   ```

`alreadyAt` (resume-from-progress) is still read from `sessionStorage` at the
top of the body; it only matters on the reload-fresh-start path (a joiner never
runs the body). The synchronous "mark active" `sessionStorage` write stays (for
reload/persistence and `mockGetScriptReviewState`), but its comment — which
today describes the *cancellation* race it once guarded — is updated to note
that cancellation is now entry-identity based and this write is
persistence-only.

### `mockCancelScriptReview` — evict the registry entry

```ts
export async function mockCancelScriptReview(bookId): Promise<CancelScriptReviewResult> {
  const state = readMockScriptReviewState(bookId);
  const cancelled = state.running !== null;   // durable liveness (survives reload; see note)
  inFlightMockReviews.delete(bookId);         // kill the live run via entry-identity mismatch
  writeMockScriptReviewState(bookId, { running: null, entries: state.entries });
  return { ok: true, cancelled };
}
```

After eviction the live timeline's next `throwIfCancelled` sees an
entry-identity mismatch (entry gone, or replaced by a fresh run's different
entry) and throws `'cancelled'` — **regardless of what any fresh click writes
to the `sessionStorage` `running` flag.** That closes the cancel-identity race.
Any awaiters (original + joiners) reject together at that next tick; because
`throwIfCancelled` runs first thing after each `await wait(...)`, no awaiter
hangs. `cancelled` intentionally reports the *durable* liveness
(`sessionStorage`), so a post-reload Cancel of a persisted-but-not-live run
still reports `true` (benign; the reattach then re-reads `running: null` and
falls back to the ledger).

### `mockAttachScriptReview` — unchanged

```ts
const state = readMockScriptReviewState(bookId);
if (!state.running) return null;
return mockReviewScript(bookId, opts);
```

The dedup now lives one layer down. A **concurrent same-context** attach joins
the in-flight run (with replay); a **post-reload** attach (registry empty,
`sessionStorage.running` set) starts the resume-from-`alreadyAt` timeline
exactly as today.

### `manuscript.tsx` comment

Extend the "safe to abandon" note (≈ lines 182–184): the cleanup-free effect is
now safe in **both** modes — real backend via the server job registry, mock via
the in-memory `inFlightMockReviews` registry. Comment-only; the effect's
behavior is unchanged.

### Deliberately unchanged (scope boundary)

- Real-backend path (`realReviewScript`, `realAttachScriptReview`) and the
  server job registry — already correct.
- `mockGetScriptReviewState`, `mockResolveScriptReviewOps`,
  `mockPatchScriptReviewSelection`, `mockDiscardScriptReview` — untouched.
- **The mock ignores `chapterId`** (it always runs the whole-book canned
  timeline), so per-chapter concurrent reviews of one book — which the real
  server and `mockGetScriptReviewState`'s `running` *array* support — are not
  modeled here; collapsing them to one book-level entry is strictly better than
  today's clobbering, not a regression.
- No new production surface; no OpenAPI change.

## Data flow — the two race scenarios, resolved

**Nav away + back mid-review (same context):**
1. Fresh click → start path → entry `E1` registered, runs the timeline.
2. Nav away + back → `mockAttachScriptReview` → `running` non-null →
   `mockReviewScript` → join path → replay `E1`'s accumulated ops/checkpoints
   to the joiner, then `E1.subscribers = {A, B}`. No second run.
3. Both `A` and `B` await `E1.promise`; `B` gets replay + live ticks; both
   finalize with the identical complete op set → idempotent. Pill never doubles.

**Cancel then fresh click (the comment's bug):**
1. `E1` running (subscribers `{A}` or `{A, B}`).
2. Cancel → evict `E1`, write `running: null`. `A`/`B` reject with `'cancelled'`
   at `E1`'s next tick (entry-identity mismatch).
3. Fresh click before that tick → registry empty → start `E2`, writes `running`
   non-null.
4. `E1`'s next `throwIfCancelled` compares against
   `inFlightMockReviews.get(bookId)` (now `E2` ≠ `E1`) → throws. `E1` dies;
   `E2` proceeds cleanly.

## Testing

Unit tests in `src/lib/api.test.ts` (primary net), driving the mock directly
with Vitest fake timers. **Test hygiene:** the module-level `inFlightMockReviews`
persists across cases in a file, so a `beforeEach` MUST reset it **in lockstep
with `sessionStorage`** — clearing one but not the other manufactures the
registry-empty + `sessionStorage`-running inconsistency the design assumes is
impossible in-context. `api.ts` exports a test-only
`__resetMockScriptReviewInFlight()` for this; the `beforeEach` calls it and
`sessionStorage.clear()`.

1. **Dedup + replay:** start `mockReviewScript(book)` (don't await), advance
   timers partway (past at least one checkpoint), then `mockAttachScriptReview(book)`
   mid-flight. Assert the attach caller's `onOps`/`onCheckpoint` received the
   **already-emitted** ops (replay), both promises resolve to the same result,
   and the finalized ledger reflects exactly one canned run (`totalOps === 5`,
   not doubled). This test is meaningful because replay makes it independent of
   where the joiner lands in the timeline. **Assert the replayed op _set_ /
   finalized ledger, NOT the order of `onOps` calls** — the join replays from
   the chapter-keyed `opsAccum`, and `Object.entries` iterates integer-like
   keys in ascending numeric order (ch1 before ch3), i.e. not emission order.
   Correctness is order-independent (`planApply` reorders by op type and the
   final accumulated state is what `setReview` consumes), so asserting call
   order would be brittle without testing anything real.
2. **Cancel-identity:** start a run, `mockCancelScriptReview`, then a fresh
   `mockReviewScript` before the old run's next tick. Assert the cancelled
   invocation rejects with `'cancelled'` and does **not** finalize the ledger,
   while the fresh run completes independently.
3. **Reload path intact:** empty registry + `sessionStorage.running` at 85% →
   `mockAttachScriptReview` resumes and completes (guards the behavior
   `e2e/script-review-persistence.spec.ts` depends on).

**E2E: intentionally skipped.** The trigger is a tight ~1.5s timing window; a
Playwright spec would be flake-prone for little marginal coverage over the unit
tests above, which exercise the mock's dedup/replay, cancel-identity, and
reload seams directly. (Recorded here per the testing-discipline "say so
explicitly" rule.)

## Review findings folded (assumption-checker, 2026-07-14)

- **Critical — missing replay:** join now replays accumulated ops/checkpoints
  (§load-bearing constraint) so the joiner's `setReview` can't drop the original
  run's ops; the design no longer depends on the fixture emitting all ops in one
  terminal block.
- **Critical — inverted init order:** register-before-run made explicit and
  implementable (placeholder `promise`, entry-reference identity), with the
  no-`await`-before-`set()` invariant stated.
- **Significant — test isolation:** exported `__resetMockScriptReviewInFlight()`
  + lockstep `beforeEach` reset with `sessionStorage`.
- **Significant — double `setReview`:** confirmed idempotent (per-chapter
  preserve-the-rest replace) *given* replay makes both op sets identical.
- **Clarified — one-review-per-book:** mock ignores `chapterId`; `bookId` keying
  is complete (Scope boundary).
- **Minor — stale comment / cancel liveness / microtask-gap:** the mark-active
  comment is updated; `cancelled` deliberately reads durable `sessionStorage`;
  all real callers are macrotasks so the settle→evict microtask drains before any
  new join.

## Ship notes

_(filled at ship time)_
