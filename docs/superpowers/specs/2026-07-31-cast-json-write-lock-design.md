# cast.json write lock — design

**Status:** approved
**Issues:** #1981 (the filed defect), #2000 (the sweep), #2001 (incidental, §10)
**Sequencing:** implementation bases on / rebases onto `fix/server-1933-assign-readiness`

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
non-torn, but the later rename wins outright, and A's mutation is gone. Removing
the inner `await` narrows the window from *an entire filesystem read* to *one
run-to-completion plus the write's own I/O* — a large and worthwhile reduction in
the odds — but it does not close the race.

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
Measured read→write spans:

| Site | Span | `await`s inside |
|---|---|---|
| `cast-merge.ts` | `:77` → `:197` | yes — writes *manuscript-edits.json* at `:171` inside the window |
| `voice-override-linked.ts` | `:235` → `:364` | yes |
| `library-cast-override.ts` | `:88`/`:89` → `:152`/`:153` | yes, and **two books** |
| `voice-library.ts` `/assign` | `:1277` → `:1434` | one (`:1386`) — the filed issue |
| `voice-style.ts` | `:53`→`:69`, `:98`→`:129` | short |
| `cast-design.ts` | `:289`→`:293`, `:448`→`:452` | already re-reads `fresh` immediately before writing |

`cast-design.ts`'s re-read-then-write is a hand-rolled mitigation of exactly this
race, which is corroborating evidence that the defect class is real and has been
felt before. It is also the shape a lock wants, so those two sites convert
cleanly.

Line numbers in this table are as of `main` at `88476dca` and will shift — see
§8. The implementation plan cites symbols, not lines.

## 3. Decision: serialise, don't narrow

The fix is a per-book cast.json write lock, applied to **every** writer. Narrowing
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
If two sites derive the key differently — `bookDir` at one, `castJsonPath(bookDir)`
at another, or an unnormalised path separator on Windows — the lock silently
partitions into two mutexes that never contend. Every test still passes and the
protection is gone. A single named function removes the opportunity.

`withCastLocks` **dedupes, then sorts** the derived keys, then nests:

- **Sorting** makes AB/BA deadlock impossible by construction, which matters
  because five call sites take two books and their argument order is
  caller-determined.
- **Deduping** matters because the two-book routes can legitimately receive the
  same book twice (`source === target`). A promise-chain mutex is not reentrant;
  acquiring one key twice in a single call wedges that request forever — not
  slowly, permanently.

### 3.2 Granularity for the N-book fan-outs

`voices.ts`'s `forEachMatchingCastCharacter` and `voice-library-usage.ts`'s
`clearLibraryVoiceReferences` walk the whole workspace (or a series) and write
each matching book.

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

## 4. The rule

Three lines, stated in `cast-lock.ts`'s header comment and as a bullet under
CLAUDE.md's *Conventions worth preserving*:

1. **Lock the innermost read-through-write, never the caller.** One level only.
   A locked function must not call another locked function on the same book.
2. **The read goes inside the lock.** Wrapping only the write buys nothing at
   all. This is the easy way to produce a diff that looks correct and fixes
   nothing.
3. **Two or more books → `withCastLocks`, never nested `withCastLock`s.**

Rule 1 is what keeps a non-reentrant mutex safe. Note that `withDesignLock` and
`withKeyLock` are separate maps, so holding a design lock while taking a cast
lock is *not* a self-deadlock — only the same key twice is. That is why the rule
is scoped to the cast lock rather than to locks generally.

## 5. Site conversion

| Class | Sites | Work |
|---|---|---|
| **1 — mechanical** | `cast-aliases` ×3, `cast-create`, `cast-merge`, `voice-style` ×2, `cast-series-patch`, `voice-library` ×2, `voice-override-linked`, `book-state` (the cast write in the save handler), `cast-design` ×2 | wrap the existing read..write span |
| **2 — multi-book** | `cast-link-prior`, `cast-not-linked-to` ×2, `library-cast-override`, `cast-add-from-roster` | `withCastLocks` |
| **3 — N-book fan-out** | `voices.ts` `forEachMatchingCastCharacter`, `voice-library-usage.ts` `clearLibraryVoiceReferences` | per-book lock inside the loop, **read moved inside it** |
| **4 — re-entrancy** | `qwen-voice.ts` `ensureCharacterVoiceUuid`, `persistEmotionVariant` | restructure, see §5.1 |
| **5 — in-job** | `analysis.ts` ×5 | wrap; verify no lock is held across a chapter loop |

Class 3 is not a wrap. `walkConfirmedCasts()` currently *yields* an
already-read `cast` and the loop body writes it, so the read sits outside any
lock the body could take. The loop body must re-read under the lock and discard
the yielded copy for write purposes.

### 5.1 The re-entrancy restructure

`ensureCharacterVoiceUuid` (`qwen-voice.ts`) reads cast.json, then branches:

- **series branch** → delegates to `forEachMatchingCastCharacter`, which under
  this design locks each book it writes — *including this one*;
- **book-scoped branch** → mutates the cast it read and writes it itself.

Wrapping the whole function in `withCastLock(bookDir)` self-deadlocks the series
branch the moment the walk reaches `bookDir`. The fix is to split: the
book-scoped branch takes the lock and **re-reads inside it**; the series branch
stays unlocked and delegates. The outer read is then used only for the branch
decision (does the character exist, does it already have a `voiceUuid`), never
as the payload for a write.

`persistEmotionVariant` has the identical two-branch shape and gets the identical
treatment.

Both are the concrete instance of rule 1, and both are the highest-risk
conversions in the sweep.

## 6. #1981 specifically

The lock supersedes the hoist: under a held lock the `await` at `:1386` is
harmless, and hoisting it costs a wasted manifest read on every request that
later `404`s on the character or `409`s on engine routing.

**The hoist still lands**, on an explicitly weaker rationale: with 35 lock sites
and future writers who will forget, keeping the window `await`-free is cheap
insurance against partial adoption. The manifest read moves above the cast read
(it depends only on `entry.provenance`, `voiceUuid`, and `located.state`, all in
hand by then); the warning *string* is still built at its current site, because
it needs `character.name`, and string formatting is synchronous.

The invariant comment is rewritten. It must say that **the lock is the
guarantee** and the `await`-free window is a secondary, best-effort narrowing. It
must stop claiming atomicity, because that claim is what made this defect look
like a one-line violation of a sound rule rather than a symptom of an unsound one.

## 7. Testing

The two failure modes to design against are a lock wrapped around the write only,
and a mechanism test that pins "no `await` in the window" while the race stays
open. Both yield a green suite and zero protection.

**Outcome test, per class.** Two overlapping RMWs against one cast.json, each
mutating a *different* character; assert **both** mutations survive. This is red
today at every unlocked site (last-write-wins drops one) and green under the
lock. It is an outcome assertion — it names the surviving data, not the absence
of a yield — and it stays red after the hoist alone, which is the honest
demonstration that the hoist was never the fix.

**Mutation-verified by reverting the producer.** Every outcome test is proven by
removing the lock at that site and watching it go red — not by reading the test
and agreeing it looks right. A placebo test authored into a plan gets copied
faithfully and survives spec review; the plan states the revert as a required
step with recorded output, not as a suggestion.

**Determinism is the open risk.** After the hoist, `/assign`'s window contains no
slow `await` to interleave against, so a naive `Promise.all` of two requests may
not reliably interleave. The plan must name exactly one interleave mechanism and
use it everywhere, rather than letting each test improvise. Candidates and their
trade-offs are the plan's first task, not this spec's.

**Guard test.** No `writeJsonAtomic(castJsonPath(…))` may appear outside a lock
scope, so site 36 cannot regress. It must be wired into `verify-cache.mjs`'s
`extraFiles` **and** `verify.yml`'s path regex — a guard test that reads a repo
file and is wired into neither never runs on the diff it exists to catch.

**Primitive unit tests.** Sorted acquisition regardless of argument order;
dedupe; release on throw; waiter ordering.

## 8. Sequencing against #1933

`fix/server-1933-assign-readiness` is open, actively edited in another session,
and rewrites 208 lines of `server/src/routes/voice-library.ts` — moving the
readiness gate below the cast read. It does **not** introduce a new `await` into
the window (verified against that branch: the gate stays synchronous, and the
manifest read remains the only yield), so it adds no hazard. It does shift every
line in the route by roughly +138.

The implementation branch therefore cuts after #1933 merges, or rebases onto it
if it is still open when the sweep starts. This spec and the plan cite symbols
rather than line numbers so both survive the shift.

## 9. Residual risks, accepted

- **In-process only.** Two server processes against one workspace would defeat
  this entirely. The product runs one server; `capture-cli.ts` reads cast.json
  but never writes it.
- **The guard test sees writes, not reads.** A read left outside its lock is
  silent — the diff looks locked and is not. Only review catches this, which is
  why rule 2 is stated in the code rather than only here.
- **Rule 1 is convention, not enforcement.** A future nested locker deadlocks at
  runtime rather than failing a check.
- **Partial atomicity for series propagation**, per §3.2.

## 10. Incidental findings, filed not fixed

The `finally` cleanup in all three existing lock helpers never fires:
`chains.get(key) === gate` compares against `gate`, but what was stored is
`prior.then(() => gate, …)` — a different promise object. Same bug in
`file-lock.ts`, `tts/design-lock.ts`, and `chapters-restructure.ts`. Each Map
therefore grows one entry per distinct key for the process lifetime.

Bounded by book count and so genuinely minor, but it makes the "best-effort
cleanup, so the map doesn't grow unboundedly" comment false in all three places.
Filed as **#2001** rather than folded in: it is in code this branch touches, but
it is a behaviour question (is the cleanup worth keeping at all, given a
promise-chain mutex needs the tail entry to remain until it settles?) rather than
an obvious one-answer fix.

The sweep itself is tracked as **#2000**; #1981 remains the filed defect this
work closes.
