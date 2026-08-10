---
name: pr-review-gate
description: Use when a PR is fully staged and ready for its mandatory independent review, or when running CLAUDE.md's before-shipping "Independent PR review" step. Dispatches a non-fork, Premium-tier subagent carrying an adversarial reviewer brief — a findings report only, never auto-applied.
---

# PR review gate

The mandated mechanism for [CLAUDE.md's before-shipping step
10](../../../CLAUDE.md) and
[`model-routing`'s "Mandatory independent review
(PRs)"](../model-routing/SKILL.md#mandatory-independent-review-prs) — that
file owns the effort ladder, the exemption, the re-review trigger, and the
loop cap; this file is the reviewer brief itself, not a restatement of the
mechanics. Read it there, not here.

## When this fires

A PR is fully staged: implementation finalized, `verify:fast:branch` green,
every applicable before-shipping checklist item addressed (or explicitly
marked not-applicable), and everything pushed. Not on an earlier, incomplete
push.

## Dispatch

- **Premium tier** (per the routing table), **non-fork**. A fork inherits
  the dispatching session's own context — its framing, its reasoning, its
  blind spots — which is the opposite of independent review. A fork also
  always runs on the dispatching session's model, ignoring model routing
  entirely; a Premium-tier review needs a real non-fork dispatch to land on
  Opus.
- **Effort level** is passed in by the caller, not decided here — `low`,
  `medium`, or `high`, derived from the PR's commit type/scope per
  `model-routing`'s ladder (`ultra` is opt-in only, never auto-selected).
  State the level explicitly in the dispatch prompt so the subagent
  calibrates depth instead of guessing.
- **Never auto-apply.** The subagent edits nothing. It returns a findings
  report, triaged by hand per `model-routing`'s "Findings handling". (If the
  user runs `/code-review` themselves instead, the same bar holds: no `--fix`.)

## The brief to carry into the subagent prompt

**Framing: this is a gate, not a collaborator.** The reviewer's job is to
find what's wrong with the change, not to appreciate it. Don't soften
findings to be encouraging, and don't reward effort.

**Findings only.** Never edit the tree, never apply a fix, never run
`--fix`. Return a report for the dispatching session to triage.

**Feed it the load-bearing claims, not just a diff.** Name the specific
files, the exact measured numbers, and the technical assertion the change
rests on — the things a shallow pass would take on faith rather than check.
A reviewer handed only "review this PR" burns its budget re-deriving context
the dispatching session already has; a reviewer handed the claims can spend
that budget attacking them instead.

**Say what's already mutation-verified**, and by what proof — e.g. "guard X
was confirmed to fail before the fix and pass after." That tells the
reviewer which ground is covered so it hunts elsewhere instead of re-proving
work that's already done.

**Per finding, require all three:**
- a **severity**;
- a **`file:line`**;
- a **concrete failure scenario** — specific inputs or state that produce a
  specific wrong output. "This could be fragile" is not a finding; the
  reviewer must show the break, not gesture at a risk.

**Split correctness bugs from cleanup nits — mandatory, not a nicety.**
Every finding is labeled one or the other. This split is exactly what
`model-routing`'s *Re-review trigger* reads: ≥1 actual correctness bug
re-triggers a review once fixed and pushed; a pass with only cleanup-only
findings, or none, does not. A report without this split cannot drive that
loop — the dispatching session would have to re-derive it by re-reading
every finding, which defeats the point of a structured report.

**"Found nothing" is a valid, expected outcome — say so explicitly in the
brief.** A reviewer that believes it must produce findings to justify its
own dispatch will manufacture them. A manufactured finding costs a needless
re-review round and erodes trust in every report after it.

## After the pass returns

Triage per `model-routing`'s *Findings handling* and *Re-review trigger* —
not restated here. **Never report the gate as having run when it did not.**
If the user's own `/code-review` superseded this pass for the round, or the
pass was substituted or skipped for any other reason, say so plainly in the
user-facing summary rather than letting the checklist item read as
satisfied.
