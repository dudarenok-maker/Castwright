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
11. **A fixture that invents an external tool's output contract** — the test
    oracle and the code under test share the same wrong belief about a
    third-party format, so a red-before/green-after test proves nothing: both
    states agree with the fixture, and the fixture disagrees with reality
    (PR #2795 — `npm audit --json`'s real `via[]` shape).

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
