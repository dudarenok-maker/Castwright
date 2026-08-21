---
status: superseded
---

> **SUPERSEDED — this is mechanism #1 of a family already tried and rejected.**
> Written without first reading #2006's own comment history, which records
> "Four mechanisms designed, four failures" — this design is a re-derivation of
> failure #1 ("fold into the lock / re-validate inside the write's scope"),
> already rejected specifically for `voices.ts`'s cross-book veto, and it does
> not address the reason the *best* of the four (a sha256 fingerprint) died:
> `ensureCharacterVoiceUuid` writes cast.json **between** the clone-consent
> gates' read and their guarded write, in both detached-job paths, with zero
> concurrency required. Also scoped to 4 of the real 5 sites — `cast-link-prior.ts`
> and the `voice-override-linked.ts`/`cast-series-patch.ts`/`cast-add-from-roster.ts`
> trio are missing. See #2006's comment thread and
> `docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` §7/§12.2/§13
> for the full prior-attempt record. Kept here, not deleted, as a record of the
> fifth failed attempt for whoever reads this next.

# Clone-consent gates: write-time refusal (closes #2006 / srv-81)

## Problem

Three clone-consent gates read cast.json, decide a refusal, and then write in
a **different scope** — after GPU work, after `res.flushHeaders()`, or after
walking to a different book — than the scope the decision was made in. A
concurrent write landing in that gap makes the decision stale, and the guard
silently passes: a character gets retargeted off a consented cloned voice
(a real person's voice) with its marker intact but its resolution muted.

| Gate | Reads / decides | Writes |
|---|---|---|
| `voices.ts` `PUT /:voiceId/override` | `hasClonedSlotAmongMatches` (`:615-645`), an unlocked cross-book workspace/series walk, before any write | `applyOverrideToCastFiles` → `forEachMatchingCastCharacter` (`:779-940`), per book inside its own `withCastLock` |
| `single-design.ts` `POST /:bookId/cast/:characterId/design-voice/stream` | `characterHasClonedSlot(character)` (`:273`), before the SSE stream starts, before GPU work | `applyOverrideToCastFiles` (`:179`) inside `runSingleDesign`, detached after `res.flushHeaders()` and after GPU work completes |
| `qwen-voice.ts` `POST /:bookId/cast/:characterId/design-voice` (variant) | `characterHasClonedSlot(character)` (`:600`), before GPU work | `persistEmotionVariant` (`:671` / `:144-209`), after GPU work; own-book branch is still pre-response, series-propagation branch touches other books entirely |
| `cast-design.ts` bulk "Design full cast" job | `characterHasClonedSlot(character)` (`:402`, `:430`), re-checked fresh each loop iteration, before that character's GPU work | same write primitives as above, after that character's GPU work, inside the same detached SSE job |

`cast-design.ts` was not named in the original issue but carries the identical
shape (found while reading the code for this design) — its own comment at
`:387-401` already states the applicable policy in miniature ("skip this
character and report it — refusing the whole sweep would let one cloned
character block designing the rest") and is folded into this design rather
than filed as a separate issue, since it's the same defect at the same root
cause.

## Why the existing per-book lock (#2000/#2118) doesn't already cover this

`forEachMatchingCastCharacter` already takes each book's `withCastLock`
individually and reads cast.json fresh **inside** that lock (`:779-825`) — the
per-book read-modify-write is race-free. What's stale is the *decision to
write at all*: the workspace-wide veto scan and the pre-GPU-work check both
run **outside and before** any lock, so a clone that appears after the check
but before the (possibly much later) write is invisible to it. This is not a
locking gap — #2000 §3.2 correctly rejected workspace-scoped lock acquisition,
and nothing here reopens that. It's a **validation-staleness** gap: the check
and the write are correct in isolation but not re-synchronized with each
other.

## Design

### Mechanism

Every write site that persists a voice override or emotion-variant slot gains
a **second clone-safety check, re-run at write time, inside the same per-book
lock the write already takes**, reading the just-locked, fresh cast.json.

- The existing upfront checks (`hasClonedSlotAmongMatches`,
  `characterHasClonedSlot` before GPU work) are **unchanged** — they remain a
  fast-path that fails before wasting GPU work in the common case.
- The **write-time check is the new authoritative one**. Whatever the upfront
  check decided, the write-time check is what actually gates the write.
- No new lock, no rollback, no workspace-wide acquisition. Each book's
  read-decide-write stays exactly one lock span, matching the existing
  same-engine check already living inside `forEachMatchingCastCharacter`'s
  mutate step (`voices.ts:927`), which is precedent for this exact pattern —
  this design generalises it from "same engine only" to "any clone-capable
  engine other than the one being written."

### Refusal semantics, per unit of work

Refusal is never "abort an in-flight multi-book operation" and never "silently
mute a clone." It is scoped to the smallest unit that can still refuse
honestly:

1. **The request's own/primary book, response not yet sent** — `voices.ts`
   single-book case, `qwen-voice.ts`'s own-book (non-series) write. Refuse
   with the existing 409, potentially thrown *after* GPU work completed for
   the qwen-voice.ts case (see "Accepted trade-off" below).
2. **A fan-out write to another book in the same request** — `voices.ts`
   workspace/series scope, `qwen-voice.ts`'s series-propagation branch of
   `persistEmotionVariant`. Skip that book, keep going, report which books
   were skipped. The response body gains a `skipped: string[]` field
   (book dirs) alongside the existing `updates`/success count. This is a
   **new response shape** for both routes — additive, not a breaking change
   to the success path when nothing is skipped (`skipped: []`).
3. **A detached SSE job** — `single-design.ts`'s stream,
   `cast-design.ts`'s bulk job. Emit `type: 'character_skipped', reason:
   'already_cloned'` (the event `cast-design.ts` already uses at `:405-410`
   for the pre-GPU-work case — reused verbatim, not a new event type) instead
   of the success event (`designed` / `character_designed` /
   `variant_designed`).

Because a fan-out or bulk-job skip is reported rather than thrown, "all
children/books processed" no longer implies "no clone was ever at risk" —
callers (UI) must read the `skipped`/`character_skipped` signal, not just
absence of a 4xx.

### Plumbing change

`forEachMatchingCastCharacter` and `persistEmotionVariant` currently return
`Promise<number>` — a bare count of books updated. They change to return
which books were skipped for clone-safety, not just how many succeeded:

```ts
type ClonePersistResult = {
  updatedBookDirs: string[];
  skippedCloneBookDirs: string[];
};
```

Every caller reacts to `skippedCloneBookDirs` on its own transport per the
rules above; no caller re-derives the reason itself. The single-book
`onlyBookDir` branch of `forEachMatchingCastCharacter` (`:809-826`) and the
book-scoped branch of `persistEmotionVariant` (`:200-208`) both populate the
same shape with at most one entry each, so callers that only ever touch one
book (single-design.ts, qwen-voice.ts's own-book write) don't need a separate
code path — they just check `skippedCloneBookDirs.length > 0` for their own
`bookDir`.

### What counts as "the write would silently mute a clone" at write time

Same predicate the upfront checks already use, applied to the freshly-locked
character instead of the pre-GPU-work snapshot:

- `voices.ts`'s SET branch: `hasClonedProvenance(fresh, engine)` for any
  clone-capable engine other than the one being written (generalising the
  existing same-engine-only check at `:927` to also gate the write, not just
  decide what to preserve inside it).
- `voices.ts`'s CLEAR branch, `single-design.ts`, `qwen-voice.ts`'s base
  design, `cast-design.ts`: `characterHasClonedSlot(fresh)`, unchanged
  predicate, just re-evaluated on fresh data at write time.
- `qwen-voice.ts` / `cast-design.ts` variant path: `characterHasClonedSlot`
  gates the variant slot exactly as the existing pre-GPU-work check does.

### Accepted trade-off

A write-time refusal after GPU work discards that GPU work
(`single-design.ts`, `qwen-voice.ts`'s own-book write, `cast-design.ts`'s
per-character GPU work). This only fires inside the race window itself —
small and rare — and matches this wave's existing philosophy everywhere else
in the codebase: refuse loudly rather than silently corrupt, even at a real
cost. No caching or replay of the discarded GPU output is in scope here.

## Components touched

- `server/src/routes/voices.ts` — `forEachMatchingCastCharacter`'s mutate
  step gains the write-time cross-engine check; its two branches
  (`onlyBookDir`, workspace/series walk) both surface
  `skippedCloneBookDirs`. `PUT /:voiceId/override` maps the result to a
  status precisely: `updatedBookDirs.length === 0 &&
  skippedCloneBookDirs.length > 0` (every match was clone-protected, nothing
  written) → 409, same as today's pre-check refusal; `updatedBookDirs.length
  > 0 && skippedCloneBookDirs.length > 0` (some written, some skipped) → 200
  + `skipped` field, a new partial-success shape; `skippedCloneBookDirs.length
  === 0` → 200, unchanged from today.
- `server/src/routes/single-design.ts` — `runSingleDesign` checks
  `skippedCloneBookDirs` after `applyOverrideToCastFiles` returns and emits
  `type: 'error', code: 'clone_protected'` (reusing the existing pre-check's
  code, `:274-277`) instead of `designed` when the job's own book was
  skipped.
- `server/src/routes/qwen-voice.ts` — `persistEmotionVariant` gains the
  write-time check in both its series-propagation branch (`:168-190`) and its
  book-scoped branch (`:200-208`); the route handler (`:671-681`) checks the
  result for its own book before returning 200, and includes propagated-skip
  book dirs in the JSON body when the series branch was used.
- `server/src/routes/cast-design.ts` — the bulk job's two post-GPU-work write
  calls, `applyOverrideToCastFiles` (base path, `:544-549`) and
  `persistEmotionVariant` (variant path, `:555`), both check the returned
  skip set for `job.bookDir` before broadcasting success and emit
  `character_skipped` / `reason: 'already_cloned'` (matching the existing
  pre-GPU-work skip at `:405-410`/`:433-438`) instead of
  `character_designed` (`:551`) / `variant_designed` (`:557`) when it was
  skipped. `job.skipped` increments and `job.clonedSkips` gains the entry,
  same bookkeeping the pre-GPU-work skip already does, so the UI's existing
  "already cloned: <names>" summary (`src/store/cast-design-stream-middleware.ts`)
  covers both the fast-path and write-time skip without a UI change.
- `docs/superpowers/specs/2026-07-31-cast-json-write-lock-design.md` §7 —
  gains a note that the write-time re-check documented here is the mechanism
  that closes the TOCTOU window §7 flagged as open, cross-referencing this
  spec.

## Testing

Every write site above needs a paired test that:

1. Sets up a character with no clone, passes the upfront check.
2. Injects a clone onto that character (or, for the cross-engine case, on a
   different engine) **between the upfront check and the write** — i.e.
   directly manipulates cast.json inside the write-time lock window, not just
   before the request starts.
3. Asserts the write-time check catches it: 409 / `skipped` entry /
   `character_skipped` event, per the site's refusal semantic above — **not**
   a silently-applied write with the clone marker muted.
4. Is mutation-verified: deleting or weakening the write-time check must turn
   the test red, with the observed failure output captured, per this repo's
   "mutate the fix, watch it fail" acceptance bar.

A fan-out test (`voices.ts` workspace scope, `qwen-voice.ts` series
propagation) additionally asserts the **other, non-conflicting books still
get written** — a skip must not abort siblings.

## Out of scope

- Any change to lock granularity or acquisition order (`#2000` §3.2 stands).
- Caching/replaying GPU output discarded by a write-time refusal.
- The fourth gate (`voice-library.ts` DELETE) — already fixed in #2000 with a
  library-voice-scoped lock, per the original issue.
- `cast-lock.guard.test.ts`'s static-scan coverage of the touched functions —
  no new unlocked write site is introduced by this design, so the guard
  needs no change.
