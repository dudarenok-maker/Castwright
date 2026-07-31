# cast.json write lock — design

**Status:** approved
**Issues:** #1981 (the filed defect), #2000 (the sweep), #2001 (incidental, §11)
**Sequencing:** implementation bases on / rebases onto `fix/server-1933-assign-readiness`
**Review:** revised after an adversarial pass found 3 Critical / 8 Major / 3 Minor
against the first draft. All 14 folded; §5, §5.1, §6 and §8 are substantially
rewritten as a result.

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

This is not theoretical. Measured (§7.1): two concurrent read-modify-writes
against one cast.json, issued from a bare `Promise.all`, lost a mutation in
**200 of 200 trials**.

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
| `qwen-voice.ts` `promote-voice` | `:692` → `:793` | `copyFile`, two `rm`s, and a **sidecar `fetch`** at `:768` |
| `cast-merge.ts` | `:77` → `:197` | writes *manuscript-edits.json* at `:171` |
| `voice-override-linked.ts` | `:235` → `:364` | `await`s |
| `library-cast-override.ts` | `:88`/`:89` → `:152`/`:153` | `await`s, **two books** |
| `voice-library.ts` `/assign` | `:1277` → `:1434` | one (`:1386`) — the filed issue |
| `analysis.ts` | `:2797` → `:3559`/`:3764`/`:4774` | **an entire analysis run** — see §6 |
| `cast-design.ts` | `:289`→`:293`, `:448`→`:452` | already re-reads `fresh` before writing |

`promote-voice` — not `/assign` — holds the longest window in the codebase, and
it spans a network call to the sidecar. `cast-design.ts`'s re-read-then-write is
a hand-rolled mitigation of this exact race, corroborating that the defect class
is real and has been felt before; it is also the shape a lock wants, so those two
sites convert cleanly.

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
There are two ways this lock can silently partition into mutexes that never
contend, and both leave every test green:

- **Derivation drift.** One site keys on `bookDir`, another on
  `castJsonPath(bookDir)`, or on an unnormalised path separator. A single named
  function removes the opportunity.
- **Module-registry drift — the one that will actually bite.** `chains` is
  module-level state (`file-lock.ts:5`), and **29 server test files call
  `vi.resetModules()`**, the dominant workspace-test idiom (`mkdtemp` +
  `WORKSPACE_DIR` + `vi.resetModules` so `paths.ts` re-reads the override — see
  `routes/backup.test.ts:7`). Any spec where the route under test and a second
  writer resolve through different module registries gets **two `chains` Maps**.

The second mode is the more dangerous, because a partitioned lock behaves like no
lock *in both directions*: the outcome test passes by partition, and §7's
revert-verification also passes vacuously. §7.3 states the countermeasure.

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
3. **Two or more books → `withCastLocks`, never nested `withCastLock`s.**
4. **Global lock order: design → cast.** Never acquire a cast lock and then a
   design lock.

Rule 4 replaces a claim in the first draft that was a non-sequitur:
*"`withDesignLock` and `withKeyLock` are separate maps, so holding a design lock
while taking a cast lock is not a self-deadlock — only the same key twice is."*
Separate maps rule out *self*-deadlock; they are exactly what makes ordinary
two-lock AB/BA deadlock possible. A **design → cast** path is already live:
`qwen-voice.ts:193` holds `withDesignLock(bookDir)` across `:203`'s
`forEachMatchingCastCharacter`, which under this design takes a cast lock per
matching book. No **cast → design** path exists today, so the design is not
deadlocked — but the rule set is what future contributors read, and without rule 4
it actively teaches them that cross-lock nesting is free. Wrapping
`single-design.ts:110` or `qwen-voice.ts:532` in a cast lock would deadlock with
no timeout and no diagnostic.

**What the lock does not cover.** It protects one read-modify-write. It does not
make a *validate-then-write* safe when the validation and the write are in
different lock scopes — see §7's clone-consent gates, folded in at §8.

## 5. Site conversion — all 35, enumerated

The first draft's class table summed to 29 and switched counting units mid-table.
This one enumerates every site, counts sites throughout, and must sum to 35. The
plan carries an arithmetic check on that.

### Class 1 — mechanical: wrap the existing read..write span (17 sites)

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
| `voice-library-usage.ts` | `:113` |

`qwen-voice.ts:793` and `:893` were missing from the first draft entirely.
`:793`'s span covers a sidecar `fetch` and two `rm`s, and it writes the `cast`
object read at `:692` — the longest and most exposed window in the sweep, not a
routine wrap. `voice-library-usage.ts:113` is class 1 rather than a fan-out
because `clearLibraryVoiceReferences` writes one book per iteration; the read
must move inside the lock, since `walkConfirmedCasts()` (`:43`) *yields* an
already-read `cast`.

### Class 2 — multi-book: `withCastLocks` (9 sites)

| Module | Sites |
|---|---|
| `cast-link-prior.ts` | `:142`, `:248` |
| `cast-not-linked-to.ts` | `:106`, `:109`, `:202`, `:207` |
| `library-cast-override.ts` | `:152`, `:153` — plus the §8 fix |
| `cast-add-from-roster.ts` | `:147` |

### Class 3 — `voices.ts` fan-out: two branches, two write sites (2 sites)

`forEachMatchingCastCharacter` (`voices.ts:771-834`) has its **own inline walk**;
it does not use `walkConfirmedCasts` at all, which the first draft got wrong. Two
distinct branches:

- **`:788-803`, the `onlyBookDir` fast path**, writing at `:801`. This is the
  branch every real call site takes — `cast-design.ts:514` and
  `single-design.ts:182` both pass `job.bookDir`, and the fs-61 comment at
  `voices.ts:783` says so explicitly. It carries production traffic and the first
  draft's class-3 text did not describe it.
- **`:816-829`, the workspace/series walk**, writing at `:828` — per-book lock
  inside the loop, read moved in with it.

### Class 4 — re-entrancy restructure (2 sites)

`qwen-voice.ts:177` (`persistEmotionVariant`) and `:215`
(`ensureCharacterVoiceUuid`). See §5.1 — these are the highest-risk conversions.

### Class 5 — `analysis.ts`: not a lock site at all (5 sites)

`:3558`, `:3763`, `:4774`, `:5422`, `:5927`. These do **not** take a cast lock.
See §6.

**17 + 9 + 2 + 2 + 5 = 35.** ✓

### Class 6 — deletions (2 sites, not counted in the 35)

`analysis.ts:2845` (`rm(castJsonPath(…), { force: true })` on "Start fresh") and
`book-state.ts:923` (the reparse handler, inside a `Promise.all`). Both destroy
cast.json and neither matches `writeJsonAtomic(castJsonPath(`, so the first
draft's guard test could not see them.

They matter more after this change, not less: a locked writer whose read predates
the delete recreates cast.json afterwards, resurrecting the stale roster the
delete exists to remove (`analysis.ts:2836-2841` documents that intent) — and the
lock *lengthens* the gap between a queued writer's read and its write. Both take
the cast lock; the guard pattern extends to `rm(castJsonPath(`.

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
character, and bakes that value into the write payload at `:162`.
`qwenStorageKey` reads `voiceUuid`, so a `voiceUuid` that changed between the
outer read and the lock anchors the variant slot on a base that never existed —
the #1057 orphaned-base shape, surfacing as a silent Kokoro fallback on
re-render.

**The rule for both:** the re-read inside the lock must **re-evaluate every
decision and re-derive every value** that feeds the write — re-check `voiceUuid`,
re-derive `qwenStorageKey`. The outer read is an early-out optimisation and is
never authoritative. The design lock is not part of the guarantee and must not be
relied on.

Both functions keep the two-branch structure: the book-scoped branch takes the
cast lock and re-reads inside it; the series branch stays unlocked and delegates
to `forEachMatchingCastCharacter`, which locks per book itself. That satisfies
rule 1 and rule 4.

## 6. `analysis.ts` — ownership, not a mutex

`analysis.ts` is 5 of the 35 sites and the module that writes cast.json most
often. It is **not a wrappable read-modify-write**: `priorCastForMerge` is read
once at `:2797`, reconciled at `:2823`, and is then the merge base for writes at
`:3559`, `:3764` and `:4774` — spread across the whole Phase 0/1 pipeline, with
the interim writes *inside* the chapter loop. The subset route has the identical
shape (read `:5206`, writes `:5423`, `:5927`).

Neither available lock strategy works. Holding a cast lock for the run would
block every other cast write on that book for minutes with no timeout. Re-reading
inside each write's lock would change behaviour: iteration N would re-read the
interim cast iteration N−1 wrote, so `mergeAnalysisResultWithExistingCast` would
no longer merge against the pre-run cast and srv-13's voice/reuse carry-forward
would silently degrade.

**Decision: analysis owns cast.json for the duration of its run**, expressed
through the existing `markAnalysisBusy` / `isAnalysisBusy` registry
(`tts/design-lock.ts:55-65`) rather than the mutex. That registry already exists
for precisely this reason — it was built so a re-analysis (which rewrites the
whole cast.json) cannot overlap a bulk design (which writes per-character
overrides), and it ref-counts so a main plus a subset job can coexist.

Concretely: cast writers consult the registry and refuse with a clear 409 —
*"analysis is rewriting this book's cast; try again when it finishes"* — rather
than queueing behind an unbounded lock. That is a better user-visible failure than
a request that hangs for minutes, and it is the behaviour the registry was
designed to express. `analysis.ts`'s own five writes stay as they are; ownership,
not serialisation, is what makes them safe.

The two deletion sites (§5 class 6) still take the cast lock — a delete is
instantaneous and does not own the book.

## 7. Check-then-act: the clone-consent gates, folded in

A per-RMW lock does not close a *validate-then-write* that spans two scopes. Four
gates read cast.json, decide, and then write elsewhere:

| Gate | Reads / decides | Writes |
|---|---|---|
| `voices.ts` `PUT /:voiceId/override` | `:709`/`:720` `hasClonedSlotAmongMatches` → 409 | `:728` `applyOverrideToCastFiles` |
| `voice-library.ts` `DELETE /:voiceUuid` | `:1683` `scanLibraryVoiceUsage` → 409 usage report | `:1686` `clearLibraryVoiceReferences` |
| `single-design.ts` | `:235` `characterHasClonedSlot` → 409 | `:254` |
| `qwen-voice.ts` | `:532` `characterHasClonedSlot` → 409 | `:552` |

These are the fs-38 Wave 3c GATE 2 clone-consent guards — the ones added because
"Phase 0 fixed seven live bugs that all had the same shape — a guard-less write
erasing a clone marker upstream of a resolver" (`voices.ts:888-893`). Shipping a
lock that *reads as* "cast.json RMW is now safe" while these stay open is how the
eighth gets missed.

**Decision: folded into this PR.** Each gate re-validates inside the lock scope
that performs its write, so the 409 decision and the write it guards are one
critical section. The `voice-library.ts` delete is the one with real data loss —
a reference acquired in the gap is left dangling at a `libraryUuid` whose
artifacts `eraseLibraryVoiceArtifacts` is about to delete.

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

### 10.1 The interleave mechanism — settled, with evidence

The first draft deferred this to the plan as "an open risk". It is now measured.
A spike (`server/src/workspace/`, run against real files, single import graph)
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

Because a partitioned lock passes both the outcome test and the revert
verification, **each outcome spec must first assert that the two writers share
one lock instance.** `cast-lock.ts` exposes a test-only accessor (an instance
token, or `chains.size`) and the spec asserts contention actually occurred before
asserting the outcome. Alternatively the spec pins a single import graph and
states that it does. Without this, §10.2 proves nothing.

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
`server/src/**`, which `test:server` already globs (`verify-cache.mjs:108`) and
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
`routes/chapters-restructure.ts:78` — the last additionally allocating a *third*
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
from `Promise.resolve()` after `fn()` has already returned. Applied identically
to all three, with the three comments corrected to match.

## 12. Residual risks, accepted

- **No bound on hold time or wait time.** `withKeyLock` (`file-lock.ts:7-19`) has
  no timeout, no queue cap, no fairness guarantee and no diagnostic for a
  long-held key. A slow or wedged holder turns every cast write on that book into
  an unbounded hang. Today those requests race and one loses a mutation; after
  this change they wait. That is a real trade, and it is why §6 routes analysis —
  the only multi-minute holder — to ownership rather than to the mutex. The
  primitive gains a warn-after-N-seconds log so a wedged key is diagnosable
  rather than silent. Expected hold time for every other class is one file read
  plus one file write.
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

## 13. Ticketing

`Closes #1981` (the filed defect), `Closes #2000` (the sweep), `Closes #2001`
(§11). One PR, per the delivery decision.
