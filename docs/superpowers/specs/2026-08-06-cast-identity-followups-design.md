# Cast-identity follow-ups — #2110, #2129, #2133, #2128

> Design of record for the four #2040 follow-up bugs shipped as one lane.
> Status: approved 2026-08-06; revised four times the same day after three
> adversarial passes (see "Review history"). Implementation plan and the
> per-issue handover brief are separate artifacts (see "Handover").
> Parent plan: [`docs/features/278-cast-character-identity.md`](../../features/278-cast-character-identity.md).

## Post-hoc note (2026-08-06, after PR #2163)

Implementation ran on `fix/server-cast-identity-followups` (PR #2163, merged
`7add81c0ce4fde75657ca2e64f5bd0131eb87d16`) rather than through the "Handover"
chain below, and did not follow this design for three of the four issues. Full
reconciliation lives in the plan's "What actually shipped" section
(`docs/features/archive/280-cast-identity-followups.md`, moved there 2026-08-11
once #2128 — the fourth issue — also shipped, via PR #2244); two points are
recorded here because they directly contradict specific claims this document
makes, not merely "this wasn't built yet":

- **§7 explicitly rejects pruning**: "Pruning dangling entries (the issue's option
  2) was rejected: a dangling entry is inert only while its target is dead, and
  resumes protecting its segments if a later re-analysis re-mints that target."
  **The shipped #2110 fix prunes anyway** — a new `dropSupersededTargetsNoLongerLive`
  primitive — but closes the exact gap this rejection warns about by moving the
  pruned entry into `displaced` and reserving `displaced` keys in `cast-create.ts`'s
  taken set, so the id stays protected across the drop. Recorded as a reversed
  decision, not a factual error in either document — the repo owner chose
  differently at implementation time, after this spec's reasoning was already
  written down.
- **§6 ("Both surfaces derive their verdict from `isAudioCurrent`") did not
  ship.** #2129 shipped via a static `STALE_AUDIO_RESOLUTIONS` allowlist on
  `resolution` type alone (`src/views/cast.tsx`) — no `seq`, no `castHistorySeq`,
  no predicate call. §1-§5 (the `seq`/predicate architecture §6 depends on) were
  never built; #2128, which that architecture exists for, remains open — and the
  open issue's own text still describes the timestamp-based approach §1's "Why a
  counter and not a timestamp" subsection argues against, unedited since before
  this spec existed.

## Why one lane

The four issues are independent defects but share one surface: the cast-identity
seam introduced by #2040 — `cast-id-history.json`, `buildCastResolver`,
`collectOrphanedCharacterFallbacks`, the Cast banner, and
`scripts/repair-cast-id-drift.mjs`. Shipping them separately would mean four
reviews of the same files and four chances to reintroduce each other's defects.
#2129 in particular spans frontend and server and cannot be reasoned about from
either side alone.

Two of the four (#2129, #2128) share a root cause and a fix; the other two
(#2110, #2133) are self-contained and ride the lane for the shared review.

## Prerequisite — discharged

`feat/server-2040-reject-scope-undo` (pair-scoped reject/undo, #2092 / #2089) was
merged as **PR #2157** on 2026-08-06, with fix rounds F1–F6 and a wrap-up in **PR
#2158**. `main` is `2ca4bb57` and in sync with `origin`. **#2133's entire
subject** — `rejectedPairs`, `repointRejectedPairs`, `RetireCharacterIdResult`,
`restoreSupersededId` — arrived with that merge.

Every `file:line` below is against `main` at `2ca4bb57` or later.

## Premise verification

| Issue | Premise | Verdict |
|---|---|---|
| #2110 | `cast-create`'s taken set excludes `supersededBy` values | **True** — `cast-create.ts:126-129` |
| #2129 | Banner and repair pass give opposite answers for the same id | **True** |
| #2129 | A stale "don't contradict the Cast banner" comment survives in `planBookRepairs` | **Already discharged** |
| #2133 | A dropped self-loop rejection orphans its `notLinkedTo` edge | **True** |
| #2128 | No per-entry marker exists to compare a render against | **True** |

**#2129's second premise.** The comment existed verbatim (`511c5382`) and was
deleted by `30456c71` — the #2107 widening — along with the `autoReconciled`
bucket it justified. #2129 was filed against the pre-widening tree. Discharged as
*already done*; the surviving comment at `repair-cast-id-drift.mjs:1124-1131`
(justifying the branch at `:1132-1142`) is accurate today, but §5 changes the
invariant it states and must update it.

> Revision 1 recorded this premise as **false**, on a `git log -S"Cast banner"`
> misread as empty when it returned both commits. Recorded rather than silently
> corrected: this section is what a later reader trusts without re-checking.

**The divergence #2129 is about.** `segments-io.ts:388-392` tags `'history'` and
`'normalised-history'` as `'alias'`; `cast.tsx:304-307` files anything `!==
'unresolved'` into a collapsed "N character ids auto-reconciled" disclosure.
`buildOrphansFromSegments` exempts **only** `'exact'`, so the same ids are listed
as damage. An operator sees "auto-reconciled, nothing to do" for `the-torment`
while the repair pass lists 67 of its segments.

## Architectural spine

Two rules, both extensions of principles this codebase already established.

**1. One comparator, two callers.** The banner and the repair pass must not each
answer "is this id fine?" with independently written logic. Plan 278's invariant 7
established this for candidate *ranking* ("two independent rankers is the exact
duplicate-matching-logic defect class Task 16's CRITICAL finding came from"); this
lane extends it to *currency*. Labels change as a consequence of the predicate
existing, not instead of it.

**2. Thread the whole `CastIdHistory`, never a subset.** This is the lane's
structural rule and it exists because the codebase has produced the same defect
three times, and documents each one in-tree:

- `cast-resolve.ts:43-47` — "five of this function's six call sites pass
  `supersededBy` alone and silently default `rejected` to `[]`".
- `repair-cast-id-drift.mjs:2156-2170` — a hand-built `{supersededBy, rejected}`
  subset "silently dropping `rejectedPairs` — the exact *defaulted field a caller
  can drop* shape Task 3 made unrepresentable server-side by threading the whole
  loaded `CastIdHistory` object instead".
- `repair-cast-id-drift.mjs:819-828` — "`rejectedPairs` was missing from this
  defended object — correct on `main` … and wrong the moment #2092/#2089 merged".

Every field this design adds is **optional**, so every hand-narrowing site keeps
compiling while silently dropping it, and — before revision 5 — the resulting
absence read as *current*. That is fail-open, on the axis this codebase actually
fails. §1 and §3 below close it structurally rather than by enumerating sites.

## Design

### 1. The persisted schema

```ts
export interface CastIdHistory {
  schema: 1;                                  // unchanged
  supersededBy: Record<string, string>;
  displaced?: Record<string, string>;
  rejected?: string[];
  rejectedPairs?: RejectedPair[];
  /** #2128 — monotonic per-book counter, incremented on EVERY write to this
   *  file, whether or not a `supersededBy` key changed. */
  seq?: number;
  /** #2128 — the `seq` at which each key's CURRENT target was established.
   *  The authoritative value the currency predicate compares.
   *  FIELD ABSENT means "this file has never been through the lane" and reads
   *  as unknown. A KEY missing from a PRESENT field means "predates the lane's
   *  one-shot stamp" and reads as 0. The two are not the same. */
  recordedAtSeq?: Record<string, number>;
  /** #2128 — human-readable companion for operator diagnostics.
   *  NEVER compared; the predicate reads `recordedAtSeq` only. */
  recordedAtIso?: Record<string, string>;
}
```

**Additive-optional, `schema` stays 1** — matching the module's existing optional
fields, each of whose doc comments promises "never bumps `schema`". Retyping
`supersededBy` to carry the marker inline was considered and rejected: it forces a
migration, reworks validation, and touches every read site, for a property the
rules below hold instead.

Each new field gets its own conjunct in `loadCastIdHistory`. **This does not
isolate its failure.** `loadCastIdHistory` is all-or-nothing by design
(`cast-id-history.ts:145-169` is one conjunction falling through to a
`console.warn` and the empty default). A malformed new field degrades the whole
file — no aliases, so every affected id is a genuine miss and is listed.
Fail-closed, and preserving it is required by #2128's acceptance.

#### Why a counter and not a timestamp

Both sides of the comparison are drawn from the same file's own counter, so no
clock is involved and cross-machine skew is structurally irrelevant. It also
removes a second hole — a long chapter render whose alias is recorded mid-render —
because the render stamps *the state it actually resolved against*.

`recordedAtIso` exists so an operator hand-inspecting the file during a repair run
(an active workflow — A33) can tell *when*, not merely *in what order*. The names
carry the rule: `…Seq` is authoritative, `…Iso` is display.

#### The uniform stamp rule — no exceptions

**Every write to the file increments `seq`. Every write to `supersededBy[k]`
stamps `recordedAtSeq[k]` and `recordedAtIso[k]`. Every delete of
`supersededBy[k]` deletes both.**

The increment is on *every* write, not only key-changing ones — five paths write
without touching a key (`rejectOrphanedPair`, `unrejectOrphanedPair`,
`rejectOrphanedId`, and BOTH drop primitives'
unconditional writes, each documented as "Always writes, even when nothing was
dropped"). Picking the broader rule makes "seq strictly increases across every
write" a testable invariant rather than an ambiguous one.

`recordedAtSeq[k]` means **"the seq at which this key's *current* target was
established"** — not "when the alias was first recorded". That closes the
merge-repoint hole:

> `routes/cast-merge.ts:230` retires `sourceId` into `targetId` after merging, and
> the repoint loop rewrites every entry whose value was `sourceId`. Same *person*,
> different *cast row* — `targetId`'s voice is whichever row won. A render made
> while the alias pointed at `sourceId` used `sourceId`'s voice, so its bytes are
> stale. Under the uniform rule the repoint restamps and the row lists.

The **seven** mutation sites, all uniform: `retireCharacterId`; its direct-reversal
branch; its repoint loop; `forgetSupersededId`;
`dropSupersededIdsReclaimedByLiveCast`; `dropSupersededTargetsNoLongerLive`; and
`restoreSupersededId`, which **stamps the current seq like every other
writer**. Nothing is preserved into `displaced` — it has zero readers outside this
module.

> **Rev 5 → 6 (2026-08-06, post-merge correction).**
> `dropSupersededTargetsNoLongerLive` was missing from both enumerations above —
> it did not exist when revisions 1-5 were written. #2110 added it in PR #2163,
> which merged after this spec, and plan 280's after-the-fact reconciliation of
> that PR did not revisit these lists. It deletes `supersededBy[k]` and writes
> unconditionally, so it is a mutation site under the uniform rule like any other.
>
> The consequence of leaving it unwired is **not** stale-marker inheritance — the
> `stampAndBump` helper self-heals that by pruning keys absent from
> `supersededBy`. It is that a write which changes history state *without*
> incrementing `seq` lets two distinct states share one counter value, which
> defeats the thing `castHistorySeq` exists to record: the state a render actually
> resolved against. A render before the drop and a render after it stamp the same
> seq while resolving differently.
>
> Line citations in this section were removed at the same time. Every one was
> stale by ~50-100 lines after #2110/#2133 reshaped `cast-id-history.ts` in
> PR #2163 — the same drift this document already called out for `analysis.ts`
> (F2) and resolved by citing symbols instead.

`restoreSupersededId`'s two early returns (`:534-539`) write nothing and therefore
stamp nothing; the guard test must assert those paths leave markers **untouched**,
or a mutant that stamps on the idempotent path passes.

Revision 3 had `restoreSupersededId` *replay* a stashed marker, by analogy with
`forgotSupersededTo`. The analogy fails in the dangerous direction:

> `seq=3`, `supersededBy['mayrin']='mairin'`. The operator rejects the pairing;
> `forgetSupersededId` removes it. The chapter is re-rendered — with **no** alias,
> so those segments render as the narrator, at `seq=4`. The operator clicks Undo.
> Replaying `recordedAtSeq=3` makes `4 >= 3` true and **clears a row whose audio
> is the narrator's.**

The justification only covered renders made *before* the forget, ignoring the
forget→restore window — exactly the interval an operator spends deciding.
Stamping may instead re-list a correct render, which §3's unknown rule already
declares the safe direction. Deleting the exception also means `RejectedPair`
needs no `forgotRecordedAt*` fields, and `keys(recordedAtSeq) ===
keys(supersededBy)` holds unconditionally.

#### The one-shot back-fill stamp

**The lane's first write to a file that has no `recordedAtSeq` field stamps every
existing `supersededBy` key at the then-current `seq`, creating the field.**
Additionally, `repair-cast-id-drift.mjs --apply` performs this stamp for **every
book it scans** whose history file lacks the field, even when it has no alias to
record.

This replaces revision 4's "back-fill clause", which cleared a row whenever a
marker was *absent*. That was fail-open on the one axis this codebase actually
fails (spine rule 2): any hand-narrowed history object, any hand-edit or merge
conflict that dropped the field, cleared every alias row in the book. After the
one-shot stamp, absence of the **field** is anomalous and reads `'unknown'`, while
a key missing from a **present** field reads `0` — an affirmative comparison
against a real value.

`--apply` covering every scanned book is what keeps #2128's acceptance intact: the
books carrying pre-lane aliases are exactly the ones the A33 repair workflow
already visits.

#### `seq` repair on load

`loadCastIdHistory` computes
`seq = max(raw.seq ?? 0, ...Object.values(raw.recordedAtSeq ?? {}), 0)`.

Without it, a file that loses `seq` while keeping `recordedAtSeq` loads as `0`,
every subsequent write starts from 1, every existing stamp stays above it, and the
book's rows can **never** clear again.

#### Single-writer dependency

The counter assumes one writer at a time. `withKeyLock` (`workspace/file-lock.ts:5`)
is a module-scope `Map` — **in-process only** — and `--apply` writes the same file
from a separate process via `server/dist` (`repair-cast-id-drift.mjs:2617`).

**This is pre-existing, not introduced by the counter.** `retireCharacterId`'s
repoint loop is already a non-atomic read-modify-write; a concurrent second writer
already corrupts `supersededBy` itself. It is already gated: `--apply` probes the
whole auto-rebind port range and refuses when a live server answers (`:2203-2215`,
#2090), which is plan 278 invariant 2's own mechanism. The lane states the
dependency and pins the gate with a test; genuine cross-process atomicity is
#2015-shaped work (see "Known limits").

#### Guard tests

1. **Bidirectional key equality** after every scripted mutation sequence from an
   empty history — `keys(recordedAtSeq) === keys(supersededBy)`. A one-directional
   `⊆` is satisfied by a *missing* marker.
2. **Monotonicity** — `seq` strictly increases across every write; no
   `recordedAtSeq` value exceeds the file's `seq`.
3. **The whole-object guard** (spine rule 2, and the lane's most important guard).
   It fails the build when a call to `buildCastResolver(` or `isAudioCurrent(`
   passes an **object literal** as its history argument rather than a loaded
   `CastIdHistory`. This is the axis the codebase actually fails on; revision 4's
   guard defended outside *mutation*, a defect class this codebase has never
   produced, and was blind to the one it has produced three times.

   Two live sites must be resolved by the implementation rather than allowlisted
   by reflex: `cast-resolve.ts:283-286` (`rejectedPairsGoverning` deliberately
   builds a rejects-blind subset — legitimate, and must be allowlisted **with that
   reason recorded**, since it never calls the predicate) and
   `repair-cast-id-drift.mjs:830-834` (`planBookRepairs`'s `historyResolver`,
   which must take the whole object — `main()` already loads it at `:2335` and
   `collectSegmentOrphans` at `:2155` already threads it whole, so the correct
   object is in scope).
4. **A no-marker test**: hand `isAudioCurrent` a history whose `recordedAtSeq` is
   absent and assert it **lists**. Under revision 4 this test would have failed.
5. **A syntactic mutation-site guard** for the stamp pairing. Its match must be
   indexed *assignment*, and must not fire on comparison — `cast-reject-orphan.ts:357`
   is `historyBeforeReject.supersededBy[orphanedId] === characterId`, which a naive
   `supersededBy\[[^\]]+\]\s*=` reddens on correct code. It ships with a
   neutralisation proof and states its blind spot: call-graph-blind.

### 2. The render-side stamp — `castHistorySeq`

Two problems make `synthesizedAt` unusable as the render-side anchor.

**It does not mean what it looks like it means.** `finalizeChapterAudioWrite`
(`finalize-chapter-write.ts:106`) is the sole non-test writer of
`<slug>.segments.json` and unconditionally refreshes `synthesizedAt` (`:331`), but
it has **three** callers and only one is a full chapter render: `generation.ts:1873`,
`chapter-qa-repair.ts:689`, `chapter-splice.ts:483`. A one-sentence QA repair or a
splice rewrites the whole file and refreshes the stamp while leaving every other
segment byte-identical.

**It cannot speak to the `'normalised-id'` tier at all.** That tier has no history
entry; its hazard is "the render predates the resolver existing at all" —
pre-Wave-1, `resolveGroup` did a bare `castById.get()` and substituted the
narrator. Per register row A32 that is `the-torment` (67 segments) and
`lightning-dave` (1) — **68 of the 188 known damaged segments**.

So the lane adds **one** field and leaves `synthesizedAt` untouched:

> **`castHistorySeq: number`** — the `seq` of the `cast-id-history.json` state
> this render resolved against. **`0` is a valid value**, not an absent one; an
> `if (!castHistorySeq)` check would route every legacy case to `'unknown'` and
> ship #2128 dead.

Threading is verified: `generation.ts:1630` loads the history, `:1631` passes it to
`synthesiseChapter`, `synthesise-chapter.ts:1510` builds the resolver from it — the
file's **only** `buildCastResolver` call, so it is never rebuilt mid-chapter — and
`generation.ts:1873` calls `finalizeChapterAudioWrite` in the same block.

**Its presence also proves the resolver existed**, so no `castResolverVersion`
field is needed (see "Known limits" for what that cannot express).

**Only the full-render path writes it.** `chapter-qa-repair.ts` and
`chapter-splice.ts` carry the prior file's value forward verbatim, or omit it when
the prior file had none. Both already read the prior segments file
(`chapter-qa-repair.ts:128`, `chapter-splice.ts:155`), so this is mechanically
available. Carrying forward is fail-closed and makes laundering a stale row through
a partial rewrite impossible.

Three declarations carry the field: `ChapterSegmentsFile`
(`finalize-chapter-write.ts:50`), `SegmentsFile` (`segments-io.ts:51`), and the
third local copy in `generation.ts` the former's doc comment notes it mirrors.

**Exactly one `Pick<CastIdHistory, …>` widens: `segments-io.ts:342`**, the banner's
collector — the only predicate call site that is typed. Five such declarations
exist (`cast-resolve.ts:76`, `:279`, `segments-io.ts:342`,
`build-synth-replacement.ts:215`, `synthesise-chapter.ts:584`); the other four do
not call `isAudioCurrent` and need nothing. Revision 4 listed three, two of them
unnecessary and one omitted. The repair script's side is untyped `.mjs`, where no
`Pick` exists and guard 3 is the only enforcement.

### 3. The predicate

`isAudioCurrent(resolution, segmentsFile, history) → true | false | 'unknown'`,
pure and I/O-free, in `server/src/store/cast-audio-currency.ts`. It takes the
**whole loaded `CastIdHistory`** (spine rule 2). The repair script imports it from
`server/dist` as `main()` already imports `buildCastResolver`.

| `resolution.via` | Result |
|---|---|
| `'exact'` | `true` — unchanged from #2107 |
| `'normalised-id'` | `castHistorySeq` absent → `'unknown'`; else `true` |
| `'history'` / `'normalised-history'` | see below |
| no resolution | not applicable — a genuine miss is `'unresolved'` and always damage |

For the two alias tiers, in order:

1. `castHistorySeq` absent or not finite → `'unknown'`. (`0` is present.)
2. **`history.recordedAtSeq` absent entirely → `'unknown'`.** The file has never
   been through the lane's one-shot stamp, or the object was narrowed in transit.
   This is the fail-closed replacement for revision 4's back-fill clause.
3. **Counter-reset guard** — `history.seq < castHistorySeq` → `'unknown'`. A render
   cannot have read a *future* state of the file, so a lower counter means the file
   was rebuilt from nothing. With the `seq` repair (§1) this fires only on that
   path, and only transiently — once writes accumulate past the old stamps it stops
   firing, which is correct, because by then the rebuilt file's own markers govern.
4. Marker for `matchedHistoryKeys` present and finite →
   `castHistorySeq >= max(recordedAtSeq[k] for k in matchedHistoryKeys)`; a key
   absent from the present field contributes `0`.
5. Any marker present but not finite → `'unknown'`.

**Damage is anything other than `true`.**

#### The unknown rule

**A missing `castHistorySeq`, a missing `recordedAtSeq` field, a file counter below
a render's stamp, and a non-finite marker each read as `'unknown'`, and
`'unknown'` is listed as damage.** Only an affirmative comparison clears a row.
Inverting this is the most dangerous mistake available in this lane ("getting that
backwards silently re-opens #2107"). Each unknown source gets its own test
asserting it **lists**.

#### Cross-chapter aggregation

`isAudioCurrent` is per-segments-file. `collectOrphanedCharacterFallbacks` builds
`out[s.characterId]` across **all** chapters (`segments-io.ts:366-397`), so an id
current in ch2 and stale in ch5 needs one verdict:

> `false` if **any** chapter is `false`; else `'unknown'` if **any** is
> `'unknown'`; else `true`.

Getting this wrong in the "any-current ⇒ `true`" direction re-opens #2107 on the
banner side.

### 4. Resolver change — `matchedHistoryKeys`

The alias tiers need the raw history key(s) to look up markers. `CastResolution`
carries `viaAlias`, but `cast-resolve.ts:173/185/192` sets it to the **queried** id
in all three non-exact branches; for a `'normalised-history'` hit the matched key
is a different spelling.

**This is not an additive change.** `byNormHistory` is built as
`put(byNormHistory, normaliseIdKey(from), target)` (`:105`) — it stores the target
only, discarding the raw `from`. Recovering it means changing the map's value type
and the `put` collision helper, which compares `.id`.

**It is also ambiguous by construction.** `put` nulls an entry only on *differing*
targets, so two raw keys that normalise identically onto the **same** target
collapse into one entry backed by two markers.

**The resolver therefore reports `matchedHistoryKeys: string[]` — every raw key
that matched — and the predicate applies the fail-closed policy** (`max`, step 4
above). Revision 4 put a singular `matchedHistoryKey` behind a build-time
tie-break, which would have required `buildCastResolver` itself to carry
`recordedAtSeq`. Reporting facts in the resolver and applying policy in the
predicate keeps the marker out of the resolver entirely and is why
`cast-resolve.ts:76` needs no widening.

### 5. #2128 — the repair pass clears

`buildOrphansFromSegments` takes the **whole history object** and replaces its `via
=== 'exact'` skip with `isAudioCurrent(...) === true`. Its doc comment's warning
carries over in form: `orphans` being empty for an id must mean **affirmatively
current**, never merely "the resolver returned something".

**This is not a local change.** `orphans` feeds `planBookRepairs`, whose
zero-segment branch (fed by `:897`'s `orphans.get(id) ?? { segments: 0, … }`)
carries an explicit invariant: *"Only `'exact'` skips `orphans` now … so
`orphan.segments === 0` here can only mean one thing: this id genuinely has zero
rendered segments anywhere in the book."* Once a *current* id also skips `orphans`
that is false, and such an id is emitted with the now-wrong reason `"…zero rendered
segments — no damage to repair"` **and drops out of `autoRecord` entirely** — the
`autoReconciled`-bucket defect `511c5382` fixed and `30456c71` deleted, one level
down.

**The signature change also breaks a pinned cross-boundary test.**
`server/src/store/cast-resolve.repair-pass-contract.test.ts:78, 87, 95` calls
`buildOrphansFromSegments(segs, resolver)` from the *server* suite, deliberately
exercising the script's function against the real `buildCastResolver` (#2130).
That file moves in this lane or the lane lands red.

The plan must decide and pin, with tests: whether an affirmatively-current id is
still **auto-recordable**; the reason string for a zero-segment row that is current
rather than never-rendered; and the updated wording of the stale invariant comment.

### 6. #2129 — the banner splits

`OrphanedCharacterFallback` gains `audioCurrent: true | false | 'unknown'`,
aggregated per §3. `resolution` and its three values are **untouched**, so the
reject/undo chips and their tests are unaffected.

`src/views/cast.tsx`'s single auto-reconciled disclosure becomes two, both
collapsed, each showing its count in its own header — so `N resolved · audio needs
a re-render` is legible **without expanding anything**. Exact copy is for the plan;
the requirement is that the actionable count is visible while collapsed.

Both surfaces derive their verdict from `isAudioCurrent`, which requires the
`segments-io.ts:342` widening in §2.

### 7. #2110 — reserve the values

`cast-create.ts`'s taken set gains `...Object.values(history.supersededBy)`;
`takenNorm` derives from `takenIds`, so normalised coverage is free.

`cast-create` does not *refuse* a taken id — it suffixes (`антон` → `антон-2`) and
creates the character with the requested **name** intact. The issue's framing
("can never be reused by name, forever") overstates it.

Pruning dangling entries (the issue's option 2) was rejected: a dangling entry is
inert **only while its target is dead**, and resumes protecting its segments if a
later re-analysis re-mints that target.

**One non-obvious consequence.** The route's `console.log` matches only
`collidingHistoryKey` or `collidingLiveId`, so a values-collision would suffix the
id **silently** — the gap #2085's review round 2 (M4) closed once for the live-id
case, and plan 278's invariant 8 states the report fires whenever the avoidance
fires. It gains a third branch in this change.

### 8. #2133 — destroy the reject's two writes together

**The invariant:** a reject writes the `rejectedPairs` entry **and** a one-sided
`notLinkedTo` edge on `cast.json`. They are created together and must be destroyed
together.

A self-loop arises only when the pair says "X is not Y" and then **Y retires into
X**, i.e. `retireCharacterId`'s own invariant now asserts they are the same person.
The retirement is the newer statement, and the surviving edge would name the row's
own id.

**The two callers need opposite treatments.** Revisions 2 and 3 each prescribed one
shape for both and were wrong in opposite directions. `cast-lock.guard.test.ts`
counts only **unlocked** occurrences (`:370`, `:380`), which is what makes this
asymmetry safe:

- **`routes/cast-merge.ts`** holds the lock — `withCastLock` at `:88`,
  authoritative cast write at `:209`, `retireCharacterId` at `:230` after it, with
  a comment refusing relocation. The edge removal is a **second `writeJsonAtomic`
  under the lock already held**. Legal: the cast-lock rules ban a locked function
  calling another locked function on the same book, not two writes under one lock.
  Unlocked count stays 0, so no allowlist entry is needed.
- **`analysis.ts` holds no cast lock at any retirement site.** It contains exactly
  **one** `withCastLock`, at `:2924`, wrapping an `rm`, and none of the eight
  `recordRetirements` call sites (`:2896, :4914, :4915, :4925, :5438, :6176,
  :6177, :6187`) is inside it. CLAUDE.md corroborates: its cast.json writes are the
  allowlisted **unlocked** exception, keyed on file **and count**, deferred to
  #2015. So a **locked** write is required here — an unlocked sixth fails the guard
  immediately.

  **The `writeJsonAtomic(castJsonPath(` text must sit textually inside the
  `withCastLock(` parens.** The guard is call-graph-blind (`:108-118`) and matches
  by textual containment, so a helper shaped `withCastLock(dir, () => applyLocked(…))`
  with the write one hop away reproduces `voice-override-linked.ts`'s allowlisted
  false-positive shape **in a file that is not allowlisted** — a red build. The
  plan must name which site acquires the lock and confirm it respects the global
  `design → library-voice → cast` order.

`recordRetirements` returns the dropped self-loop pairs to its caller either way.

**The helper needs promoting.** It is `removeNotLinked`
(`cast-reject-orphan.ts:639`), not `removeNotLinkedTo`, and it is
**module-private**, documented as a deliberate local copy; the promotable
equivalent is at `cast-not-linked-to.ts:262`.

**The tests must settle empirically** whether the edge survives the merge at all —
whether Y's row is *renamed* (data carries over) or *discarded* in favour of X's.
Unverified. If a path discards the row, the fix is a no-op there and the test
records that rather than asserting a phantom.

## Known limits

Properties of the chosen design, stated so they are known rather than discovered.

1. **Only a full re-render clears a row.** `chapter-qa-repair` re-synthesises
   affected sentences against the current resolver, correctly, but carries the old
   `castHistorySeq` forward (§2), so the row stays listed — fail-closed and
   deliberate, since the file's other segments were not re-rendered. The
   release-notes wording must say "as chapters are re-rendered", not "as the work
   gets done".
2. **Reject-then-Undo lists the chapter until re-rendered.** `restoreSupersededId`
   stamps the current seq (§1), so an Undo with no intervening render leaves every
   prior render below the new marker. Operator-visible and permanent-until-render;
   accepted because the alternative is the narrator-voice false negative above.
   Worth a line in the release notes.
3. **`castHistorySeq` cannot express a resolver *change*.** Its presence proves the
   four-tier resolver existed, the only distinction #2128 needs. It cannot
   distinguish v1 from a future v2 — a later change to the tier set or to
   `normaliseIdKey` would alter which ids resolve via `'normalised-id'` with no
   marker to invalidate against. Adding a version field then is the fix; adding it
   now is speculative.
4. **Cross-process writes are gated, not excluded** (§1). Pre-existing, already
   true of `supersededBy` itself, already gated by the live-server probe. A
   follow-up issue records genuine cross-process atomicity against the module.

## Ordering against A33

Either order works. If `--apply` runs first it performs the one-shot stamp on every
book it scans (§1), which is strictly helpful. The two must not run
*concurrently* — §1's single-writer dependency, enforced by the existing
live-server gate.

## Back-compat

**No migration, and day-one output is byte-identical to today's.** Every existing
history file has no counter and no `recordedAtSeq` field; every existing segments
file has no `castHistorySeq`. Both read as `'unknown'`, so every currently-listed
row stays listed until the one-shot stamp lands **and** the chapter is fully
re-rendered.

## Test plan

Every assertion is mutated on its own line during implementation to prove it can
fail before it is trusted.

**Server (Vitest)**

- `cast-id-history.test.ts` — markers stamped on every `supersededBy` write
  including the repoint loop, the direct-reversal branch and `restoreSupersededId`;
  deleted by `forgetSupersededId` and `dropSupersededIdsReclaimedByLiveCast`;
  `restoreSupersededId`'s early returns leave markers untouched; bidirectional key
  equality; `seq` increments on the four non-key writes too; the `seq` repair; the
  one-shot stamp creating the field; a malformed new field collapsing the file.
- **The forget→re-render→restore regression** — a render made while the alias was
  forgotten must still list after Undo (revision 3's Critical).
- **The merge-repoint regression** — an alias repointed onto a row with a different
  voice lists again.
- **The whole-object guard** with its neutralisation proof, plus the recorded
  reason for `rejectedPairsGoverning`'s legitimate exception.
- **The no-marker test** — a history with `recordedAtSeq` absent **lists**.
- The stamp-pairing guard, proving it matches indexed assignment and does **not**
  fire on `cast-reject-orphan.ts:357`'s `===`.
- `cast-audio-currency.test.ts` — full truth table; each unknown source asserted to
  **list**; the counter-reset guard; `castHistorySeq === 0` treated as present; the
  `max` over `matchedHistoryKeys`; cross-chapter aggregation with two chapters
  disagreeing.
- `cast-resolve.test.ts` — `matchedHistoryKeys` contains every colliding raw key,
  not the queried id.
- `cast-resolve.repair-pass-contract.test.ts` — updated for the new signature.
- `finalize-chapter-write` / splice / QA-repair — the partial writers carry the
  prior stamp forward and never refresh it. **This protects against the
  false-negative the whole §2 redesign exists to prevent.**
- `synthesise-chapter` / `generation` — the seq resolved against is the seq written.
- `segments-io.test.ts` — `audioCurrent` correct; `resolution` unchanged.
- `cast-create` route test — the full #2110 chain through the real route, and the
  new report branch.
- #2133 — the edge is removed at **both** callers; `cast-lock.guard.test.ts` still
  passes with the locked write textually inside the lock; `recordRetirements`
  returns the dropped pairs; rename-vs-discard settled.

**Scripts**

- `repair-cast-id-drift.test.mjs` — a fully re-rendered chapter drops off; an
  un-re-rendered one stays; a history with no `recordedAtSeq` field stays; a book
  whose counter is below a render's stamp reports unknown; `--apply` performs the
  one-shot stamp on a book with no auto-records; the live-server refusal still
  fires; and §5's `planBookRepairs` consequences.

**Frontend (Vitest + Playwright)**

- `cast.test.tsx` — the three-way split; the actionable count visible while
  collapsed.
- `e2e/orphaned-character-fallback-banner.spec.ts` — extended (CLAUDE.md's e2e bar:
  this crosses router/redux/layout seams).

## On-box acceptance

#2128's acceptance is only provable by fully re-rendering a real chapter on the
box, so acceptance is owed and **its recording is a merge gate** (the running is
not).

- A row in `docs/testing/onbox-acceptance-register.md`, grouped with A33's
  hardware prerequisite.
- Criteria in `docs/testing/cast-id-drift-onbox-acceptance.md`.
- `docs/testing/onbox-acceptance-register-live-view.html` edited and republished to
  the URL in the register header — never the `.md`, never without the `url`, with
  `npm run check:onbox-register -- --against-published <saved copy>` run
  immediately beforehand.

## Documentation

- **Plan 278** — new invariants: the whole `CastIdHistory` is threaded, never a
  subset (spine rule 2); a `supersededBy` entry and its markers are written and
  destroyed together with no exception; `recordedAtSeq` tracks the *current*
  target's establishment; `'unknown'` never clears; the render stamp is written
  only by the full-render path. Invariant 8 amended for the widened taken set and
  the third report branch; #2133's semantics recorded.
- **`docs/release-notes-next.md`** and **`RELEASE_NOTES.md`** — respecting known
  limits 1 and 2.
- **The #2129 premise correction** recorded on the issue.
- **A follow-up issue** for known limit 4.

## Out of scope

- Rewriting frozen `segments.json` files to migrate ids — plan 278 invariant 6.
- Any change to `resolution`'s three values or to the reject/undo chips.
- Pruning dangling `supersededBy` entries (§7).
- Per-segment currency stamping — §2 confines the file-level stamp to the
  full-render path.
- A second candidate ranker on any surface — plan 278 invariant 7.

## Review history

**Rev 1 → 2** (pass 1). The file-level `synthesizedAt` false-negative via the
splice / QA-repair writers; pre-existing aliases unable to clear;
`restoreSupersededId` as an unlisted mutation site; a malformed-field
contradiction; `matchedHistoryKey` neither additive nor unambiguous; the
`planBookRepairs` zero-segment invariant; #2133's plumbing; the missing
aggregation rule; and the misread `git log` behind the #2129 verdict.

**Rev 2 → 3** (owner directive: fix the accepted limitations). Voice-identity
closed by redefining the marker as "current target established"; clock skew closed
by a per-book counter, which also closed the mid-render window and collapsed two
render-side fields into one.

**Rev 3 → 4** (pass 2). `restoreSupersededId`'s replay exception cleared rows whose
audio was the narrator's; the back-fill premise falsified by a pre-lane
`rejectedPairs` entry; §8 wrong for `analysis.ts`, which holds no cast lock at any
retirement site. Plus the `seq` repair, `0` as a valid stamp, and the `#2130`
contract test. The prerequisite branch merged mid-review, so citations were
re-verified against `main`.

**Rev 4 → 5** (pass 3 — declared *not converged*, with a structural cause).
`CastIdHistory` is consumed through hand-narrowed structural subsets and every
field this lane adds is optional, so every narrowing site keeps compiling while
silently dropping it — and revision 4's back-fill clause made that absence read as
**current**. The codebase has produced this exact shape three times and documents
each. Closed as a shape rather than by enumeration:

- the back-fill clause is **deleted**; absence of `recordedAtSeq` reads
  `'unknown'`, and a one-shot stamp (plus `--apply` covering every scanned book) is
  what lets legacy entries clear, via an affirmative comparison;
- **spine rule 2** and guard 3 replace revision 4's guard, which defended outside
  *mutation* — a defect class this codebase has never produced — and was blind to
  the one it has;
- the tie-break moves out of the resolver (`matchedHistoryKeys` + a predicate-side
  `max`), so `cast-resolve.ts` needs no widening and the `Pick` list drops from
  three-and-wrong to **one**;
- the `seq` increment rule is disambiguated to every write;
- citation fixes: `cast.tsx:304-307`, `finalize-chapter-write.ts:106`,
  `aggregate.ts:485` was a comment, and the guard regex must not fire on
  `cast-reject-orphan.ts:357`'s `===`.

**Rev 5 → 6** (post-merge correction, 2026-08-06 — after PR #2163 shipped
#2110/#2129/#2133 and left #2128 open). The uniform-stamp rule enumerated **six**
mutation sites and **four** keyless writes; both counts predate
`dropSupersededTargetsNoLongerLive`, which #2110 introduced in PR #2163 — i.e.
after this spec was written, and not caught by plan 280's after-the-fact
reconciliation of that PR. Now seven and five. The failure it would have caused is
subtler than a missing marker (the `stampAndBump` helper self-heals those): an
unwired write changes history state without moving `seq`, so two distinct states
share one counter and `castHistorySeq` stops identifying the state a render
resolved against. Line citations in the affected sections were dropped rather than
re-derived — #2110/#2133 shifted `cast-id-history.ts` by ~50-100 lines, so every
one of them pointed at the wrong write, the same drift this document already
resolved for `analysis.ts` by citing symbols (F2).

## Handover

Implementation is a separate thread. Its inputs are the plan doc produced from this
spec plus a handover-brief comment on each of #2110, #2129, #2133 and #2128. This
document is the design of record; the plan holds the task breakdown.
