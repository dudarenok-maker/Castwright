---
name: model-routing
description: Use when choosing which model tier to dispatch a subagent/Workflow agent to, when deciding whether a spec/plan needs adversarial review before the user approves it, when a PR is fully staged and ready for independent review, or when filing/verifying the GitHub issue link on a new PR. Reference for the full model-routing table, escalation ladder, and review-gate mechanics.
---

# Model routing & review gates

Full reference for [CLAUDE.md "Model routing"](../../../CLAUDE.md) — the
quick table lives there; this file is the complete spec. Design rationale:
[docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md](../../../docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md).

## Routing table

Applies to non-fork subagent/Workflow dispatch, and as guidance to the main
session's own model. **Does not apply to forks** — the `Agent` tool's own
schema states a fork "always runs on your model — a `model` override is
ignored." Cheap high-volume fan-out intended for the Haiku tier must use a
non-fork subagent, or the routing instruction is silently void.

| Tier | Model | Selected for |
|---|---|---|
| Cheap | Haiku 4.5 | Mechanical search-and-report subagents, boilerplate/scaffolding, running commands and summarizing output, single well-specified bug fixes with a clear repro and no design decisions, high-volume parallel fan-out **via non-fork subagents** |
| Default | Sonnet 5 | Everything else — standard feature work, most debugging, most non-fork subagent dispatch, code review, the main session itself |
| Premium | Opus 4.8 | Ambiguous specs needing judgment, architecture/design tradeoffs with multiple viable options, adversarial review passes (below), cases where Sonnet visibly got stuck (2 failed attempts), irreversible/high-blast-radius decisions |
| Reserved | Fable 5 | Never auto-selected. Explicit user approval only, per task |

## Escalation (subagent dispatch)

A subagent that fails twice on its assigned tier is auto-re-dispatched one
rung up — Haiku → Sonnet, Sonnet → Opus — without asking first; report the
escalation after the fact, not before. One rung at a time: a failing Haiku
dispatch escalates to Sonnet, not straight to Opus.

**"Fails" means:** the dispatch terminates with a surfaced error, OR its
returned result is rejected by your own follow-up check against the task's
stated acceptance criteria (tests still red after a claimed fix, output
doesn't match the request) — not merely "produced an answer you'd have
phrased differently."

This is silent/non-interrupting by design: subagent dispatch is cheap and
disposable, unlike the session-level case below.

## Session-level drift (main session's own model)

You cannot switch your own running model. When the current unit of work,
judged against the routing table above, matches a different row than the
model the active session is actually running, say so explicitly and ask
whether to switch — do not silently work through it on the "wrong" tier.

**"Drifted" means:** the current unit of work now matches a different table
row than the one the active session model sits on, by the same criteria used
for subagent dispatch above.

## Mandatory adversarial review (specs & plans)

- **Trigger**: every non-trivial spec (`brainstorming`) and plan
  (`writing-plans`). "Non-trivial" reuses `CLAUDE.md`'s existing "Branching
  workflow" trivial-work bar (typo, dead-comment removal, single-line doc
  tweak) — not a separate, softer definition. Trivial/direct-to-main work is
  exempt.
- **Mechanism**: a real invocation of the `assumption-checker` skill, never a
  paraphrase of its posture.
  - If the active session is already Opus-tier: invoke the skill directly
    in-session via the `Skill` tool.
  - Otherwise: dispatch an Opus-tier `Agent` subagent and instruct it to
    invoke the `Skill` tool itself against the artifact.
  - Either way, present the skill's actual returned output — its evidence
    tagging (`Confirmed`/`Contradicted`/`Asserted`/`Unverifiable`) and
    load-bearing tagging (`Critical`/`Significant`/`Minor`) — not a
    hand-summarized version of it.
- **Timing**: findings are presented alongside the spec/plan at the same
  review checkpoint — not before the user sees it, not after they've
  separately approved it.
- **Re-review trigger**: ≥1 assumption rated `Critical` AND `Contradicted`,
  OR ≥2 rated `Significant` AND `Contradicted`. A correctly-flagged-but-
  confirmed-true assumption is not a defect and does not trigger a loop.
- **Loop cap**: initial pass + up to 2 re-review rounds (3 total). Still
  tripping the threshold after that stops the loop and hands it to the user
  — do not keep looping automatically past the cap.
- **Judgment-call carve-out**: see below.

## Mandatory independent review (PRs)

- **Sequence**: finalize implementation → local `npm run verify` → `gh pr
  create` → work through `CLAUDE.md`'s before-shipping checklist item by
  item (each done or explicitly marked not-applicable), committing and
  pushing along the way → once every applicable item is addressed and
  everything is pushed, that is "fully staged" and this review triggers on
  that state (not on an earlier, incomplete push).
- **Mechanism**: the `code-review` skill at `high` effort, run once fully
  staged, **without** `--fix` — produces a findings report only. (`--fix`
  applies whatever the pass surfaced wholesale; there's no per-finding
  confidence filter to gate it on, so triage happens by hand instead — see
  Findings handling.) This is the `code-review` *skill* — a working/branch-
  diff tool — not the separate `/review` PR-comment slash command.
- **Findings handling**: triage the report by hand. Clear-cut findings
  (unambiguous bug, obvious dead code, a straightforward CLAUDE.md
  violation) get fixed directly, committed, and pushed. Findings that turn
  on a judgment call route through the carve-out below instead of being
  auto-applied.
- **Re-review trigger**: only when the initial pass surfaced ≥1 finding
  that is an actual correctness bug (wrong behavior, crash, security issue —
  not a reuse/simplification/efficiency-only cleanup nit). Fixing and
  pushing those re-triggers a pass. If the initial pass came back empty, or
  surfaced only cleanup-only findings, fix-and-push (or push nothing) does
  **not** re-trigger a re-review — re-running it in that case just burns
  tokens for no new signal. This mirrors the spec/plan loop's severity-gated
  shape (above), rather than firing on every push.
- **Loop cap**: 2 re-review rounds, same numeric cap as the spec/plan loop
  above, same trigger shape now too — a severity threshold, not "any push."
- **Judgment-call carve-out**: see below.

## Judgment-call carve-out (shared by both review loops)

A finding that requires a decision only the user can make (a genuinely
ambiguous or load-bearing assumption) suspends the fix-and-re-review loop
and routes through the normal ask-first behavior in `CLAUDE.md`'s "Think
before coding" — it does not get silently resolved just to keep the loop
moving. This is the same failure mode in both loops: an automated loop
mistaking a decision for a defect.

## PR-gate issue verification

- **Trigger**: every `gh pr create` for non-trivial work, including
  bug-shaped work.
- **Check**: the PR body must contain `Closes #NN` or `Refs #NN` referencing
  an existing GitHub issue, outside of any inline-code/fenced-code span (a
  backtick-wrapped `` `Closes #NN` `` does not actually auto-close on
  GitHub — write it plain).
- **Missing case**: auto-file a new issue capturing the work, then add
  `Closes #NN` to the PR body — proceed without pausing to ask, in every
  case including bug-shaped work (a deliberate, explicit override of
  `CLAUDE.md`'s general "user files bugs" convention, scoped to this one
  gate). Label per `CONTRIBUTING.md`'s actual two-shape convention:
  - **Bug-shaped** (fixing existing broken behavior, no design decision):
    standalone `bug` label, plain descriptive title. No `area:`/`type:`/
    `moscow:`.
  - **Backlog-shaped** (new/changed behavior): `area:<prefix>` +
    (`type:feature` or `type:chore`). `moscow:` left unset for the user.
    Use `type:chore` when the work matches this repo's commit-type-`chore`
    shape (codegen, version bumps, tidy-up — no user-facing behavior
    change); `type:feature` otherwise.
- **Timing**: at PR creation — distinct from, and prior to, the mandatory
  independent review above, which reviews code + docs combined once the PR
  (and its issue link) already exist.
- **Mechanical backstop**: `.github/workflows/pr-issue-link.yml` fails the
  PR check if neither `Closes #\d+` nor `Refs #\d+` appears in the body
  (outside code spans) — the one gate in this file with a real, external
  enforcement, not just this convention. It does not check labeling or
  whether the auto-file step above ran correctly, only that some issue
  reference exists.
