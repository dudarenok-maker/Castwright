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
