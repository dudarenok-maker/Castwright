# cast.json write lock — design

**Status:** approved
**Closes:** #1981 (the filed defect), #2000 (the sweep), #2001 (§11),
#2006 (§14, §15), #2015 (§14.2) — **nothing is deferred out of this change**
**Sequencing:** implementation bases on / rebases onto `fix/server-1933-assign-readiness`

**Scope note (post-review):** §14 and §15 were added after five review rounds,
on a decision to fold every residual rather than ship a cleanup lane behind this
PR. They close #2006 and #2015, which earlier drafts deferred. Sections 6, 7 and
12 are written against the pre-fold scope and are annotated where the fold
supersedes them — read §14–§16 as the current position.

**Review:** four adversarial passes on the pre-fold scope — 3C/8M/3m, 4C/6M/8m,
1C/5M/5m, then 0C/4M/4m; a fifth reviewed the plan (2C/8M/6m, all in the plan).
§14 and §15 postdate all of them and have not yet been through a round. Each round's worst findings landed in whatever the *previous* round had
just rewritten, which is the main thing to know when reading this document: the
parts revised most recently are the parts least proven. Round 3 verified ~60
citations clean; round 4 confirmed the three-class lock order holds across every
traced path, and that the scope reductions did not hollow the sweep out.

Two sections were re-decided outright rather than patched. §6 tried "analysis owns
cast.json" (round 1), then a route-level admission gate (round 2), and now defers
to #2015 having rejected both — the second survived a full review round before
failing the next. §7 claimed all four clone-consent gates were folded in (round
2), then that gate 2 was fixed by a `library-voice` lock (round 3) — which was
inert, because no *writer* took the key. It now specifies both sides.

The pattern is worth naming: every one of those failures was a design that read
as coverage while covering nothing. §10's revert-verification and §10.3's
cross-module outcome spec exist to catch that in the tests; this header exists to
flag it in the prose.

Round 4 also inverted a claim the first three drafts all carried — that a
partitioned lock passes tests silently. It does not; partition means no
contention, which means a lost mutation, which makes the outcome test go **red**
(§3.1). The countermeasure moved accordingly, from detecting partition to
covering the one case no self-vs-self race can reach.

## 1. What was filed, and what is actually wrong

#1981 reports that #1953's designed-arm manifest read `await`s inside
`/api/voice-library/:voiceUuid/assign`'s cast.json read-modify-write window
(`readJson` → `nextCharacters` → `writeJsonAtomic`), violating the invariant
documented at length in that route.

The report is accurate. That `await` is the only yield between the cast read and
the cast write; every other helper in the window (`getResolvedTtsModelKey`,
`engineForModelKey`, `resolveCharacterEngine`, `cloneStorageKey`,
`sidecarLanguageName`, `bookStateLanguage`) is synchronous, verified individually.

**But the invariant itself is unsound, and that is the real defect.** The route's
comment asserts that a window containing zero `await`s makes the RMW "effectively
atomic". It does not. The *read* is itself a yield point:

```
A: await readJson(cast)   ─┐ yields to the event loop
B: await readJson(cast)   ─┘ yields to the event loop
A: read resolves → runs synchronously → writeJsonAtomic starts
B: read resolves → runs synchronously → writeJsonAtomic starts
                                        ↑ B's snapshot predates A's write
```

Both writes land. `writeJsonAtomic`'s rename makes each write individually
non-torn, but the later rename wins outright, and A's mutation is gone.

This is not theoretical. A spike run in this worktree (§10.1) had two concurrent
read-modify-writes against one cast.json, issued from a bare `Promise.all`, lose a
mutation in **200 of 200 trials**. That figure is pinned by task 1 of the plan,
which lands the spike as a committed test before any site is converted — it is not
reproducible from this document alone.

Two consequences follow, and they shape everything below:

1. **#1981's second acceptance criterion cannot be satisfied by the hoist it
   asks for.** "A concurrent-writer harness proving the second write is not
   clobbered" fails both before *and* after the hoist. The only test that goes
   red→green on a hoist alone is one that interleaves specifically at the
   manifest-read yield point — a mechanism assertion dressed as an outcome one.
2. **`/assign` is not the worst offender.** It is the only cast.json writer that
   documented the invariant at all. Its siblings never attempted it.

## 2. The scale of it

Seventeen modules write `writeJsonAtomic(castJsonPath(…))` across 35 call sites.
cast.json is the most-written file in the workspace and has no lock of any kind.
Two further sites *delete* it. Measured read→write spans:

| Site | Span | inside the window |
|---|---|---|
| `qwen-voice.ts` `promote-voice` | `:692` → `:793` | a `stat`, **four `rm`s**, **three `rename`s**, a `copyFile`, and a **sidecar `fetch`** at `:768` |
| `cast-merge.ts` | `:77` → `:197` | writes *manuscript-edits.json* at `:171` |
| `voice-override-linked.ts` | `:235` → `:364` | `await`s |
| `library-cast-override.ts` | `:88`/`:89` → `:152`/`:153` | `await`s, **two books** |
| `voice-library.ts` `/assign` | `:1277` → `:1434` | one (`:1386`) — the filed issue |
| `analysis.ts` | `:2797` → `:3558`/`:3763`/`:4774` | **an entire analysis run** — see §6 |
| `cast-design.ts` | `:289`→`:293`, `:448`→`:452` | already re-reads `fresh` before writing |

`promote-voice` — not `/assign` — holds the longest window in the codebase, and
it spans a network call to the sidecar. `cast-design.ts`'s re-read-then-write is
a hand-rolled mitigation of this exact race, corroborating that the defect class
is real and has been felt before, and it is the shape a lock wants.

It is not, however, a clean template. Its decisions — the two idempotency
`continue`s at `:268`/`:269` — are taken from the *first* read, and an LLM persona
generation runs at `:273` before the `fresh` re-read at `:289`. Locking `:289-293`
protects other characters' fields but leaves those decisions stale: two concurrent
runs can each generate a persona and the second overwrites the first. Recorded as
a residual in §12. The narrowing pattern is right; this instance of it is
incomplete, and §5 says so where it reuses the shape.

Line numbers here are as of `main` at `88476dca` and will shift — see §9. The
implementation plan cites symbols, not lines.

## 3. Decision: serialise, don't narrow

The fix is a per-book cast.json write lock, applied to every writer. Narrowing
windows is unfalsifiable defence; a lock either holds the critical section or it
does not, and a test can tell you which.

The codebase already has the primitive. `server/src/workspace/file-lock.ts`
exports `withKeyLock(key, fn)`, a generic per-key promise-chain mutex — the same
idiom as `tts/design-lock.ts`'s `withDesignLock(bookDir, fn)` and
`chapters-restructure.ts`'s `withBookLock`. Nothing new is invented here.

### 3.1 The two exports

New file `server/src/workspace/cast-lock.ts`:

```ts
withCastLock<T>(bookDir: string, fn: () => Promise<T>): Promise<T>
withCastLocks<T>(bookDirs: string[], fn: () => Promise<T>): Promise<T>
```

`withCastLock` delegates to `withKeyLock(castJsonPath(bookDir), fn)`.

The wrapper is not ceremony. **Key derivation must live in exactly one place.**
Two things can partition this lock into mutexes that never contend:

- **Derivation drift.** One site keys on `bookDir`, another on
  `castJsonPath(bookDir)`, or on an unnormalised path separator. A single named
  function removes the opportunity.
- **Module-registry drift — the one that will actually bite.** `chains` is
  module-level state (`file-lock.ts:5`), and **29 server test files call
  `vi.resetModules()`**, the dominant workspace-test idiom (`mkdtemp` +
  `WORKSPACE_DIR` + `vi.resetModules` so `paths.ts` re-reads the override — see
  `routes/backup.test.ts:7`). Any spec where the route under test and a second
  writer resolve through different module registries gets **two `chains` Maps**.

**Partition surfaces as a failing test, not a passing one** — the first three
drafts had this exactly backwards, and it is worth stating plainly because it
redirects the whole countermeasure. Two `chains` Maps means no contention, which
means the unlocked behaviour §10.1 measured at 200/200 lost mutations. §10.2's
outcome test asserts *both* mutations survive, so a partitioned lock makes it go
**red**. Key-derivation drift has the same signature: different keys, no
contention, red.

So partition is a false-red/flake risk, not a silent-coverage risk, and the
import-graph pin in §10.3 is hygiene rather than a detector.

**The genuinely undetectable case is different**, and it is the one to design
against: a spec that races one site *against itself* resolves both calls through
one import and one key, so it can never observe a key mismatch **between two
different sites**. That is what §10.3 now targets.

`withCastLocks` **dedupes, then sorts** the derived keys, then nests:

- **Sorting** makes AB/BA deadlock impossible by construction, which matters
  because five call sites take two books and their argument order is
  caller-determined.
- **Deduping** matters for `library-cast-override.ts`, the one two-book route
  that can legitimately receive the same book twice — its guard at `:77` rejects
  same-book *and* same-character only. (The other four reject same-book outright
  with a 400: `cast-link-prior.ts:84`, `cast-add-from-roster.ts:79`,
  `cast-not-linked-to.ts:57` and `:154`.) A promise-chain mutex is not reentrant;
  acquiring one key twice in a single call wedges that request permanently.

  **That same-book path is already broken without any concurrency**, and §8 folds
  the fix in.

### 3.2 Granularity for the N-book fan-outs

**Decision: lock per book, inside the loop.** Each book's RMW is individually
atomic; the fan-out as a whole is not.

The alternative — collect all N `bookDir`s, sort, acquire every lock, run the
whole propagation, release — would make a series update genuinely all-or-nothing.
It was rejected because a workspace-scoped `PUT /:voiceId/override` would then
hold a lock on *every book in the workspace* across a full directory walk plus N
file writes, queueing every other cast write in the process behind it. The
accepted cost is that a concurrent writer can interleave *between* two books of
one propagation, so a series update can land half-old/half-new. That is weaker
than the guarantee the current code claims and stronger than the one it has.

## 4. The rules

Four rules, stated in `cast-lock.ts`'s header comment and as a bullet under
CLAUDE.md's *Conventions worth preserving*:

1. **Lock the innermost read-through-write, never the caller.** One level only.
   A locked function must not call another locked function on the same book.
2. **The read goes inside the lock, and so does every decision derived from it.**
   Wrapping only the write buys nothing at all. This is the easy way to produce a
   diff that looks correct and fixes nothing.

   **The carve-out, and its criterion.** Four sites legitimately leave something
   outside — `promote-voice`'s `realVoiceId`, `cast-design.ts`'s two idempotency
   guards, `cast-add-from-roster`'s target read, and
   `ensureCharacterVoiceUuid`'s series branch. A value may stay outside the lock
   **only when** (a) re-deriving it inside would be wrong rather than merely
   redundant — because irreversible work outside the lock has already committed to
   it, as with `realVoiceId`'s renamed artifacts — or (b) it is a cross-book read a
   per-book lock cannot cover anyway. Every such case is named at its site and
   carried as a residual in §12. **Anything not on that list, with a reason
   written down, is rule 2's failure mode and not a narrowing.** A reviewer who
   cannot tell which they are looking at should treat it as the failure mode.
3. **Two or more books → `withCastLocks`, never nested `withCastLock`s.**
4. **Global lock order: `design` → `series` → `library-voice` → `cast`.** Every
   acquisition site names where it sits in that order. Never acquire a lock from
   an earlier class while holding one from a later class.

Rule 4 covers **four** lock classes. `series:<author>/<series>` is added by §15;
the existing `design → cast` path (`qwen-voice.ts:193` → `:203`) becomes
`design → series → cast`, which is consistent with the order rather than a new
constraint on it.

It covers more than two. The first rewrite stated it over
`design` and `cast` only, and §7 then introduced `library-voice:<uuid>` four
sections later — leaving a rule that would read as satisfied by an ordering it
had never considered. Concretely, the `DELETE /voice-library/:voiceUuid` path
holds `library-voice:U` across `clearLibraryVoiceReferences`, which takes a cast
lock per book (`voice-library-usage.ts:113`); so `library-voice → cast` is
mandatory, and `POST /assign` must acquire `library-voice:U` **before** its cast
lock rather than after. Acquiring them the other way round is an AB/BA cycle on a
mutex with no timeout and no diagnostic — both requests hang permanently.

Rule 4 also replaces a claim in the first draft that was a non-sequitur:
*"`withDesignLock` and `withKeyLock` are separate maps, so holding a design lock
while taking a cast lock is not a self-deadlock — only the same key twice is."*
Separate maps rule out *self*-deadlock; they are exactly what makes ordinary
two-lock AB/BA deadlock possible. A **design → cast** path is already live:
`qwen-voice.ts:193` holds `withDesignLock(bookDir)` across `:203`'s
`forEachMatchingCastCharacter`, which under this design takes a cast lock per
matching book. No **cast → design** path exists today, so the design is not
deadlocked — but the rule set is what future contributors read, and without rule 4
it actively teaches them that cross-lock nesting is free. Any future change that
wraps a `withDesignLock` call in a cast lock — for instance around
`qwen-voice.ts:193` itself, or around `single-design.ts`'s design invocation —
creates the opposite order and deadlocks with no timeout and no diagnostic.

**What the lock does not cover.** It protects one read-modify-write. It does not
make a *validate-then-write* safe when the validation and the write are in
different lock scopes — see §7's clone-consent gates, folded in at §8.

## 5. Site conversion — all 35, enumerated

The first draft's class table summed to 29 and switched counting units mid-table.
This one enumerates every site, counts sites throughout, and must sum to 35. The
plan carries an arithmetic check on that.

### Class 1 — mechanical: wrap the existing read..write span (18 sites)

| Module | Sites |
|---|---|
| `cast-aliases.ts` | `:161`, `:268`, `:354` |
| `cast-create.ts` | `:91` |
| `cast-merge.ts` | `:197` |
| `cast-series-patch.ts` | `:221` |
| `cast-design.ts` | `:293`, `:452` |
| `voice-style.ts` | `:69`, `:129` |
| `voice-override-linked.ts` | `:364` |
| `book-state.ts` | `:634` |
| `voice-library.ts` | `:1434` (`POST /assign`), `:1536` (`DELETE /assign`) |
| `qwen-voice.ts` | `:793` (`promote-voice`), `:893` (`DELETE emotion-variant`) |
| `cast-add-from-roster.ts` | `:147` |
| `voice-library-usage.ts` | `:113` — **not mechanical, see below** |

Three of these are not routine wraps despite sitting in this class:

- **`qwen-voice.ts:793`** (`promote-voice`) was missing from the first draft
  entirely, and it is the one site that must **not** be wrapped as-is. Its span
  covers a `stat`, four `rm`s, three `rename`s, a `copyFile` and a sidecar
  `fetch` (`:768`) — which has no `AbortSignal` and no timeout, so under undici
  defaults a hung sidecar holds it for minutes. Wrapping `:692→:793` would put a
  network round-trip inside the hottest lock in the product and stall every cast
  write for that book behind it.

  **Instead: narrow the lock to a fresh re-read plus the write, at the end**, with
  the artifact moves and the evict `fetch` outside it. That keeps §12's "one file
  read plus one file write" hold-time claim true — which, wrapped naively, it
  would not be.

  Narrowing here is not a one-line change, because the `:692` read is load-bearing
  throughout: `:698` derives `realVoiceId` from `character.voiceUuid`, and that
  value drives the 400 gate, the `stat` 409, the `rm`s and `rename`s, the
  `copyFile` and the evict payload; `:787` takes `qwenSlot`, `:789-791` builds
  `staleVariantIds` from it, and `:792`'s `delete qwenSlot.variants` mutates the
  `:692` object *in place* — which `:793` then writes. So the lock body is
  specified exactly, and the implementer invents nothing:

  1. Inside `withCastLock`, **re-read** cast.json and re-find the character. If it
     is gone, **no-op — do not 404.** The artifact renames have already committed
     by this point and the handler reports them as done, so a 404 would misreport
     completed work. (An earlier draft of this section said 404; the plan's Task 8
     is correct and this is the retraction.)
  2. **Re-derive `qwenSlot` and `staleVariantIds` from the fresh object**, apply
     the `delete`, and write that object. The `:692` copy must not be the payload.
  3. **`realVoiceId` stays pinned to the pre-lock read, deliberately** — the
     artifacts have already been renamed to it by the time the lock is taken, so
     re-deriving it afterwards would name files that do not exist. The divergence
     (a concurrent write changing `voiceUuid` mid-promotion) is a residual,
     recorded in §12, not something this lock can fix.
  4. The `staleVariantIds` teardown stays **outside** the lock — it is filesystem
     work, and holding the lock across it reintroduces the problem being avoided.
- **`book-state.ts:634`** has **no cast read at the call site** — the write's
  argument is `await preserveDesignedVoices(bookDir, body.patch)`, and the read
  lives inside that helper (`book-state.ts:128-130`). Wrapping "the span"
  mechanically therefore locks the *write only*, which is rule 2's named failure
  mode. It is also the site where a stale read does the most damage: that read
  feeds `rejectForeignCloneKeys` (`:135`) and `preserveClonedSlotsOnCastWrite`
  (`:140`), both **clone-consent guards**. The lock must enclose the
  `preserveDesignedVoices` call and the write together, or be pushed into the
  helper.
- **`cast-add-from-roster.ts:147`** moved here from class 2 after round 2: it
  reads *both* books (`:104`, `:105`) but writes **only the source** (`:147`), and
  `:79` already 400s same-book. A single-book lock on the source is correct;
  `withCastLocks` across both would widen a lock over a second book for a
  read-only consultation. Note the target read still feeds the decision, so it is
  a check-then-act — accepted per §12, not closed here.
- **`voice-library-usage.ts:113`** needs its read moved inside the lock, because
  `walkConfirmedCasts()` (`:43`) *yields* an already-read `cast`. An earlier draft
  called this a shared-seam restructure, on the grounds that the walker is shared
  with `scanLibraryVoiceUsage` (`:71-85`). It is not: `clearLibraryVoiceReferences`
  consumes only `bookDir` and `cast.characters`, so it can **ignore the yielded
  `cast` and re-read `castJsonPath(bookDir)` inside its own per-book lock**,
  leaving the walker's signature and the read-only scan untouched. A contained
  conversion, not a design decision.

### Class 2 — multi-book: `withCastLocks` (8 sites)

| Module | Sites |
|---|---|
| `cast-link-prior.ts` | `:142`, `:248` |
| `cast-not-linked-to.ts` | `:106`, `:109`, `:202`, `:207` |
| `library-cast-override.ts` | `:152`, `:153` — plus the §8 fix |

### Class 3 — `voices.ts` fan-out: two branches, two write sites (2 sites)

`forEachMatchingCastCharacter` (`voices.ts:771-834`) has its **own inline walk**;
it does not use `walkConfirmedCasts` at all. Two branches:

- **`:816-829`, the workspace/series walk**, writing at `:828`. **This path is
  live for every series book**, and the first draft claimed the opposite. The fast
  path is gated on `if (!seriesFilter && onlyBookDir)` (`:788`), and both cited
  callers pass `seriesFilter` *as well as* `job.bookDir` (`cast-design.ts:510-515`,
  `single-design.ts:176-183`) — so for any book in a real series the walk runs.
  Three further callers never pass `onlyBookDir` at all: `applyTierToCastFiles`
  (`voices.ts:938`, from `cast-tier.ts:38`), `persistEmotionVariant`
  (`qwen-voice.ts:170`), and `ensureCharacterVoiceUuid` (`qwen-voice.ts:203`).
  Per-book lock inside the loop, read moved in with it.
- **`:788-803`, the `onlyBookDir` fast path**, writing at `:801` — taken only when
  there is no `seriesFilter`, i.e. standalone books.

This correction matters beyond the table: §3.2's granularity trade was originally
reasoned as though the workspace walk were near-dead. It is not. The trade still
stands — holding N locks across a full directory walk is still the worse option —
but it is now a trade against a live path, and §12 records the resulting
half-old/half-new exposure as a real accepted risk rather than a theoretical one.

### Class 4 — re-entrancy restructure (2 sites)

`qwen-voice.ts:177` (`persistEmotionVariant`) and `:215`
(`ensureCharacterVoiceUuid`). See §5.1 — these are the highest-risk conversions.

### Class 5 — `analysis.ts`: not a lock site at all (5 sites)

`:3558`, `:3763`, `:4774`, `:5422`, `:5927`. These do **not** take a cast lock.
See §6.

**18 + 8 + 2 + 2 + 5 = 35.** ✓

### Class 6 — deletions (2 sites, not counted in the 35)

`analysis.ts:2845` (`rm(castJsonPath(…), { force: true })` on "Start fresh") and
`book-state.ts:923` (the reparse handler, inside a `Promise.all`). Both destroy
cast.json and neither matches `writeJsonAtomic(castJsonPath(`, so the first
draft's guard test could not see them.

They matter because a delete that is not serialised against the writers can
simply be undone: a writer that acquires after the delete recreates cast.json,
resurrecting the stale roster the delete exists to remove
(`analysis.ts:2836-2841` documents that intent). Both take the cast lock; the
guard pattern extends to `rm(castJsonPath(`.

(An earlier draft justified this by claiming the lock "lengthens the gap between
a queued writer's read and its write". That is wrong under rule 2 —
`file-lock.ts:12-14` awaits `prior` *before* `fn()`, so a queued writer's read
happens after the holder's write and the gap is unchanged. The claim held only
for the sites whose reads are deliberately left outside, i.e. the exceptions.)

### 5.1 The re-entrancy restructure

The first draft said the outer read is used "only for the branch decision (does
the character exist, does it already have a `voiceUuid`), never as the payload
for a write." **That decision is exactly the thing that must be inside the lock**,
and the draft placed it outside.

**`ensureCharacterVoiceUuid`** (`qwen-voice.ts:188-218`) is safe *today* only
because `withDesignLock(bookDir)` at `:193` wraps read → decide → mint → write as
one critical section. Its own docstring says so (`:182-184`: "Mints under the
per-book design lock so two concurrent designs of one character can't mint two
uuids"). Moving the `voiceUuid` check outside the cast lock makes correctness
depend entirely on an unrelated lock that this same PR is editing (§11). Two
concurrent calls would both read "no uuid", both mint, and the second write would
win — reintroducing the exact double-mint the design lock exists to prevent.

**`persistEmotionVariant` is not the same shape**, and "identical treatment" was
wrong. It has *no* design lock: `cast-design.ts:521` and `qwen-voice.ts:623` both
call it *after* `designQwenVoiceForCharacter` has released the lock
(`qwen-voice.ts:384-471`). And its outer read is not merely a decision — `:152`
computes `baseVoiceId = qwenStorageKey(character, characterId)` from the stale
character, and that value enters the write payload at `:158`/`:161` as the
default `name` when the qwen slot has none. `qwenStorageKey` reads `voiceUuid`,
so a `voiceUuid` that changed between the outer read and the lock anchors the
variant slot on a base that never existed — the #1057 orphaned-base shape,
surfacing as a silent Kokoro fallback on re-render. (Narrower than the first
rewrite implied: it bites only when the slot has no existing `name`.)

**The rule:** the re-read inside the lock must **re-evaluate every decision and
re-derive every value** that feeds the write — re-check `voiceUuid`, re-derive
`qwenStorageKey`. The outer read is an early-out optimisation, never
authoritative.

### The branch this rule cannot cover, stated plainly

Round 2 established that the rule above is satisfiable for the **book-scoped**
branch of both functions and **not** for `ensureCharacterVoiceUuid`'s **series**
branch. In that function the `voiceUuid` check (`:197`) and the mint (`:199`) sit
*above* the branch; the series branch (`:202-205`) then delegates to
`forEachMatchingCastCharacter`, which re-reads each book but is handed an
already-decided uuid. There is no cast-lock scope in which the decision could be
re-evaluated, because the decision precedes the branch.

Two concurrent series-scoped calls therefore both read "no uuid", both mint, and
both propagate. **Within one book that is prevented by `withDesignLock(bookDir)`
at `:193`**, as the function's own docstring claims (`:182-184`).

**Across books it is not prevented at all, and that is a pre-existing defect this
spec must not paper over.** `withDesignLock` keys on `bookDir`
(`design-lock.ts:26-27`), and so do `isDesignBusy`, `isAnalysisBusy` and
`cast-design.ts:648`'s `inFlightByBook` gate. Two bulk-design jobs on **two
different books of one series** therefore hold two different design locks; both
call `ensureCharacterVoiceUuid(job.bookDir, characterId, seriesFilter)`
(`cast-design.ts:485`) for the same linked identity, both see no `voiceUuid` at
`:197`, both mint at `:199`, and both propagate across the whole series at
`:203`. The design lock is per-book; the propagation is not.

This sweep makes the *outcome* finer-grained rather than worse: today the two
propagations race whole-file and one wins; afterwards `forEachMatchingCastCharacter`
locks per book, so they can interleave per book and leave the series carrying a
**split** uuid. Recorded as a residual in §12 and added to #2006's scope.

So the honest position, replacing the first rewrite's "the design lock is not
part of the guarantee and must not be relied on":

- For the **book-scoped** branch, the cast lock is the guarantee and the design
  lock is not relied on.
- For the **series** branch, **the design lock remains load-bearing for same-book
  concurrency, and nothing protects the cross-book case.** This spec does not
  change either. Moving the decision under a cast lock would require
  `ensureCharacterVoiceUuid` to hold a cast lock across
  `forEachMatchingCastCharacter`, which violates rule 1 — genuine design work,
  and out of scope here.
- §11 edits `design-lock.ts`'s map cleanup **only**. It does not touch
  acquisition, release, or ordering, so the series branch's existing guarantee is
  unaffected. The implementation brief calls this out so nobody "simplifies" the
  design lock away while touching that file.

`persistEmotionVariant` has no design lock to lean on, so its book-scoped branch
must take the cast lock and re-derive `qwenStorageKey` inside it; its series
branch inherits `forEachMatchingCastCharacter`'s per-book locking and the same
residual exposure.

## 6. `analysis.ts` — ownership, not a mutex

`analysis.ts` is 5 of the 35 sites and the module that writes cast.json most
often. It is **not a wrappable read-modify-write**: `priorCastForMerge` is read
once at `:2797`, reconciled at `:2823`, and is then the merge base for writes at
`:3558`, `:3763` and `:4774` — spread across the whole Phase 0/1 pipeline, with
the interim writes *inside* the chapter loop. The subset route has the identical
shape (read `:5206`, writes `:5422`, `:5927`).

Neither available lock strategy works. Holding a cast lock for the run would
block every other cast write on that book for minutes with no timeout. Re-reading
inside each write's lock would change behaviour: iteration N would re-read the
interim cast iteration N−1 wrote, so `mergeAnalysisResultWithExistingCast` would
no longer merge against the pre-run cast and srv-13's voice/reuse carry-forward
would silently degrade.

> **Superseded by §14.2.** This section records why the two *lock-based*
> mitigations were rejected, which is still the reasoning that rules them out.
> The conclusion — that `analysis.ts` ships unprotected — no longer holds: §14's
> revision counter closes it without either mitigation, by checking the merge
> base at each write instead of trying to keep it valid across the run. #2015 is
> closed by this PR.

**Decision at the time: `analysis.ts` is out of scope. Its five writes stay
unprotected, recorded as a named residual and filed as #2015.**

Two mitigations were designed and both rejected. They are recorded because each
looked obviously right at the time, and the second survived a full review round
before failing the next one.

**Rejected — "analysis owns cast.json", via the `markAnalysisBusy` registry.**
Consulting `isAnalysisBusy` from an unlocked writer is *itself* check-then-act —
the exact defect class this spec exists to close. `isAnalysisBusy` is a bare `Map`
read (`tts/design-lock.ts:63-65`) with no coupling to the cast mutex. A writer
that reads `false`, then `await`s its cast read — the very yield §1 identifies as
the race — then writes, races a run that marked busy (`analysis.ts:2572`,
`:5109`). The consultation's window is *wider* than the one #1981 filed.

**Rejected — a route-level admission gate.** The salvage was to check busy at
request entry and 409 early, on the precedent of `cast-design.ts:655` (currently
the only `isAnalysisBusy` call site, and a correct one — it checks before
flushing SSE headers). Three things killed it:

- **Most sites cannot express a refusal.** Seven of the 30 non-analysis write
  sites have no status-code channel — `cast-design.ts:293`/`:452` run detached
  after `res.flushHeaders()` and report via SSE `endJob`; `qwen-voice.ts:177`/
  `:215`, `voices.ts:801`/`:828` and `voice-library-usage.ts:113` are shared
  helpers with multiple callers, for which "refuse" is undefined — particularly
  when book 7 of 12 is busy and six are already written. (Plus
  `single-design.ts:178`'s call into `voices.ts`, which is a caller rather than
  one of the 35 sites.)
- **The gate set is not enumerable from a site-indexed spec.** §5's tables index
  write *sites*, so routes that write transitively are invisible in them:
  `cast-merge-suggestions.ts:92` (via `performCastMerge`) and `cast-tier.ts:38`
  (via `applyTierToCastFiles` → `forEachMatchingCastCharacter`) both write
  cast.json and would have been missed. For the two-book routes the spec never
  said which `bookDir` to check.
- **It is a ~20-route API contract change** — `openapi.yaml` is the documented
  source of truth for backend shapes — plus release-notes and frontend handling,
  bought for something the design itself concedes is *not* a correctness
  guarantee, since a run can begin after a handler is admitted.

Paying a contract change across twenty documented routes for a probabilistic
improvement is a poor trade, and it is the part of this design that kept
generating findings. The lock sweep stands on its own without it. `#2015` carries
the real fix — a merge base that survives the run, via compare-and-set or a
recomputed delta — with the rejected options recorded so they are not
re-proposed.

The two deletion sites (§5 class 6) still take the cast lock — a delete is
instantaneous and does not own the book.

## 7. Check-then-act: the clone-consent gates, folded in

A per-RMW lock does not close a *validate-then-write* that spans two scopes. Four
gates read cast.json, decide, and then write elsewhere. **The first rewrite's
table had three of these four rows wrong** — it printed the `readJson` line as the
gate and the gate line as the write, because the citations were regenerated by
pattern-matching nearby lines rather than re-derived. Corrected, with the function
each write lives in:

| Gate | Reads | Decides (409) | Writes |
|---|---|---|---|
| `voices.ts` `PUT /:voiceId/override` | `:612-642` walk | `:709`/`:720` `hasClonedSlotAmongMatches` | `:728` `applyOverrideToCastFiles`, per book inside `forEachMatchingCastCharacter` |
| `voice-library.ts` `DELETE /:voiceUuid` | `:1680` `scanLibraryVoiceUsage` | `:1682` (`usage.length > 0 && !confirmed`) | `:1686` `clearLibraryVoiceReferences`, then `eraseLibraryVoiceArtifacts` |
| `single-design.ts` | `:235` | `:254` `characterHasClonedSlot` | `:178` `applyOverrideToCastFiles`, in `runSingleDesign`, detached after `res.flushHeaders()` (`:266`) |
| `qwen-voice.ts` | `:532` | `:552` `characterHasClonedSlot` | `:623` `persistEmotionVariant` |

Against the corrected map, "each gate re-validates inside the lock scope that
performs its write" is **not achievable for three of the four**:

- **`voices.ts` is a cross-book veto.** `hasClonedSlotAmongMatches` walks the
  whole workspace or series and blocks the entire operation if any matching
  character anywhere carries a cloned slot; the write is per-book. Re-validating
  inside a per-book lock demotes a workspace veto to a per-book one, and honouring
  it mid-walk means a 409 on a partially-applied propagation. Fixing it properly
  means reopening §3.2.
- **`single-design.ts` and `qwen-voice.ts` write from contexts that cannot
  refuse** — one detached after header flush, one a helper shared between an SSE
  bulk job and a JSON route.

**Decision: fix gate 2 here; file the other three.**

**Gate 2 is fixed, and its fix is not a cast lock.** The data loss is real —
a reference written after the scan passed a book is left dangling at a
`libraryUuid` whose artifacts `eraseLibraryVoiceArtifacts` is about to erase —
and it is cross-book by construction, so no per-book cast lock can reach it. The
fix is a lock on a **different key**: `withKeyLock('library-voice:<uuid>')` held
across scan → clear → erase. With `?confirm=1` the user has already consented, so
there is nothing to re-validate — the lock protects the *artifact erasure*, not
the 409 decision.

**Both sides must take the key, or the lock does nothing.** The first version of
this section specified only the DELETE side, which would have serialised DELETE
against DELETE and left the described race entirely open — a lock that makes the
defect look addressed. The writers that plant a `libraryUuid`:

- **`POST /:voiceUuid/assign`** — writes `libraryUuid` at `voice-library.ts:1416`
  and `:1425`, persisted at `:1434`. It **acquires `library-voice:<voiceUuid>`
  first, then its cast lock**, per rule 4's order. It can, because the uuid is its
  route parameter. This is the acquisition that makes the gate-2 fix real.
- **`cast-link-prior.ts:239-241`** spreads `target.overrideTtsVoices` — including
  `libraryUuid` and `provenance` — into the source character and writes at
  `:248`, creating a new reference, in a different book, to a uuid the request
  never names. It **cannot** take the key up front, because it does not know which
  uuids it is about to plant until it has read the target; taking it afterwards is
  check-then-act over an unbounded uuid set. **Added to #2006** as a fourth entry,
  and named here as an accepted hole rather than left implicit.

This also sequences `voice-library-usage.ts:113` (§5 class 1), since
`walkConfirmedCasts` is shared between `clearLibraryVoiceReferences` and this
gate's `scanLibraryVoiceUsage`.

> **Superseded by §14.** Gates 1, 3 and 4 were filed rather than fixed because
> the open question was what a refusal *means* for a partially-applied cross-book
> propagation and for a detached job. §14.2 answers exactly that, generically:
> recompute where you can, 409 where you can, report-and-skip where you can do
> neither. #2006 is closed by this PR. The analysis below stands — it is why a
> per-book cast lock alone was never going to be the mechanism.

**Filed at the time as #2006** — one issue, not three. They are the
fs-38 Wave 3c clone-consent guards, added because "Phase 0 fixed seven live bugs
that all had the same shape — a guard-less write erasing a clone marker upstream
of a resolver" (`voices.ts:888-893`). The real work in each is deciding what a
refusal *means* for a partially-applied cross-book propagation and for a detached
job — a behaviour decision, not a locking one. Shipping a lock that reads as
"cast.json writes are safe now" while they stay open is how the eighth gets
missed, which is what #2006 exists to keep visible.

## 8. `library-cast-override.ts` same-book: folded in

`library-cast-override.ts`'s guard at `:77` rejects same-book *and* same-character
only, so `source === target` with different characters is reachable — and that
path is **already broken with no concurrency at all**. `:88` and `:89` are two
independent reads of the same file; `:141` and `:144` derive two arrays from those
separate snapshots; `:152` and `:153` write the same path twice. Since
`nextTargetCharacters` does not contain `mergedSource`, the second write silently
discards the source character's merge.

`withCastLocks`'s dedupe removes the deadlock and lets both writes proceed — the
data loss survives, now under a lock, which makes it look addressed. It is a
defect in code this branch already touches, with one obvious fix, coverable by a
test in this PR: it clears CLAUDE.md's fix-now bar. Same-book takes one read and
one merged write.

## 9. #1981 specifically

The lock supersedes the hoist: under a held lock the `await` at `:1386` is
harmless, and hoisting costs a wasted manifest read on every request that later
`404`s on the character or `409`s on engine routing.

**The hoist still lands, on the partial-adoption argument alone.** The first
draft justified it as "a large and worthwhile reduction in the odds"; that number
is unmeasured and mechanically dubious — `writeJsonAtomic`
(`workspace/state-io.ts:93-120`) yields at least three more times before its
rename lands (`mkdir`, `writeFile`, `renameWithRetry`), and a competing
`readJson` is a single queued `readFile` that will almost always resolve inside
that. The honest claim is that it narrows the window by an unmeasured amount, and
that with 35 lock sites and future writers who will forget, keeping the window
`await`-free is cheap insurance against partial adoption. That is the whole
justification.

Mechanically: the manifest read moves above the cast read (it depends only on
`entry.provenance`, `voiceUuid`, and `located.state`, all in hand by then); the
warning *string* is still built at its current site, because it needs
`character.name`, and string formatting is synchronous.

The invariant comment is rewritten. It must say that **the lock is the
guarantee** and the `await`-free window is a secondary, unmeasured narrowing. It
must stop claiming atomicity, because that claim is what made this defect look
like a one-line violation of a sound rule rather than a symptom of an unsound one.

### 9.1 Sequencing against #1933

`fix/server-1933-assign-readiness` is open, actively edited in another session,
and rewrites 208 lines of `server/src/routes/voice-library.ts`, moving the
readiness gate below the cast read. Verified against that branch: it introduces
**no new `await`** into the window — the gate stays synchronous, and the only
yields remain the cast read, the manifest read, and the write. It shifts the read
`1277 → 1415` (+138) and the write `1434 → 1612` (+178), i.e. it adds ~40 lines
*inside* the window. Harmless, but the span grows.

The implementation branch cuts after #1933 merges, or rebases onto it if still
open. This spec and the plan cite symbols rather than line numbers so both
survive the shift.

## 10. Testing

Two failure modes to design against: a lock wrapped around the write only, and a
test that is green because the lock partitioned rather than because it held.

### 10.1 The interleave mechanism — settled in mechanism; the number lands as task 1

The first draft deferred this to the plan as "an open risk". It is now measured.
A spike run in this worktree against real files, in a single import graph,
compared two candidate harnesses:

| Mechanism | Unlocked | Locked |
|---|---|---|
| bare `Promise.all` of two RMWs, 200 trials | **200/200 lost a mutation** | **0/200** |
| `vi.spyOn` barrier holding both readers, 20 trials | 20/20 lost a mutation | — |

A bare `Promise.all` loses a mutation **100% of the time**: both `readFile`s are
issued in the same tick and both resolve before either write. No barrier is
needed, and the simpler harness is also the deterministic one.

**Decision: bare `Promise.all`, used uniformly at every site.** The barrier
mechanism is not used anywhere — a second mechanism would let a site that fails
under one be quietly rewritten to the other.

**The spike is task 1 of the implementation plan, not an artifact of this spec.**
Round 2 correctly objected that these numbers were unreproducible: the spike file
was written, run, and then moved out of the repo, so the evidentiary spine of §1,
§3 and §10.2 existed only as a quoted figure. It lands as a real committed test
(`server/src/workspace/cast-lock.race.test.ts`) **before any site is converted**,
proving red on the unlocked path first. Its single-import-graph property is not
incidental — see §10.3.

### 10.2 The outcome test

Two overlapping RMWs against one cast.json, each mutating a *different*
character; assert **both** mutations survive. Red today at every unlocked site,
green under the lock. It is an outcome assertion — it names the surviving data,
not the absence of a yield — and it stays red after the hoist alone, which is the
honest demonstration that the hoist was never the fix.

**Mutation-verified by reverting the producer.** Every outcome test is proven by
removing the lock at that site and watching it go red, with the output recorded —
not by reading the test and agreeing it looks right. A placebo test authored into
a plan gets copied faithfully and survives spec review; the plan states the revert
as a required step with recorded output.

### 10.3 The partition assertion — mandatory, and it comes first

Two countermeasures were proposed across earlier drafts and both were aimed at
the wrong failure. Recording the correction, because the reasoning matters more
than the conclusion:

- A **test-only `chains.size` accessor** was made mandatory in round 2. It cannot
  work: imported into the *spec file*, it resolves through the spec file's
  registry, which in the failure mode being detected is neither writer's. And in
  the half-partitioned case the observed size is `1` — indistinguishable from a
  correctly shared lock with one queued waiter, because `file-lock.ts:11`
  overwrites the key rather than adding an entry per waiter. **Not added.**
- **Pinning a single import graph** was then made mandatory in round 3, on the
  premise that partition otherwise passes silently. §3.1 now establishes that
  partition makes the outcome test go **red**, so this is hygiene against a
  confusing false failure, not a detector. **Keep it, but as hygiene.**

**The requirement that actually closes the gap:** at least one outcome spec must
race **two different modules'** write sites against the same book — for example
`cast-aliases.ts`'s alias split against `voice-style.ts`'s style write. A spec
that races one site against itself resolves both calls through one import and one
key, so it can never observe a key mismatch *between* sites, and cross-site
derivation drift is the one partition mode no self-vs-self test can reach.

Concretely: every outcome spec pins one registry (hygiene), and the cross-module
spec is a required deliverable, not an optional extra.

This is also why §10.1's spike lands as a committed test rather than a quoted
number: it is the reference for what a correctly-pinned harness looks like.

### 10.4 Guard test

No `writeJsonAtomic(castJsonPath(…))` **or `rm(castJsonPath(…))`** may appear
outside a lock scope, so site 36 cannot regress.

Its known blind spots, stated rather than papered over: it sees one syntactic
form, so `const p = castJsonPath(dir); await writeJsonAtomic(p, …)` passes, as
would a future writer routed through `workspace/schema-migrate.ts`'s cast.json
seam (`:44`, with the v1→v2 hook still commented at `:92`). The stronger form —
*if `castJsonPath` appears in a module, every `writeJsonAtomic`/`rm` in it is
inside a lock scope* — is preferred if it can be written without false positives.

No `verify-cache.mjs` `extraFiles` entry is needed. The #1847 trap applies to
files read at runtime from *outside* a step's globs; this guard reads
`server/src/**`, which `test:server` already globs (`verify-cache.mjs:113`) and
`verify.yml:152` already matches. Any diff adding an unlocked write site
necessarily busts both. Adding an entry would be a no-op and a cargo-culted
precedent.

### 10.5 Primitive unit tests

Sorted acquisition regardless of argument order; dedupe; release on throw;
waiter ordering; and the §11 map-cleanup assertion.

## 11. Folded in: the lock helpers never clean up their key map (#2001)

The `finally` cleanup in all three existing promise-chain mutexes is dead code.
`chains.get(key) === gate` compares against `gate`, but what was stored is
`prior.then(() => gate, …)` — a different object, so the identity check can never
hold and `delete` never runs. Each Map grows one entry per distinct key for the
process lifetime, while the comment above each asserts the opposite
(`design-lock.ts`: *"Tidy up when we're the chain tail, so the map doesn't grow
unbounded"*).

Three copies: `workspace/file-lock.ts:17`, `tts/design-lock.ts:45`, and
`routes/chapters-restructure.ts:86` — the last additionally allocating a *third*
promise inside the comparison itself. (`generation.ts:470`'s
`serializeQueueMutation` is a single global chain with no map and is correctly
not affected.)

**Fixed here, not deferred.** The sweep is about to make `withKeyLock` the mutex
behind every cast.json write in the product; shipping that on a helper whose
cleanup has never worked, and whose comment says it has, is not a defensible
scope line.

```ts
const mine = prior.then(() => gate, () => gate);
chains.set(key, mine);
…
} finally {
  release();
  if (chains.get(key) === mine) chains.delete(key);
}
```

Tail-detection is then correct, and there is no losing interleave: a waiter's
read of `prior` and its `chains.set` are in one synchronous block with no `await`
between (`file-lock.ts:8-11`), as are `release()` and the `delete`. So a waiter
either registered before the delete (entry ≠ `mine`, no delete) or starts fresh
from `Promise.resolve()` after `fn()` has already returned.

The same change applies to all three, but **the safety argument above is derived
against `file-lock.ts`'s structure and must be re-stated for
`chapters-restructure.ts`, not assumed.** That copy puts `await prev` *inside*
its `try` and omits the `.catch()` swallow, so its control flow differs. (In
practice its chain can never reject — every gate resolves in a `finally` — which
makes adding the rejection arm semantically inert there; the point is that this
was checked rather than carried over.) All three comments are corrected to match
the code.

## 12. Residual risks, accepted

> **Re-scoped by §16.** With §14 and §15 folded in, the items below that were
> *outstanding work* are closed. What remains is a description of the design's
> **properties** — things that would need a different approach to change, not a
> queue. Entries superseded by the fold are marked inline.

- **No bound on hold time or wait time.** `withKeyLock` (`file-lock.ts:7-19`) has
  no timeout, no queue cap and no diagnostic for a long-held key. (It *is* FIFO by
  construction — a promise chain — so waiters are ordered fairly; the first
  rewrite's "no fairness guarantee" was wrong and contradicted §10.5's own
  waiter-ordering test.) A slow or wedged holder turns every cast write on that
  book into an unbounded hang. Today those requests race and one loses a
  mutation; after this change they wait. That trade is why §6 keeps analysis —
  the only multi-minute writer — off the mutex entirely, and why §5 narrows
  `promote-voice`'s lock to exclude its sidecar `fetch`. **With those two
  exclusions**, expected hold time everywhere is one file read plus one file
  write. Without them the claim is false, which is how it read before round 3.

  A warn-after-N-seconds log was considered and **dropped**. `withKeyLock` has
  five existing non-cast callers (`book-state.ts:1588`, and
  `workspace/script-review-ledger.ts:83`/`:105`/`:131`/`:143`), so a timer per acquisition
  is a behaviour change to all of them, and a non-`unref()`d one would hold the
  event loop open on what is about to become the hottest lock in the product —
  in a repo whose flake register already tracks tinypool worker-exit failures.
  Speculative diagnostics on a shared primitive are not worth that.
- ~~**`analysis.ts`'s five writes are not protected.**~~ **Closed by §14.2** —
  the merge base is now revision-checked at each write and rebuilt when it has
  moved, rather than replayed. #2015 closed.
- ~~**`cast-link-prior.ts:239-241` plants `libraryUuid` references it never
  names.**~~ **Closed by §14** — it records the target's revision at read and
  asserts it at write, so a reference planted from a snapshot that has since
  moved is detected rather than written blind.
- ~~**Cross-book concurrent series designs can double-mint a `voiceUuid`.**~~
  **Closed by §15** — the mint decision moves under a `series:<author>/<series>`
  key. This is the one item the revision counter provably could not reach, since
  the staleness is in a decision taken before any file is read.
- ~~**Three cross-book check-then-act consultations survive.**~~ **Closed by
  §14** — each records the revision of every book it consulted and asserts it at
  write time. Retained here because the three sites are where the counter has to
  be threaded, and they are easy to miss:
  - `cast-add-from-roster.ts` reads the target book to decide a source write;
  - `voice-override-linked.ts` reads the **source** cast and derives
    `canonicalVoiceId`, `sourceTokens`, the `inGroup` predicate and the entire
    `writes` list from that snapshot, then writes **other** books via
    `applyToBook`;
  - `cast-series-patch.ts` reads the source cast, derives `sourceChar` and the
    `targets` list, additionally reads other books via
    `scanSeriesCharactersForBookId`, then writes per book.

  The latter two are the worse pair — they carry *data and grouping* derived from
  a stale cross-book snapshot into writes in other books, where
  `cast-add-from-roster` carries only a decision. A per-book lock closes none of
  the three. Added to **#2006**.
- **`promote-voice`'s `realVoiceId` is pinned to its pre-lock read** (§5), so a
  concurrent write that changes `voiceUuid` mid-promotion leaves the artifacts
  named for the old uuid.
- **`cast-design.ts`'s two sites keep stale idempotency decisions.** Its
  `continue` guards are evaluated against the first read, before an LLM persona
  generation, and the lock covers only the later re-read and write — so two
  concurrent runs can each generate a persona and the second overwrites the
  first.
- **In-process only.** Two server processes against one workspace would defeat
  this entirely. The product runs one server; verified that `server/src` has no
  `worker_threads` and no cast.json writer in a child process.
  `analyzer/attribution-eval/capture-cli.ts` reads cast.json but writes only to
  the eval corpus dir.
- **Partial atomicity for series propagation**, per §3.2.
- **Rule 1 and rule 4 are convention, not enforcement.** A future nested locker,
  or one that takes cast-then-design, deadlocks at runtime rather than failing a
  check.
- **The guard sees writes, not reads.** A read left outside its lock is silent —
  the diff looks locked and is not. Only review catches this, which is why rule 2
  is stated in the code and not only here.

## 14. The cast.json revision counter — closing check-then-act

§7 and §12 between them named six places where a decision is derived from a
cast.json snapshot and the write that depends on it lands in a *different* lock
scope. The per-book lock cannot reach any of them: it makes each read-modify-write
atomic, and every one of these is a read in one scope and a write in another.

They are not six defects. They are one defect six times:

| Site | Decision | Write |
|---|---|---|
| `analysis.ts` | `priorCastForMerge`, read once at `:2797` | `:3558`, `:3763`, `:4774`, `:5422`, `:5927`, minutes later |
| `voices.ts` `PUT /:voiceId/override` | `hasClonedSlotAmongMatches` cross-book veto | `applyOverrideToCastFiles`, per book |
| `single-design.ts` | `characterHasClonedSlot` 409 at `:254` | `:178`, detached after `res.flushHeaders()` |
| `qwen-voice.ts` | `characterHasClonedSlot` 409 at `:552` | `:623` via `persistEmotionVariant` |
| `cast-link-prior.ts` | target's `overrideTtsVoices`, read at `:105` | source, at `:248` |
| `voice-override-linked.ts` / `cast-series-patch.ts` | source snapshot → `writes` list / `targets` list | other books |

**Decision: cast.json carries a revision, and a write that depends on an earlier
read asserts the revision has not moved.** Optimistic concurrency, not a longer
lock — a longer lock is what §3.2 and §6 both rejected, for good reasons that
have not changed.

This is deliberately *one* mechanism rather than six bespoke fixes. Six fixes
would each be locally obvious and collectively unenforceable: nothing would stop
a seventh instance, and each would invent its own failure semantics. A revision
makes staleness **detectable**, which is the property all six actually need.

### 14.1 The shape

`cast.json` gains a top-level `rev: number`. Absent means `0` — a read-path
default, so no migration script and no compatibility break with an existing
workspace.

Two helpers, in `workspace/cast-io.ts`, both of which assume the caller holds the
cast lock:

```ts
readCastForUpdate(bookDir): Promise<{ cast: CastJson; rev: number }>
writeCastChecked(bookDir, next: CastJson, expectedRev: number): Promise<void>
```

`writeCastChecked` re-reads, compares `rev` against `expectedRev`, and throws
`CastRevConflictError` if it moved. On success it writes `rev: expectedRev + 1`.

**The helper owns the increment, and that matters beyond bookkeeping.** At least
**20 of the 35** current writers construct a fresh payload (`{ characters:
nextCharacters }`) rather than passing back the object they read — a shape that
drops every other top-level field. Left alone they would silently erase `rev` on
every write and the counter would never advance. Routing writes through one
helper is what stops that, and it is the same argument as §3.1's for key
derivation.

### 14.2 What a conflict means, per caller shape

This is the "refusal semantics" question #2006 was filed to answer. One rule,
three shapes:

- **Can recompute → recompute.** `analysis.ts` re-derives its merge against the
  fresh cast rather than replaying `priorCastForMerge`. Its run must not fail
  because a user renamed a character mid-analysis. This also answers #2015: the
  merge base does not need to *survive* the run, it needs to be *checked* at each
  write and rebuilt when it has moved.
- **Can refuse → 409.** The HTTP gates (`voices.ts`, `cast-link-prior`,
  `voice-override-linked`, `cast-series-patch`) return
  `409 { code: 'cast-changed' }`. The caller retries against fresh state. This is
  expressible because these handlers have not yet responded.
- **Can neither → report and skip.** The detached SSE jobs (`single-design.ts`,
  `qwen-voice.ts`'s bulk path) log the conflict, skip that book, and surface it in
  the job's completion payload. §6 established these cannot 409; a revision
  conflict does not change that, but it does make the skip *deliberate and
  reported* rather than a silent overwrite.

### 14.3 What this does not do

It does not make a multi-book propagation atomic. A conflict on book 7 of 12
still leaves 6 books written. What changes is that the operation **knows** and
says so, instead of overwriting a decision it never saw. Genuine cross-book
atomicity needs the workspace-scoped lock §3.2 rejected, and that rejection
stands.

## 15. The series lock — closing the cross-book double-mint

The one foldable residual a revision counter provably cannot reach.

`ensureCharacterVoiceUuid` mints a `voiceUuid` for a linked cast identity, then
propagates it across the series. Two bulk designs on **two different books of one
series** each read their *own* book, each see no `voiceUuid`, each mint, and each
propagate. Every design gate keys on `bookDir` — `withDesignLock`
(`design-lock.ts:26-27`), `isDesignBusy`, `cast-design.ts:648`'s `inFlightByBook`
— while the propagation is series-wide.

A revision counter does not help, and the reason is worth stating because it is
counter-intuitive: the propagation **re-reads every book under its own lock**, so
each write is against a current revision and is therefore "valid". The staleness
is in the *mint decision*, which happens before either book is read. There is no
file whose revision encodes it.

**Decision: a fourth key class, `series:<author>/<series>`**, held across
read → decide → mint → propagate in `ensureCharacterVoiceUuid`'s series branch.
Standalone books keep the book-scoped branch and need no series key.

**Global lock order becomes `design` → `series` → `library-voice` → `cast`**
(§4 rule 4). The existing `design → cast` path (`qwen-voice.ts:193` → `:203`)
becomes `design → series → cast`, which is consistent. No path takes them in any
other order; that is verified per §4, not assumed.

## 16. Scope, restated

With §14 and §15 folded in, this PR closes the residual set rather than filing
it. **#2006 and #2015 are closed here, not deferred.**

What remains in §12 is no longer debt. It is a list of **properties of the
design** — things that are true of the chosen approach and would require a
different approach to change:

- The lock is in-process. Two server processes against one workspace defeat it.
- `promote-voice`'s `realVoiceId` is pinned to its pre-lock read *because the
  artifacts have already been renamed to it* by the time the lock is taken.
  Re-deriving it would name files that do not exist.
- A multi-book propagation is per-book atomic, not atomic as a whole (§3.2,
  §14.3) — now detected and reported rather than silent.
- `cast-design.ts`'s idempotency guards are evaluated before an LLM call and the
  lock covers only the write; a duplicate persona generation is possible.

Each is stated at its site in the code, not only here. The distinction matters:
a reader who finds "residual risks" reads a to-do list, and a to-do list that
nobody is going to do is worse than an honest description of what the design is.

## 17. Ticketing

`Closes #1981` (the filed defect), `Closes #2000` (the sweep), `Closes #2001`
(§11), `Closes #2006` (§14, §15), `Closes #2015` (§14.2). One PR.

Nothing is deferred out of this change. #2006 and #2015 were filed as follow-ups
during design and are folded back in by §14 and §15 — the residual list in §12 is
now a description of the design's properties, not a queue of work.
