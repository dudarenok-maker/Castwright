---
name: pr-review-gate
description: Use when preparing to ship a PR, staging one for merge, or running CLAUDE.md's before-shipping "Independent PR review" step. This is the full PR review runbook — preconditions, the docs-only exemption, the review-depth ladder, dispatching the reviewer, posting the pass comment, findings triage, the re-review loop, and issue verification at PR creation. For choosing a subagent's model tier outside a PR review, or the spec/plan adversarial-review loop, consult `model-routing` instead. Dispatches a non-fork subagent at the routing table's Premium tier carrying an adversarial reviewer brief — a findings report only, never auto-applied.
---

# PR review gate

The mandated mechanism for [CLAUDE.md's before-shipping step
10](../../../CLAUDE.md#before-shipping-checklist) — this file is the full
spec for what this repo expects of a PR review: the procedure the shipping
session runs, the rubric the reviewer applies
([`references/reviewer-brief.md`](references/reviewer-brief.md)), what
happens to the findings
([`references/findings-triage.md`](references/findings-triage.md)), and the
durable record each pass leaves on the PR itself. `model-routing` keeps the
model-tier routing table and the spec/plan adversarial-review loop; this file
owns everything PR-specific.

## When this fires

A PR is fully staged: implementation finalized, cloud `verify.yml` green (the
required status check on `main` — ops-2997 slimmed the local pre-push hook to
an instant scope-gated check, so `verify:fast:branch` passing is no longer the
enforcement signal; see CLAUDE.md "Commit gate"), every applicable
[before-shipping checklist](../../../CLAUDE.md#before-shipping-checklist)
item addressed (or explicitly marked not-applicable), and everything pushed.
Not on an earlier, incomplete push.

## Exemption

A docs-only PR — changed-file set entirely under `docs/**`, root-level
`*.md`, or `.github/*.md` (the same file-set test
[CONTRIBUTING.md's "Doc-only PR fast-path"](../../../CONTRIBUTING.md#doc-only-pr-fast-path)
already uses for the `verify.yml` `paths-ignore` skip) — is exempt from this
gate entirely; no review pass runs.

Exempt does not mean silent: post a one-line exemption note on the PR naming
the file-set test that exempted it (see [The PR comment](#the-pr-comment)).
A large share of this repo's PRs are docs-only, so without the note the
durable record would be missing exactly where the volume is.

## Review depth

For every non-exempt PR, **review depth** scales with the PR's commit
type/scope, reusing CONTRIBUTING.md's existing commit-convention vocabulary
rather than a new classification:

- **`low`** — single-scope `chore`, `test`, `build`, `ci`, or `docs`. Usually
  mechanical with no user-facing behavior change; `docs` earns the tier by
  shipping no *product* behavior, **not** by being inert. A `docs(...)` commit
  can change instructions agents follow literally (`.clinerules/`,
  `.claude/skills/`, `AGENTS.md`), where a wrong instruction is a correctness
  bug with a blast radius — so that subclass is reviewed rather than waved
  through, and `low` buys it a narrower scope, not a lighter standard. Note
  also that "docs-type commit" and "docs-only **file set**" are different
  tests, and only the second one [exempts](#exemption) a PR from the gate
  entirely. PR #2385 was exactly this case — a `docs(...)` PR touching
  `.clinerules/`, whose depth had to be argued by analogy because `docs`
  appeared in no tier, and whose three review passes then found **nine**
  correctness bugs in the instructions themselves.
- **`medium`** — single-scope `feat` or `fix`.
- **`high`** — `refactor`, `perf`, or any multi-scope PR (CONTRIBUTING.md's
  own "use sparingly" multi-scope guidance already flags these as
  higher-risk) — today's unchanged default.

A PR whose commits mix types takes the highest tier any single commit would
earn on its own (e.g. one `fix` commit + one `refactor` commit → `high`).
`ultra` is never auto-selected here — it is billed and requires explicit user
opt-in (`/code-review ultra`, or the user asking for it by name), per the
Workflow tool's own rule.

**"Depth", not "effort", and the distinction is load-bearing.** This ladder is
prompt-stated scope — how much of the PR the reviewer is asked to interrogate.
It is *not* the model's reasoning-effort setting, which is pinned at `xhigh` on
the `pr-reviewer` role and does not vary by PR. Both were called "effort" until
2026-08-14, so a reader meeting `effort: xhigh` in a definition and `effort:
low` in a comment header had no way to tell them apart. Repo-wide, **`effort`
now means only the model setting**; this axis is `depth`.

**Comments posted before 2026-08-14 use the old noun for this same thing.**
Seven of them, across PRs #2339, #2337 and #2350, read `effort <level>` in
their header. They are historical records and are not rewritten.

State the level explicitly in the dispatch prompt so the subagent calibrates
depth instead of guessing.

## Dispatch

- **Premium tier** (per [`model-routing`'s routing
  table](../model-routing/SKILL.md#routing-table)), **non-fork**. A fork
  inherits the dispatching session's own context — its framing, its
  reasoning, its blind spots — which is the opposite of independent review. A
  fork also always runs on the dispatching session's model, ignoring model
  routing entirely; a Premium-tier review needs a real non-fork dispatch to
  land on Opus.
- **Fresh context** — not a continuation of any earlier pass in this session.
- **Never auto-apply.** The subagent edits nothing (verified by [the tree
  check](#the-tree-check), not trusted). It returns a findings report,
  triaged by hand per [Triage](#triage). If the user runs `/code-review`
  themselves instead, the same bar holds: no `--fix`. `--fix` applies
  whatever the pass surfaced wholesale, and there's no per-finding confidence
  filter to gate it on, so triage happens by hand instead. This is a
  working/branch-diff review — not the separate `/review` PR-comment slash
  command, and not the `code-review@claude-plugins-official` plugin command
  either: that plugin reviews a GitHub PR, discards every finding below 80%
  confidence, and posts a public comment on the PR instead of returning a
  report to triage.
- **The reviewer reads the rubric itself.** The dispatch prompt points it at
  [`references/reviewer-brief.md`](references/reviewer-brief.md) **by path**
  and instructs it to read the file in full before it starts — not a
  paraphrase retyped into the prompt. Triage rules for what comes back are in
  [`references/findings-triage.md`](references/findings-triage.md).
- **Why not invoke the built-in `code-review` skill directly**: it is
  user-invocable only — `Skill(skill: "code-review")` fails with "cannot be
  used with Skill tool due to disable-model-invocation", and a dispatched
  subagent hits the same wall, so "dispatch an agent and have it invoke the
  skill" is not a workaround. It remains available and is the *better*
  reviewer: the user may type `/code-review <level>` at any point, and when
  they do it supersedes the agent pass for that round.
- **Never report the gate as having run when it did not.** If the agent pass
  was substituted, or skipped, say so plainly in the user-facing summary.

### Per-agent mapping

The properties above are stated as reviewer *capabilities*, not one agent's
tool names, so the mechanism ports:

- **Claude Code** — a non-fork `Agent` dispatch at the routing table's
  Premium tier.
- **Cline** — dispatches subagents via `spawn_agent`, and they start cold
  (recorded in `docs/testing/agent-skill-resolution-probe.md`). **That is not
  sufficient on its own.** Cline cannot select its subagent's model — the
  probe records `CLINE_TIER_SELECTABLE: no`, observed running
  `deepseek-v4-flash` — so a Cline-run pass is independent but **flash-tier**,
  and this section's Premium requirement is unmet. Two conditions, both
  required, and the tier one is the easier to forget because independence is
  the property people check:

  | Condition | Cline today |
  |---|---|
  | Fresh context, not a fork | yes (self-reported, not independently reproduced) |
  | Premium tier | **no** |

  So a Cline pass is recorded as a **flash-tier independent pass**, never as
  this gate. It is worth running and worth reading; it does not discharge the
  merge gate, and a summary that calls it "the review gate" is a false
  completion claim. Same outcome if `CLINE_SUBAGENT_COLD` ever reads anything
  but `yes` — then it is a self-run as well as untiered.
- **Any agent that genuinely cannot dispatch** runs the rubric in-session and
  reports it as a **self-run pass, never as the independent gate** — the same
  rule that forbids reporting a gate as having run when it did not.

## The tree check

Before dispatching, capture:

    git rev-parse HEAD && git status --porcelain

Re-run both after the pass returns. **Any delta is a gate failure** — report
it as such, do not absorb it. This is the one behavioural property of the
pass verifiable from outside it, so it is the one that gets verified. The
guard test cannot check it, and does not claim to.

**The reviewer's `tools:` list is not what stops it writing**, and was
deliberately not used for that. Stripping `Write` from the role would make
this skill's own mandated path — `gh pr comment --body-file <file>`, which
requires creating a file — run through a Bash heredoc instead, i.e. it would
make routing around the restriction the normal, unremarkable happy path.
`Bash` can write files regardless. The prohibition stays prose, and the tree
check above is its enforcement.

## The PR comment

Every pass posts one summary comment on the PR the moment it returns,
**before any fixes**, so the thread reads as found → fixed → re-verified in
order.

Format, following the three comments on [PR
#2320](https://github.com/dudarenok-maker/Castwright/pull/2320):

```
## PR review — pass N (head <sha>, depth <level>)

Scope: <files reviewed> · verified: <suite counts, typecheck> before
adversarially probing <what>.

### 🔴 Blocking — <claim>
<concrete repro: exact input → wrong output, file:line>

### 🟠 Significant — <claim>
### 🟡 Minor
### ✅ What is solid
### Verdict
```

Two elements are required rather than stylistic:

- **the head SHA in the heading** — it is what makes a comment interpretable
  months later, when the branch has moved on;
- **on a re-review, each prior finding's disposition** (`VERIFIED RESOLVED`,
  or still open and why), so the thread is a chain rather than three
  unrelated opinions.

Severity maps onto the split [Triage](#triage) reads: 🔴 and 🟠 are
correctness bugs and re-trigger a pass once fixed and pushed; 🟡 is cleanup —
fixed this round, but not a re-trigger.

### The reviewer posts its own comment

The **reviewer posts its own comment directly** — `gh pr comment <number>
--body-file <file>` — one hop, before returning its report to the dispatching
session. Nothing sits between finding and record: the session does not relay
it, and does not compare what gets posted against what the reviewer found,
because nothing sits in between to compare.

The reviewer's boundary is a prohibition, not a capability limit: **it must
not modify tracked files.** That is enforced by [the tree
check](#the-tree-check), not trusted.

The session then confirms the comment actually landed (`gh pr view <number>
--json comments`) before starting triage. A pass that returned a report but
posted nothing is reported as a pass that did not complete.

### A pass that finds nothing still posts

"Found nothing" is an explicitly valid outcome, so it gets the same header
and a `### ✅ No findings` body. Without this, the record cannot distinguish
*reviewed and clean* from *never reviewed* — the single distinction the whole
record exists to preserve.

For the same reason, a docs-only PR — exempt from the pass entirely, per
[Exemption](#exemption) — posts a one-line exemption note naming the
file-set test that exempted it. Absence of a review becomes a recorded fact
rather than a silence.

**Re-review comments state deltas only** — each prior finding's disposition,
plus anything new. They do not re-list the solid items. Three passes plus fix
commits is already the cap; re-listing would make the thread unreadable at
exactly the point it matters most.

**Standing authorization.** Posting to a public PR is an outward-facing
action. The repo owner has authorized it as a standing part of this process,
recorded here, so the agent posts each round without pausing to ask.

## Triage

The full rubric for what the reviewer checks and how it must report a
finding is [`references/reviewer-brief.md`](references/reviewer-brief.md).
What happens to what comes back — the fix-in-this-round rule, the defect /
chore / taste seam, the void deferral reasons, the design-pass carve-out, and
one dispatched fix agent per finding with one paired test — is
[`references/findings-triage.md`](references/findings-triage.md). Not
restated here.

## Re-review trigger and loop cap

- **Re-review trigger**: only when the initial pass surfaced ≥1 finding that
  is an actual correctness bug (wrong behavior, crash, security issue — not a
  reuse/simplification/efficiency-only cleanup nit). Fixing and pushing those
  re-triggers a pass. If the initial pass came back empty, or surfaced only
  cleanup-only findings, fix-and-push (or push nothing) does **not**
  re-trigger a re-review — re-running it in that case just burns tokens for
  no new signal. This mirrors the spec/plan loop's severity-gated shape (see
  [`model-routing`'s adversarial-review
  loop](../model-routing/SKILL.md#mandatory-adversarial-review-specs--plans)),
  rather than firing on every push. Re-review re-derives the review depth
  from the PR's current commit set (per [Review depth](#review-depth))
  rather than reusing the initial pass's tier — a fix commit can raise the
  tier the same way any other commit would.
- **Loop cap**: 2 re-review rounds, same numeric cap as the spec/plan loop
  (initial pass + up to 2 re-review rounds, 3 total). Still tripping the
  trigger after that stops the loop and hands it to the user — do not keep
  looping automatically past the cap.
- **Judgment-call carve-out**: a finding that requires a decision only the
  user can make suspends the fix-and-re-review loop and routes through the
  normal ask-first behavior in [CLAUDE.md's "Think before
  coding"](../../../CLAUDE.md#think-before-coding) — shared with the
  spec/plan review loop, see [`model-routing`'s judgment-call
  carve-out](../model-routing/SKILL.md#judgment-call-carve-out-shared-by-both-review-loops).

## Issue verification at PR creation

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

## Merge

Once triage is closed — every finding fixed and pushed, or the sole
design-pass carve-out routed to its own issue naming the decision owed — and
any re-review round the trigger required has landed clean, merge per
[CLAUDE.md's Branching workflow → Opening the
PR](../../../CLAUDE.md#opening-the-pr) ("Create a merge commit"; squash/rebase
disabled at the repo level; head branch auto-deleted on merge).
