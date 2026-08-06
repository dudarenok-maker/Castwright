# #2166 — the reject's two writes fail in the recoverable direction

> Design of record for [#2166](https://github.com/dudarenok-maker/Castwright/issues/2166).
> Status: approved 2026-08-06.
> Parent plan: [`docs/features/278-cast-character-identity.md`](../../features/278-cast-character-identity.md), invariant 10.
> Filed from PR [#2163](https://github.com/dudarenok-maker/Castwright/pull/2163)'s own review, which
> deliberately built no fix because the choice had three defensible answers.
> Every `file:line` is against `main` at `f31da8c2`.

## The defect

"Not the same character" writes two records of one decision:

1. a `rejectedPairs` entry on `cast-id-history.json` (`rejectOrphanedPair`)
2. a one-sided `notLinkedTo` edge on `cast.json` (`appendNotLinked`)

`POST /api/books/:bookId/cast/:characterId/reject-orphan-match` writes the **edge first**
(`cast-reject-orphan.ts:339-343`), then the pair (`:369`). If the pair write fails — a 500
from a disk error, or the process dying between the two writes — and the user does not
retry, the edge survives alone.

That edge is read by the §4.4 name matcher (`remap-fresh-to-prior.ts`), so it permanently
suppresses name-matching between those two characters on every future re-analysis. And it
is **unreachable**: `OrphanRejectedChips` renders only off `info.rejectedAgainst`, derived
from `rejectedPairsGoverning`, which is empty by construction in this state — so no chip
renders and no Undo exists. PR #2163 made the DELETE endpoint *capable* of clearing it
(`cast-reject-orphan.ts:505-530`, unconditional clear keyed on `orphanedId`), but nothing
in the UI can reach that state to call it.

## Why the current order was chosen, and where the reasoning stops

`cast-reject-orphan.ts:95-110` documents the choice explicitly: cast.json is written
"first, UNCONDITIONALLY, on BOTH verbs — it's the authoritative record (spec §4.1) and the
write cast-merge.ts's own precedent orders first." Its safety argument:

> "the worst case is a same-book id-history 500 AFTER cast.json already changed, which a
> retry simply repeats as a no-op"

**That is true, and it does not cover #2166.** The premise is a retry; #2166 is defined by
its absence. The reasoning was never wrong — it answered a different question, and this
state fell outside it.

## The spine — the pair is the recoverable half

The two writes are not interchangeable. The `rejectedPairs` entry is what drives
`rejectedAgainst` → the chip → Undo. **The edge is invisible on its own; the pair is not.**

> **The `rejectedPairs` entry is written first and removed last. The edge is created after
> it and destroyed before it.**

| Verb | Order | A failure between the writes leaves |
|---|---|---|
| POST | pair → edge | pair present, edge absent |
| DELETE | edge → pair | pair present, edge absent |

Both verbs fail into **one** state, and it is the visible one — the chip renders, Undo
works, a retry completes. There is one failure state and one repair.

**DELETE therefore needs no change.** Its current edge-first order (`:495-530`, before the
id-history undo) already satisfies the rule. The "cast.json first on BOTH verbs" symmetry
is precisely what produced the asymmetric outcome: the same order is right on one verb and
wrong on the other, because the two verbs move in opposite directions.

Only POST inverts.

## Design

### 1. POST — reorder, and make both halves fatal

The new sequence inside the existing `withCastLock` span:

1. read cast.json; 409 / 404 checks (unchanged)
2. read history; compute `forgotSupersededTo` by a **pure read** (unchanged, `:355-360`)
3. `rejectOrphanedPair(...)` — **fatal**, unchanged semantics, now the first write
4. `appendNotLinked` + `writeJsonAtomic(castJsonPath(...))` — **now fatal**
5. `forgetSupersededId(...)` — best-effort, unchanged, still last

**I1 survives intact.** Fix round 1's I1 requires only that `forgotSupersededTo` be
computed by a pure read before any write, and that `forgetSupersededId` run after the fatal
pair write. Both hold: step 2 still precedes every write, and step 5 still follows step 3.
The reorder moves the cast.json write across the pair write, which I1 says nothing about.

**Step 4 becomes fatal.** Today a throw there propagates to the route's error handler
anyway; what changes is the message, which is currently the inverse of the truth. Today's
500 says *"the character link update, if any, was already saved."* After the reorder, a
step-3 failure means **nothing** was written, and a step-4 failure means the rejection is
durably recorded but the link update is not. Both messages must say which, and both must
say a retry is safe — it is: `rejectOrphanedPair` is idempotent on `(from, to)`, and
`appendNotLinked` is idempotent by construction.

### 2. The reconciliation

A new self-contained module, `server/src/store/reject-edge-reconcile.ts`, holding the rule
and the two edge helpers it needs. Given a book's live cast and its loaded `CastIdHistory`:

- `P` = every `rejectedPairs` entry
- `E` = every `notLinkedTo` edge whose `bookId` is **this** book
- `p ∈ P`, `p.to` is a live cast id, no matching edge → **write the edge**
- `e ∈ E` with no matching pair → **remove the edge**
- `p.to` not a live cast row → **skip**; there is no character to carry the edge
- a cross-book edge is **never** touched

Matching is on `(bookId, characterId)` against `(this book, pair.from)`, keyed on the
pair's own `from` — the raw spelling the original POST wrote under, which need not equal
the row's current raw id (the DELETE handler makes the same distinction at `:495-503`, for
the same reason).

**The `bookId` filter is what makes this safe, and it is exact.** A same-book `notLinkedTo`
edge can only ever have come from this route: `cast-not-linked-to.ts:58-63` rejects a
same-book pair outright with a 400 ("not-linked-to is for CROSS-book pairs; use cast/merge
for same-book duplicates"), and the only other `appendNotLinked` caller is that route. The
DELETE handler's own comment states the same fact independently. So "same-book edge with no
backing pair" identifies a stranded edge with **zero ambiguity** — this is not a heuristic.

**It reports what it changed.** Every drop/avoidance on this surface is operator-visible
(`dropSupersededIdsReclaimedByLiveCast`, `dropSupersededTargetsNoLongerLive`,
`cast-create`'s avoidance report). This one logs both directions. That is the answer to the
issue's own objection that a sweep "silently discards a decision the user may still hold" —
it discards visibly, and only ever a decision whose durable half never landed.

### 3. Where it runs

At `analysis.ts:5061` and `:6336`, beside the existing `dropSupersededTargetsNoLongerLive`
calls — the authoritative persist points where cast-identity bookkeeping already happens.

**In its own `withCastLock`, best-effort, non-fatal**, mirroring
`clearNotLinkedEdgesForDroppedRejections` (`analysis.ts:261`), which PR #2163 added in this
same function for the sibling reason and which is the template for shape, lock discipline
and failure policy. `analysis.ts` holds no cast lock at these sites — its cast.json writes
are the allowlisted **unlocked** exception deferred to #2015 — so the new write must be
locked, and **`writeJsonAtomic(castJsonPath(` must sit textually inside the `withCastLock(`
parens**: `cast-lock.guard.test.ts` is call-graph-blind and matches by textual containment,
so a helper one hop away reproduces `voice-override-linked.ts`'s allowlisted false-positive
shape in a file that is not allowlisted.

**Interaction with `clearNotLinkedEdgesForDroppedRejections`.** They are compatible in
either order and are deliberately kept separate: that one is per-retirement, driven by
`droppedSelfLoopRejections`; this one is per-persist, derived from state. After #2133's
helper runs, the pair and its edge are both gone, so the reconciliation sees nothing to do.
Merging them would couple a scoped, tested helper to a broader sweep for no gain.

### 4. Rejected alternatives

**Teaching the consumer to ignore a same-book edge with no pair.** `notLinkedToId`
(`remap-fresh-to-prior.ts:80-89`) matches on `characterId` alone and **ignores `bookId`
deliberately**, documented at `:72-79` as fail-safe: *"a false 'linked' is silent data
corruption (two people collapsed into one), a false 'not linked' only costs a remap that a
user can still do by hand."* `merge-analysis-cast.ts`'s `groupHasNotLinkedEdge` (`:507`)
makes the identical trade. Two sites would have to abandon a documented fail-safe, in the
corrupting direction, to fix a rare state. Rejected.

> Citation correction: `remap-fresh-to-prior.ts:75` cites that sibling as
> `merge-analysis-cast.ts:377-388`. It is at **`:507`**. Recorded rather than fixed in
> passing — the stale citation is not this change's to repair.

**A true two-file transaction** (the issue's option 1 as literally worded). The writes go
to two different files, so atomicity needs a write-ahead journal — a primitive this
codebase does not have — for a failure that needs a disk error or a crash inside a
millisecond window. Disproportionate. The reorder achieves prevention without it.

**Rendering a chip for a stranded edge** (the issue's option 2). Requires the banner to
model a rejection with no `rejectedPairs` entry, a state nothing else in the system
produces, and to keep modelling it forever for a state that after this change can no longer
be created.

## The risk this design carries, stated

The reorder moves the failure toward the direction the consumers explicitly guard against.
A pair with no edge means the §4.4 name matcher is **not** suppressed, so a re-analysis
could re-link a pair the user rejected — a "false linked", which
`remap-fresh-to-prior.ts:72-79` names as the corrupting direction.

On its own that would be a bad trade. **The reconciliation is what makes it sound**: the
missing edge is written back at the next authoritative persist — which is the same event
that would perform the re-link — so the suppression is restored before the matcher that
needs it runs. The interim exposure is a window between a failed reject and the next
re-analysis, during which the chip is visible and a retry closes it.

This is the load-bearing dependency in the design: **reorder without reconcile is worse than
today.** They ship together or not at all.

## Known limits

1. **Healing cadence is per-book re-analysis.** A book that is never re-analysed keeps its
   stranded edge — inert once the matcher is the only consumer, but present on disk.
   Running the reconciliation inside the reject route's own lock span would heal on any
   banner interaction; deliberately out of scope as a second call site for a state that,
   after this change, can no longer be created.
2. **Ordering within the persist is not atomic across the two files.** A crash between the
   reconciliation's cast.json write and anything after it leaves the same class of partial
   state the reconciliation itself repairs on the next run. Self-correcting by construction.
3. **The reconciliation trusts `rejectedPairs` as the decision of record.** An operator who
   hand-edits `cast.json` to add a same-book edge will see it removed at the next persist.
   Correct per the invariant, and worth the log line.

## Test plan

Every assertion is mutated on its own line during implementation to prove it can fail.

**Fault injection — the two halves of prevention**

- `rejectOrphanedPair` throws → 500, **and `cast.json` is byte-unchanged**. This is the
  regression test for #2166 itself: it fails before the reorder and passes after.
- the cast.json write throws after the pair landed → 500, pair present, message names which
  half landed.
- both 500 messages assert the *new* wording; the old message asserted the opposite fact and
  must not survive.
- a retry after either failure reaches a complete state (both records present).

**Ordering, pinned**

- POST writes the pair before the edge; DELETE removes the edge before the pair. Pinned
  explicitly so a later tidy-up cannot "symmetrise" the two verbs back into agreement — the
  asymmetry is the design.

**Reconciliation**

- edge with no pair → removed; pair with no edge → edge written
- pair whose `to` is not a live cast row → no edge written, and an existing edge for it removed
- **a cross-book edge is untouched** — the case the `bookId` filter exists for
- an already-consistent book → no write at all (idempotent, no churn on every analysis)
- both directions logged
- runs after `clearNotLinkedEdgesForDroppedRejections` without undoing it

**Guards**

- `cast-lock.guard.test.ts` stays green: `analysis.ts`'s allowlisted **unlocked** count is
  unchanged, because the new write is locked and textually inside `withCastLock(`.

## On-box acceptance

**None owed.** Every behaviour here is provable by fault injection in unit tests — no GPU,
no sidecar, no analyzer, no real book. Stated explicitly rather than silently skipped
(CLAUDE.md before-shipping step 3).

## Documentation

- **Plan 278 invariant 10** (`:223`) currently records this as an open residual. It becomes
  the enforced rule: written first / removed last, reconciled at the authoritative persist.
- `docs/release-notes-next.md` + `RELEASE_NOTES.md` — a failed "not the same character"
  click no longer silently suppresses name matching forever.
- #2166 closes.

## Out of scope

- Any change to `notLinkedToId` / `groupHasNotLinkedEdge`'s `bookId`-ignoring fail-safe.
- Deduplicating the three `appendNotLinked` / `removeNotLinked` copies. The new module
  carries its own helpers rather than adding a fourth inline copy; the existing three are
  left alone.
- The cross-book `not-linked-to` route.
- #2015's unlocked-write debt in `analysis.ts`.

## Handover

Implementation is a separate thread. Its inputs are the plan doc produced from this spec
plus a handover-brief comment on #2166.
