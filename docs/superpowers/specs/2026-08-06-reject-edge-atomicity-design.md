# #2166 — the reject's two writes fail in the recoverable direction

> Design of record for [#2166](https://github.com/dudarenok-maker/Castwright/issues/2166).
> Status: approved 2026-08-06; **revised once the same day** after an adversarial pass
> declared revision 1 not converged (see "Review history").
> Parent plan: [`docs/features/278-cast-character-identity.md`](../../features/278-cast-character-identity.md), invariant 10.
> Filed from PR [#2163](https://github.com/dudarenok-maker/Castwright/pull/2163)'s own review, which
> deliberately built no fix because the choice had three defensible answers.
> Every `file:line` is against `main` at `f31da8c2`.

## The defect

"Not the same character" writes two records of one decision:

1. a `rejectedPairs` entry on `cast-id-history.json` (`rejectOrphanedPair`)
2. a one-sided `notLinkedTo` edge on `cast.json` (`appendNotLinked`)

`POST /api/books/:bookId/cast/:characterId/reject-orphan-match` writes the **edge first**
(`cast-reject-orphan.ts:339-341`), then the pair (`:369`). If the pair write fails — a 500
from a disk error, or the process dying between the two writes — and the user does not
retry, the edge survives alone.

That edge is read by the §4.4 name matcher (`remap-fresh-to-prior.ts`), so it permanently
suppresses name-matching between those two characters on every future re-analysis. And it
is **unreachable**: `OrphanRejectedChips` renders only off `info.rejectedAgainst`, derived
from `rejectedPairsGoverning`, which is empty by construction in this state — so no chip
renders and no Undo exists. PR #2163 made the DELETE endpoint *capable* of clearing it
(`cast-reject-orphan.ts:537-540`, unconditional clear keyed on `orphanedId`), but nothing
in the UI can reach that state to call it.

## Why the current order was chosen, and where the reasoning stops

`cast-reject-orphan.ts:97-110` documents the choice explicitly: cast.json is written
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

Both verbs fail into the **visible** state — the chip renders, Undo works, a retry
completes. **DELETE therefore needs no reorder**: its current edge-first order
(`:501-540`, before the id-history undo at `:589`) already satisfies the rule. The
"cast.json first on BOTH verbs" symmetry is precisely what produced the asymmetric outcome:
the same order is right on one verb and wrong on the other, because the two verbs move in
opposite directions.

Only POST inverts.

**What the table does not say** (review round 1, finding 4): the two verbs reach that state
with *opposite* intents. A half-failed POST wants the edge written; a half-failed DELETE
wants the pair gone. The reconciliation below cannot read intent, so it completes toward
`rejectedPairs` — the decision of record — and a half-failed Undo therefore has its edge
re-created and must be retried. That is visible (the chip is there) and recoverable, but it
is not the symmetry the table alone implies. See "Known limits" 2.

## The three writers of a `notLinkedTo` edge

Revision 1 claimed a same-book edge "can only ever have come from the reject-orphan route".
**That was false in two ways**, and both are load-bearing, so the design now names all
three writers.

1. **`cast-reject-orphan.ts:339`** — the route this issue is about. Same-book by definition.
2. **`cast-not-linked-to.ts:110-111`** — cross-book only. `:58-63` rejects a same-book pair
   outright with a 400 ("not-linked-to is for CROSS-book pairs; use cast/merge for same-book
   duplicates"), so it can never produce the shape the reconciliation targets. This one was
   correctly excluded.
3. **The client, via the whole-roster cast PUT.** `src/store/persistence-middleware.ts:69-94`
   PUTs `{ characters: s.cast.characters }` — the entire redux roster, `notLinkedTo`
   included — on nine ordinary cast actions, and `book-state.ts:685-688` writes it verbatim
   under `withCastLock` with no validation of that field. Redux genuinely holds a same-book
   edge: `src/views/cast.tsx:378-383` dispatches `applyNotLinked({ otherBookId: bookId, … })`
   — `otherBookId` **is this book** — and `cast-slice.ts:600` appends it.

Writer 3 is the one revision 1 missed, and it does more damage than being a mere third
source: `cast-slice.ts:50, 336, 409` merge incoming server state as
`notLinkedTo: existing.notLinkedTo ?? inc.notLinkedTo`, i.e. **redux's own array wins over
the server's**. So a client that hydrated before a reconciliation would re-PUT the stale
edge on the next unrelated cast edit, undoing the repair — and, symmetrically, an
edge-without-pair can arise with **no failure at all** (reject → Undo → any later cast
edit re-PUTs the edge redux never dropped).

## Design

Three components. The first prevents, the second repairs, and the third is what makes the
second durable rather than a coin-flip against the client.

### 1. POST — reorder, and make both halves fatal

The new sequence inside the existing `withCastLock` span:

1. read cast.json; 409 / 404 checks (unchanged)
2. read history; compute `forgotSupersededTo` by a **pure read** (unchanged, `:355-360`)
3. `rejectOrphanedPair(...)` — **fatal**, unchanged semantics, now the first write
4. `appendNotLinked` + `writeJsonAtomic(castJsonPath(...))` — **now fatal, with a message**
5. `forgetSupersededId(...)` — best-effort, unchanged, still last

**I1 survives intact.** Fix round 1's I1 requires only that `forgotSupersededTo` be computed
by a pure read before any write, and that `forgetSupersededId` run after the fatal pair
write. Both hold: step 2 still precedes every write, and step 5 still follows step 3. The
reorder moves the cast.json write across the pair write, which I1 says nothing about.

**Step 4 gains a failure message it never had.** Today a throw at `:341` sits outside any
`try` and reaches `errorHandler` (`app.ts:231`) as a generic 500 that says nothing about
which half landed — the quoted "the character link update, if any, was already saved" is
step 3's `catch` (`:375-378`), not step 4's. After the reorder each half needs its own
message: a step-3 failure means **nothing** was written; a step-4 failure means the
rejection is durably recorded but the link update is not. Both must say a retry is safe —
it is: `rejectOrphanedPair` is idempotent on `(from, to)` (`cast-id-history.ts:703`) and
`appendNotLinked` is idempotent by construction.

### 2. The reconciliation

A new self-contained module, `server/src/store/reject-edge-reconcile.ts`. Given a book's
live cast and its loaded `CastIdHistory`:

- `E` = every `notLinkedTo` edge whose `bookId` is **this** book
- an edge `e ∈ E` is **backed** when either
  - some `p ∈ history.rejectedPairs` has `p.from === e.characterId`, **or**
  - `history.rejected` includes `e.characterId` — the legacy id-wide list (see below)
- **unbacked edge → remove it**
- `p ∈ rejectedPairs`, `p.to` is a live cast row, and **no** edge anywhere in this book has
  `characterId === p.from` → **write the edge on `p.to`**
- `p.to` not a live cast row → skip; there is no character to carry the edge
- a cross-book edge is **never** touched

**Matching key, stated explicitly** (revision 1 contradicted itself here — §2 read
book-scoped, the test plan asserted row-scoped). **Both sides are book-scoped on
`e.characterId`, not row-scoped on `p.to`.** The reason is real, not theoretical:
`merge-analysis-cast.ts:473-480` copies `old.notLinkedTo` onto a fresh row matched by
**name**, so a legitimate edge can end up on a row whose id ≠ `p.to`. Row-scoped matching
would delete that relocated edge and write a duplicate on `p.to`. Book-scoped matching
leaves it alone, which is the fail-safe reading.

#### Legacy books — why `history.rejected` counts as backing

Revision 1's removal rule would have **deleted a legitimate edge**. The original route
(`aa6616d8`, 2026-08-04) wrote the identical same-book edge alongside
`rejectOrphanedId(bookDir, orphanedId)` (`:103` and `:114` of that revision), which lands in
the **id-wide `rejected` list**, not `rejectedPairs`. That list is still live and still
honoured — `cast-resolve.ts:108` builds `rejectedSet` from it and `:164` consults it, and
`cast-id-history.ts` documents it as "kept as a LEGACY, READ-ONLY field: still honoured by
`buildCastResolver` for back-compat with a file written before this change". On such a book
the durable half **did** land and the decision **is** still enforced — just at the id tier.
Removing the edge would silently un-suppress the §4.4 matcher for a decision the user made.

The window is narrow (`aa6616d8` → `f6074ca8`, both unreleased) but the owner's 20-book
workspace runs off `main`, and the codebase's own back-compat comment asserts such files are
expected to exist. Treating `rejected` as backing costs one clause and removes the entire
class.

**It reports what it changed**, both directions, matching every other drop/avoidance on this
surface (`dropSupersededIdsReclaimedByLiveCast`, `dropSupersededTargetsNoLongerLive`,
`cast-create`'s avoidance report). That is the answer to the issue's objection that a sweep
"silently discards a decision the user may still hold" — it discards visibly, and only ever
an edge with no durable half anywhere.

### 3. `notLinkedTo` becomes server-owned on the cast PUT

Without this, component 2 is not durable: the client re-PUTs whatever redux holds, and
redux's merge prefers its own array.

`book-state.ts:126-146`'s `preserveDesignedVoices` is already exactly this pattern — it
reads the on-disk cast and runs per-field passes (`preserveClonedSlotsOnCastWrite`,
`preserveDesignedVoicesOnCastWrite`) that restore server-owned fields a client PUT dropped
or overwrote. Add one more pass to that chain:

> **`preserveNotLinkedToOnCastWrite(existingChars, characters)`** — every character's
> `notLinkedTo` is taken from disk, discarding whatever the client sent.

`notLinkedTo` is identity state written only by dedicated server routes; the roster PUT has
no business carrying it. This kills the oscillation, restores the reconciliation's
durability, and makes "an already-consistent book performs no write" achievable.

**The client keeps its optimistic update** — `applyNotLinked` / the reject chips still
render immediately off redux; they are simply no longer able to *persist* that field. The
next hydrate reconciles them to disk.

### 4. Where the reconciliation runs

At `analysis.ts:5061` and `:6336`, beside the existing `dropSupersededTargetsNoLongerLive`
calls — the authoritative persist points (`:3744`, `:3956`, `:5750` are documented
provisional/interim writes that the final one clobbers).

**In its own `withCastLock`, best-effort, non-fatal**, mirroring
`clearNotLinkedEdgesForDroppedRejections` (`analysis.ts:261`), which PR #2163 added in this
same function for the sibling reason. `analysis.ts` holds no cast lock at these sites — its
cast.json writes are the allowlisted **unlocked** exception deferred to #2015 — so the new
write must be locked, and **`writeJsonAtomic(castJsonPath(` must sit textually inside the
`withCastLock(` parens**. `cast-lock.guard.test.ts` is call-graph-blind and matches by
textual containment, so taking the lock in `analysis.ts` around a *call into the module*
would leave an unlocked-looking write in a file whose allowlist entry is keyed on file
**and count**, reddening the build. The module therefore exposes a **pure** reconcile
function — `(cast, history) → { adds, removes, next }` — and `analysis.ts` performs the
lock, the read and the write itself, inline.

**Interaction with `clearNotLinkedEdgesForDroppedRejections`.** Compatible in either order
and deliberately separate: that one is per-retirement, driven by `droppedSelfLoopRejections`;
this one is per-persist, derived from state. After #2133's helper runs, pair and edge are
both gone, so the reconciliation sees nothing to do.

### 5. Rejected alternatives

**Teaching the consumer to ignore an unbacked edge.** `notLinkedToId`
(`remap-fresh-to-prior.ts:80-90`) matches on `characterId` alone and **ignores `bookId`
deliberately**, documented at `:72-79`: *"a false 'linked' is silent data corruption (two
people collapsed into one), a false 'not linked' only costs a remap that a user can still do
by hand."* `merge-analysis-cast.ts`'s `groupHasNotLinkedEdge` (`:507`) makes the identical
trade. Two sites would have to abandon a documented fail-safe, in the corrupting direction.

> Citation correction: `remap-fresh-to-prior.ts:75` cites that sibling as
> `merge-analysis-cast.ts:377-388`. It is at **`:507`**. Recorded, not fixed in passing.

**A true two-file transaction.** Two files, so atomicity needs a write-ahead journal — a
primitive this codebase does not have — for a failure needing a disk error or a crash inside
a millisecond window. The reorder achieves prevention without it.

**Rendering a chip for an unbacked edge.** Requires the banner to model a rejection with no
`rejectedPairs` entry, a state nothing else produces, and to keep modelling it forever for a
state that after this change can no longer be created.

## The risk this design carries, stated

The reorder moves the POST failure toward the direction the consumers explicitly guard
against: a pair with no edge means the §4.4 matcher is **not** suppressed, so a re-analysis
could re-link a pair the user rejected — a "false linked".

**The reconciliation is what makes it sound**: the missing edge is written back at the next
authoritative persist, which is the same event that would perform the re-link, so
suppression is restored before the matcher that needs it runs. Interim exposure is the
window between a failed reject and the next re-analysis, during which the chip is visible
and a retry closes it.

**This is the load-bearing dependency: reorder without reconcile is worse than today, and
reconcile without component 3 is undone by the next client PUT. All three ship together or
none do.**

## Known limits

1. **Healing cadence is per-book re-analysis.** A book never re-analysed keeps its unbacked
   edge. Running the reconciliation in the reject route's own lock span would heal on any
   banner interaction; out of scope as a second call site for a state that, after this
   change, can no longer be created.
2. **A half-failed Undo has its edge re-created.** The reconciliation completes toward
   `rejectedPairs`, so a DELETE that wrote the edge removal but failed at
   `unrejectOrphanedPair` (`:589`) is repaired *back to rejected*. Visible (the chip renders)
   and fixed by retrying the Undo — but it is the reconciliation asserting a decision the
   user was revoking.
3. **The reconciliation is skipped on two paths at `:5061`** — it sits inside the `else` of
   `if (phase1DriftExceeded)` (`:4978-4983`) and inside the `try/catch (historyErr)`
   (`:5003-5075`), so a drift-refused run, or an earlier throw in that block, reconciles
   nothing. Acceptable for a best-effort sweep that runs again next analysis; stated so it
   is known.
4. **Hand-edited cast.json loses unbacked edges.** An operator adding a same-book edge by
   hand sees it removed at the next persist. Correct per the invariant, and logged.

## Deliberately not fixed here — filed instead

**A multi-pair DELETE can half-complete and become unretryable.** If `restoreSupersededId`
(`cast-id-history.ts:626-644`) succeeds for one pair and a later `unrejectOrphanedPair`
(`:589`) throws, the restored `supersededBy[orphanedId]` changes what
`rejectedPairsGoverning` computes on the retry: `resolveIgnoringPairRejects` now returns the
`history` tier instead of a normalised one, `normalisedTierRelevant` goes false
(`cast-resolve.ts:276-293`), and the normalised-spelling sibling pairs **drop out of
`governingPairs`** — the retry can no longer see them, so it never removes them. The
reconciliation then writes their edges back.

This is a real defect in the same seam, but it is not #2166's, and its fix is a design
decision of its own (ordering `restoreSupersededId` against `unrejectOrphanedPair`, or
making the DELETE's multi-pair loop transactional). It fails the fix-now bar — two
defensible answers, a changed failure contract — so it gets its own issue, referenced from
plan 278's invariant 10.

## Test plan

Every assertion is mutated on its own line during implementation to prove it can fail.

**Fault injection — prevention**

- `rejectOrphanedPair` throws → 500, **and `cast.json` is byte-unchanged**. The regression
  test for #2166: fails before the reorder, passes after.
- the cast.json write throws after the pair landed → 500, pair present, message names which
  half landed.
- both 500 messages assert the *new* wording; step 4's message did not previously exist.
- a retry after either failure reaches a complete state.

**Ordering, pinned**

- POST writes the pair before the edge; DELETE removes the edge before the pair. Pinned so a
  later tidy-up cannot "symmetrise" the verbs back into agreement — the asymmetry is the
  design.

**Reconciliation**

- unbacked edge → removed; pair with no edge anywhere in the book → edge written on `p.to`
- **an edge backed only by the legacy `history.rejected` list → NOT removed** (the
  revision-1 Critical; fails against revision 1's rule, passes against this one)
- **an edge relocated onto a name-matched row whose id ≠ `p.to` → NOT removed and NOT
  duplicated** (book-scoped matching)
- `p.to` not a live cast row → no edge written
- **a cross-book edge is untouched** — the case the `bookId` filter exists for
- an already-consistent book → **no write at all**
- both directions logged
- runs after `clearNotLinkedEdgesForDroppedRejections` without undoing it

**Server-owned `notLinkedTo`**

- a cast PUT carrying a mutated/absent `notLinkedTo` leaves the on-disk value untouched
- a cast PUT still persists every other field it is supposed to (no collateral freeze)
- reject → reconcile → unrelated cast edit → the repaired state survives the PUT (the
  oscillation regression)

**Guards**

- `cast-lock.guard.test.ts` stays green: `analysis.ts`'s allowlisted **unlocked** count is
  unchanged (`:3744, :3956, :4996, :5750, :6285`), because the new write is locked and
  textually inside `withCastLock(`.

## On-box acceptance

**None owed.** Every behaviour is provable by fault injection in unit tests — no GPU, no
sidecar, no analyzer, no real book. Stated explicitly rather than silently skipped
(CLAUDE.md before-shipping step 3).

## Documentation

- **Plan 278 invariant 10** (`:223`) currently records this as an open residual. It becomes
  the enforced rule: written first / removed last, reconciled at the authoritative persist,
  with `notLinkedTo` server-owned — plus a pointer to the filed multi-pair DELETE issue.
- `docs/release-notes-next.md` + `RELEASE_NOTES.md` — a failed "not the same character"
  click no longer silently suppresses name matching forever.
- #2166 closes; the multi-pair DELETE issue is filed and linked.

## Out of scope

- Any change to `notLinkedToId` / `groupHasNotLinkedEdge`'s `bookId`-ignoring fail-safe.
- Deduplicating the three `appendNotLinked` / `removeNotLinked` copies.
- The cross-book `not-linked-to` route.
- #2015's unlocked-write debt in `analysis.ts`.
- The multi-pair DELETE defect above — filed, not fixed.

## Review history

**Rev 1 → 2** (Premium `assumption-checker`, 2026-08-06). Declared **not converged**. Two
Criticals, both against the central safety argument, both verified before acting:

- **The sweep would have eaten legitimate legacy edges.** Revision 1 removed any same-book
  edge with no `rejectedPairs` entry. A book rejected between `aa6616d8` and `f6074ca8` has
  its decision recorded in the legacy id-wide `rejected` list instead — still honoured by
  `buildCastResolver` — so the durable half *had* landed and the edge was legitimate.
- **"A same-book edge can only have come from the reject route" was false.** The client
  PUTs the whole roster including `notLinkedTo` (`persistence-middleware.ts:69-94` →
  `book-state.ts:685-688`), redux holds same-book edges (`cast.tsx:378-383`), and its merge
  rule prefers its own array over the server's (`cast-slice.ts:50, 336, 409`) — so the
  client would re-PUT edges the reconciliation deleted, and edge-without-pair can arise with
  no failure at all. This added component 3.

Also folded: the matching key contradicted itself between §2 and the test plan (now
book-scoped, both); "one failure state, one repair" understated that the repair is
direction-blind (now known limit 2); a third DELETE partial state that is unretryable (now
filed); four citation corrections (`:537-540`, `:501-540`, `:97-110`, and step 4's message
belonging to step 3's `catch`); and two unstated skip conditions at `:5061` (now known
limit 3).

## Handover

Implementation is a separate thread. Its inputs are the plan doc produced from this spec
plus a handover-brief comment on #2166.
