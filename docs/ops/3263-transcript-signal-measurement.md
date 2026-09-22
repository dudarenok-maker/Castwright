# Castwright#3263 — the transcript assignment signal, measured at scale

**Date:** 2026-09-22 · **Box:** the repo owner's Windows dev machine ·
**Motivated by:** PR #3358 review pass 1, finding F1 (blocking).

This doc is the evidence base for `guard-worktree-write.mjs`'s assigned-root
resolution. It replaces the 4-transcript, single-turn corpus behind
[`3263-transcript-extraction-feasibility.md`](3263-transcript-extraction-feasibility.md)
and [`3263-fix-agent-dispatch-transcript-findings.md`](3263-fix-agent-dispatch-transcript-findings.md)
as the justification for what the guard does, and it corrects two claims —
one from each side of the review.

## Why a new measurement

PR #3358 shipped H2 ("the first absolute path in the most recent `sdk`/`user`
prompt turn") as a preference over the `cwd`-derived root, justified by 3/3
hits on the answerable subset of a 7-transcript corpus. The review pass scored
it against every transcript on the box and reported that it picked the primary
checkout **499/499 times (100%)** — i.e. that the change inverted the guard.

Both figures are artifacts of their corpora, and neither is what the guard
should be judged on:

- **3/3** came from 4 single-turn transcripts. The source doc's own
  `## Not tested` section named multi-turn briefing as an untested gap; the
  number was promoted into a shipping argument with that caveat dropped.
- **499/499** counted only extractions that resolve under a **currently live**
  worktree. Historical transcripts overwhelmingly name worktrees that have
  since been torn down, so that filter discards almost every correct pick and
  keeps the primary-checkout ones (the primary is the one root that never goes
  away). Re-run with roots classified by *shape* rather than by liveness, the
  same population yields 527 worktree picks and 465 primary picks, not 0 and
  499.

The mechanism the review identified is nonetheless real, and it is what this
measurement confirms and quantifies.

## Method

- **Population:** every `…\<project>\<session-id>\subagents\agent-*.jsonl`
  transcript under `%USERPROFILE%\.claude\projects` — 1,594 files.
- **Ground truth, independent of any brief parsing:** the checkout root each
  agent **actually wrote to**, taken as the modal root across that agent's own
  `Write`/`Edit`/`MultiEdit`/`NotebookEdit` `tool_use` calls. Transcripts with
  no writes, or with no root holding ≥80% of them, are excluded as ambiguous.
  **715 transcripts** survive that filter.
- **Scoring:** each candidate rule is run over the raw transcript and its
  answer compared to the ground truth. `knownRoots` is reconstructed per
  transcript as every checkout root appearing anywhere in it, standing in for
  the set that was live at dispatch time.
- Probes are throwaway; the numbers below are reproducible from this method
  against the same on-box corpus. They are **not** a CI-checkable artifact —
  the transcripts are per-machine and not in the repo.

### The ground truth's one weakness, stated up front

"Where the agent wrote" is not always "where the agent was assigned". In at
least 3 scored transcripts the agent wrote into the primary checkout against a
brief that assigned it a worktree — #3044's own incident shape. Those count as
errors against a rule that correctly names the worktree, so every precision
figure below is a **floor**, not a ceiling.

## Result 1 — `cwd` is the wrong signal, by a wide margin

| what the recorded `cwd` named | count | share |
|---|---|---|
| the root the agent actually wrote to | 48 | 6.7% |
| **the primary checkout, while the agent wrote in a worktree** | **626** | **87.6%** |
| a worktree, while the agent wrote elsewhere | 41 | 5.7% |

This is the single most important number here, and it reframes the whole
feature. `cwd` is not a conservative baseline that a transcript signal is
layered on top of — on this box it is the **wrong answer in 87.6% of
dispatches**. The #3263 shape is the dominant shape, not an edge case, which
is also why CLAUDE.md records that `fix-agent` "currently cannot be used for
any worktree the dispatching session's `cwd` is not already inside."

## Result 2 — polarity is what makes the transcript signal work

Scored against the 715-transcript ground truth:

| rule | fires | correct | wrong: primary | wrong: other worktree | precision |
|---|---|---|---|---|---|
| H2 as shipped in #3355 | 523 | 400 | **123** | 0 | 76.5% |
| H2, discarding a primary-rooted pick | 394 | 394 | 0 | 0 | 100.0% |
| **newest-first scan, skipping primary-rooted and unknown-rooted candidates** | **658** | **652** | **0** | **6** | **99.1%** |
| same, anchored to the FIRST turn instead of the newest | 658 | 651 | 0 | 7 | 98.9% |

**Every one of H2's 123 errors named the primary checkout, and none named a
wrong worktree.** The cause is polarity, not noise: this repo's briefing
convention leads with the prohibition —

> One finding, one fix, one paired regression test. Repo: `dudarenok-maker/Castwright`,
> primary checkout `C:\Claude\Projects\Audiobook-Generator` — do NOT edit files
> in the primary checkout and do NOT touch any other `C:\Claude\Projects\wt-*`
> worktree.

— so "first path wins" reads the explicitly forbidden root as the assigned
one. The better the brief warns the agent off the primary checkout, the more
confidently a polarity-blind rule hands it over. Skipping primary-rooted
candidates is not a tuning constant; it is the invariant
`guard-worktree-write.mjs` already asserts at `PRIMARY_CHECKOUT_ROOT`'s
declaration.

Skipping alone would only convert those 123 wrong picks into no-picks (row 2:
100% precise but fires on 55% of dispatches). Continuing the scan — through the
rest of the turn and on into earlier turns — recovers coverage to 92% at a cost
of 6 wrong picks. **That trade was the operator's call and was taken
deliberately**, on the reasoning that a guard that declines to fire on 45% of
dispatches pushes work onto `implementer`, which carries no guard at all.

Requiring `knownRoots` membership *inside* the scan matters for the same
reason: it discards the literal `C:\Claude\Projects\wt-*` glob the brief itself
contains (it resolves under no real root) instead of returning it.

## Result 3 — the six residual errors, itemised

Of the 6 wrong-worktree picks in the shipped rule:

1. **1 is an artifact of this measurement**, not of the guard: the
   reconstructed `knownRoots` contained the `C:\Claude\Projects\wt-` glob
   fragment. The real `listKnownCheckoutRoots()` reads `git worktree list`, so
   it can never contain it. Re-scored against the shipped function with a
   git-sourced root list this case disappears (631/636, 99.2%).
2. **3 are the rule being right and the agent being wrong** — the agent wrote
   into the primary checkout against a brief that assigned it a worktree. The
   ground truth marks these as misses; the guard would have denied exactly the
   write that should have been denied.
3. **2 are genuine.** A later prompt turn named another PR's worktree — one a
   `pr-review-gate` skill preamble, one a pass-3 re-review brief referencing a
   different PR's tree — and the newest-first scan took it.

Those last 2 are the accepted residual risk. In that shape the guard both
wrongly denies the true tree and wrongly allows the mis-extracted one;
fail-open covers "found nothing", never "found the wrong known root". It is
asserted as a test (`KNOWN LIMIT: a confident pick of the WRONG known
worktree…`) so that closing it later is a deliberate act, and it is why the
manual before/after `git status --porcelain` check stays in CLAUDE.md.

## What did not change

- The fail-open contract. No `transcriptPath`, an unreadable file, a wholly
  malformed one, or a scan that finds no known non-primary root all land on
  exactly the pre-existing `cwd`-derived behaviour.
- The Bash/PowerShell check's coarseness (#3044's documented decision).
- Whether a denial should be terminal — parked, tracked separately.
