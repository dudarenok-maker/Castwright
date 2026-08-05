# Cast-identity follow-ups — #2110, #2129, #2133, #2128

> Design of record for the four #2040 follow-up bugs shipped as one lane.
> Status: approved 2026-08-06; revised twice the same day (see "Review history").
> Implementation plan and the per-issue handover brief are separate artifacts
> (see "Handover").
> Parent plan: [`docs/features/278-cast-character-identity.md`](../../features/278-cast-character-identity.md).

## Why one lane

The four issues are independent defects but share one surface: the cast-identity
seam introduced by #2040 — `cast-id-history.json`, `buildCastResolver`,
`collectOrphanedCharacterFallbacks`, the Cast banner, and
`scripts/repair-cast-id-drift.mjs`. Shipping them separately would mean four
reviews of the same files and four chances to reintroduce each other's defects.
#2129 in particular spans frontend and server and cannot be reasoned about from
either side alone.

Two of the four (#2129, #2128) share a root cause and a fix; the other two
(#2110, #2133) are self-contained and ride the lane for the shared review, not
because they are blocked by it.

**This lane carries no accepted limitations.** An earlier revision deferred three
known holes to follow-up issues; all three are fixed here, and two of the fixes
made the design smaller rather than larger (see "Review history").

## Prerequisite — not part of this lane

`feat/server-2040-reject-scope-undo` must be pushed, reviewed as a whole branch,
PR'd and merged **before** this lane starts. It is 35 commits ahead of `main`
and unpushed as of 2026-08-06, and it rewrites every file this lane touches:
`cast-id-history.ts` (+375), `cast-resolve.ts` (+213), `cast.tsx` (+197),
`segments-io.ts` (+73), `repair-cast-id-drift.mjs` (+144).

**#2133 does not exist on `main` at all.** `rejectedPairs`,
`repointRejectedPairs`, `RetireCharacterIdResult` and `restoreSupersededId` are
entirely that branch's code.

**Citation convention.** Everything below is designed against the merged result,
so **every `file:line` reference is against `feat/server-2040-reject-scope-undo`**
unless marked `(main)`. An earlier revision mixed the two and gave `main` line
numbers for a tree the implementer will not be standing in.

## Premise verification (2026-08-06)

| Issue | Premise | Verdict |
|---|---|---|
| #2110 | `cast-create`'s taken set excludes `supersededBy` values | **True** — `cast-create.ts:126-129` |
| #2129 | Banner and repair pass give opposite answers for the same id | **True** — see below |
| #2129 | A stale "don't contradict the Cast banner" comment survives in `planBookRepairs` | **Already discharged** — see below |
| #2133 | A dropped self-loop rejection orphans its `notLinkedTo` edge | **True** |
| #2128 | No per-entry marker exists to compare a render against | **True** — `supersededBy` is `Record<string, string>` |

### #2129's second premise — already discharged, not false

**The comment existed, verbatim.** `511c5382` (2026-08-05) added it to
`planBookRepairs` as the justification for the `autoReconciled` branch:

> `// resolver's own normalised-id tier (the Cast banner already shows`
> `// it under "auto-reconciled", not "needs your decision"). Reporting`
> `// that case … is FALSE — it contradicts the banner …`

`30456c71` (2026-08-05) — the #2107 widening — deleted the `autoReconciled`
bucket and the comment with it. #2129 was filed against the pre-widening tree.
Both commits are ancestors of `main`.

**Disposition:** discharged as *already done*. The surviving comment in the same
function (`:1131-1146`) is accurate today — but see §5, which changes the
invariant it states and therefore must update it.

> A prior revision of this spec recorded this premise as **false**, on the
> strength of a `git log -S"Cast banner"` misread as empty when it in fact
> returned the two commits above. Recorded rather than silently corrected,
> because the premise-verification section is precisely what a later reader
> trusts without re-checking.

### The divergence #2129 is actually about

`segments-io.ts:388-392` tags a `'history'` or `'normalised-history'` resolution
as `'alias'`; `cast.tsx:304-309` files anything `!== 'unresolved'` under a
collapsed disclosure headed "N character ids auto-reconciled". Meanwhile
`buildOrphansFromSegments` (post-#2107) exempts **only** `'exact'`, so those same
ids are listed as damage needing a re-render. An operator reading the Cast screen
sees "auto-reconciled, nothing to do" for `the-torment` while the repair pass
lists 67 of its segments as needing work.

## Architectural spine: one comparator, two callers

**The root cause of #2129 is not the word "auto-reconciled".** It is that the
banner and the repair pass each answer "is this id fine?" with independently
written logic. Relabelling leaves that intact and lets the two drift apart again
at the next change.

Plan 278's invariant 7 already established this principle for candidate
*ranking* — "two independent rankers is the exact duplicate-matching-logic defect
class Task 16's CRITICAL finding came from". This lane extends it to *currency*:
a single exported predicate, called by both surfaces. The labels change as a
consequence of the predicate existing, not instead of it.

## Design

### 1. The persisted schema

```ts
export interface CastIdHistory {
  schema: 1;                                  // unchanged
  supersededBy: Record<string, string>;
  displaced?: Record<string, string>;
  rejected?: string[];
  rejectedPairs?: RejectedPair[];
  /** #2128 — monotonic per-book counter, incremented on every write. */
  seq?: number;
  /** #2128 — the `seq` at which each key's CURRENT target was established.
   *  This is the authoritative value the currency predicate compares. */
  recordedAtSeq?: Record<string, number>;
  /** #2128 — human-readable companion for operator diagnostics.
   *  NEVER compared; the predicate reads `recordedAtSeq` only. */
  recordedAtIso?: Record<string, string>;
}
```

**Additive-optional, `schema` stays 1.** This matches the module's three existing
optional fields; each of their doc comments promises "never bumps `schema`" and
"an old reader that doesn't know this key still works". Retyping `supersededBy`
to carry the marker inline was considered — it makes desync structurally
impossible — and rejected: it forces a real migration, reworks
`loadCastIdHistory`'s validation, and touches every read site across the server,
the repair script and their tests in one diff, for a sync property a guard test
can hold instead.

Each new field gets its own conjunct in `loadCastIdHistory`. **This does not
isolate its failure.** `loadCastIdHistory` is all-or-nothing by design
(`cast-id-history.ts:145-169`): any failing conjunct falls through to one
`console.warn` and the empty-history default. A malformed new field therefore
degrades the **whole file** — no aliases at all, so every affected id resolves as
a genuine miss and is listed. That is fail-closed, and preserving it is required
by #2128's acceptance ("its validation is all-or-nothing and never throws — don't
regress that"). Do **not** rewrite it into per-field validation.

#### Why a counter and not a timestamp

An earlier revision compared wall-clock times and accepted cross-machine clock
skew as a residual risk. A counter removes the risk instead of tolerating it:
**both sides of the comparison are drawn from the same file's own counter**, so
no clock is involved and skew is structurally irrelevant. It also removes a
second hole — a long chapter render whose alias is recorded mid-render — because
the render stamps *the state it actually resolved against* rather than an
approximate start time.

`recordedAtIso` exists purely so an operator hand-inspecting
`cast-id-history.json` during a repair run (an active workflow — see A33) can
tell *when*, not merely *in what order*. The names carry the rule: `…Seq` is
authoritative, `…Iso` is display.

#### The uniform stamp rule

**Every write to `supersededBy[k]` stamps `recordedAtSeq[k]` and
`recordedAtIso[k]`. Every delete of `supersededBy[k]` deletes both. Every write
increments `seq` first.** No exceptions except the one named below.

`recordedAtSeq[k]` therefore means **"the seq at which this key's *current*
target was established"** — not "when the alias was first recorded". That
distinction is what closes the merge-repoint hole:

> `cast-merge.ts:230` retires `sourceId` into `targetId` after merging, and the
> repoint loop (`cast-id-history.ts:317-321`) rewrites every entry whose value
> was `sourceId`. Same *person*, different *cast row* — `targetId`'s
> `voiceId`/`overrideTtsVoices` is whichever row won the merge. A render made
> while the alias pointed at `sourceId` used `sourceId`'s voice, so its bytes are
> stale. Under the uniform rule the repoint restamps, the render's seq is now
> lower, and the row lists. An earlier revision deliberately *preserved* the
> original stamp here and was wrong.

The five mutation sites, all now uniform:

- **`retireCharacterId`** — the entry it writes (stamp).
- **`retireCharacterId`'s direct-reversal branch** (`:291-298`) — deletes
  `supersededBy[to]` (delete both) and writes `supersededBy[from]` (stamp), and
  its own repoint writes (stamp).
- **`retireCharacterId`'s repoint loop** (`:317-321`) — every key it rewrites
  (stamp).
- **`forgetSupersededId`** (`:475-491`) — deletes one key (delete both), **and
  stashes them** (below).
- **`dropSupersededIdsReclaimedByLiveCast`** (`:417`) — deletes reclaimed keys
  (delete both). Nothing is preserved into `displaced`: it has zero readers
  outside this module, so a marker there would protect nothing.
- **`restoreSupersededId`** (`:497`) — **the one exception.**

`RejectedPair` gains `forgotRecordedAtSeq?: number` and `forgotRecordedAtIso?:
string`, stashed alongside the existing `forgotSupersededTo` when a reject
forgets an alias, and replayed verbatim by `restoreSupersededId` on undo. It
restores rather than stamps because it re-establishes the *same* target that was
forgotten — exactly parallel to `forgotSupersededTo`, and correct for the same
reason: renders made while that alias was live were right, and restamping would
needlessly re-list them. Without the stash, `forgetSupersededId` destroys the
only copy and the undo restores an unmarked entry — the lossy-undo defect
`forgotSupersededTo` (D6, `:100-104`) was invented to close, one level down.

Three tests hold the sync property:

1. **Bidirectional key equality** after every scripted mutation sequence run from
   an empty history — `keys(recordedAtSeq) === keys(supersededBy)`. A
   one-directional `⊆` is satisfied by a *missing* marker and so cannot catch
   `restoreSupersededId`.
2. **Monotonicity** — `seq` strictly increases across every write, and no
   `recordedAtSeq` value ever exceeds the file's `seq`.
3. **A syntactic guard**, in the shape of
   `server/src/workspace/cast-lock.guard.test.ts`, failing the build when a new
   `supersededBy` mutation site appears without a paired stamp — and, **scanning
   `server/src`, `scripts` and `src`**, when any indexed write to `supersededBy`
   or `recordedAtSeq` appears *outside this module at all*. That external
   property is true today (verified 2026-08-06: only reads exist outside, at
   `cast-create.ts:171,179` and in a script test), so the guard pins a real
   property rather than aspiring to one — which is what makes the repair
   script's own `--apply` writes safe, since they go through the choke point
   (`repair-cast-id-drift.mjs:2632` calls the real `retireCharacterId` via
   `server/dist`). The guard ships with a neutralisation proof and states its
   remaining blind spot: it is call-graph-blind.

Legacy files have no markers for their existing keys; equality is asserted for
sequences the new code wrote, not for what is already on disk. The back-fill
clause in §3 is what makes those legacy entries resolvable.

### 2. The render-side stamp — `castHistorySeq`

Two problems make `synthesizedAt` unusable as the render-side anchor.

**It does not mean what it looks like it means.** `finalizeChapterAudioWrite` is
the sole writer of `<slug>.segments.json` and unconditionally refreshes
`synthesizedAt`, but it has **three** callers and only one is a full chapter
render: `routes/generation.ts`, `routes/chapter-qa-repair.ts:689` and
`routes/chapter-splice.ts:483`. A one-sentence QA repair or a single splice
rewrites the whole file and refreshes the whole-file stamp while leaving every
other segment's audio byte-identical. Anchoring on it would clear a row whose
audio is still wrong — the false-negative direction #2107 exists to prevent.

**It cannot speak to the `'normalised-id'` tier at all.** That tier has no
history entry. Its hazard is different in kind: not "the alias postdates the
render" but "the render predates the resolver existing at all" — pre-Wave-1,
`resolveGroup` did a bare `castById.get()` and substituted the narrator
regardless of tier. Per register row A32 this covers `the-torment` (67 segments)
and `lightning-dave` (1 segment) — **68 of the 188 known damaged segments**, the
single largest block.

So the lane introduces **one** field of its own and leaves `synthesizedAt` and
its other consumers untouched:

> **`castHistorySeq: number`** — the `seq` of the `cast-id-history.json` state
> this render actually resolved against.

This is available for free. `generation.ts:1630` loads the history and passes it
to `synthesiseChapter` at `:1631-1634`; `synthesise-chapter.ts:1510` builds the
resolver from it **once** per chapter. The same route scope calls
`finalizeChapterAudioWrite`, so the seq threads straight through. The
`castIdHistory` parameter's `Pick<…>` (`synthesise-chapter.ts:584`) widens to
include `seq`.

**Its presence also proves the resolver existed**, which is why no separate
`castResolverVersion` field is needed: a render that read the history and built
the resolver is by construction a render that had all four tiers. An earlier
revision carried two fields here; one suffices.

**Only the full-render path writes it.** `chapter-qa-repair.ts` and
`chapter-splice.ts` **carry the prior file's value forward verbatim**, or omit it
when the prior file had none. Carrying an older value forward is fail-closed —
the row stays listed — and it makes laundering a stale row through a partial
rewrite impossible.

The field is supplied by the caller, so the type to change is the strict write
view **`ChapterSegmentsFile`** (`finalize-chapter-write.ts:50`) as well as the
loose read view `SegmentsFile` (`segments-io.ts:51`); the former's doc notes it
mirrors a third local copy in `generation.ts`, which the plan must update too.

### 3. The predicate

`isAudioCurrent(resolution, segmentsFile, history) → true | false | 'unknown'`,
pure and I/O-free, in `server/src/store/cast-audio-currency.ts`. The repair
script imports it from `server/dist` exactly as `main()` already imports
`buildCastResolver` and `normaliseForMatch`.

| `resolution.via` | Result |
|---|---|
| `'exact'` | `true` — unchanged from #2107 |
| `'normalised-id'` | `castHistorySeq` absent → `'unknown'`; else `true` |
| `'history'` / `'normalised-history'` | see below |
| no resolution | not applicable — a genuine miss is `'unresolved'` and always damage |

For the two alias tiers, in order:

1. `castHistorySeq` absent or not a finite number → `'unknown'`.
2. **Counter-reset guard** — `history.seq` absent, or `history.seq <
   castHistorySeq` → `'unknown'` for every alias-tier row in this book. A render
   cannot have read a *future* state of this file, so a lower file counter means
   the file was rebuilt after corruption and the counter restarted. Without this
   the rebuilt file's low `recordedAtSeq` values would compare as older than
   every pre-existing render and clear rows wholesale.
3. `recordedAtSeq[matchedHistoryKey]` present and finite →
   `castHistorySeq >= recordedAtSeq[key]`.
4. `recordedAtSeq[matchedHistoryKey]` **absent** → **back-fill clause**:
   `true` (`castHistorySeq` is already known present from step 1).
5. `recordedAtSeq[matchedHistoryKey]` present but not a finite number →
   `'unknown'`.

**Damage is anything other than `true`.**

#### Why the back-fill clause is sound

`recordedAtSeq` is written only by this lane's code, so an alias with no entry
necessarily predates the lane. `castHistorySeq` is likewise written only by this
lane's code, so a render carrying it necessarily postdates the lane. Render >
lane > alias, so the audio is current.

This is the one place the design clears on the **absence** of evidence, and it
does so because the absence itself carries information. It is also what makes
#2128 work at all: nothing rewrites an existing `supersededBy` entry — the repair
script's "already recorded" skip prevents it and `restoreSupersededId` refuses
when the key exists — so without this clause **every alias already on disk stays
listed forever regardless of re-rendering**, and #2128 ships without meeting its
own acceptance criterion on the only workspace that matters.

Its soundness depends on `restoreSupersededId` replaying a stashed marker (§1). A
post-lane restore that wrote an unmarked entry would falsify the premise.

#### Per-tier discriminators do not swap

`recordedAtSeq` cannot speak to `'normalised-id'` — no entry exists, so the
presence of `castHistorySeq` is the whole test. On the alias tiers presence alone
must never be *sufficient* except via the back-fill clause, because an alias can
be established after a perfectly modern render.

#### The unknown rule

**A missing `castHistorySeq`, a missing or lower `history.seq`, and a
non-finite marker on either side each read as `'unknown'`, and `'unknown'` is
listed as damage.** Only an affirmative comparison — or the back-fill clause —
clears a row.

Inverting this is the most dangerous mistake available in this lane; #2128 says
so explicitly ("getting that backwards silently re-opens #2107"). Each unknown
source gets its own test asserting it **lists**, not clears.

#### Cross-chapter aggregation

`isAudioCurrent` is per-segments-file, because the stamp is. But
`collectOrphanedCharacterFallbacks` builds `out[s.characterId]` across **all**
chapters (`segments-io.ts:366-397`), so an id current in ch2 and stale in ch5
needs a single verdict. The rule is fail-closed and must be stated, because
getting it wrong in the "any-current ⇒ `true`" direction re-opens #2107 on the
banner side:

> `false` if **any** chapter is `false`; else `'unknown'` if **any** is
> `'unknown'`; else `true`.

### 4. Resolver change — `matchedHistoryKey`

The alias tiers need the raw history key to look up `recordedAtSeq`.
`CastResolution` carries `viaAlias`, but `cast-resolve.ts:173/185/192` sets it to
the **queried** id in all three non-exact branches, and for a
`'normalised-history'` hit the matched key is a different spelling.

**This is not an additive change.** `byNormHistory` is built as
`put(byNormHistory, normaliseIdKey(from), target)` (`:105`) — it stores the
target character only and discards the raw `from`. Recovering it means changing
the map's value type and the `put` collision helper, which compares `.id`.

**It is also ambiguous by construction.** `put` nulls the entry only on
*differing* targets, so two raw keys that normalise identically and point at the
**same** target collapse into one entry backed by two markers, with
`Object.entries(supersededBy)` iteration order silently picking one.

**Tie-break: the highest `recordedAtSeq` among the colliding keys.** A higher seq
makes `castHistorySeq >= recordedAtSeq` harder to satisfy, so this is the
fail-closed choice. Pinned by its own test.

### 5. #2128 — the repair pass clears

`buildOrphansFromSegments` takes the history and replaces its `via === 'exact'`
skip with `isAudioCurrent(...) === true`. Its doc comment's warning carries over
in form: `orphans` being empty for an id must mean **affirmatively current**,
never merely "the resolver returned something".

**This is not a local change, and an earlier revision wrongly said it was.**
`orphans` feeds `planBookRepairs`, whose zero-segment branch carries an explicit
invariant (`repair-cast-id-drift.mjs:1131-1157`): *"Only `'exact'` skips `orphans`
now … so `orphan.segments === 0` here can only mean one thing: this id genuinely
has zero rendered segments anywhere in the book."* Once a *current* id also skips
`orphans`, that is false, and such an id is emitted with the now-wrong reason
`"…but this id has zero rendered segments — no damage to repair"` **and drops out
of `autoRecord` entirely**.

That is the `autoReconciled`-bucket defect `511c5382` fixed and `30456c71`
deleted, resurrected one level down — and it would silently change what
`--apply` writes for exactly the ids the register measures as auto-recordable.

The plan must therefore decide and pin, with tests:

- whether an id that is affirmatively current is still **auto-recordable**;
- the reason string for a zero-segment row that is current rather than
  never-rendered;
- the updated wording of the `:1131-1146` comment, which this change makes stale.

### 6. #2129 — the banner splits

`OrphanedCharacterFallback` gains `audioCurrent: true | false | 'unknown'`,
aggregated per §3. The existing `resolution` field and its three values are
**untouched**, so the prerequisite branch's reject/undo chips and their tests are
unaffected.

`src/views/cast.tsx`'s single auto-reconciled disclosure becomes two, both
collapsed, each showing its count in its own header — so `N resolved · audio
needs a re-render` is legible **without expanding anything**. That is the direct
fix to "the operator sees *nothing to do*". Exact copy is for the plan; the
requirement is that the actionable count is visible while collapsed.

Both surfaces derive their verdict from `isAudioCurrent`, so they cannot
disagree.

### 7. #2110 — reserve the values

`cast-create.ts`'s taken set gains `...Object.values(history.supersededBy)`.
`takenNorm` derives from `takenIds`, so normalised coverage is free.

Cost, correctly scoped: `cast-create` does not *refuse* a taken id — it suffixes
(`антон` → `антон-2`) and creates the character with the requested **name**
intact. The issue's framing ("can never be reused by name, forever") overstates
it.

Pruning dangling entries instead (the issue's option 2) was considered and
rejected: a dangling entry is inert **only while its target is dead**, and
resumes protecting its segments if a later re-analysis re-mints that target.
Pruning destroys that; `displaced` would preserve the record but has no readers.

**One non-obvious consequence.** The route's `console.log` report matches only
`collidingHistoryKey` or `collidingLiveId`, so a values-collision would suffix
the id **silently**. That is the gap #2085's review round 2 (M4) already closed
once for the live-id case, and plan 278's invariant 8 states the report fires
whenever the avoidance fires. The report gains a third branch in this same
change, or the same defect recurs in a new place.

### 8. #2133 — destroy the reject's two writes together

**The invariant:** a reject writes two things — the `rejectedPairs` entry and a
one-sided `notLinkedTo` edge on `cast.json`. They are created together and must
be destroyed together.

Why dropping the decision is right rather than merely convenient: a self-loop
arises only when the pair says "X is not Y" and then **Y retires into X**, i.e.
`retireCharacterId`'s own invariant now asserts Y and X are the same person. The
retirement is the newer and more authoritative statement, and the surviving edge
would name the row's own id.

**The plumbing is the hard part, and an earlier revision described it wrongly.**
"Folds into the `cast.json` write the caller already performs" is true at neither
caller:

- **`cast-merge.ts`** — the handler holds `withCastLock` from `:88`; the
  authoritative `writeJsonAtomic(castJsonPath(...))` is at `:209`;
  `retireCharacterId` is at `:230`, **after** it, and its own comment refuses
  relocation ("Kept HERE rather than moved after the cache update: the position
  is correct"). There is no later write to fold into.
- **`analysis.ts`** — `retireCharacterId` is called once, at `:230`, inside
  `recordRetirements`, which has **eight** call sites (`:2896, :4914, :4915,
  :4925, :5438, :6176, :6177, :6187`), each with a different cast.json write
  context.

**The shape:** `recordRetirements` returns the dropped self-loop pairs to its
caller, and the edge removal is a **second `writeJsonAtomic` inside the
`withCastLock` the caller already holds**. The cast-lock rules ban a locked
function calling another locked function on the same book — they do not ban two
writes under one lock — so a dedicated locked helper is exactly what must *not*
be used here.

**The helper needs promoting.** It is `removeNotLinked`
(`cast-reject-orphan.ts:639`), not `removeNotLinkedTo`, and it is
**module-private** and documented as a deliberate local copy. Exporting it, or
promoting `cast-not-linked-to.ts`'s equivalent, is in scope.

**One thing the tests must settle empirically:** whether the edge survives the
merge at all depends on whether Y's row is *renamed* (data carries over) or
*discarded* in favour of X's row. This is unverified. If a path discards the row,
the fix is a no-op there and the test records that rather than asserting a
phantom.

## Ordering against A33

The owed A33 `--apply` run may happen before or after this lane; neither order
breaks anything. If `--apply` runs first, the 68 `'normalised-id'` segments become
unmarked `'history'` entries, and the back-fill clause covers them because their
eventual re-render will carry `castHistorySeq`.

## Back-compat

**There is no migration, and day-one output is byte-identical to today's.** Every
existing `cast-id-history.json` is schema 1 with no counter; every existing
segments file has no `castHistorySeq`. Every currently-listed row therefore stays
listed until a chapter is re-rendered under this lane's code. That is what makes
the design safe to ship against a real workspace, and the back-fill clause is
what lets those rows clear at all.

`loadCastIdHistory` returns `seq: 0` for a file that has none, and the first
write sets `seq: 1`.

## Test plan

Every assertion is mutated on its own line during implementation to prove it can
fail before it is trusted.

**Server (Vitest)**

- `cast-id-history.test.ts` — markers stamped on every `supersededBy` write
  including **the repoint loop and the direct-reversal branch**; deleted by
  `forgetSupersededId` and `dropSupersededIdsReclaimedByLiveCast`; **replayed by
  `restoreSupersededId` from the stash**; bidirectional key equality; `seq`
  strictly increasing and never exceeded by any `recordedAtSeq`; a malformed new
  field collapsing the whole file to the empty default (the existing, required
  behaviour).
- **The merge-repoint regression** — an alias repointed by a merge onto a row
  with a different voice lists again, rather than reporting current. This is the
  test for the hole an earlier revision accepted as a limitation.
- The syntactic guard, **with its neutralisation proof**, including its
  external-write scan over `server/src`, `scripts` and `src`.
- `cast-audio-currency.test.ts` — the full truth table; each unknown source
  asserted to **list, not clear**; the back-fill clause; **the counter-reset
  guard**; the cross-chapter aggregation rule with two chapters disagreeing.
- `cast-resolve.test.ts` — `matchedHistoryKey` is the matched key, not the
  queried id, for `'normalised-history'`; the highest-seq tie-break when two raw
  keys normalise identically onto the same target.
- `finalize-chapter-write` / splice / QA-repair — the two partial writers carry
  the prior stamp forward and never refresh it. **This is the test that protects
  against the false-negative the whole §2 redesign exists to prevent.**
- `synthesise-chapter` / `generation` — the seq the render resolved against is
  the seq that reaches the segments file.
- `segments-io.test.ts` — `audioCurrent` present and correct; `resolution`
  unchanged.
- `cast-create` route test — the full #2110 chain through the **real route**:
  retire → target dropped by re-analysis → re-create by name → assert no tier-2
  attachment, and assert the new report branch fires.
- #2133 — the self-loop drop removes the edge; `recordRetirements` returns the
  dropped pairs; the rename-vs-discard question settled by the test.

**Scripts**

- `repair-cast-id-drift.test.mjs` — a re-rendered chapter drops off the list; an
  un-re-rendered one stays; an unmarked entry with no render stamp stays; an
  unmarked entry **with** a render stamp clears (back-fill); a book whose file
  counter is lower than a render's stamp reports unknown; and §5's
  `planBookRepairs` consequences — the zero-segment reason string and whether a
  current id stays auto-recordable.

**Frontend (Vitest + Playwright)**

- `cast.test.tsx` — the three-way banner split; the actionable count visible
  while collapsed.
- `e2e/orphaned-character-fallback-banner.spec.ts` — extended for the split.
  Required: this crosses router/redux/layout seams, CLAUDE.md's e2e bar.

## On-box acceptance

#2128's acceptance — "the list clears as the operator works through it" — is only
provable by re-rendering a real chapter on the box, so acceptance is owed and
**its recording is a merge gate** (the running is not).

- A row in `docs/testing/onbox-acceptance-register.md`, grouped under the same
  hardware prerequisite as A33.
- Criteria in `docs/testing/cast-id-drift-onbox-acceptance.md`.
- `docs/testing/onbox-acceptance-register-live-view.html` edited and republished
  to the URL recorded in the register header — never the `.md`, never without the
  `url`. `npm run check:onbox-register -- --against-published <saved copy>` run
  immediately beforehand.

## Documentation

- **Plan 278** — new invariants (a `supersededBy` entry and its markers are
  written and destroyed together, and `recordedAtSeq` tracks the *current*
  target's establishment, not the alias's first recording; `'unknown'` never
  clears; the render stamp is written only by the full-render path); invariant 8
  amended for the widened taken set and the third report branch; #2133's chosen
  semantics recorded, as its acceptance requires.
- **`docs/release-notes-next.md`** and **`RELEASE_NOTES.md`** — the re-render list
  now shrinks as the work gets done, and the Cast screen stops reporting "nothing
  to do" for audio that needs a re-render.
- **The #2129 premise correction** recorded on the issue, so the next reader who
  greps and finds `511c5382` is not misled.

## Out of scope

- Rewriting frozen `segments.json` files to migrate ids — plan 278 invariant 6
  stands.
- Any change to `resolution`'s three values or to the reject/undo chips.
- Pruning dangling `supersededBy` entries (§7).
- Per-segment currency stamping — the file-level stamp is sound here because §2
  confines it to the full-render path; a per-segment marker on 84,642 segments
  would buy nothing further.
- A second candidate ranker on any surface — plan 278 invariant 7 stands.

## Review history

**Revision 1 → 2** (adversarial `assumption-checker` pass). Folded: the
file-level `synthesizedAt` false-negative via the splice / QA-repair writers
(§2); pre-existing aliases being unable to ever clear (§3, back-fill);
`restoreSupersededId` as an unlisted mutation site and the lossy undo it implies
(§1); a contradiction over malformed-field handling (§1); `matchedHistoryKey`
being neither additive nor unambiguous (§4); the `planBookRepairs` zero-segment
invariant this lane breaks (§5); the #2133 plumbing being wrong at both callers
and the helper misnamed (§8); the missing cross-chapter aggregation rule (§3);
and the misread `git log` behind the #2129 premise verdict.

**Revision 2 → 3** (owner directive: fix the accepted limitations rather than
defer them). All three are now closed, and two of the fixes shrank the design:

- *Voice identity across a repointed alias* — closed by redefining
  `recordedAtSeq` as "when this key's current target was established", which
  makes the repoint loop restamp. Revision 2 preserved the original marker there
  and was wrong. The rule is now uniform across all five mutation sites, which
  is also easier to guard.
- *Clock skew between machines* — closed by comparing a per-book counter instead
  of wall-clock times. Both sides come from the same file's counter, so skew is
  structurally irrelevant rather than tolerated. This also closed the
  mid-render-alias window for free, since the render stamps the state it actually
  resolved against.
- *Guard scope blind to external writers* — closed by widening the syntactic
  guard to scan `server/src`, `scripts` and `src` for any indexed write outside
  the module.

Net effect on size: the render side went from two new fields to one
(`castResolverVersion` dropped — `castHistorySeq`'s presence already proves the
resolver existed), against one new counter and one display-only map on the
history file. One new fail-closed rule was added that revision 2 did not need:
the counter-reset guard.

## Handover

Implementation is a separate thread. Its inputs are the plan doc produced from
this spec plus a handover-brief comment on each of #2110, #2129, #2133 and #2128.
This document is the design of record; the plan holds the task breakdown.
