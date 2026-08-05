# Cast-identity follow-ups — #2110, #2129, #2133, #2128

> Design of record for the four #2040 follow-up bugs shipped as one lane.
> Status: approved 2026-08-06, revised the same day after an adversarial review
> (see "Review history"). Implementation plan and the per-issue handover brief
> are separate artifacts (see "Handover").
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
so **every `file:line` reference in this document is against
`feat/server-2040-reject-scope-undo`**, not `main`, unless a line is explicitly
marked `(main)`. An earlier revision mixed the two and gave `main` line numbers
for a tree the implementer will not be standing in.

## Premise verification (2026-08-06)

Each issue's premise was checked against the tree. Results:

| Issue | Premise | Verdict |
|---|---|---|
| #2110 | `cast-create`'s taken set excludes `supersededBy` values | **True** — `cast-create.ts:126-129` |
| #2129 | Banner and repair pass give opposite answers for the same id | **True** — see below |
| #2129 | A stale "don't contradict the Cast banner" comment survives in `planBookRepairs` | **Already discharged** — see below |
| #2133 | A dropped self-loop rejection orphans its `notLinkedTo` edge | **True** |
| #2128 | No per-entry timestamp exists to compare a render against | **True** — `supersededBy` is `Record<string, string>` |

### #2129's second premise — already discharged, not false

The issue's second acceptance criterion asks that a stale "don't contradict the
Cast banner" comment in `planBookRepairs` be corrected.

**That comment existed, verbatim.** `511c5382` (2026-08-05) added it to
`planBookRepairs` as the justification for the `autoReconciled` branch:

> `// resolver's own normalised-id tier (the Cast banner already shows`
> `// it under "auto-reconciled", not "needs your decision"). Reporting`
> `// that case … is FALSE — it contradicts the banner …`

`30456c71` (2026-08-05) — the #2107 widening — deleted the `autoReconciled`
bucket and the comment with it. #2129 was filed against the pre-widening tree.
Both commits are ancestors of `main`.

**Disposition:** the criterion is discharged as *already done*, and nothing
remains to correct. The surviving comment in the same function (`:1131-1146`) is
accurate today — but see §5, which changes the invariant it states and therefore
must update it.

> A prior revision of this spec recorded this premise as **false**, on the
> strength of a `git log -S"Cast banner"` that was misread as empty when it in
> fact returned the two commits above. Recorded here rather than silently
> corrected, because the premise-verification section is precisely the part a
> later reader trusts without re-checking.

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

**Additive-optional, `schema` stays 1.** This matches the module's three existing
optional fields; each of their doc comments promises "never bumps `schema`" and
"an old reader that doesn't know this key still works". Retyping `supersededBy`
to carry the timestamp inline was considered — it makes desync structurally
impossible — and rejected: it forces a real migration, reworks
`loadCastIdHistory`'s validation, and touches every read site across the server,
the repair script and their tests in one diff, for a sync property a guard test
can hold instead.

`recordedAt` gets its own `typeof === 'object' && !Array.isArray && !== null`
conjunct in `loadCastIdHistory`. **This does not isolate its failure.**
`loadCastIdHistory` is all-or-nothing by design (`cast-id-history.ts:145-169`):
any failing conjunct falls through to one `console.warn` and the empty-history
default. A malformed `recordedAt` therefore degrades the **whole file**, which
means no aliases at all, which means every row listed. That is fail-closed and
is the behaviour #2128's acceptance explicitly requires be preserved ("its
validation is all-or-nothing and never throws — don't regress that"). Do **not**
rewrite it into per-field validation.

#### Sync discipline — four functions, five mutation sites

- **`retireCharacterId`** stamps `recordedAt[from] = <now, ISO-8601>` for the
  entry it writes.
- **`retireCharacterId`'s direct-reversal branch** (`:291-298`) deletes
  `supersededBy[to]`, so it deletes `recordedAt[to]` in the same breath.
- **`retireCharacterId`'s repoint loop** (`:317-321`) rewrites **values** only.
  Keys keep their timestamps — but see "Accepted limitations" for the case where
  that is wrong and why it is accepted rather than fixed here.
- **`forgetSupersededId`** (`:475-491`) deletes one key ⇒ deletes its timestamp,
  **and stashes it** (below).
- **`dropSupersededIdsReclaimedByLiveCast`** (`:417`) deletes reclaimed keys ⇒
  deletes their timestamps. It does **not** preserve them into `displaced`:
  `displaced` has zero readers outside this module, so a timestamp there would
  protect nothing.
- **`restoreSupersededId`** (`:497`) — the reject-**undo** path — writes
  `supersededBy[id] = target` and must restore its timestamp too.

`RejectedPair` gains `forgotRecordedAt?: string`, stashed alongside the existing
`forgotSupersededTo` when a reject forgets an alias, and replayed by
`restoreSupersededId` on undo. Without it, `forgetSupersededId` destroys the only
copy of the timestamp and the undo restores a **timestamp-less** entry — which
would permanently un-clear rows the operator had already re-rendered. This is
exactly the lossy-undo defect `forgotSupersededTo` (D6, `:100-104`) was invented
to close, one level down.

Two tests hold the sync property, because a single one is blind in the direction
that matters:

1. **Bidirectional key equality** after every scripted mutation sequence run from
   an empty history — `keys(recordedAt) === keys(supersededBy)`. A one-directional
   `⊆` is satisfied by a *missing* timestamp and so cannot catch
   `restoreSupersededId`.
2. **A syntactic guard** over the module, in the shape of
   `server/src/workspace/cast-lock.guard.test.ts`, failing the build when a new
   `supersededBy` mutation site appears without a paired `recordedAt` mutation.
   **Its header states its own blind spots**, as the cast-lock guard's does: it
   is call-graph-blind, and it is scoped to this module — it will not see a
   future writer elsewhere. The guard ships with a neutralisation proof.

Legacy files predate all of this and have no `recordedAt` for their existing
keys; equality is asserted for sequences the new code wrote, not for what is
already on disk. The back-fill clause in §3 is what makes those legacy entries
resolvable.

### 2. The render-side stamp — `castRenderedAt` + `castResolverVersion`

Two problems make `synthesizedAt` unusable as the render-side anchor.

**It does not mean what it looks like it means.** `finalizeChapterAudioWrite` is
the sole writer of `<slug>.segments.json` and unconditionally refreshes
`synthesizedAt`, but it has **three** callers and only one is a full chapter
render: `routes/generation.ts`, `routes/chapter-qa-repair.ts:689` and
`routes/chapter-splice.ts:483`. A one-sentence QA repair or a single splice
rewrites the whole file and refreshes the whole-file stamp while leaving every
other segment's audio byte-identical. Anchoring on it would clear a row whose
audio is still wrong — the exact false-negative direction #2107 exists to
prevent.

**It cannot clear the `'normalised-id'` tier at all.** That tier has no history
entry and therefore no timestamp to compare against. Its hazard is different in
kind: not "the alias postdates the render" but "the render predates the resolver
existing at all" — pre-Wave-1, `resolveGroup` did a bare `castById.get()` and
substituted the narrator regardless of tier. Per register row A32 this covers
`the-torment` (67 segments) and `lightning-dave` (1 segment) — **68 of the 188
known damaged segments**, the single largest block.

So the lane introduces its **own** pair of fields, and leaves `synthesizedAt`
and its other consumers untouched:

- **`castRenderedAt: string`** — ISO-8601, the time the chapter render **started**.
  Start-time rather than completion-time deliberately: a re-analysis can record
  an alias while a long chapter is mid-render, and a start stamp is the
  fail-closed end of that window.
- **`castResolverVersion: number`** — the resolver generation that render used;
  `1` for the four-tier resolver. Bumped only when a new tier changes what a
  render resolves to.

**Only the full-render path writes them.** `generation.ts` supplies fresh values;
`chapter-qa-repair.ts` and `chapter-splice.ts` **carry forward the prior file's
values verbatim**, or omit them when the prior file had none. Carrying an older
value forward is fail-closed — the row stays listed — and it makes laundering a
stale row through a partial rewrite impossible.

The fields are supplied by the caller, so the type to change is the strict write
view **`ChapterSegmentsFile`** (`finalize-chapter-write.ts:50`) as well as the
loose read view `SegmentsFile` (`segments-io.ts:51`); the former's doc notes it
mirrors a third local copy in `generation.ts`, which the plan must update too.

A dated/SHA'd epoch constant in the repair script was considered and rejected:
nothing pins such a constant, and setting it too early silently re-opens #2107
while setting it too late over-reports forever.

### 3. The predicate

`isAudioCurrent(resolution, segmentsFile, history) → true | false | 'unknown'`,
pure and I/O-free, in `server/src/store/cast-audio-currency.ts`. The repair
script imports it from `server/dist` exactly as `main()` already imports
`buildCastResolver` and `normaliseForMatch`.

| `resolution.via` | Result |
|---|---|
| `'exact'` | `true` — unchanged from #2107 |
| `'normalised-id'` | `castResolverVersion` absent → `'unknown'`; else `true` |
| `'history'` / `'normalised-history'` | see below |
| no resolution | not applicable — a genuine miss is `'unresolved'` and always damage |

For the two alias tiers, in order:

1. `castRenderedAt` absent or unparseable → `'unknown'`.
2. `recordedAt[matchedHistoryKey]` present and parseable →
   `castRenderedAt >= recordedAt[key]`.
3. `recordedAt[matchedHistoryKey]` **absent** → **back-fill clause**:
   `castResolverVersion` present → `true`; else `'unknown'`.
4. `recordedAt[matchedHistoryKey]` present but **unparseable** → `'unknown'`.

**Damage is anything other than `true`.**

**Comparison is on parsed instants, not strings.** `Date.parse` on both sides,
with an explicit non-finite check on each; a bare `>=` between two strings is
lexicographic and diverges on a non-`Z` offset or differing fractional
precision, and both values are read from untrusted disk.

#### Why the back-fill clause is sound

`recordedAt` is written only by this lane's code. An alias with no timestamp
therefore necessarily predates the lane. `castResolverVersion` is likewise
written only by this lane's code, so a render carrying it necessarily postdates
the lane. Render > lane > alias, so the audio is current.

This is the one place the design clears a row on the **absence** of evidence, and
it is doing so because the absence itself carries information. It is also what
makes #2128 work at all: nothing rewrites an existing `supersededBy` entry — the
repair script's "already recorded" skip prevents it and `restoreSupersededId`
refuses when the key exists — so without this clause **every alias already on
disk stays listed forever, no matter how often the operator re-renders**, and
#2128 ships without meeting its own acceptance criterion on the only workspace
that matters.

Its soundness depends entirely on `restoreSupersededId` stamping a timestamp
(§1). A post-lane restore that wrote an untimestamped entry would make the
clause's premise false.

#### Per-tier discriminators do not swap

`recordedAt` cannot clear `'normalised-id'` — no entry exists. `castResolverVersion`
must not *gate* the alias tiers, because an alias can be recorded after a
perfectly modern render; gating there would keep a row listed even when
`recordedAt` proves it current, forcing the exact needless re-render #2128 exists
to stop. It appears on the alias tiers only as the back-fill **fallback** when no
timestamp exists — an OR, never an AND.

#### The unknown rule

**On the tier where each applies: a missing `castResolverVersion`, a missing or
unparseable `castRenderedAt`, and an unparseable `recordedAt` each read as
`'unknown'`, and `'unknown'` is listed as damage.** Only an affirmative
comparison — or the back-fill clause — clears a row.

Inverting this is the most dangerous mistake available in this lane; #2128 says
so explicitly ("getting that backwards silently re-opens #2107"). Each unknown
source gets its own test asserting it **lists**, not clears.

#### Cross-chapter aggregation

`isAudioCurrent` is per-segments-file, because the stamps are. But
`collectOrphanedCharacterFallbacks` builds `out[s.characterId]` across **all**
chapters (`segments-io.ts:366-397`), so an id current in ch2 and stale in ch5
needs a single verdict. The rule is fail-closed and must be stated because
getting it wrong in the "any-current ⇒ `true`" direction re-opens #2107 on the
banner side:

> `false` if **any** chapter is `false`; else `'unknown'` if **any** is
> `'unknown'`; else `true`.

### 4. Resolver change — `matchedHistoryKey`

The alias tiers need the raw history key to look up `recordedAt`. `CastResolution`
carries `viaAlias`, but `cast-resolve.ts:173/185/192` sets it to the **queried**
id in all three non-exact branches, and for a `'normalised-history'` hit the
matched key is a different spelling.

**This is not an additive change.** `byNormHistory` is built as
`put(byNormHistory, normaliseIdKey(from), target)` (`:105`) — it stores the
target character only and discards the raw `from`. Recovering it means changing
the map's value type and the `put` collision helper, which compares `.id`.

**It is also ambiguous by construction.** `put` nulls the entry only on
*differing* targets, so two raw keys that normalise identically and point at the
**same** target collapse into one entry backed by two `recordedAt` values, with
`Object.entries(supersededBy)` iteration order silently picking one.

**Tie-break: the latest of the colliding keys' timestamps.** A later `recordedAt`
makes `castRenderedAt >= recordedAt` harder to satisfy, so this is the
fail-closed choice. It is pinned by its own test.

### 5. #2128 — the repair pass clears

`buildOrphansFromSegments` takes the history and replaces its `via === 'exact'`
skip with `isAudioCurrent(...) === true`. Its doc comment's warning carries over
in form: `orphans` being empty for an id must mean **affirmatively current**,
never merely "the resolver returned something".

**This is not a local change, and the earlier revision of this spec wrongly said
it was.** `orphans` feeds `planBookRepairs`, whose zero-segment branch carries an
explicit invariant (`repair-cast-id-drift.mjs:1131-1157`): *"Only `'exact'` skips
`orphans` now … so `orphan.segments === 0` here can only mean one thing: this id
genuinely has zero rendered segments anywhere in the book."* Once a *current* id
also skips `orphans`, that is false, and such an id is emitted with the now-wrong
reason `"…but this id has zero rendered segments — no damage to repair"` **and
drops out of `autoRecord` entirely**.

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

**The plumbing is the hard part, and the earlier revision of this spec described
it wrongly.** "Folds into the `cast.json` write the caller already performs" is
true at neither caller:

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
promoting `cast-not-linked-to.ts`'s equivalent, is in scope for this change.

**One thing the tests must settle empirically:** whether the edge survives the
merge at all depends on whether Y's row is *renamed* (data carries over) or
*discarded* in favour of X's row. This is unverified. If a path discards the row,
the fix is a no-op there and the test records that rather than asserting a
phantom.

## Accepted limitations

Stated rather than fixed, each because fixing it is materially larger than this
lane. Each gets a test pinning the behaviour so it is known rather than
discovered.

1. **A merge can change the voice behind a repointed alias.** The repoint loop
   preserves the original `recordedAt` on the argument that a repointed entry
   still names the same *person*. Same person, different *cast row*:
   `cast-merge.ts:230` retires `sourceId` into `targetId` after merging, and
   `targetId`'s `voiceId`/`overrideTtsVoices` is whichever row won. A render made
   while the alias pointed at `sourceId` used `sourceId`'s voice, so its bytes
   are stale while the predicate reports current. Restamping on a voice-identity
   change is the fix and is deferred; filed as a follow-up issue in the same
   round.
2. **Clock skew between machines.** `recordedAt` and `castRenderedAt` may be
   stamped on different boxes. The gap the comparison measures is normally hours
   or days and skew is normally seconds, so this is accepted — but it is an
   assumption, not a guarantee, and it is why the render side is compared with
   `>=` rather than a tight window.
3. **The repair script is a `recordedAt` producer, not only a reader.**
   `--apply` calls the real `retireCharacterId` through `server/dist`
   (`repair-cast-id-drift.mjs:2632`), so it stamps timestamps. The §1 syntactic
   guard is module-scoped and will not see a future script-side write; its header
   says so.

**Not a limitation, worth stating:** the ordering of this lane against the owed
A33 `--apply` run does not matter. If `--apply` runs first, the 68
`'normalised-id'` segments become untimestamped `'history'` entries — and the
back-fill clause covers them, because their eventual re-render will carry
`castResolverVersion`.

## Back-compat

**There is no migration, and day-one output is byte-identical to today's.** Every
existing `cast-id-history.json` is schema 1 with no `recordedAt`; every existing
segments file has no `castRenderedAt`/`castResolverVersion`. Every currently-listed
row therefore stays listed until a chapter is re-rendered under this lane's code.
That is what makes the design safe to ship against a real workspace, and the
back-fill clause is what makes those rows able to clear at all.

## Test plan

Every assertion is mutated on its own line during implementation to prove it can
fail before it is trusted.

**Server (Vitest)**

- `cast-id-history.test.ts` — `recordedAt` stamped on write; deleted by
  `forgetSupersededId`, `dropSupersededIdsReclaimedByLiveCast` and the
  direct-reversal branch; preserved across the repoint loop; **restored by
  `restoreSupersededId` from `forgotRecordedAt`**; bidirectional key equality
  after scripted sequences; a malformed `recordedAt` collapsing the whole file to
  the empty default (the existing, required behaviour).
- The syntactic mutation-site guard, **with its neutralisation proof**.
- `cast-audio-currency.test.ts` — the full truth table; each unknown source
  asserted to **list, not clear**; the back-fill clause; unparseable
  `castRenderedAt` **and** unparseable `recordedAt`; the cross-chapter
  aggregation rule with two chapters disagreeing.
- `cast-resolve.test.ts` — `matchedHistoryKey` is the matched key, not the
  queried id, for `'normalised-history'`; the latest-timestamp tie-break when two
  raw keys normalise identically onto the same target.
- `finalize-chapter-write` / splice / QA-repair — the two partial writers carry
  the prior stamps forward and never refresh them. **This is the test that
  protects against the false-negative the whole §2 redesign exists to prevent.**
- `segments-io.test.ts` — `audioCurrent` present and correct; `resolution`
  unchanged.
- `cast-create` route test — the full #2110 chain through the **real route**:
  retire → target dropped by re-analysis → re-create by name → assert no tier-2
  attachment, and assert the new report branch fires.
- #2133 — the self-loop drop removes the edge; `recordRetirements` returns the
  dropped pairs; the rename-vs-discard question settled by the test.

**Scripts**

- `repair-cast-id-drift.test.mjs` — a re-rendered chapter drops off the list; an
  un-re-rendered one stays; a timestamp-less entry with no resolver stamp stays;
  a timestamp-less entry **with** a resolver stamp clears (the back-fill clause);
  and the `planBookRepairs` consequences of §5 — the zero-segment reason string
  and whether a current id stays auto-recordable.

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

- **Plan 278** — new invariants (a `supersededBy` entry and its `recordedAt` are
  written and destroyed together; `'unknown'` never clears; the currency stamps
  are written only by the full-render path); invariant 8 amended for the widened
  taken set and the third report branch; #2133's chosen semantics recorded, as
  its acceptance requires.
- **`docs/release-notes-next.md`** and **`RELEASE_NOTES.md`** — the re-render list
  now shrinks as the work gets done, and the Cast screen stops reporting "nothing
  to do" for audio that needs a re-render.
- **The #2129 premise correction** recorded on the issue, so the next reader who
  greps and finds `511c5382` is not misled.
- **A follow-up issue** for accepted limitation 1 (voice identity across a
  repointed alias), filed in the same round per CLAUDE.md's backlog rule.

## Out of scope

- Rewriting frozen `segments.json` files to migrate ids — plan 278 invariant 6
  stands.
- Any change to `resolution`'s three values or to the reject/undo chips.
- Pruning dangling `supersededBy` entries (§7).
- Per-segment currency stamping (§2) — considered and deferred as materially
  larger than this lane.
- A second candidate ranker on any surface — plan 278 invariant 7 stands.

## Review history

Revised 2026-08-06 after an adversarial `assumption-checker` pass, which found
and this revision folds in: the file-level `synthesizedAt` false-negative via the
splice / QA-repair writers (§2); pre-existing aliases being unable to ever clear
(§3, back-fill); `restoreSupersededId` as an unlisted fourth mutation site and
the lossy-undo it implies (§1); a direct contradiction over malformed-`recordedAt`
handling (§1); `matchedHistoryKey` being neither additive nor unambiguous (§4);
the `planBookRepairs` zero-segment invariant this lane breaks (§5); the #2133
plumbing being wrong at both callers and the helper misnamed (§8); the missing
cross-chapter aggregation rule (§3); and the misread `git log` behind the #2129
premise verdict.

## Handover

Implementation is a separate thread. Its inputs are the plan doc produced from
this spec plus a handover-brief comment on each of #2110, #2129, #2133 and #2128.
This document is the design of record; the plan holds the task breakdown.
