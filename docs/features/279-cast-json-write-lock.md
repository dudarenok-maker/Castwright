---
status: active
shipped: null
owner: null
---

# 279 — cast.json write lock

> Status: active
> Key files: `server/src/workspace/cast-lock.ts` (the three lock exports),
> `server/src/workspace/file-lock.ts` (the underlying per-key mutex),
> `server/src/workspace/cast-lock.guard.test.ts` (the static regression guard),
> `server/src/workspace/cast-lock.race.test.ts` / `cast-lock.test.ts` (the
> primitive's own tests), plus every route module listed in "Locked sites"
> below.
> URL surface: none — this is a server-internal concurrency fix with no new
> route, no changed response shape, no frontend involvement.
> OpenAPI ops: none.

## Benefit / Rationale

- **User:** a concurrent edit to one book's cast no longer silently loses to
  another concurrent edit. A bulk "Design full cast" job running in one
  browser tab, and an alias edit or a plain cast save happening in another,
  used to race — whichever write's atomic rename landed last simply
  overwrote the other's change, with nothing on screen to say so. Both
  survive now.
- **Technical:** cast.json is the most-written file in the workspace — 35
  `writeJsonAtomic` call sites across 17 modules, plus 2 `rm` sites, all of
  them read-modify-write with no lock of any kind before this. A bare
  `Promise.all` of two concurrent RMWs against real files lost a mutation
  200/200 trials (`cast-lock.race.test.ts`) — the *read* is itself a yield
  point, so an `await`-free window between read and write does not make the
  operation atomic, whatever the removed pre-existing code comments claimed.
- **Architectural:** introduces a codebase-wide invariant — every cast.json
  writer takes a per-book lock before it reads, not just before it writes —
  and a second lock class (`library-voice:<uuid>`) that joins a three-class
  global acquisition order (`design` → `library-voice` → `cast`) now
  documented in CLAUDE.md's "Conventions worth preserving". A static guard
  test (`cast-lock.guard.test.ts`) fails the build on any future writer that
  skips the lock, so the invariant can't rot silently the way the unlocked
  state did.

## Architectural impact

- **New seams:** `server/src/workspace/cast-lock.ts` exports
  `withCastLock(bookDir, fn)`, `withCastLocks(bookDirs, fn)` (dedupes then
  sorts its keys — sorting makes AB/BA deadlock impossible by construction
  for the five two-book routes; deduping matters because
  `library-cast-override.ts` can legitimately receive the same book twice),
  and `withLibraryVoiceLock(voiceUuid, fn)`. All three delegate to the
  existing `withKeyLock` primitive in `file-lock.ts` — no new locking
  mechanism, just a new named key space and the discipline to use it
  everywhere.
- **Invariants preserved:** the existing `withDesignLock(bookDir)`
  (`tts/design-lock.ts`) is untouched in its acquisition/release/ordering
  behaviour — only its dead key-map cleanup was fixed (see "Also fixed in
  passing" below). No path in `server/src` acquires a `cast` lock while
  holding a `design` lock, or a `cast`/`design` lock while holding a
  `library-voice` lock — verified by reading every acquisition site, not
  assumed.
- **Migration story:** none. No on-disk shape change to cast.json or any
  other workspace file; this is purely a concurrency-control layer above the
  existing read/write calls.
- **Reversibility:** every change is additive locking around an existing
  call; a `git revert` of the whole PR returns every site to its prior
  unlocked (racy) behaviour with no data-shape cleanup required.

## Invariants to preserve

The four rules, stated in full in `server/src/workspace/cast-lock.ts`'s
header comment and mirrored in CLAUDE.md's "Conventions worth preserving" —
this doc doesn't restate them a third time, see either of those for the
canonical wording. In short:

1. Lock the innermost read-through-write, never the caller — one level only.
2. The read, and every decision derived from it, goes inside the lock.
   Wrapping only the write is the easy way to produce a diff that looks
   correct and fixes nothing (five named, reasoned carve-outs exist; see
   "Deliberately not covered" below and the design spec §4).
3. Two or more books → `withCastLocks`, never nested `withCastLock`s.
4. Global lock order: **`design` → `library-voice` → `cast`.** Never acquire
   an earlier class while holding a later one — the `DELETE
   /voice-library/:voiceUuid` path holds `library-voice:<uuid>` across a
   per-book cast-lock acquisition (`voice-library-usage.ts`'s
   `clearLibraryVoiceReferences`), so `POST /:voiceUuid/assign` must take
   `library-voice` **before** its cast lock, never after — the reverse order
   is an AB/BA cycle on a mutex with no timeout and no diagnostic; both
   requests hang forever.

`withKeyLock` itself has no timeout, no queue cap, and no diagnostic for a
long-held key (it *is* FIFO, so waiters are ordered fairly). A wedged holder
turns every cast write on that book into an unbounded hang. This is why
`analysis.ts`'s runs and `promote-voice`'s sidecar `fetch` are deliberately
excluded from the lock's critical section — see below.

## Locked sites

**28 locked write sites across 15 modules, plus both cast.json delete sites**
— 30 locked call sites in total. Counted at HEAD: 33
`writeJsonAtomic(castJsonPath(` occurrences across 16 files, of which
`analysis.ts`'s 5 stay unlocked (#2015). The "35 sites across 17 modules"
figure elsewhere in this plan is the **pre-change** baseline; two sites were
consolidated into `writeVoiceStylePersona` during the sweep, which is why the
before and after counts do not differ by exactly the number locked.

**Single-book, mechanical wrap** — `cast-aliases.ts` (`unlink-alias`,
`repoint-alias`, `add-alias`), `cast-create.ts`, `cast-merge.ts`,
`cast-series-patch.ts`, `voice-override-linked.ts`'s `applyToBookLocked` and
its A3-stamp write, `book-state.ts`'s `PUT /:bookId/state` cast-slice write
(the lock encloses the whole `preserveDesignedVoices` call, not just the
subsequent write, because the clone-consent guards it runs live off that
same read), `voice-library.ts`'s `POST /:voiceUuid/assign` and `DELETE
/:voiceUuid/assign`, `qwen-voice.ts`'s `promote-voice` (`discard-voice`
route) and `DELETE .../emotion-variant/:emotion`, `cast-add-from-roster.ts`
(source book only — the target read is a check-then-act residual, see
below), and `voice-library-usage.ts`'s `clearLibraryVoiceReferences`.

**Not mechanical, restructured:**

- **`promote-voice`** — the naive span covers a `stat`, four `rm`s, three
  `rename`s, a `copyFile`, and an un-timed sidecar `fetch`. Locking all of
  it would put a network round-trip inside the hottest lock in the product.
  The lock is narrowed to a fresh re-read plus the write, at the end;
  `realVoiceId` (derived from the pre-lock read) stays pinned outside the
  lock deliberately, because the artifact renames have already committed to
  it by the time the lock is taken.
- **`voice-style.ts`'s `/generate` and `/generate-all`** — both call
  `generateVoiceStylePersona`, an LLM round-trip that on the Gemini path
  sits behind an unbounded rate-limiter sleep. Both handlers read
  unlocked, generate unlocked, and persist through `cast-design.ts`'s
  `writeVoiceStylePersona` helper, which re-reads cast.json fresh inside its
  own short per-character `withCastLock` immediately before writing.

**Multi-book (`withCastLocks`)** — `cast-link-prior.ts`, `cast-not-linked-to.ts`
(both `POST` and `DELETE`, each writing both books inside one
`withCastLocks` call), and `library-cast-override.ts` (which also gained a
same-book-different-character merge fix — see "Also fixed in passing").

**The `voices.ts` fan-out (`forEachMatchingCastCharacter`)** — two write
sites, one per book, inside the loop: the `onlyBookDir` fast path
(standalone books) and the workspace/series walk (live for every series
book — an earlier draft of the design spec wrongly called this path
near-dead). Locking per book inside the loop, rather than locking every
matched book up front, is a deliberate trade: the alternative would hold a
lock on every book in the workspace across a full directory walk, queueing
every other cast write behind it. The accepted cost is that the fan-out as
a whole is not atomic — a concurrent writer can land between two books of
one propagation (§3.2 of the design spec).

**The re-entrancy restructure** — `qwen-voice.ts`'s `persistEmotionVariant`
and the book-scoped branch of `ensureCharacterVoiceUuid`. Both functions'
outer read was previously used only for a branch decision (does the
character exist, does it already have a `voiceUuid`) and never re-evaluated
inside the write's scope — exactly rule 2's failure mode. The fix
re-derives every decision (the `voiceUuid` check, `qwenStorageKey`) inside
the lock. `ensureCharacterVoiceUuid`'s **series** branch stays unlocked and
delegating — it calls `forEachMatchingCastCharacter`, which locks per book
itself, so wrapping the series branch in a cast lock would call a locked
function from inside a lock on the same book (rule 1) and self-deadlock the
moment the walk reaches the calling book.

**Deletion sites (2, not counted above but locked the same way)** —
`analysis.ts`'s "Start fresh" `rm(castJsonPath(...))` in `runMainAnalyzerJob`,
and `book-state.ts`'s `applyReparse` (only the cast.json arm of its
`Promise.all` — the analysis-cache, revisions and audio arms are untouched).
An unserialised delete can simply be undone: a writer that acquires the lock
after the delete recreates cast.json, resurrecting the stale roster the
delete existed to remove.

**The static guard** — `cast-lock.guard.test.ts` walks `server/src/**/*.ts`
(excluding tests), and for every `writeJsonAtomic(castJsonPath(` or
`rm(castJsonPath(` occurrence, does a brace-depth scan back to the nearest
enclosing `withCastLock`/`withCastLocks` call. `withLibraryVoiceLock` does
not count — it is a different key in the same map, so a cast write enclosed
by it alone is not serialised against the other 34 writers, and accepting it
would make the guard green on exactly the regression it exists to catch. The
allowlist is keyed on file **and** expected count, never file alone:

```ts
const ALLOWED_UNLOCKED = new Map([
  ['routes/analysis.ts', { writes: 5, rms: 0, why: 'merge-base writes deferred to #2015; the rm IS locked' }],
  ['routes/voice-override-linked.ts', { writes: 1, rms: 0, why: 'locked via applyToBookLocked; unprovable syntactically' }],
]);
```

A sixth unlocked write in `analysis.ts` fails the guard rather than
inheriting the exemption — mutation-verified, along with two different
converted sites each unwrapped in a separate run and each failing by naming
its own file, and a site re-wrapped in `withLibraryVoiceLock` instead of
`withCastLock` still reporting unlocked. Known blind spots, documented in
the guard's own header rather than papered over: it matches one syntactic
form, so `const p = castJsonPath(dir); await writeJsonAtomic(p, …)` would
slip through, as would a future writer routed through
`workspace/schema-migrate.ts`'s cast.json seam.

## Deliberately NOT covered

Two things a per-book RMW lock cannot reach, both carrying real design
history on open tickets rather than being silently dropped:

- **`analysis.ts`'s five writes** (`Refs #2015`) replay a merge base
  (`priorCastForMerge`) read once at the top of a run and reconciled against
  writes spread across the whole Phase 0/1 pipeline. Neither available lock
  strategy works: holding a cast lock for the run would block every other
  cast write on that book for minutes with no timeout; re-reading inside
  each write's lock would change behaviour, because a later iteration would
  then merge against an interim write instead of the pre-run cast, silently
  degrading srv-13's voice/reuse carry-forward. Two mitigations were
  designed and both rejected on review — an `isAnalysisBusy`-consulting
  admission gate (itself check-then-act, the exact defect class this PR
  closes) and a route-level busy-refusal gate (a ~20-route API contract
  change for something that concedes it isn't a correctness guarantee, since
  a run can start after a handler is admitted). Both are recorded on #2015
  so the next attempt doesn't re-propose them.
- **Three clone-consent gates validate cast.json and write elsewhere**
  (`Refs #2006`) — `voices.ts`'s `PUT /:voiceId/override` (a cross-book veto
  that a per-book lock would demote to per-book, honouring it mid-walk would
  409 a partially-applied propagation), and `single-design.ts` /
  `qwen-voice.ts`, which write from contexts that structurally cannot refuse
  (one detached after `res.flushHeaders()`, one a helper shared between an
  SSE bulk job and a JSON route). One of the four original clone-consent
  gates — the library-voice DELETE-vs-assign race — **is** fixed in this PR
  (`withLibraryVoiceLock`, see above); the other three, plus a fourth
  `cast-link-prior.ts` hole this work surfaced (it plants a `libraryUuid`
  reference it cannot know up front, so it cannot take the key before
  reading), are added to #2006. In total, four staleness mechanisms across
  both tickets were designed and none survived review — recorded in the
  design spec's §13 so a fifth isn't proposed from a blank page.
- **`PUT /:bookId/state` is last-writer-wins by contract**, unrelated to
  either open ticket. It writes the client's whole `characters` array
  wholesale; the lock protects the clone-consent guards inside
  `preserveDesignedVoices`, not the patch itself. Two browser tabs editing
  the same book's cast through this route still resolve last-write-wins —
  closing that needs an `If-Match`-style token on the wire, out of scope
  here.
- **`applyReparse`'s two rule-2 gaps, both closed (#2099).** (a) The
  carryover snapshot's `readJson(cast.json)`, the derived `reuseRows`, the
  carryover write/rm and the cast.json delete now all run inside one
  `withCastLock` hold, as one arm of the existing `Promise.all` — not a
  sequential step before it (a sequential shape was drafted and rejected:
  today all four `Promise.all` arms start in the same tick, and sequencing
  the locked block first means a `rm` rejection there, e.g. EPERM/EBUSY,
  skips the other three — which have already started — while `state.json`
  was already rewritten with the new chapter slugs and
  `castConfirmed:false`, a strictly worse inconsistent state than before).
  **Correction to this doc's own earlier claim**, which said closing (a)
  "means widening the lock across `writeStateJsonAtomic` plus the carryover
  write" — that was over-broad. `state.json` is a different file with no
  cast writer, written before the cast read; only the carryover write (and
  the read that feeds it) needed to move inside the lock. (b) The
  `existsSync` guard around the delete is gone — `rm(…, { force: true })` is
  already a no-op on a missing file, so the guard only ever saved a lock
  acquisition while sourcing the *decision whether to delete at all* from a
  read taken outside the lock. The three sibling arms (revisions, audio,
  analysis-cache) keep their own `existsSync` guards: they gate an
  already-idempotent `rm` and acquire no lock, so no decision of theirs
  crosses a lock boundary — only the cast arm's guard was gap B.

  **Honest residuals, not closed by #2099:**
  - The carryover has a **third** toucher this widened lock does not reach:
    `analysis.ts:186`'s `readPriorCastForMerge` **reads** it unlocked, and
    *prefers `cast.json` when present* over it. A concurrent analysis run can
    still observe the intermediate read→carryover→delete state exactly as
    before — the lock only serialises other **lock-taking writers** against
    reparse, not this unlocked reader.
  - Gap (b)'s *decision* is closed (the guard is gone), but its motivating
    scenario is not: the racer the ticket names for it is `analysis.ts`'s
    five still-unlocked merge-base writes (#2015). Those take no cast lock at
    all, so removing the guard converts "cast.json is never deleted once one
    of those writers has run" into "deleted unless the write lands after the
    `rm`" — it serialises nothing against them. Closing that gap fully is
    #2015's job, not #2099's.
- **Cross-book residuals**, all carried on #2006: `cast-add-from-roster`
  reads the target book to decide a source-only write; `voice-override-linked`
  and `cast-series-patch` derive their whole write-list from a source book
  they never write; and two concurrent series-scoped design jobs on
  *different* books of one series can each mint a distinct `voiceUuid` for
  the same linked identity, because `withDesignLock` keys per book while the
  propagation is series-wide — pre-existing, and this sweep makes the
  *outcome* finer-grained (a split uuid rather than one whole-file loser)
  rather than fixing it.
- **In-process only.** Two server processes against one workspace defeat
  this entirely; the product runs one server process.

## Also fixed in passing

Two defects found and fixed in code this branch already touches, each
clearing CLAUDE.md's fix-now bar:

- **The promise-chain lock helpers' key-map cleanup never ran** (`#2001`).
  `file-lock.ts`, `tts/design-lock.ts`, and `chapters-restructure.ts`'s
  `withBookLock` each compared `chains.get(key)` against `gate` in their
  `finally`, but what was stored was `prior.then(() => gate, …)` — a
  different object, so the identity check could never hold and the entry
  was never deleted. Each map grew one entry per distinct key for the
  process lifetime. Fixed by storing the comparable promise itself.
- **`library-cast-override.ts`'s same-book-different-character path silently
  discarded one side's merge, with zero concurrency involved.** Its guard
  rejects same-book-and-same-character only, so `source === target` with
  different characters was reachable: two independent reads of the same
  file, two arrays derived from those separate snapshots, the same path
  written twice — the second write overwriting the first's merge outright.
  `withCastLocks`'s dedupe alone would have removed the deadlock and left
  the data loss intact under a lock, which would have made it look
  addressed. Fixed with a genuine same-book branch: one read, both merges
  applied to one array, one write.

## Test plan

### Automated coverage

- `server/src/workspace/cast-lock.race.test.ts` — the outcome test:
  two overlapping RMWs against one cast.json, each mutating a different
  character, both mutations asserted to survive. Red at every unlocked
  site (mutation-verified by reverting the lock, not merely read and
  agreed with); green under the lock. Also carries the cross-module
  variant required by the design spec §10.3 — one outcome spec races two
  *different* modules' write sites against the same book, which a
  self-vs-self race cannot catch (it can't observe a key-derivation
  mismatch between two different call sites).
- `server/src/workspace/cast-lock.test.ts` — primitive unit tests: sorted
  acquisition regardless of argument order, dedupe, release-on-throw,
  waiter (FIFO) ordering, and the key-map cleanup fix.
- `server/src/workspace/cast-lock.guard.test.ts` — the static regression
  guard described above.
- Per-route race tests at each converted site (e.g.
  `cast-link-prior.test.ts`, `cast-not-linked-to.test.ts`,
  `library-cast-override.test.ts`, `voice-style.test.ts`,
  `qwen-voice.test.ts`, `voices.test.ts`) — same-site races proving a lock
  exists, and (for the five two-book routes) AB/BA deadlock tests proving
  acquisition order. A bare `Promise.all` is adequate for the former but
  not the latter: an outer-granted → inner-requested acquisition pair is a
  same-tick microtask with no seam to hold open, so AB/BA tests use a
  deterministic barrier (a hoisted `vi.mock` holding both requests at a
  common point, released together) instead.
  `cast-not-linked-to.test.ts` shipped with only the AB/BA test until
  `#2123`: its lock-existence detectors race a genuine `withCastLocks`
  writer (an orthogonal field on the SAME book) against the route's own
  in-lock `readJson`, gated via the same barrier idiom — proven red both
  when `withCastLocks` is neutralised (`return fn();`, bypassing its
  `reduceRight` chain — mutation-verified against that primitive, not
  `withCastLock`, which this two-book site never calls) and when
  `sourceCast`'s read is hoisted back outside the still-present lock (a
  rule-2 regression — the same stale-snapshot clobber outcome as the
  `library-cast-override.ts` defect above, though that one was a same-book
  aliasing bug with zero concurrency involved). This route has TWO locked
  handlers, POST (mark) and DELETE (unmark), with a structurally identical
  read-through-write span; an independent review found the original
  `#2123` detector covered POST only, so hoisting DELETE's read left the
  file green 16/16 with the static guard blind to it too (it checks the
  write site, not the read). A second detector, sharing the same
  `runLockDetector` construction, now covers DELETE as well. Both
  detectors also assert a `racerEntered` flag set on entry to the racer's
  critical section (not just that its write survived) — the survival-only
  assertion depends on the racer's full read+write losing outright against
  an 80ms head start, which a slow-enough unlocked write can still beat.
  `#2123` also re-measured two single-book sites, `cast-add-from-roster.ts`
  and `voice-library-usage.ts`'s `clearLibraryVoiceReferences`. Both had
  been read as detector-less by neutralising `withCastLocks` (plural) and
  finding their specs green — but both actually call `withCastLock`
  (singular; `cast-add-from-roster.ts` locks only the source book it
  writes, and `clearLibraryVoiceReferences` holds at most one book's lock
  at a time), which that mutation never touches. **A sweep-wide mutation of
  ONE primitive silently exempts every site built on the OTHER**, and a
  spec staying green under a mutation is evidence of a gap only once you
  have confirmed the site actually calls the thing you broke. Confirm the
  primitive by reading the module; don't infer it from the site's shape.
  Re-measured against the correct primitive the two sites differ:
  `voice-library-usage.test.ts` was genuinely detector-less (green under
  `withCastLock` → `return fn();`), while `cast-add-from-roster.test.ts`
  was already covered — its pre-existing `#1981` self-race test goes red
  under both that mutation and a rule-2 read-hoist. Its new detector is
  kept nonetheless because a self-race cannot catch a **divergent lock
  key**: keying the site's `withCastLock` off a different derivation of
  the same book (verified by mutating the call site to
  `sourceLocated.bookDir.toUpperCase()`) leaves the lock fully intact and
  the self-race green — both callers queue on the same wrong key — while
  the external-writer detector is the only test that fails. That is the
  exact failure `cast-lock.ts`'s header warns of ("a site that derived the
  key slightly differently would get a second mutex that never contends
  with the first, and every test would still pass"), and it is
  structurally invisible to any same-site race. Each site now carries its
  own `runLockDetector`-style test racing a genuine `withCastLock` writer
  from outside the site: `cast-add-from-roster.test.ts`
  against the route's in-lock `sourceCast` read (no separate unlocked
  pre-lock read of that path to confuse the gate with — `findBookByBookId`
  only reads state.json); `voice-library-usage.test.ts` against
  `clearLibraryVoiceReferences`'s in-lock read, which is genuinely the
  SECOND read of that book's cast.json (`walkConfirmedCasts()`'s own
  unlocked scan reads it first), so that gate intercepts by occurrence
  count rather than first-match, to avoid gating the wrong one. Three
  modules now carry behavioural lock-existence detectors from this sweep:
  `cast-not-linked-to.ts` (POST + DELETE), `cast-add-from-roster.ts`, and
  `voice-library-usage.ts`.
- `server/src/routes/analysis.fresh-cast-lock.test.ts` and
  `server/src/routes/book-state.reparse.test.ts` — race the two delete
  sites against `cast-aliases`, which re-reads inside its own lock and
  409s on an absent cast, so the file stays deleted in both interleavings
  once serialised.

Every race/outcome test in this sweep is proven able to fail, not merely
read as correct: mutating to a pass-through (`return fn();`) the primitive
body of **whichever entry point the site under test actually calls** —
`withCastLock` OR `withCastLocks`, confirmed by reading the module —
across multiple separate process runs, per CLAUDE.md's "a test that passes
in the red phase is a harness problem." Mutating only one of the two is
NOT a completeness check: it silently exempts every site built on the
other, and a spec that stays green under it is evidence of nothing (see
the `#2123` note above, which is what that mistake cost).
Two shapes were rejected after being measured, not assumed: a bare
`Promise.all` for AB/BA ordering (proven a placebo — see above), and a
multi-trial retry loop for a probabilistic race (repeating inside one
vitest process is not independent sampling; only trial 0 ever caught a
miss in instrumented testing). Where a single external run wasn't reliably
deterministic, the interleaving is scripted instead: a hoisted `vi.mock`
intercepts the specific in-lock read the write depends on and holds its
resolution behind a manual gate, giving the racing writer a one-directional
head start with nothing to tune.

### Manual acceptance walkthrough

Server-side concurrency behaviour — this crosses no router/redux/layout
seam, so it needs the real backend rather than mock mode, and Playwright
cannot observe it (no e2e spec added; the walkthrough below is the manual
equivalent).

1. Open a book with an unvoiced or partially-voiced cast of several
   characters. Start a bulk **"Design full cast"** job from the Cast view.
2. While it is running, open the same book's cast in a second browser tab
   (or a second window) and edit a character's alias (unlink, repoint, or
   add) via the Cast screen's alias controls.
3. Let both finish. Expected: the alias edit from step 2 is present on the
   character it targeted, **and** every character the bulk design job
   assigned a voice to in step 1 keeps that assignment — neither operation's
   write is silently missing. Before this change, whichever write's atomic
   rename landed last would win outright and the other's change would be
   gone with no error shown anywhere.
4. Confirm cast.json on disk (`<workspace>/<book>/.audiobook/cast.json`)
   reflects both changes together, not just one.

## Out of scope

- `analysis.ts`'s five merge-base writes and the three remaining
  clone-consent gates — see "Deliberately NOT covered" above; both carried
  on open tickets (`#2015`, `#2006`) with their design history attached.
- `PUT /:bookId/state`'s last-writer-wins contract — a wire-protocol change
  (an `If-Match`-style token), not a locking change.
- Any second server process or worker-thread topology — the lock is
  in-process only by design (§12.1 of the design spec).
- Frontend, OpenAPI, and on-box acceptance — no surface in any of the three
  changed by this work (see the PR body for the explicit N/A discharge of
  each before-shipping checklist step).

## Ship notes

Not yet shipped — filled in when this PR merges and the plan's status
flips to `stable`.
