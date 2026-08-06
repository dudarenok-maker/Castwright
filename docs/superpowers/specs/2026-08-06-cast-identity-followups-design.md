# Cast-identity follow-ups — #2110, #2129, #2133, #2128

> Design of record for the four #2040 follow-up bugs shipped as one lane.
> Status: approved 2026-08-06; revised three times the same day (see "Review
> history"). Implementation plan and the per-issue handover brief are separate
> artifacts (see "Handover").
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

## Prerequisite — discharged

`feat/server-2040-reject-scope-undo` (the pair-scoped reject/undo work, #2092 /
#2089) was merged as **PR #2157** on 2026-08-06, with fix rounds F1–F6 and a
wrap-up in **PR #2158**. `main` is `2ca4bb57` and in sync with `origin`.

This matters because **#2133's entire subject** — `rejectedPairs`,
`repointRejectedPairs`, `RetireCharacterIdResult`, `restoreSupersededId` — came
in with that merge and did not exist on `main` when these issues were filed.

**Citation convention:** every `file:line` below is against `main` at `2ca4bb57`
or later. Revisions 1–3 of this spec were written against the unmerged branch and
carried a branch-relative convention; that is now moot and has been removed.

## Premise verification

| Issue | Premise | Verdict |
|---|---|---|
| #2110 | `cast-create`'s taken set excludes `supersededBy` values | **True** — `cast-create.ts:126-129` |
| #2129 | Banner and repair pass give opposite answers for the same id | **True** — see below |
| #2129 | A stale "don't contradict the Cast banner" comment survives in `planBookRepairs` | **Already discharged** — see below |
| #2133 | A dropped self-loop rejection orphans its `notLinkedTo` edge | **True** |
| #2128 | No per-entry marker exists to compare a render against | **True** — `supersededBy` is `Record<string, string>` |

### #2129's second premise — already discharged, not false

**The comment existed, verbatim.** `511c5382` added it to `planBookRepairs` as the
justification for the `autoReconciled` branch:

> `// resolver's own normalised-id tier (the Cast banner already shows`
> `// it under "auto-reconciled", not "needs your decision"). Reporting`
> `// that case … is FALSE — it contradicts the banner …`

`30456c71` — the #2107 widening — deleted the `autoReconciled` bucket and the
comment with it. #2129 was filed against the pre-widening tree.

**Disposition:** discharged as *already done*. The surviving comment in the same
function (`repair-cast-id-drift.mjs:~1122-1131`, justifying the branch at
`~:1132-1143`) is accurate today — but see §5, which changes the invariant it
states and therefore must update it.

> Revision 1 recorded this premise as **false**, on a `git log -S"Cast banner"`
> misread as empty when it in fact returned both commits above. Recorded rather
> than silently corrected: the premise-verification section is precisely what a
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
a single exported predicate, called by both surfaces.

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
   *  The authoritative value the currency predicate compares. */
  recordedAtSeq?: Record<string, number>;
  /** #2128 — human-readable companion for operator diagnostics.
   *  NEVER compared; the predicate reads `recordedAtSeq` only. */
  recordedAtIso?: Record<string, string>;
}
```

**Additive-optional, `schema` stays 1** — matching the module's existing optional
fields, each of whose doc comments promises "never bumps `schema`". Retyping
`supersededBy` to carry the marker inline was considered and rejected: it forces a
migration, reworks `loadCastIdHistory`'s validation, and touches every read site
in one diff, for a sync property a guard test can hold instead.

Each new field gets its own conjunct in `loadCastIdHistory`. **This does not
isolate its failure.** `loadCastIdHistory` is all-or-nothing by design
(`cast-id-history.ts:145-169` is a single conjunction falling through to one
`console.warn` and the empty default). A malformed new field degrades the **whole
file** — no aliases, so every affected id resolves as a genuine miss and is
listed. Fail-closed, and preserving it is required by #2128's acceptance ("its
validation is all-or-nothing and never throws — don't regress that").

#### Why a counter and not a timestamp

**Both sides of the comparison are drawn from the same file's own counter**, so no
clock is involved and cross-machine skew is structurally irrelevant rather than
tolerated. It also removes a second hole — a long chapter render whose alias is
recorded mid-render — because the render stamps *the state it actually resolved
against* rather than an approximate start time.

`recordedAtIso` exists purely so an operator hand-inspecting
`cast-id-history.json` during a repair run (an active workflow — see A33) can tell
*when*, not merely *in what order*. The names carry the rule: `…Seq` is
authoritative, `…Iso` is display.

#### The uniform stamp rule — no exceptions

**Every write to `supersededBy[k]` increments `seq` and stamps `recordedAtSeq[k]`
and `recordedAtIso[k]`. Every delete of `supersededBy[k]` deletes both.**

`recordedAtSeq[k]` therefore means **"the seq at which this key's *current* target
was established"** — not "when the alias was first recorded". That distinction
closes the merge-repoint hole:

> `cast-merge.ts:230` retires `sourceId` into `targetId` after merging, and the
> repoint loop rewrites every entry whose value was `sourceId`. Same *person*,
> different *cast row* — `targetId`'s `voiceId`/`overrideTtsVoices` is whichever
> row won the merge. A render made while the alias pointed at `sourceId` used
> `sourceId`'s voice, so its bytes are stale. Under the uniform rule the repoint
> restamps, the render's seq is now lower, and the row lists.

The six mutation sites, all uniform:

- **`retireCharacterId`** — the entry it writes.
- **its direct-reversal branch** (`:291-298`) — the delete and both writes.
- **its repoint loop** (`:317-321`) — every key it rewrites.
- **`forgetSupersededId`** (`:475-491`) — the delete.
- **`dropSupersededIdsReclaimedByLiveCast`** (`:417`) — each reclaimed key.
  Nothing is preserved into `displaced`: it has zero readers outside this module,
  so a marker there would protect nothing.
- **`restoreSupersededId`** (`:526`) — **stamps the current seq like every other
  writer.**

That last one is the correction revision 3 got wrong. Revision 3 had
`restoreSupersededId` *replay* a stashed marker, by analogy with
`forgotSupersededTo`. The analogy fails, and it fails in the dangerous direction:

> `seq=3`, `supersededBy['mayrin']='mairin'`. The operator rejects the pairing;
> `forgetSupersededId` removes it. The chapter is then re-rendered — with **no**
> alias for `mayrin`, so those segments render as the narrator, at `seq=4`. The
> operator clicks Undo. Replaying `recordedAtSeq=3` makes `4 >= 3` true and
> **clears a row whose audio is the narrator's.**

The justification only ever covered renders made *before* the forget; it ignored
the forget→restore window, which is exactly the interval an operator spends
deciding. Stamping instead may re-list a correct render — a false *positive*,
which §3's unknown rule already declares the safe direction. Deleting the
exception also means `RejectedPair` needs no `forgotRecordedAt*` fields at all,
and `keys(recordedAtSeq) === keys(supersededBy)` holds unconditionally rather than
depending on a replay path.

#### `seq` repair on load

`loadCastIdHistory` computes `seq = max(raw.seq ?? 0, ...Object.values(raw.recordedAtSeq ?? {}), 0)`.

Without this, a file that loses `seq` while keeping `recordedAtSeq` (hand-edit,
merge conflict) loads as `seq: 0`, every subsequent write starts from 1, and every
existing stamp stays above it — so the book's rows can **never** clear again. The
repair makes the counter self-healing and keeps monotonicity a real invariant
rather than an assumption about file integrity.

#### Single-writer dependency

The counter's uniqueness assumes one writer at a time. `withKeyLock`
(`workspace/file-lock.ts`) is a module-scope `Map` of promise chains — **an
in-process mutex only** — and `scripts/repair-cast-id-drift.mjs --apply` writes
the same file from a separate process via `server/dist` (`:2617`).

**This is a pre-existing property of the module, not something the counter
introduces.** `retireCharacterId`'s repoint loop is already a non-atomic
read-modify-write; a concurrent second writer already corrupts `supersededBy`
itself, independently of any marker. It is already gated: `--apply` probes the
whole auto-rebind port range and refuses when a live server answers
(`repair-cast-id-drift.mjs:2203-2215`, #2090), which is plan 278 invariant 2's
own stated mechanism.

The lane therefore **states the dependency and pins the gate with a test**, rather
than inventing cross-process locking here. Genuine cross-process atomicity for
`cast-id-history.json` is #2015-shaped work covering `supersededBy` as a whole —
see "Known limits".

#### Guard tests

1. **Bidirectional key equality** after every scripted mutation sequence run from
   an empty history — `keys(recordedAtSeq) === keys(supersededBy)`. A
   one-directional `⊆` is satisfied by a *missing* marker.
2. **Monotonicity** — `seq` strictly increases across every write, and no
   `recordedAtSeq` value ever exceeds the file's `seq`.
3. **A syntactic guard**, in the shape of `cast-lock.guard.test.ts`, failing the
   build when a new `supersededBy` mutation site appears without a paired stamp,
   and — **scanning `server/src`, `scripts` and `src`** — when any indexed write
   to `supersededBy` or `recordedAtSeq` appears outside this module.

   That external property is true today (verified 2026-08-06: every outside
   reference is a *read* or an object-literal construction — `cast-create.ts:126`
   and `:179`, `repair-cast-id-drift.mjs:742` and `:832`, `segments-io.ts:342`,
   `build-synth-replacement.ts:215-216`, `book-state.ts:482`,
   `render-integrity/aggregate.ts:485`), which is what makes the repair script's
   own writes safe: they go through the choke point. **The guard must match
   indexed assignment specifically, not the bare identifier** — an allowlist built
   from the identifier alone fails on first run against those eight sites. The
   guard ships with a neutralisation proof and states its blind spot: it is
   call-graph-blind.

Legacy files have no markers for their existing keys; equality is asserted for
sequences the new code wrote, not for what is already on disk. The back-fill
clause in §3 is what makes those legacy entries resolvable.

### 2. The render-side stamp — `castHistorySeq`

Two problems make `synthesizedAt` unusable as the render-side anchor.

**It does not mean what it looks like it means.** `finalizeChapterAudioWrite`
(`finalize-chapter-write.ts:115`) is the sole non-test writer of
`<slug>.segments.json` and unconditionally refreshes `synthesizedAt` (`:331`), but
it has **three** callers and only one is a full chapter render: `generation.ts:1873`,
`chapter-qa-repair.ts:689`, `chapter-splice.ts:483`. A one-sentence QA repair or a
single splice rewrites the whole file and refreshes the whole-file stamp while
leaving every other segment's audio byte-identical. Anchoring on it would clear a
row whose audio is still wrong.

**It cannot speak to the `'normalised-id'` tier at all.** That tier has no history
entry. Its hazard is different in kind: not "the alias postdates the render" but
"the render predates the resolver existing at all" — pre-Wave-1, `resolveGroup`
did a bare `castById.get()` and substituted the narrator regardless of tier. Per
register row A32 this covers `the-torment` (67 segments) and `lightning-dave` (1
segment) — **68 of the 188 known damaged segments**, the single largest block.

So the lane introduces **one** field of its own and leaves `synthesizedAt`
untouched:

> **`castHistorySeq: number`** — the `seq` of the `cast-id-history.json` state
> this render actually resolved against. **`0` is a valid value**, not an absent
> one; an `if (!castHistorySeq)` check would route every legacy back-fill case to
> `'unknown'` and ship #2128 dead.

This is available for free and the threading is verified: `generation.ts:1630`
loads the history, `:1631` passes it to `synthesiseChapter`,
`synthesise-chapter.ts:1510` builds the resolver from it — the file's **only**
`buildCastResolver` call, so it is never rebuilt mid-chapter — and `generation.ts:1873`
calls `finalizeChapterAudioWrite` in the same closure.

**Its presence also proves the resolver existed**, which is why no separate
`castResolverVersion` field is needed: a render that read the history and built the
resolver had all four tiers by construction. See "Known limits" for what this
cannot express.

**Only the full-render path writes it.** `chapter-qa-repair.ts` and
`chapter-splice.ts` **carry the prior file's value forward verbatim**, or omit it
when the prior file had none. Carrying an older value forward is fail-closed and
makes laundering a stale row through a partial rewrite impossible.

Three type declarations carry the field: the strict write view
**`ChapterSegmentsFile`** (`finalize-chapter-write.ts:50`), the loose read view
`SegmentsFile` (`segments-io.ts:51`), and the third local copy in `generation.ts`
that the former's doc comment notes it mirrors.

**Three `Pick<CastIdHistory, …>` parameters must widen to include `seq` and
`recordedAtSeq`**, or the predicate cannot run on the surface that needs it:
`synthesise-chapter.ts:584`, **`segments-io.ts:342`** (the banner's collector —
without this §6's "cannot disagree" is unreachable) and
`build-synth-replacement.ts:215`.

### 3. The predicate

`isAudioCurrent(resolution, segmentsFile, history) → true | false | 'unknown'`,
pure and I/O-free, in `server/src/store/cast-audio-currency.ts`. The repair script
imports it from `server/dist` exactly as `main()` already imports
`buildCastResolver` and `normaliseForMatch`.

| `resolution.via` | Result |
|---|---|
| `'exact'` | `true` — unchanged from #2107 |
| `'normalised-id'` | `castHistorySeq` absent → `'unknown'`; else `true` |
| `'history'` / `'normalised-history'` | see below |
| no resolution | not applicable — a genuine miss is `'unresolved'` and always damage |

For the two alias tiers, in order:

1. `castHistorySeq` absent or not a finite number → `'unknown'`. (`0` is present.)
2. **Counter-reset guard** — `history.seq < castHistorySeq` → `'unknown'` for
   every alias-tier row in this book. A render cannot have read a *future* state
   of this file, so a lower file counter means the file was rebuilt and the
   counter restarted; without this, the rebuilt file's low `recordedAtSeq` values
   would compare as older than every pre-existing render and clear rows wholesale.
   With the `seq` repair in §1 this fires only on genuine rebuild-from-nothing,
   not on a file that merely lost its `seq` key.
3. `recordedAtSeq[matchedHistoryKey]` present and finite →
   `castHistorySeq >= recordedAtSeq[key]`.
4. `recordedAtSeq[matchedHistoryKey]` **absent** → **back-fill clause**: `true`
   (`castHistorySeq` is already known present from step 1).
5. `recordedAtSeq[matchedHistoryKey]` present but not finite → `'unknown'`.

**Damage is anything other than `true`.**

#### Why the back-fill clause is sound

`recordedAtSeq` is written only by this lane's code, so an unmarked alias
necessarily predates the lane. `castHistorySeq` is likewise written only by this
lane's code, so a render carrying it necessarily postdates the lane. Render > lane
> alias, so the audio is current.

The premise this needs is **"an unmarked entry cannot be created after the lane
ships"**. Revision 3 stated a weaker premise ("markers are written only by this
lane's code") and had a path that falsified it: `forgotSupersededTo` already
existed pre-lane, so a post-lane Undo of a *pre-lane* reject would have restored an
entry with nothing to replay — unmarked, created now, and cleared by back-fill.
The uniform stamp rule (§1) closes that: `restoreSupersededId` stamps, so no
unmarked entry can ever be created post-lane.

This is the one place the design clears on the **absence** of evidence, and it
does so because the absence carries information. It is also what makes #2128 work
at all: nothing rewrites an existing `supersededBy` entry, so without this clause
**every alias already on disk stays listed forever regardless of re-rendering**.

#### The unknown rule

**A missing `castHistorySeq`, a file counter below a render's stamp, and a
non-finite marker on either side each read as `'unknown'`, and `'unknown'` is
listed as damage.** Only an affirmative comparison — or the back-fill clause —
clears a row. Inverting this is the most dangerous mistake available in this lane
("getting that backwards silently re-opens #2107"). Each unknown source gets its
own test asserting it **lists**, not clears.

#### Cross-chapter aggregation

`isAudioCurrent` is per-segments-file, because the stamp is. But
`collectOrphanedCharacterFallbacks` builds `out[s.characterId]` across **all**
chapters (`segments-io.ts:366-397`), so an id current in ch2 and stale in ch5
needs a single verdict:

> `false` if **any** chapter is `false`; else `'unknown'` if **any** is
> `'unknown'`; else `true`.

Getting this wrong in the "any-current ⇒ `true`" direction re-opens #2107 on the
banner side.

### 4. Resolver change — `matchedHistoryKey`

The alias tiers need the raw history key to look up `recordedAtSeq`.
`CastResolution` carries `viaAlias`, but `cast-resolve.ts:173/185/192` sets it to
the **queried** id in all three non-exact branches, and for a
`'normalised-history'` hit the matched key is a different spelling.

**This is not an additive change.** `byNormHistory` is built as
`put(byNormHistory, normaliseIdKey(from), target)` (`:105`) — it stores the target
only and discards the raw `from`. Recovering it means changing the map's value
type and the `put` collision helper, which compares `.id`.

**It is also ambiguous by construction.** `put` nulls the entry only on
*differing* targets, so two raw keys that normalise identically and point at the
**same** target collapse into one entry backed by two markers, with iteration
order silently picking one.

**Tie-break: the highest `recordedAtSeq` among the colliding keys** — a higher seq
makes the comparison harder to satisfy, so it is the fail-closed choice. Pinned by
its own test.

### 5. #2128 — the repair pass clears

`buildOrphansFromSegments` takes the history and replaces its `via === 'exact'`
skip with `isAudioCurrent(...) === true`. Its doc comment's warning carries over in
form: `orphans` being empty for an id must mean **affirmatively current**, never
merely "the resolver returned something".

**This is not a local change.** `orphans` feeds `planBookRepairs`, whose
zero-segment branch carries an explicit invariant: *"Only `'exact'` skips `orphans`
now … so `orphan.segments === 0` here can only mean one thing: this id genuinely
has zero rendered segments anywhere in the book."* Once a *current* id also skips
`orphans`, that is false, and such an id is emitted with the now-wrong reason
`"…but this id has zero rendered segments — no damage to repair"` **and drops out
of `autoRecord` entirely** — the `autoReconciled`-bucket defect `511c5382` fixed
and `30456c71` deleted, resurrected one level down.

**The signature change also breaks a pinned cross-boundary contract test.**
`server/src/store/cast-resolve.repair-pass-contract.test.ts:78, 87, 95` calls
`buildOrphansFromSegments(segs, resolver)` from the *server* suite, deliberately
exercising the script's function against the real `buildCastResolver` (#2130).
That file moves in this lane or the lane lands red.

The plan must decide and pin, with tests:

- whether an id that is affirmatively current is still **auto-recordable**;
- the reason string for a zero-segment row that is current rather than
  never-rendered;
- the updated wording of the invariant comment this change makes stale.

### 6. #2129 — the banner splits

`OrphanedCharacterFallback` gains `audioCurrent: true | false | 'unknown'`,
aggregated per §3. The existing `resolution` field and its three values are
**untouched**, so the reject/undo chips and their tests are unaffected.

`src/views/cast.tsx`'s single auto-reconciled disclosure becomes two, both
collapsed, each showing its count in its own header — so `N resolved · audio needs
a re-render` is legible **without expanding anything**. Exact copy is for the plan;
the requirement is that the actionable count is visible while collapsed.

Both surfaces derive their verdict from `isAudioCurrent` — which requires the
`segments-io.ts:342` `Pick` widening in §2, without which this section is
unimplementable.

### 7. #2110 — reserve the values

`cast-create.ts`'s taken set gains `...Object.values(history.supersededBy)`.
`takenNorm` derives from `takenIds`, so normalised coverage is free.

Cost, correctly scoped: `cast-create` does not *refuse* a taken id — it suffixes
(`антон` → `антон-2`) and creates the character with the requested **name** intact.
The issue's framing ("can never be reused by name, forever") overstates it.

Pruning dangling entries instead (the issue's option 2) was considered and
rejected: a dangling entry is inert **only while its target is dead**, and resumes
protecting its segments if a later re-analysis re-mints that target. Pruning
destroys that; `displaced` would preserve the record but has no readers.

**One non-obvious consequence.** The route's `console.log` report matches only
`collidingHistoryKey` or `collidingLiveId`, so a values-collision would suffix the
id **silently** — the gap #2085's review round 2 (M4) already closed once for the
live-id case, and plan 278's invariant 8 states the report fires whenever the
avoidance fires. The report gains a third branch in this same change.

### 8. #2133 — destroy the reject's two writes together

**The invariant:** a reject writes two things — the `rejectedPairs` entry and a
one-sided `notLinkedTo` edge on `cast.json`. They are created together and must be
destroyed together.

A self-loop arises only when the pair says "X is not Y" and then **Y retires into
X**, i.e. `retireCharacterId`'s own invariant now asserts Y and X are the same
person. The retirement is the newer, more authoritative statement, and the
surviving edge would name the row's own id.

**The two callers need opposite treatments.** Revisions 2 and 3 each prescribed a
single shape; both were wrong, in opposite directions.

- **`cast-merge.ts`** *does* hold the lock — `withCastLock` at `:88`, authoritative
  cast write at `:209`, `retireCharacterId` at `:230` after it, with a comment
  refusing relocation ("Kept HERE rather than moved after the cache update: the
  position is correct"). There is no later write to fold into, so the edge removal
  is a **second `writeJsonAtomic` under the lock already held**. That is legal: the
  cast-lock rules ban a locked function calling another locked function on the same
  book, not two writes under one lock.
- **`analysis.ts` holds no cast lock at any retirement site.** It contains exactly
  **one** `withCastLock`, at `:2924`, wrapping an `rm` — and none of the eight
  `recordRetirements` call sites (`:2896, :4914, :4915, :4925, :5438, :6176,
  :6177, :6187`) is inside it. CLAUDE.md corroborates: `analysis.ts`'s cast.json
  writes are the allowlisted **unlocked** exception, deferred to #2015.

  So here a **locked helper is required**, not forbidden — and the allowlist is
  "keyed on file **and** count so a further unlocked write in either still fails",
  meaning an unlocked sixth write would fail `cast-lock.guard.test.ts` on the
  first run. The plan must name which site acquires the lock and confirm it
  respects the global `design → library-voice → cast` order. `recordRetirements`
  returns the dropped self-loop pairs to its caller either way.

**The helper needs promoting.** It is `removeNotLinked`
(`cast-reject-orphan.ts:639`), not `removeNotLinkedTo`, and it is
**module-private**, documented as a deliberate local copy. Exporting it, or
promoting `cast-not-linked-to.ts`'s equivalent, is in scope.

**One thing the tests must settle empirically:** whether the edge survives the
merge at all depends on whether Y's row is *renamed* (data carries over) or
*discarded* in favour of X's row. Unverified. If a path discards the row, the fix
is a no-op there and the test records that rather than asserting a phantom.

## Known limits

Not deferred defects — properties of the chosen design, each stated so it is known
rather than discovered.

1. **A partial repair does not clear a row.** `chapter-qa-repair` re-synthesises
   affected sentences against the *current* resolver, correctly, but carries the
   old `castHistorySeq` forward (§2), so the row stays listed. Fail-closed and
   deliberate — the file's other segments were not re-rendered. **Only a full
   re-render clears a row**, and the release-notes wording must say so rather than
   promising the list shrinks as any work is done.
2. **`castHistorySeq` cannot express a resolver *change*.** Its presence proves the
   four-tier resolver existed, which is the only distinction #2128 needs. It cannot
   distinguish resolver v1 from a future v2 — a later change to the tier set or to
   `normaliseIdKey` would alter which ids resolve via `'normalised-id'` with no
   marker to invalidate against. Adding a version field at that point is the fix;
   adding it now would be speculative.
3. **Cross-process writes are gated, not excluded** (§1). Pre-existing, already
   true of `supersededBy` itself, and already gated by the live-server probe.
   Genuine cross-process atomicity is #2015-shaped work; a follow-up issue records
   it against the module rather than this lane.

## Ordering against A33

The owed A33 `--apply` run may happen before or after this lane. If `--apply` runs
first, the 68 `'normalised-id'` segments become unmarked `'history'` entries, and
the back-fill clause covers them because their eventual re-render carries
`castHistorySeq`. The two must not run *concurrently* — see §1's single-writer
dependency, which the existing live-server gate enforces.

## Back-compat

**No migration, and day-one output is byte-identical to today's.** Every existing
`cast-id-history.json` has no counter; every existing segments file has no
`castHistorySeq`. Every currently-listed row stays listed until a chapter is fully
re-rendered under this lane's code. The back-fill clause is what lets those rows
clear at all.

## Test plan

Every assertion is mutated on its own line during implementation to prove it can
fail before it is trusted.

**Server (Vitest)**

- `cast-id-history.test.ts` — markers stamped on every `supersededBy` write
  including **the repoint loop, the direct-reversal branch, and
  `restoreSupersededId`**; deleted by `forgetSupersededId` and
  `dropSupersededIdsReclaimedByLiveCast`; bidirectional key equality; `seq`
  strictly increasing and never exceeded by any `recordedAtSeq`; the `seq` repair
  on a file that lost its counter; a malformed new field collapsing the whole file
  to the empty default.
- **The forget→re-render→restore regression** — a render made while the alias was
  forgotten must still list after Undo. This is the test for revision 3's Critical.
- **The merge-repoint regression** — an alias repointed onto a row with a different
  voice lists again rather than reporting current.
- The syntactic guard, **with its neutralisation proof**, including the
  external-write scan and a case proving it matches indexed assignment rather than
  the bare identifier.
- `cast-audio-currency.test.ts` — the full truth table; each unknown source
  asserted to **list, not clear**; the back-fill clause; the counter-reset guard;
  **`castHistorySeq === 0` treated as present**; cross-chapter aggregation with two
  chapters disagreeing.
- `cast-resolve.test.ts` — `matchedHistoryKey` is the matched key, not the queried
  id; the highest-seq tie-break on a normalised collision.
- `cast-resolve.repair-pass-contract.test.ts` — updated for the new signature
  (#2130's cross-boundary pin).
- `finalize-chapter-write` / splice / QA-repair — the two partial writers carry the
  prior stamp forward and never refresh it. **This protects against the
  false-negative the whole §2 redesign exists to prevent.**
- `synthesise-chapter` / `generation` — the seq the render resolved against is the
  seq that reaches the segments file.
- `segments-io.test.ts` — `audioCurrent` present and correct; `resolution`
  unchanged.
- `cast-create` route test — the full #2110 chain through the **real route**, and
  the new report branch.
- #2133 — the self-loop drop removes the edge at **both** callers; the
  `cast-lock.guard.test.ts` allowlist still passes; `recordRetirements` returns the
  dropped pairs; the rename-vs-discard question settled by the test.

**Scripts**

- `repair-cast-id-drift.test.mjs` — a fully re-rendered chapter drops off; an
  un-re-rendered one stays; an unmarked entry with no render stamp stays; an
  unmarked entry **with** a stamp clears (back-fill); a book whose counter is below
  a render's stamp reports unknown; the live-server `--apply` refusal still fires;
  and §5's `planBookRepairs` consequences.

**Frontend (Vitest + Playwright)**

- `cast.test.tsx` — the three-way split; the actionable count visible while
  collapsed.
- `e2e/orphaned-character-fallback-banner.spec.ts` — extended for the split
  (CLAUDE.md's e2e bar: this crosses router/redux/layout seams).

## On-box acceptance

#2128's acceptance — "the list clears as the operator works through it" — is only
provable by fully re-rendering a real chapter on the box, so acceptance is owed and
**its recording is a merge gate** (the running is not).

- A row in `docs/testing/onbox-acceptance-register.md`, grouped under the same
  hardware prerequisite as A33.
- Criteria in `docs/testing/cast-id-drift-onbox-acceptance.md`.
- `docs/testing/onbox-acceptance-register-live-view.html` edited and republished to
  the URL recorded in the register header — never the `.md`, never without the
  `url`. `npm run check:onbox-register -- --against-published <saved copy>` run
  immediately beforehand.

## Documentation

- **Plan 278** — new invariants (a `supersededBy` entry and its markers are written
  and destroyed together with no exception; `recordedAtSeq` tracks the *current*
  target's establishment; `'unknown'` never clears; the render stamp is written
  only by the full-render path); invariant 8 amended for the widened taken set and
  the third report branch; #2133's chosen semantics recorded.
- **`docs/release-notes-next.md`** and **`RELEASE_NOTES.md`** — the re-render list
  shrinks as chapters are re-rendered, and the Cast screen stops reporting "nothing
  to do" for audio that needs one. Wording must respect known limit 1.
- **The #2129 premise correction** recorded on the issue.
- **A follow-up issue** for known limit 3 (cross-process atomicity for
  `cast-id-history.json`), filed against the module.

## Out of scope

- Rewriting frozen `segments.json` files to migrate ids — plan 278 invariant 6.
- Any change to `resolution`'s three values or to the reject/undo chips.
- Pruning dangling `supersededBy` entries (§7).
- Per-segment currency stamping — the file-level stamp is sound because §2 confines
  it to the full-render path.
- A second candidate ranker on any surface — plan 278 invariant 7.

## Review history

**Rev 1 → 2** (adversarial pass). Folded: the file-level `synthesizedAt`
false-negative via the splice / QA-repair writers; pre-existing aliases unable to
ever clear (back-fill); `restoreSupersededId` as an unlisted mutation site; a
contradiction over malformed-field handling; `matchedHistoryKey` neither additive
nor unambiguous; the `planBookRepairs` zero-segment invariant this lane breaks; the
#2133 plumbing wrong at both callers; the missing aggregation rule; and the misread
`git log` behind the #2129 verdict.

**Rev 2 → 3** (owner directive: fix the accepted limitations, don't defer them).
Closed all three; two fixes shrank the design. Voice-identity-across-a-repoint
closed by redefining the marker as "current target established", making the repoint
restamp. Clock skew closed by comparing a per-book counter instead of wall-clock
times, which also closed the mid-render window and collapsed two render-side fields
into one.

**Rev 3 → 4** (second adversarial pass, plus the prerequisite landing on `main`).

- **Critical:** revision 3's `restoreSupersededId` exception cleared rows whose
  audio was the narrator's, via the forget→re-render→restore window — and
  contradicted revision 3's own "current target established" semantics. Exception
  deleted; the rule is now genuinely uniform, and `RejectedPair` sheds two fields.
- **Critical:** the back-fill clause's premise was falsified by a pre-lane
  `rejectedPairs` entry having nothing to replay. Closed by the same fix.
- **Critical:** §8's plumbing was wrong for `analysis.ts`, which holds no cast lock
  at any retirement site and whose unlocked writes are allowlisted by count — so
  the construct revision 3 forbade is the one that is required there.
- **Important:** `seq` repair on load, `0` as a valid stamp, the `segments-io.ts`
  and `build-synth-replacement.ts` `Pick` widenings, and the `#2130` contract test.
- The prerequisite branch merged (PR #2157/#2158) mid-review, so the
  branch-relative citation convention was dropped and all citations re-verified
  against `main`.

## Handover

Implementation is a separate thread. Its inputs are the plan doc produced from this
spec plus a handover-brief comment on each of #2110, #2129, #2133 and #2128. This
document is the design of record; the plan holds the task breakdown.
