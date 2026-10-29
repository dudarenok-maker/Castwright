# PR reviewer brief

Read this file in full before starting. It is the rubric — what to check and
how to report it. The dispatching session's runbook is
[`../SKILL.md`](../SKILL.md); you do not need it.

**Framing: this is a gate, not a collaborator.** Your job is to find what's
wrong with the change, not to appreciate it. Don't soften findings to be
encouraging, and don't reward effort.

## Half one: house gates

Mechanically checkable, and you are expected to actually check them rather
than assume the author did:

- the paired test is a real regression test — red before the fix, green
  after, and red *for the reason claimed*;
- on-box acceptance recorded across all three surfaces (register, per-feature
  run sheet, live view) when the PR ships hardware-provable behaviour;
- the release-notes pair (`docs/release-notes-next.md` + `RELEASE_NOTES.md`),
  or an explicit not-applicable;
- `Closes #NN` / `Refs #NN` present and outside any code span;
- `cast.json` writes locked per the four rules, and lock-timeout errors
  routed through the correct curation seam;
- a new config knob carrying its registry entry, `config:sync`, Settings row
  and `.env.example` line;
- derived artifacts regenerated — `src/lib/api-types.ts`, `docs/BACKLOG.md`,
  brand PNGs;
- incidental findings fixed in this round rather than filed, and declared in
  the PR body.

## Half two: recurring defect shapes

Curated, roughly ten, each stated as *how it hides* rather than as a rule to
recite:

1. **A guard that fails open on absent evidence** — the input it inspects is
   missing, so it passes.
2. **A guard that enumerates syntax** — it loses one spelling per round to
   anything it did not list.
3. **A test that cannot fail** — or that went red before the fix for a
   different reason than the one claimed.
4. **A metric blind to a case it must score** — deletion counted as repair, a
   merge counted as repair, the dominant shape excluded.
5. **An acceptance criterion blind to its own feature** — it would pass on a
   null observation.
6. **Success reported while doing nothing** — the most common shape in this
   repo's history, including inside guards written to catch it.
7. **A fix unreachable at the default configuration** — correct code that
   runs zero times as shipped.
8. **A control group labelled clean but never measured.**
9. **The defect is in the instrument or the document, not the code** — a
   stale comment the change made false, a figure measured under one rule
   reused as evidence for another.
10. **One instance fixed, the class left armed** — sibling call sites, other
    entry points, the second copy.
11. **A fixture that invents an external tool's output contract** — written
    from belief rather than from a recorded run, so oracle and code share one
    wrong shape and the suite is green. Checkable: is the fixture traceable
    to real output? Red-before/green-after does not settle it — it measures
    conformance to the fixture (PR #2795 — `npm audit --json`'s `via[]`).
12. **A brief that paraphrases the design of record drops the constraints an
    earlier review added, and the implementation conforms to the
    paraphrase.** A design doc hardened across multiple adversarial review
    rounds (a boolean status widened to a state machine, a missing recovery
    primitive added, a naive target-selection fixed) gets summarized into a
    ticket/brief as its ORIGINAL one-paragraph scope, predating those
    rounds' findings — the brief never names the doc it's summarizing, so
    nothing points the implementer back at the hardened version. Tests
    written against the paraphrase go green over the exact regressions the
    earlier rounds already fixed once (PR #3113 — `auto-revert.ts`'s first
    cut reintroduced a revert-to-'auto' infinite-loop bug and a
    missing-try/catch status-corruption bug, both already found and fixed
    in the design doc's own round-2/3 history). Checkable: does the brief
    cite the design doc by path/commit, not just restate a summary of it?
13. **A fix written to the reported repro rather than to the invariant it
    violated** — the fix satisfies the finding's exact scenario and passes
    its paired test, but breaks the configurations the finding did not happen
    to name. The bug is one level of abstraction higher than the fix targets:
    the invariant itself, not one path that violates it. The regression test
    inherited the repro's own blind spot by hard-coding the values the repro
    held fixed, so a future regression that substitutes a different value is
    not caught (PR #3192 C2→C3: a fix for "when only Phase 1 is picked, Phase 0
    should get the account default" was written to that exact repro,
    hard-coding `analyzerPhase{0,1}Model: null`, and broke the wider
    invariant "a saved Advanced Settings override should never be discarded by
    a pick on a different phase"; the fix conditioned on whether the *other*
    phase was picked, not on whether this phase already had a model the server
    would resolve). Checkable: does the fix's condition name the invariant,
    or the repro's state? Does the paired test vary the conditions the repro
    held fixed?
14. **A computation moved earlier "verbatim" now records a stale observation**
    — code that was correct because it ran immediately before the thing it
    describes is hoisted into an up-front pass (to let an earlier decision
    see its result), and the later consumer reads the early value back
    instead of recomputing. Each line is unchanged, so the diff reads as
    a pure move — what changed is WHEN it runs relative to the side effects
    in between. A pre-pass hashes every step's inputs before the first step
    runs so the pipeline budget can exclude steps that would be `[cached]`;
    a passing step then writes that plan-time hash to the cache. An input
    rewritten while an earlier step ran is tested in its new state and
    recorded under the hash of its old one, so restoring the file produces
    `[cached]`, exit 0, for content the step never ran against. The suite
    was green and a source pin actively REQUIRED the bug: "the loop must
    read the hash from the pre-pass, not recompute" (PR #3393 —
    `scripts/verify-cache.mjs`). Checkable: for anything hoisted out of
    a loop or moved ahead of side-effecting work, what can change between
    where it now runs and where its result is used — and is the value an
    estimate (safe to take early) or a record of what actually happened
    (must be taken at the time)?
15. **A test that cannot pass on the CI leg that runs it** — it uses a
    Windows-only cmdlet parameter (`Start-Process -WindowStyle`, `-Verb`) or
    a Windows-only API, and the author ran it only on Windows, while the leg
    that executes it is Ubuntu pwsh (CI's Windows leg runs `test`,
    `test:server` and `test:hooks`, never `test:scripts`). The author's
    green run proves nothing about the runner (PR #3404 pass 4: three
    `Stop-ProcessTreeByLiveness` Pester cases died with `NotSupportedException`
    on `-WindowStyle`, 99 pass / 3 fail on the required leg). The fix is
    never a Windows-only skip — that leaves the test running in no leg, and
    `$IsWindows` is `$null` on Windows PowerShell 5.1 so the naive skip also
    skips there. Splat the Windows-only parameter conditionally
    (`$PSVersionTable.PSEdition -eq 'Desktop' -or $IsWindows`). Checkable:
    for every new test, name the CI leg that executes it and whether anything
    in it is unavailable there.
16. **An ordering fix whose snapshot and queue position are taken in different
    ticks** — a per-path write queue is added so "last writer wins" matches
    call order, but the value is snapshotted before an `await` (a book-dir
    verification, a lock) and the queue slot is claimed after it. Two callers
    whose awaits resolve out of order enqueue in the wrong order, so the
    OLDER snapshot is written last; the queue serialises the writes and still
    loses data. Every test with a uniform delay is green (PR #3430 passes 1-2,
    interim edits rolls in `routes/analysis.ts`). Checkable: for each queued
    write, is the value read in the same synchronous step as the enqueue (no
    `await` between), and does a test make the FIRST caller's await slower
    than the second's with distinct snapshots?
17. **A clear on one phase's success path that does not check which phase
    the record came from** — a failure record is cleared when a later phase
    completes for the chapter (here: Phase 1 clears any `failedChapterIds`
    entry). Harmless while the phases run in sequence, because a chapter
    reaching Phase 1 has necessarily passed Phase 0; wrong once they overlap.
    In pipelined mode Phase 1 dispatches off a watermark (the highest Phase-0
    index completed, not a contiguous prefix), so a chapter whose own Phase 0a
    failed is still attributed, and its Phase-1 success erased the cast-phase
    record the resume needed to re-cast it (PR #3439 pass 3,
    `routes/analysis.ts`). Checkable: for every clear, name every phase that
    can have written the record, and ask whether this phase's success is
    evidence that THAT phase's failure is fixed — and whether a test
    interleaves the two phases for one chapter rather than running them in
    order.
18. **A hand-off tested by calling the receiver directly** — the producer
    is meant to cause a later step (a subset Retry that "hands off to the
    main resume"), and the test invokes that later step itself, so it cannot
    see that the product's real trigger never fires. Here the trigger was the
    view's auto-resume, which waits for every failed row to clear; the Retry
    kept its row, so the main run was never re-POSTed, while the test that
    called `runMainAnalyzerJob` itself passed (PR #3439 pass 3,
    `src/views/analysing.tsx`). Checkable: for every "X then Y resumes"
    claim, find what actually starts Y in the product, and ask whether a test
    reaches Y through that trigger (the view harness with the real slice and
    middleware) or only by calling it.
19. **A sentinel that is also a valid value** — a marker meaning "none" or
    "not recorded" (an empty array, `0`, `''`, `null`) is also something the
    field legitimately holds, so the reader cannot tell "never written" from
    "written as empty". In `server/src/routes/analysis.ts` the Phase-0
    failure catch wrote `chapterCast[id] = []` as the cast-failure marker,
    but `[]` is also a real cast for a narration-only chapter (cast detection
    succeeded and found no characters). `isPhase0aCoverageComplete` read every
    `[]` as "cast missing", so a Retry or Re-analyse on a book with a
    narration-only chapter never reached Phase 1 (test P-theta). #3435 makes
    the failure record's `phase: 'cast'` the discriminator, passed in as
    `castFailedIds`.
    Checkable: for every default or "empty" value a reader branches on, ask
    whether a real writer can produce exactly that value, and whether a test
    seeds that case.
20. **A flag read as "phase N finished" that is written before phase N** —
    a completeness marker set on entry to, or in the middle of, the step it
    vouches for, so an interrupted or refused step leaves the flag claiming
    success. In `server/src/routes/analysis.ts` the subset persist set
    `takesPersisted`/`confirmReached` before the S14 gate had passed, so a
    `resume_required` exit left the book marked as having reached Confirm;
    the fix sits inside S14's pass branch (`if (wroteStateJson)`) (#3435).
    Checkable: for every marker, find the write site and ask whether it sits
    inside the success branch of the last step the marker is read as proving,
    and whether a test fails that step and asserts the marker is absent.
21. **A derived "not done" list computed from a store that isn't the record
    for every book it's applied to, so an absent store reads as "nothing
    done"** — the list is correct where its source exists and silently wrong
    where it does not. `server/src/routes/book-state.ts` built
    `unattributedChapterIds` from the analysis cache alone, and a missing
    cache loads as `{ chapters: {} }`, so a confirmed sample book with no
    cache showed every chapter as unfinished; the fix treats
    `manuscript-edits.json` as authoritative past Confirm (#3435, PR #3505
    gate pass 1).
    Checkable: for every derived list, name the store it reads, and ask what
    it reports for a book where that store is absent or was never written.
22. **Test cleanup that deletes a directory the code under test is still
    writing to fire-and-forget** — the test passes its assertions, then the
    teardown races the detached writes and fails intermittently. The
    plan-287 `afterEach` in `server/src/routes/analysis.test.ts` `rmSync`'d
    the book dir while `endJob`'s detached `persistTerminalSnapshot` write was
    still landing (ENOTEMPTY, 1 run in 3); fixed by awaiting the recorded
    `withVerifiedBookDir` promises. That covers the snapshot write only; the
    last-outcome write (`tryResolveVerifiedBookDir`) of a registered job is
    not awaited (#3435, PR #3505 gate pass 1).
    Checkable: for every `afterEach` that removes a directory, list the
    fire-and-forget writes the code under test can still be making into it,
    and confirm the test awaits them.
23. **A completion moved onto a promise chain that outlives its view** — in
    `src/views/analysing.tsx` a Retry's `.then` began calling the shared
    `completeRun`/`onComplete`; the main run's call sat behind an unmount
    guard (`cancelled`) but the Retry's chain did not, so a late Retry result
    hydrated whichever book was open and could persist one book's roster into
    another's cast.json. Pass 2's fix covered only the `.then`/`.catch`/
    `.finally` completion; pass 3 found the Retry's stream callbacks and the
    Generate view's flows still unguarded, closed in 50dbb2cc (#3435, PR
    #3505). Checkable: when a completion/dispatch is moved or added onto an
    async chain, find the guard the original call site had against unmount or
    navigation and confirm the new site has it too, with a test that resolves
    the chain after unmount. A "fixed" claim covers only the call sites it
    names: list every callback and flow that writes on the same chain, not
    just the one that was reported.
24. **A guard tied to component lifetime when the rule is about what the
    screen shows** — `src/views/analysing.tsx`, PR #3505 gate pass 3: a
    `mountedRef` guard on a Retry's completion both let too much through (the
    unkeyed route element survived a book switch, so A's result routed B to
    A's Confirm) and blocked too much (returning via the pill mounted a new
    instance, so the old one skipped completion and left a stale screen);
    fixed by reading `ui.stage` at resolution (`bookOnScreen()`), scoping
    snapshot writes by manuscriptId, gating store writes with
    `selectIsOpenBook()` (`src/store/open-book.ts`), and keying the
    Generate/Analysing route elements by bookId. Checkable: for every async
    guard, state the rule it enforces in terms of what the user sees; if the
    guard is about component lifetime, find the route param change that keeps
    the instance and the remount that starts a new one, and test both.
25. **A guard that checks which book the screen shows, while the write lands
    in slices — or on disk — that still hold the previous book for one state
    read** — PR #3505 gate pass 4: `AnalysingRoute`'s `onComplete` routed by
    `ui.stage` but loaded the payload into the cast/chapters/manuscript slices
    that still held another book (`src/routes/index.tsx`), and the Generate
    gate refused on the stage alone, dropping a result its own slices should
    take; fixed by deciding late writes by which book the slices hold
    (`selectIsOpenBook`, `src/store/open-book.ts`, which compares
    `manuscript.manuscriptId`). Pass 5: Confirm's auto voice-match effect
    (`src/components/layout.tsx`) fired on `confirm/A` with the previous
    book's cast before A's read landed, and its `applyVoiceMatches` is
    persisted to the book the stage names, so B's cast was written to A's
    cast.json; fixed by waiting until `manuscript.bookId === bookId`. The
    background and manual emotion detection (`runProsodyPasses` `canApply`,
    `src/store/prosody-thunk.ts`) had the same shape (#3435, PR #3505 gate
    passes 4-5). The general class is tracked as design issue #3519 (no
    explicit loaded-book identity on the slices). Checkable: for every async
    write into a book-scoped slice or a persisted action, name (a) which book
    the screen shows, (b) which book the slices hold, (c) which book the
    persistence middleware will save to — and test with the stage and the
    slices moved independently, including with the real persistence
    middleware so a disk write to the wrong book is visible.
26. **A job started under a condition, but tracked and cancelled by when it
    started, in a single slot** — `src/components/layout.tsx`, PR #3505 gate
    pass 7: the open trigger's background emotion run was started only while
    its book was open on Confirm or Generate, but nothing stopped it when that
    stopped being true, and the yield tracker (`prosodyBackground`) was one
    slot that the next background run overwrote. A second instance silently
    untracked the first, so the first's yield or cancel never fired: it kept
    applying annotations to a book being rendered or re-analysed, and opening
    three books in turn left three whole-book runs in flight. Fixed in
    b3bf65be by aborting the run the moment its book stops being the open
    trigger's book (`selectOpenProsodyBookId`) or an analysis starts for it,
    which also makes the single slot sufficient (#3435). Checkable: for every
    detached job, name the condition it may run under; ask what stops it when
    that condition ends; and ask what a second concurrent instance does to the
    first's registration.
27. **A sync-to-async conversion that drops error handling the sync API did
    implicitly** — `scripts/lib/bounded-spawn.mjs`, PR #3705 gate pass 2:
    `spawnSync` with `input` absorbed a stdin write failure (EPIPE/EOF, a
    child that exits without draining) into `r.error` and still returned the
    child's own status; the async `child.stdin.end(input)` raised it as an
    unhandled `'error'` event that crashed the host (`write EOF`). Fixed with
    a stdin `'error'` handler that ignores the benign codes and rejects on
    the rest. Checkable: for every sync call replaced by an async one, list
    what the sync version returned or swallowed instead of throwing (`r.error`,
    a status, a buffered result) and confirm the async path handles each, with
    a test where the child exits before reading its input.
28. **A timeout that cannot fire because the wait it bounds blocks the event
    loop** — PR #3705 gate pass 1: the e2e test's bound was a node:test
    `{ timeout }` and then an async spawn bound, both wrapped around a
    blocking `spawnSync` git call, so no timer could run until the call
    returned and a hang produced silence, not the named failure; fixed by
    making the spawn itself async (`boundedSpawn`). Checkable: for every
    timeout or deadline, find the call it is meant to bound and confirm that
    call yields to the event loop; a bound around a `*Sync` call is decorative
    unless it is the call's own `timeout` option.
29. **A lock keyed by a path resolved BEFORE acquisition** — PR #3706 pass 2
    (#3700): `state-json:<book dir>/state.json` was keyed by the folder a
    request had resolved before it queued. Once the holder moves or deletes
    that folder (a folder-renaming PUT, a DELETE), every waiter acquires a key
    naming a path that is no longer the book, and queuing makes that certain
    rather than a race. Waiters then either wrote their stale snapshot back
    (resurrecting a deleted book, or leaving two folders with one bookId) or
    answered 200 for a write that never happened (a reparse wiping the moved
    book's analysis cache by manuscript id). Checkable: for every lock whose
    key is derived from a path or id resolved earlier, ask what the holder may
    move or delete while you wait, and what each waiter does when the thing it
    re-reads is absent; test by holding the key, moving or deleting the
    target, then releasing, and assert a refusal with nothing written.
    The same hazard runs the other way, for the lock HOLDER: its steps after
    the lock is released, against a path it resolved before it (a change-log
    write, a cast delete, a slug rewrite), land in a folder a queued
    folder-move has since vacated, recreating the old folder (PR #3706 pass 4).
    Fixed for moves by `book-op` + `book-jobs` (#3711): a move/delete holds
    `book-op:<bookId>` exclusively and is refused while a long job is registered.
30. **An op list computed before a later pass changes its keys, then patched
    only for the entries it already has** — `server/src/workspace/restructure.ts` (`postProcessRestructure`),
    PR #3594 gate pass 3: the audio rename ops were computed from the first
    slug transform, then the prune renumber and the generic-title retitle
    changed more slugs but only patched ops that already existed, so a chapter
    renamed ONLY by a later pass kept its stale audio, `.previous` takes and
    sidecars (a merged chapter could even play another chapter's audio); fixed
    in 0c6d9a2b by moving files with the slugs the post-passes change.
    Checkable: list every later pass that changes a key the op list is keyed
    on, and for each ask whether an entry renamed ONLY by that pass gets an
    op; test with a fixture where the later pass is the sole renamer.
31. **A reference-identity check used to mean "unchanged since X" in a store
    where every write replaces the reference** — `src/views/restructure.tsx`
    (`applyResponse`), PR #3594 gate pass 4: the sentence remap skipped when
    the book's sentences were no longer the same array as at click time, but
    under Immer any same-book write replaces the array, so the skip fired on
    unrelated writes (a background emotion-detection run) and the work it
    dropped was never retried, saving sentences with stale chapter ids; fixed
    in 3723e4f6 with a `hydrateSeq` counter that moves only on a re-hydrate. Checkable: for every `===` /
    `Object.is` guard on store state, ask what ELSE replaces that reference;
    then ask whether the work the guard drops is retried. Test by making an
    unrelated write between capture and use.
32. **A debounced save that captures its payload when the action fires, racing
    a server-side rewrite of the same file, where the client's in-memory
    correction is never itself saved** — `src/views/restructure.tsx` and the
    persistence middleware, PR #3594 gate pass 5: a manuscript edit queued
    before (or during) a restructure was built from the old chapter ids and
    sent one debounce later, so it landed AFTER the route's own rewrite of
    `manuscript-edits.json` and put the old ids back on disk, while the client
    fixed up only its in-memory sentences and never saved them. Fixed in
    2fc93b50 by flushing and awaiting the book's queued saves before the
    request, and saving the remapped state after the response. Checkable: for
    every server route that rewrites a file the client also saves, ask what a
    save queued before the rewrite does when it lands after it, and whether the
    client re-saves its corrected state. Test with a slow or debounced PUT
    queued around the rewrite and assert on the final disk state.
33. **A cancellation that sends a cleanup write at the same moment as the
    operation that caused it, through a route whose read-modify-write of the
    same file is not under the operation's lock** —
    `src/components/detect-emotions-button.tsx` (`markUnfinished`), PR #3594
    gate pass 6: starting a chapter restructure aborted a running emotion run
    synchronously, and the abort path sent `PUT /state {prosodyAnnotated:false}`
    in the same tick as the restructure's own `POST`. The state PUT read,
    patched and rewrote `state.json` without the lock the restructure held, so
    in 8 of 20 runs the pre-merge chapter list was written back over the
    restructure's. The compensating write was sent BY the cancellation the
    operation itself triggers, so it overlaps the operation by construction.
    Fixed in 982a59d9 (the state and manuscript PUT slices take the book lock)
    and c3c63f90 (the client holds the mark until the restructure ends).
    Checkable: for every write an abort or cancel path sends, name the server
    write it can overlap and whether both routes take the same lock. Test with
    both requests against the real routes, started in the same tick, and assert
    on the files.
34. **A read path that "heals" by rewriting a whole file from an unlocked
    earlier read, so every reader is a potential writer** —
    `server/src/workspace/scan.ts` (segments backfill, srv-35 uuid mint), PR
    #3594 gate pass 6: `findBookByBookId` and `scanLibrary` read `state.json`,
    derived missing chapter fields from the audio sidecars, and rewrote the
    entire file. Any locate, including the one the state PUT does, could revert
    a concurrent locked writer's chapter list with its stale copy. Fixed in
    27c1297c: the heal re-reads under the book lock and fills only unset fields
    of chapters whose id and slug still match; 9490ed06 pins the re-read-to-write
    window with a lock-respecting writer. Checkable: for every function a read
    path calls that writes, ask what lock it holds across its read and its
    write, and whether it writes back its own earlier snapshot or a fresh one
    merged field by field. Test by landing a locked writer between the re-read
    and the write, and assert it survives.
35. **A lock added to a read path's write makes the caller wait, but the caller
    keeps its pre-wait snapshot, so its own later write is guaranteed to land
    last** — `server/src/workspace/scan.ts` (`backfillAudioModelKeysFromSegments`
    returning `{ state: upgraded }`), PR #3594 gate pass 7: 27c1297c made the
    segments heal queue on the book lock behind an in-flight restructure and
    merge correctly once it had the lock, then returned the read from BEFORE the
    wait plus the fills, discarding the fresh merged state. Every caller that
    wrote `state.json` from the located state then wrote the pre-restructure
    chapter list, and wrote it after the restructure by construction: the
    revert went from 11 of 40 runs to 40 of 40. The lock turned a race into a
    certainty. Fixed in 07f97a6d (the heal returns the state it merged under the
    lock and re-locates a book that moved). Checkable: wherever a lock is added
    to a function that returns state, ask which snapshot it returns, and whether
    a caller that waited on the lock starts from the post-wait file. Test with
    the caller's own write after the wait, and assert on the end state.
36. **A refusal the caller cannot see, so the writes that go with it record an
    edit that never happened** — `src/store/restructure-guard-middleware.ts`
    (returned `undefined` for a refused action), PR #3594 gate pass 7: Script
    Review Apply marked ops resolved in the server ledger that were never
    applied, Reassign lines logged a `boundary_move` per chapter and closed as
    done, and re-upload Apply cleared the title overrides and navigated to
    Listen, all because the manuscript action they dispatched was dropped
    without a signal. A silent refusal is not safe just because the refused
    action is harmless: the caller's other writes assume it succeeded. Fixed in
    bdf0d7d6: the surfaces disable with a reason and check the live flag before
    any side write, and the guard toasts. Checkable: for every middleware or
    guard that drops an action, list its dispatch sites and what each does next;
    a dropped dispatch must be visible to the caller or checked before the
    caller's side writes. Test against the real store with the guard on, and
    assert that nothing was resolved, logged, or closed.
37. **A write moved later to fix an ordering race strands the side effects that
    ran before it when a step in between fails** -- `server/src/routes/
    book-state.ts` (replace-manuscript), PR #3594 gate pass 8: 39bfe13f moved
    the `state.json` record behind the cast / audio / revisions work so it could
    be taken under the book lock, but the route had already written the new
    manuscript file and unlinked the old one. A rejection from any of those arms
    now left `state.json` naming the deleted file, so the book could not be
    hydrated after a restart, while the 500 suggested nothing had happened.
    Fixed in 858e37d4 (the old file is unlinked only after the record lands, and
    the new one is removed if it never did). Checkable: when a diff moves a
    write later, list every side effect that now runs before it (file writes,
    deletes, renames, cache wipes) and ask what is left on disk if each step in
    between throws; test with a rejecting step and assert that what
    `state.json` names exists. The same shape applies to moving a write earlier.
38. **A write staged against a location resolved before the lock, committed by a
    step that re-resolves the location inside the lock** -- `server/src/routes/
    book-state.ts` (replace-manuscript / reparse), PR #3594 gate pass 9:
    572f26fa moved the upload's write into the locked step but built its paths
    from the `bookDir` the route resolved before any lock, while the locked step
    re-located the book by id and recorded `manuscriptFile` against the new
    folder. A folder-renaming write that landed during the destructive arms left
    the record in one folder and the file in another (409 after a restart, or a
    silently lost same-extension upload). 47c23fc2's in-step refusal
    (absent-book 404 when the located folder differs) was not enough: the
    destructive arms had already run, so the moved book lost its cast, audio and
    cache and the user got a false "Book not found". Fixed in pass 10 by refusing
    the rename up front (409 while a ref-counted reparse marker is set); the
    in-step check stays as a backstop. Checkable:
    for every locked step that locates the target again, list each earlier side
    effect and path that was derived from the pre-lock location and ask whether
    the two can name different places; test by forcing the move between the two
    (hold one of the earlier steps open) and assert nothing was installed and
    the moved book is untouched.
39. **A book-folder writer outside `withBookOp` and outside a `runBookJob`
    `fn`** — #3711 / plan 288. The writer is a quick operation that takes no
    `book-op`, or a long job that never registered, or one whose write escapes
    its registration: an un-awaited child that writes the book after the parent's
    token is released (generation's `afterChapterFinalized`, scoring), a
    registration released at a deadline while its units still run (analysis's
    `MAIN_DRAIN_DEADLINE_MS`), or a book resolved before the lock (`findBookBy*`
    ahead of `withBookOp`, a `peekBook` result fed into a write). A folder move
    then lands mid-operation and the next write recreates the old folder.
    Checkable: for every route or job that writes under a book folder, hold its
    `book-op` or its job (gate the work), queue a rename/delete, and assert the
    rename waits (quick) or gets 409 `book_busy` (long) with the old path never
    recreated; also confirm the token is released on every exit path (sync throw,
    early return, rejection) and not before the last child settles.
40. **A shared index or cache seeded from a caller-supplied hint, so one
    caller's guess becomes every caller's answer** — PR #3714 pass 1 (#3711,
    `book-op-lock.ts` `accept()`): a resolve accepted the caller's `hintDir`
    and then wrote it into the process-wide `bookId -> bookDir` index. A
    startup sweep locks each walked folder by its own path as the hint, so for
    a bookId two folders carry it indexed the SECOND twin; every later
    resolve-by-id then wrote the twin the unlocked first-match GET does not
    show. The hint was correct for that one caller and wrong as a shared
    answer. Pass 2 found the same shape reachable through a swallowed read
    error: a walk that could not read one folder counted as authoritative
    discovery. Checkable: for every write to a shared map, cache or index,
    list where the written value came from — authoritative discovery (a full
    walk that saw every candidate, the key's own verified entry) versus
    caller-supplied input (a hint, a request param, a walker's current
    folder, a partial walk) — and confirm only the former writes it; then
    test by resolving once through the non-authoritative input and asserting
    the next resolve WITHOUT it still answers what the unlocked reader does.
41. **A fail-closed guard whose scope is wider than its uncertainty — one
    unreadable, unrelated record blocks every operation** — PR #3714 pass 3
    (#3711, `book-op-lock.ts` `resolveBook`): pass 2 rightly stopped a
    `state.json` read error being read as "not this book" (catalogue 1), but
    the fix failed the whole resolve on ANY unreadable folder the walk passed,
    including folders that could not change the answer. One `EBUSY` or
    `EISDIR` sibling then 500'd every autosave, rename, delete, job
    registration and peek of every book sorting after it, permanently (that
    book could never become indexed), and blocked every import. The
    uncertainty was one folder's identity; the failure was the library.
    Checkable: for each fail-closed branch, name what the unknown input could
    change about the answer, and confirm the operation fails only when the
    unknown could change THIS operation's outcome (the target itself, a known
    twin, an id it might carry); then test with an unreadable record that
    cannot matter (an unrelated sibling sorting first) and assert the
    operation still succeeds, alongside the case where it can matter and must
    still fail.
42. **A cache fill whose read precedes an invalidation and whose write follows
    it reinstates the invalidated value** — PR #3714 pass 6 (#3711,
    `store/manuscripts.ts` `getOrHydrateManuscript`): the hydrate read and
    parsed the manuscript with no lock held, then stored the record
    unconditionally. A bundle overwrite's eviction (or replace-manuscript's
    `putManuscript`) that landed during the parse was undone by that store, so
    the replaced manuscript went back into memory until a restart, and a
    chapter restructure rebuilt `state.chapters` from it. The invalidation was
    correct and locked; the fill raced it from outside the lock. Checkable: for
    every cache write, does it verify nothing invalidated the key since its
    read began (a per-key version or generation captured before the read and
    compared before the write, or the fill held under the writer's lock)?
    Then test by gating the fill between its read and its write, landing the
    invalidation, releasing, and asserting the cache holds the new value.
43. **An equality key frozen at write time, compared against a producer whose
    change is exactly what triggers the comparison** — PR #3836 pass 1 (#3828,
    `refreshChapterTitles`): the title refresh paired a restructured book's
    chapters with a fresh parse by exact body text. The hint bodies were frozen
    when the restructure ran; the refresh only runs after a title-parser bump,
    i.e. when the parser changed, and a title-parser change is precisely what
    moves text between a title and its body (the v1 to v2 subtitle merge). The
    chapters whose titles changed were the ones that stopped matching, kept
    their old title, and the version bump was still recorded, so the refresh
    never retried. Every test restructured and refreshed under the SAME parser,
    which is not the condition the code runs under. Checkable: for every
    comparison of a stored value against a freshly produced one, ask what
    event triggers the comparison and whether that event changes the producer
    (a parser version, a normaliser, a schema); if so, key on something the
    producer's change cannot move (a recorded origin, an id), and test by
    rewriting the stored value to what the OLD producer wrote before the
    comparison runs.
44. **A best-effort cleanup that becomes a correctness dependency once a new
    reader treats the leftover as evidence** — PR #3836 pass 2 (#3828,
    reparse's `removeManuscriptHints`): the delete was best-effort, logged and
    swallowed, justified by "a leftover file can never validate against the
    reparsed chapters, so it is housekeeping". True while nothing read the
    leftover. The new title refresh read it and treated "present but invalid"
    as "skip without bumping", so a leftover a failed delete left behind
    blocked the refresh of a plain fresh parse on every GET. Checkable: when a
    change adds a reader of a file, list every writer or cleaner of that file
    that is documented as best-effort or harmless-if-skipped, and for each ask
    what the new reader does with the leftover; then test by seeding the
    leftover (a restored copy of the deleted file) and asserting the reader's
    outcome, alongside the genuinely stale case that must still be refused.

45. **An exact comparison against a value re-derived from a producer that has
    changed since the stored copy was made** — PR #3835 passes 1-4 (#3829,
    `workspace/restructure.ts` `parseTitlesPairWithState`): state.json holds
    chapter titles as the parser wrote them at import; the check compared each
    to what TODAY's parser produces, position by position. Every unversioned
    parser change (entity decoding, heading normalisation) then read as a
    mismatch, and the refusal's advice (re-parse) destroys analysis, cast and
    audio, so a never-restructured book would have been locked out of work that
    was harmless before. Checkable: for every guard that recomputes a value and
    compares it to a stored one, has the producer changed since the oldest
    stored copy (git log on the producer, and whether its version constant
    moved)? If so, equality is not a safe test; and extending a shared check to
    a new caller widens who is exposed to that drift, so measure it on a book
    in an older producer's form before reusing it. Four rounds of rule changes
    did not settle which weaker test is safe; that design is tracked in #3837.
46. **An app-made placeholder compared as identity evidence** — PR #3835 passes
    2-3 (#3829, same function): the parser's fallback title for an untitled
    section is `Chapter N` (a position number), and a real heading elsewhere can
    carry the same text, so an untouched import was read as a reorder. A
    special case for the placeholder (exempt it at its own position) also
    exempted a real heading moved onto that position that happened to read
    `Chapter 1`. Any placeholder the app invents (a position-numbered title, a
    default name, a synthesized id) collides with real data of the same text.
    Checkable: for each value used as evidence of which item something is, can
    the app itself have produced it? If so, test a fresh, untouched import with
    the placeholder equal to a real value elsewhere (must pass), and the case
    where a real value of that same text sits on the placeholder's position
    (must still be caught), before trusting any exemption.

47. **A skip honoured where a value is tested as the subject, but not where the
    same value is read as evidence about another item** — PR #3835 pass 4
    (#3829, `parseTitlesPairWithState`): `titleOverridden` (the user's own
    wording) exempted a chapter from being checked, but that chapter's title
    was still used as the "home" of a parse title when deciding whether ANOTHER
    chapter had moved, so renaming a real "Chapter 1" heading made an app-made "Chapter 1" elsewhere look like that heading moved, and a book that was never restructured was refused.
    Any exemption (overridden, synthesized, excluded, unreadable) has two roles
    to decide: is the item itself checked, and may its value vouch for or
    against its neighbours? Checkable: for each skip in a comparison loop,
    find every other place the skipped item's value is read, and ask whether
    the skip should apply there too. Then test a skipped item next to a moved
    one, in both orders.

### Keeping the catalogue current

A catalogue written once is a snapshot that decays, and the next new shape
gets transmitted nowhere — which is the problem this file exists to solve.
So it gets an explicit trigger and owner rather than good intentions:
**when a gate round surfaces a defect shape the catalogue above does not
already name, appending it here is part of that round's fix work**, in the
same PR, on the same footing as any other chore the work made owed. This is
a living file with a maintenance rule, not an appendix.

## The finding contract

**Per finding, require all three:**
- a **severity**;
- a **`file:line`**;
- a **concrete failure scenario** — specific inputs or state that produce a
  specific wrong output. "This could be fragile" is not a finding; show the
  break, don't gesture at a risk.

**Split correctness bugs from cleanup nits — mandatory, not a nicety.**
Every finding is labeled one or the other. This split is what the re-review
trigger in [`findings-triage.md`](findings-triage.md) reads: ≥1 actual
correctness bug re-triggers a review once fixed and pushed; a pass with only
cleanup-only findings, or none, does not.

**"Found nothing" is a valid, expected outcome.** A reviewer that believes it
must produce findings to justify its own dispatch will manufacture them. A
manufactured finding costs a needless re-review round and erodes trust in
every report after it.

## Post your own findings before returning

**Write that body file to the OS temp directory, NEVER inside the repository.**
A scratch file in the worktree dirties `git status --porcelain`, and the
dispatching session treats any delta as a gate failure — so a clean review
would be reported as a failed one, *after* you had already posted it. Use
`$env:TEMP` / `$TMPDIR` (Node: `os.tmpdir()`), and delete it when done.

Post one comment on the PR with `gh pr comment <number> --body-file <file>`
BEFORE returning your report. Do not hand it to the dispatching session to
publish — nothing would compare what it posts against what you found.

**The PR number and head SHA come from the dispatch prompt.** Do not infer
them: `gh pr view` on the wrong branch, or in a worktree whose HEAD moved,
posts a review onto someone else's PR. If the prompt did not give you both,
stop and say so rather than guessing — a review comment on the wrong PR cannot
be quietly withdrawn.

Heading: `## PR review — pass N (head <sha>, depth <level>)`. The head SHA is
required; without it the comment is uninterpretable once the branch moves.

If you found nothing, post anyway with `### ✅ No findings`. A record that
cannot distinguish "reviewed and clean" from "never reviewed" is not a record.

**Modify no tracked file.** Posting a comment is not a modification; editing,
committing, or staging anything is. The dispatching session compares
`git rev-parse HEAD` and `git status --porcelain` before and after this pass,
and any delta is reported as a gate failure.
