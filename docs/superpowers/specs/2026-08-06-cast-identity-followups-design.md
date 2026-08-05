# Cast-identity follow-ups — #2110, #2129, #2133, #2128

> Design of record for the four #2040 follow-up bugs shipped as one lane.
> Status: approved 2026-08-06. Implementation plan and the per-issue handover
> brief are separate artifacts (see "Handover" at the end).
> Parent plan: [`docs/features/278-cast-character-identity.md`](../../features/278-cast-character-identity.md).

## Why one lane

The four issues are independent defects but share one surface: the cast-identity
seam introduced by #2040 — `cast-id-history.json`, `buildCastResolver`,
`collectOrphanedCharacterFallbacks`, the Cast banner, and
`scripts/repair-cast-id-drift.mjs`. Shipping them separately would mean four
reviews of the same files and four chances to reintroduce each other's defects.
#2129 in particular spans frontend and server and cannot be reasoned about from
either side alone.

Two of the four (#2129, #2128) turn out to share a root cause and a fix; the
other two (#2110, #2133) are self-contained and ride the lane for the shared
review, not because they are blocked by it.

## Prerequisite — not part of this lane

`feat/server-2040-reject-scope-undo` must be pushed, reviewed as a whole branch,
PR'd and merged **before** this lane starts. It is 35 commits ahead of `main`
and unpushed as of 2026-08-06, and it rewrites every file this lane touches:
`cast-id-history.ts` (+375), `cast-resolve.ts` (+213), `cast.tsx` (+197),
`segments-io.ts` (+73), `repair-cast-id-drift.mjs` (+144).

**#2133 does not exist on `main` at all.** `rejectedPairs`,
`repointRejectedPairs` and `RetireCharacterIdResult.droppedSelfLoopRejections`
are entirely that branch's code. Everything below is designed against the
merged result, and any file/line reference in this document that concerns
`rejectedPairs` refers to that branch.

## Premise verification (2026-08-06)

Each issue's premise was checked against the tree rather than taken at face
value. Results:

| Issue | Premise | Verdict |
|---|---|---|
| #2110 | `cast-create`'s taken set excludes `supersededBy` values | **True** — `cast-create.ts:126-129` |
| #2129 | Banner and repair pass give opposite answers for the same id | **True** — see below |
| #2129 | A stale "don't contradict the Cast banner" comment survives in `planBookRepairs` at `~:656-665` | **FALSE** — see below |
| #2133 | A dropped self-loop rejection orphans its `notLinkedTo` edge | **True** — on the prerequisite branch |
| #2128 | No per-entry timestamp exists to compare `synthesizedAt` against | **True** — `supersededBy` is `Record<string, string>` |

### #2129's second premise is wrong

The issue's second acceptance criterion asks that "the stale justification
comment in `planBookRepairs`" be corrected, citing `~:656-665` and the #2093
residual-5 / MINOR-4 reasoning "don't contradict the Cast banner".

No such comment exists. Lines 656-665 of `scripts/repair-cast-id-drift.mjs` are
the `withheldForMissingCache` / `withheldForMissingBak` accounting paragraph,
which concerns neither the banner nor resolution tiers. Searching the file's
whole history — `git log -S"Cast banner"` and `git log -S"contradict the Cast"`
on that path — returns nothing: the text never existed there. The nearest
mentions of the banner in that file are two `detail` strings (`:833`, and
`:1034` on the prerequisite branch), both of which correctly describe a user's
own reject action.

**Disposition:** that acceptance criterion is discharged as not-applicable, and
this finding is recorded here and on the issue so a later reader does not
re-file it. The issue's *first* criterion — the divergence itself — is real and
is what this lane fixes.

### The divergence #2129 is actually about

`segments-io.ts` tags a `'history'` or `'normalised-history'` resolution as
`'alias'`; `cast.tsx:254-257` files anything `!== 'unresolved'` under a
collapsed disclosure headed "N character ids auto-reconciled". Meanwhile
`buildOrphansFromSegments` (post-#2107) exempts **only** `'exact'`, so those
same ids are listed as damage needing a re-render. An operator reading the Cast
screen sees "auto-reconciled, nothing to do" for `the-torment` while the repair
pass lists 67 of its segments as needing work.

## Architectural spine: one comparator, two callers

**The root cause of #2129 is not the word "auto-reconciled".** It is that the
banner and the repair pass each answer "is this id fine?" with independently
written logic. Relabelling leaves that intact and lets the two drift apart
again at the next change.

Plan 278's invariant 7 already established this exact principle for candidate
*ranking* — "two independent rankers is the exact duplicate-matching-logic
defect class Task 16's CRITICAL finding came from". This lane extends it to
*currency*: a single exported predicate, called by both surfaces, is the fix.
The labels change as a consequence of the predicate existing, not instead of it.

## Design

### 1. The persisted schema — `recordedAt`

```ts
export interface CastIdHistory {
  schema: 1;                                  // unchanged
  supersededBy: Record<string, string>;
  displaced?: Record<string, string>;
  rejected?: string[];
  rejectedPairs?: RejectedPair[];
  /** #2128 — ISO-8601 UTC, keyed parallel to `supersededBy`. */
  recordedAt?: Record<string, string>;
}
```

**Additive-optional, `schema` stays 1.** This matches the module's three
existing optional fields exactly; each of their doc comments promises "never
bumps `schema`" and "an old reader that doesn't know this key still works".
Retyping `supersededBy` to carry the timestamp inline was considered — it makes
desync structurally impossible — and rejected: it forces a real migration,
reworks `loadCastIdHistory`'s all-or-nothing validation, and touches every read
site across the server, the repair script and their tests in one diff, for a
sync property a guard test can hold instead.

`recordedAt` is validated **independently** of the other optional keys — its own
`typeof === 'object' && !Array.isArray && !== null` check — so a malformed
`recordedAt` cannot discard a well-formed `supersededBy`. This is the discipline
`rejectedPairs` documents for the same reason.

#### Sync discipline at the three mutation sites

A sidecar map's failure mode is drift. Three functions mutate `supersededBy`
today, and each acquires a paired obligation:

- **`retireCharacterId`** stamps `recordedAt[from] = <now, ISO-8601>` for the
  entry it writes. Its repoint loop rewrites **values** only, so existing keys
  keep their **original** timestamps. That is correct, not an oversight: a
  repointed entry still names the same person (`retireCharacterId` is only ever
  called when `from` and the dereferenced target are the same character under
  two ids), so a render made while the entry pointed at the old target is still
  that person's voice, and its currency verdict must not change.
- **`retireCharacterId`'s direct-reversal branch** deletes `supersededBy[to]`,
  so it must delete `recordedAt[to]` in the same breath.
- **`forgetSupersededId`** deletes one key ⇒ deletes its timestamp.
- **`dropSupersededIdsReclaimedByLiveCast`** deletes reclaimed keys ⇒ deletes
  their timestamps. It does **not** preserve them into `displaced`: `displaced`
  is never read by the resolver, so a timestamp there would protect nothing.

Two tests hold this:

1. A **behavioural invariant** — after every scripted mutation sequence,
   `keys(recordedAt) ⊆ keys(supersededBy)`.
2. A **syntactic guard** over the module, in the shape of
   `server/src/workspace/cast-lock.guard.test.ts`, failing the build when a new
   `supersededBy` mutation site appears without a paired `recordedAt` mutation.
   **Its header states its own blind spot**, exactly as the cast-lock guard's
   does: it is call-graph-blind, so a new *caller* of an already-correct helper
   adds no occurrence text and passes. The guard ships with a neutralisation
   proof — a demonstration that it fails when the mutation it checks for is
   removed.

### 2. The render-side discriminator — `castResolverVersion`

`recordedAt` alone cannot clear the `'normalised-id'` tier, because that tier
has no history entry and therefore no timestamp. The hazard there is different
in kind: not "the alias postdates the render" but "the render predates the
resolver existing at all" — pre-Wave-1, `resolveGroup` did a bare
`castById.get()` and substituted the narrator regardless of tier.

This is not a corner case. Per register row A32, `the-torment` (67 segments) and
`lightning-dave` (1 segment) both resolve under `'normalised-id'` — **68 of the
188 known damaged segments**, the single largest block. Without a discriminator
for that tier, those rows never clear no matter how often the operator
re-renders them, which defeats #2128's own acceptance criterion.

**`SegmentsFile` gains an optional `castResolverVersion: number`**, written as a
module constant next to `synthesizedAt` at `finalize-chapter-write.ts:325-331`.
Present ⇒ the render went through today's four-tier resolver ⇒ its bytes match
today's resolution for that tier. Absent ⇒ unknown. Bumped only when a new
resolver tier changes what a render resolves to.

A dated/SHA'd epoch constant in the repair script was considered and rejected:
nothing pins such a constant, the workspace's renders span branches and
machines, and setting it too early silently re-opens #2107 while setting it too
late over-reports forever.

`SegmentsFile` carries no version stamp today (`synthesizedAt` is its only
temporal marker), so this is a new field, not a reuse.

### 3. The predicate

`isAudioCurrent(resolution, segmentsFile, history) → true | false | 'unknown'`,
pure and I/O-free, in `server/src/store/cast-audio-currency.ts`. The repair
script imports it from `server/dist` exactly as `main()` already imports
`buildCastResolver` and `normaliseForMatch`.

| Case | Result |
|---|---|
| `via === 'exact'` | `true` — unchanged from #2107 |
| `via === 'history'` / `'normalised-history'` | `recordedAt[matchedHistoryKey]` absent, or `synthesizedAt` absent/unparseable → `'unknown'`; else `synthesizedAt >= recordedAt[key]` |
| `via === 'normalised-id'` | `castResolverVersion` absent → `'unknown'`; else `true` |

**Damage is anything other than `true`.**

**Each tier has exactly one discriminator, and `castResolverVersion` gates only
`'normalised-id'`.** The two mechanisms are not interchangeable — `recordedAt`
cannot clear `'normalised-id'` because that tier has no history entry, and
`castResolverVersion` cannot clear an alias tier because an alias can be
recorded *after* a perfectly modern render. But the alias tiers get their
resolver-epoch guarantee for free and so must not be gated on the stamp:
`cast-id-history.json` was introduced by the same #2040 wave as the resolver, so
any entry that *has* a `recordedAt` was necessarily written post-Wave-1, and
`synthesizedAt >= recordedAt` therefore already implies the render is
post-Wave-1 too.

Gating the alias tiers on `castResolverVersion` as well would be actively
harmful rather than merely redundant: it would keep a row listed even when
`recordedAt` proves its audio is current, until someone performed the exact
needless re-render #2128 exists to stop.

#### The unknown rule

**On the tier where each applies: a missing `recordedAt`, a missing
`castResolverVersion`, and a missing or unparseable `synthesizedAt` each read as
`'unknown'`, and `'unknown'` is listed as damage.**
Only an affirmative comparison clears a row; absence of evidence never clears
anything.

Inverting this is the single most dangerous mistake available in this lane —
#2128 says so explicitly ("getting that backwards silently re-opens #2107"), and
it is why each of the three unknown sources gets its own test asserting it
*lists*, not clears.

An unparseable `synthesizedAt` is checked **explicitly** rather than left to
`NaN` comparison. A `NaN >= x` evaluates to `false`, which happens to land
fail-closed — but an accident is not a guarantee, and this codebase shipped a
NaN-comparison defect recently enough (#2144) not to rely on one.

### 4. Resolver change — `matchedHistoryKey`

`CastResolution` carries `viaAlias`, but `cast-resolve.ts:116-133` sets it to
the **queried** id in all three non-exact branches. For a `'normalised-history'`
hit the actual matched key is a different spelling, so `viaAlias` cannot be used
to look up `recordedAt`.

`CastResolution` gains an optional `matchedHistoryKey?: string`, set to the real
key on the `'history'` and `'normalised-history'` branches. Additive; `viaAlias`
is untouched.

### 5. #2128 — the repair pass clears

`buildOrphansFromSegments(segs, resolver)` takes the history and replaces its
`via === 'exact'` skip with `isAudioCurrent(...) === true`. Its doc comment's
existing warning carries over verbatim in form: `orphans` being empty for an id
must mean **affirmatively current**, never merely "the resolver returned
something".

A chapter that has been re-rendered since its alias was recorded now drops off
the list; one that has not still appears. The list becomes a work list.

### 6. #2129 — the banner splits

`OrphanedCharacterFallback` gains `audioCurrent: true | false | 'unknown'`. The
existing `resolution` field and its three values (`'alias' | 'normalised' |
'unresolved'`) are **untouched**, so the prerequisite branch's reject/undo chips
and their tests are unaffected.

`src/views/cast.tsx`'s single auto-reconciled disclosure becomes two, both
collapsed, each showing its count in its own header — so `N resolved · audio
needs a re-render` is legible **without expanding anything**. That is the direct
fix to "the operator sees *nothing to do*". Exact copy is an implementation
detail for the plan; the requirement is that the actionable count is visible in
the collapsed state.

Both surfaces now derive their verdict from `isAudioCurrent`, so they cannot
disagree.

### 7. #2110 — reserve the values

`cast-create.ts`'s taken set gains `...Object.values(history.supersededBy)`.
`takenNorm` derives from `takenIds`, so normalised coverage is free.

Cost, correctly scoped: `cast-create` does not *refuse* a taken id — it suffixes
(`антон` → `антон-2`) and creates the character with the requested **name**
intact. The cost is a marginally uglier internal id for a genuinely dead
character, not a blocked action. The issue's framing ("can never be reused by
name, forever") overstates it.

Pruning dangling entries instead (the issue's option 2) was considered and
rejected: a dangling entry is inert **only while its target is dead**, and
resumes protecting its segments if a later re-analysis re-mints that target.
Pruning destroys that; `displaced` would preserve the record but the resolver
never reads it.

**One non-obvious consequence.** The route's `console.log` report matches only
`collidingHistoryKey` or `collidingLiveId`, so a values-collision would suffix
the id **silently**. That is precisely the gap #2085's review round 2 (M4)
already closed once for the live-id case, and plan 278's invariant 8 states the
report fires whenever the avoidance fires. The report therefore gains a third
branch in this same change, or the same defect recurs in a new place.

### 8. #2133 — destroy the reject's two writes together

**The invariant:** a reject writes two things — the `rejectedPairs` entry and a
one-sided `notLinkedTo` edge on `cast.json`. They are created together and must
be destroyed together.

`analysis.ts:229` and `cast-merge.ts:223` stop discarding
`RetireCharacterIdResult.droppedSelfLoopRejections` and remove the matching edge
via the existing `removeNotLinkedTo` helper (`cast-reject-orphan.ts:634`, which
the undo path already uses — this reuses tested machinery rather than inventing
a teardown).

Why dropping the decision is right here rather than merely convenient: a
self-loop arises only when the pair says "X is not Y" and then **Y retires into
X**, i.e. `retireCharacterId`'s own invariant now asserts Y and X are the same
person. The retirement is the newer and more authoritative statement, and the
surviving edge would name the row's own id. The decision has been contradicted,
not merely inconvenienced.

**Lock constraint.** The edge lives on `cast.json`. The cast-lock rules forbid a
locked function calling another locked function on the same book, so the removal
folds into the `cast.json` write the caller already performs — never a second
`withCastLock`.

**One thing the tests must settle empirically:** whether the edge survives the
merge at all depends on whether Y's row is *renamed* (data carries over) or
*discarded* in favour of X's row. This is unverified. If a given path discards
the row, the fix is a no-op there and the test records that fact rather than
asserting a phantom.

## Back-compat

**There is no migration, and day-one output is byte-identical to today's.**
Every existing `cast-id-history.json` is schema 1 with no `recordedAt`; every
existing segments file has no `castResolverVersion`. Both read as `'unknown'`,
so every currently-listed row stays listed. The list only begins shrinking as
new writes accumulate — which is what makes "unknown ⇒ listed" safe to ship
against a real workspace.

## Error handling

`loadCastIdHistory` keeps its never-throws guarantee. A malformed `recordedAt`
degrades the whole file to the empty-history default (the existing all-or-
nothing behaviour), which means no timestamps, which means everything unknown,
which means everything listed. Fail-closed at every level.

## Test plan

Every assertion below is mutated on its own line during implementation to prove
it can fail before it is trusted.

**Server (Vitest)**

- `cast-id-history.test.ts` — `recordedAt` stamped on write; deleted by
  `forgetSupersededId`, `dropSupersededIdsReclaimedByLiveCast`, and the
  direct-reversal branch; **preserved** across the repoint loop; the
  `keys(recordedAt) ⊆ keys(supersededBy)` invariant after scripted sequences;
  a malformed `recordedAt` not discarding a good `supersededBy`.
- The syntactic mutation-site guard, **with its neutralisation proof**.
- `cast-audio-currency.test.ts` — the predicate's full truth table, with each of
  the three unknown sources asserted to **list, not clear**, and an unparseable
  `synthesizedAt` asserted explicitly.
- `cast-resolve.test.ts` — `matchedHistoryKey` is the matched key, not the
  queried id, for a `'normalised-history'` hit.
- `segments-io.test.ts` — `audioCurrent` present and correct on the fallback map;
  `resolution` unchanged.
- `cast-create` route test — the full #2110 chain through the **real route**:
  retire → the target dropped by re-analysis → re-create by name → assert no
  tier-2 attachment, and assert the new report branch fires.
- #2133 — the self-loop drop removes the edge; both callers stop discarding;
  the rename-vs-discard question settled by the test.

**Scripts**

- `repair-cast-id-drift.test.mjs` — a re-rendered chapter drops off the list; an
  un-re-rendered one stays; a timestamp-less entry stays; a
  `castResolverVersion`-less segments file stays.

**Frontend (Vitest + Playwright)**

- `cast.test.tsx` — the three-way banner split; the actionable count visible in
  the collapsed state.
- `e2e/orphaned-character-fallback-banner.spec.ts` — extended for the split.
  Required: this crosses router/redux/layout seams, which is CLAUDE.md's e2e bar.

## On-box acceptance

#2128's acceptance — "the list clears as the operator works through it" — is
only provable by re-rendering a real chapter on the box, so acceptance is owed
and **its recording is a merge gate** (the running is not).

- A row in `docs/testing/onbox-acceptance-register.md`, grouped under the same
  hardware prerequisite as A33.
- Criteria in `docs/testing/cast-id-drift-onbox-acceptance.md`.
- `docs/testing/onbox-acceptance-register-live-view.html` edited and republished
  to the URL recorded in the register header — never the `.md`, never without
  the `url`. `npm run check:onbox-register -- --against-published <saved copy>`
  run immediately beforehand.

## Documentation

- **Plan 278** — a new invariant (a `supersededBy` entry and its `recordedAt`
  are written and destroyed together; `'unknown'` never clears); invariant 8
  amended for the widened taken set and the third report branch; #2133's chosen
  semantics recorded, as its acceptance requires; `castResolverVersion` noted as
  the tier-existence discriminator.
- **`docs/release-notes-next.md`** and **`RELEASE_NOTES.md`** — the re-render
  list now shrinks as the work gets done, and the Cast screen stops reporting
  "nothing to do" for audio that needs a re-render.
- **#2129's wrong premise** recorded on the issue and here, so it is not quietly
  dropped and re-filed later.

## Out of scope

- Rewriting frozen `segments.json` files to migrate ids — plan 278 invariant 6
  stands.
- Any change to `resolution`'s three values or to the reject/undo chips.
- Pruning dangling `supersededBy` entries (see §7).
- A second candidate ranker on any surface — plan 278 invariant 7 stands.

## Handover

Implementation is a separate thread. Its inputs are the plan doc produced from
this spec plus a handover-brief comment on each of #2110, #2129, #2133 and
#2128. This document is the design of record; the plan holds the task breakdown.
