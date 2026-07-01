# Model routing & review gates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed the eleven governance decisions from `docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md` into this repo's actual working instructions — a model-routing table + skill, mandatory review-gate documentation, task-tracking/checkpoint rules, and one real mechanical enforcement hook — so they hold by default instead of requiring a repeated ask.

**Architecture:** Pure documentation + one small Node validator + one GitHub Actions workflow + one regression-plan entry. No application code, no new dependencies. `CLAUDE.md` gets four targeted edits (new "Model routing" section, before-shipping-checklist + "Opening the PR" amendments, new "Task tracking & checkpoint flagging" section). A new project skill (`.claude/skills/model-routing/SKILL.md`) holds the full routing table + review-gate mechanics, following the existing `.claude/skills/run-app/SKILL.md` pattern. Decision 11's mechanical check (`pr-issue-link.yml`) mirrors the existing `pr-title-lint.yml` shape exactly: a tiny pure-function validator (`scripts/validate-pr-issue-link.mjs`, tested under `scripts/tests/`, following `scripts/validate-commit-msg.mjs`) called from a workflow that writes the PR body to a temp file and invokes the validator via `node`. The workflow alone is advisory (a failing check doesn't block a merge); making it actually block merges needs a required-status-check ruleset on `main`, which is a repo security-setting change — Task 7 documents the exact command but does **not** execute it; it's a one-time step you run yourself.

**Tech Stack:** Markdown (CLAUDE.md, skill file), Node.js ESM (`node:test`, no extra deps — matches `scripts/validate-commit-msg.mjs`), GitHub Actions YAML (matches `.github/workflows/pr-title-lint.yml`).

## Global Constraints

- No application code, product-surface, or test-suite changes outside the files this plan names — this is a governance/process change only (spec "Out of scope").
- Reuse existing patterns exactly; do not invent new ones where a working one already exists in this repo: `scripts/validate-commit-msg.mjs` is the template for the new validator, `.github/workflows/pr-title-lint.yml` is the template for the new workflow, `.claude/skills/run-app/SKILL.md` is the template for the new skill's frontmatter shape, `docs/features/163-protected-push-guard.md` and `docs/features/166-github-issues-backlog-integration.md` (both filed under INDEX.md's "K. Cross-cutting invariants") are the template for the regression-plan entry — this is a tooling/CI-gate change of exactly their shape, not a product feature, so `docs/features/TEMPLATE.md`'s product-specific fields (URL surface, OpenAPI ops) are marked `n/a` rather than force-fit.
- Commit convention: `<type>(<scope>): <subject>` — types/scopes come from `CONTRIBUTING.md` (already read this session): scopes used in this plan are `docs`, `scripts`, `ci`. `chore` is the only no-scope type.
- `brainstorming` and `writing-plans` are global plugin skills and are **not** edited by this plan — only project-level `CLAUDE.md` / `.claude/skills/` content changes (spec "Embedding" § Mechanism note).
- **A `docs/features/` regression-plan entry IS required for this change** (Task 7): `CONTRIBUTING.md:337` — "Substantial / cross-cutting issues still get a numbered `docs/features/NN-*.md` regression plan" — and rewriting CLAUDE.md's core instructions plus adding an always-on CI gate affecting every future PR is cross-cutting, not small/localized. (An earlier draft of this plan misclassified it as small/localized to justify skipping the plan doc — caught by this plan's own mandatory adversarial review; see the design spec's sibling correction on Decision 11 for the parallel case.)
- **The required-status-check ruleset wiring is a manual, user-run step, not a plan task an implementing agent executes.** Per this harness's own action-care rules, "modifying system or security settings" is never auto-performed, even with prior authorization for the general approach — Task 7 documents the exact command; you run it yourself, after the PR merges.
- This work is itself subject to the PR-gate issue-verification rule it implements (Decision 9): the PR that ships this plan needs a linked GitHub issue (`Closes #NN`), filed with `area:ops` + `type:feature` (new, user/agent-facing process behavior — not a `chore`-shaped tidy-up) per the labeling rule this plan itself documents. Task 7 files it and opens the PR once Tasks 1–6 are complete and verified — matching the shape of this repo's own prior "final task ships" plans (e.g. the manuscript-analysis pill-gate plan's Task 11).

---

### Task 1: `CLAUDE.md` — new "Model routing" section

**Files:**
- Modify: `CLAUDE.md:71-72` (insert a new section between the end of "Working principles" and the start of "## Commands")

**Interfaces:**
- Produces: a `## Model routing` heading in `CLAUDE.md`, containing the 4-tier table (Cheap/Default/Premium/Reserved) and a pointer to `.claude/skills/model-routing/SKILL.md` (created in Task 2 — this task's link target does not exist until Task 2 lands, so Task 1's markdown link will 404 until then; that's expected mid-plan and is resolved by Task 2 in the same PR).

- [ ] **Step 1: Insert the new section**

Read the current boundary first to get exact surrounding text (already confirmed this session): line 71 is a blank line ending "### Goal-driven execution", line 72 is `## Commands`. Insert between them.

```
old_string:
- For multi-step tasks, state a brief plan with a verify check per step.
- Strong success criteria let you loop independently; weak ones ("make it
  work") force constant clarification.

## Commands

new_string:
- For multi-step tasks, state a brief plan with a verify check per step.
- Strong success criteria let you loop independently; weak ones ("make it
  work") force constant clarification.

## Model routing

Route non-fork subagent/Workflow dispatch (and, as guidance, the main
session's own model) by task shape — not by habit. Forks always inherit the
dispatching session's model; the table below does not apply to them.

| Tier | Model | Selected for |
|---|---|---|
| Cheap | Haiku 4.5 | Mechanical search-and-report subagents, boilerplate/scaffolding, running commands and summarizing output, single well-specified bug fixes with a clear repro and no design decisions, high-volume parallel fan-out via non-fork subagents |
| Default | Sonnet 5 | Everything else — standard feature work, most debugging, most non-fork subagent dispatch, code review, the main session itself |
| Premium | Opus 4.8 | Ambiguous specs needing judgment, architecture/design tradeoffs with multiple viable options, adversarial review passes (spec/plan and PR review — see below), cases where Sonnet visibly got stuck (2 failed attempts), irreversible/high-blast-radius decisions |
| Reserved | Fable 5 | Never auto-selected. Explicit user approval only, per task |

A subagent that fails twice on its assigned tier is silently re-dispatched
one rung up (Haiku → Sonnet, Sonnet → Opus) and the escalation is reported
after the fact — no need to ask first, since subagent dispatch is cheap and
disposable. A session-level tier mismatch (the current work matches a
different table row than the model the session is actually running) is
flagged instead of silently absorbed — I cannot switch my own running model,
so a drift gets an explicit sentence naming it and asking whether to switch.

**Mandatory review gates**, both using this table's Premium tier:
- Every non-trivial spec (`brainstorming`) or plan (`writing-plans`) gets a
  real `assumption-checker` pass before the user is asked to approve it.
- Every PR gets a `code-review` pass (`high` effort, no `--fix`) once fully
  staged, before merge.

Full escalation logic, the "fails"/"drifted" definitions, the review-gate
mechanics (in-session vs. subagent dispatch, re-review loop caps, the
judgment-call carve-out), and the PR issue-linkage gate live in
[`.claude/skills/model-routing/SKILL.md`](.claude/skills/model-routing/SKILL.md)
— this section is the quick-reference table, that file is the full spec.
Design rationale:
[docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md](docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md).

## Commands
```

- [ ] **Step 2: Verify the insertion**

```bash
grep -n "^## Model routing$" CLAUDE.md
grep -n "^## Commands$" CLAUDE.md
```

Expected: `## Model routing` appears once, immediately followed (a few lines later) by `## Commands`, and the file still has exactly one `## Commands` heading.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(docs): add model routing table to CLAUDE.md"
```

---

### Task 2: `.claude/skills/model-routing/SKILL.md`

**Files:**
- Create: `.claude/skills/model-routing/SKILL.md`

**Interfaces:**
- Consumes: nothing (standalone reference doc).
- Produces: the full routing table + escalation ladder + both review-gate procedures + the PR-gate issue-verification procedure, referenced (not duplicated in full) from `CLAUDE.md`'s "Model routing" section (Task 1) and "Before-shipping checklist" / "Opening the PR" (Task 3).

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p .claude/skills/model-routing
```

Write `.claude/skills/model-routing/SKILL.md`:

```markdown
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
  auto-applied. Any push after the review — a clear-cut fix, or nothing to
  fix at all — re-triggers a re-review pass.
- **Loop cap**: 2 re-review rounds, same numeric cap as the spec/plan loop
  above — but **not the same trigger shape**. The spec/plan loop only
  re-reviews past a severity threshold, because `assumption-checker`
  findings carry that taxonomy. `code-review` findings don't carry one, so
  this loop re-reviews after *any* clear-cut fix, with no severity gate.
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
```

- [ ] **Step 2: Verify the file**

```bash
node -e "const fs=require('fs'); const t=fs.readFileSync('.claude/skills/model-routing/SKILL.md','utf8'); if(!t.startsWith('---')) throw new Error('missing frontmatter'); console.log('frontmatter OK, length', t.length)"
```

Expected: prints `frontmatter OK, length <N>` with no thrown error.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/model-routing/SKILL.md
git commit -m "docs(docs): add model-routing skill reference"
```

---

### Task 3: `CLAUDE.md` — wire the review gates into "Before-shipping checklist" and "Opening the PR"

**Files:**
- Modify: `CLAUDE.md:244-254` ("Before-shipping checklist")
- Modify: `CLAUDE.md:447-459` ("Opening the PR")

**Interfaces:**
- Consumes: the anchor `.claude/skills/model-routing/SKILL.md` (Task 2) and `.github/workflows/pr-issue-link.yml` (Task 6 — this task's reference to it is forward-looking within the same PR, same situation as Task 1's forward reference to Task 2).

- [ ] **Step 1: Amend the before-shipping checklist**

```
old_string:
4. **Close or advance the linked issue.** Put `Closes #NN` in the PR body for a full delivery (`Refs #NN` for a partial), and confirm the issue's `area:`/`moscow:` labels still reflect reality. Bugs link their `bug` issue with `Closes #NN` too.
5. **Run `npm run verify`** locally — same battery as pre-push. Catches typecheck + all tests + e2e + build in one shot.
6. **If shipping a plan** (status → `stable`): fill its **Ship notes** section with the shipped date and the commit SHA, then `git mv` it under `docs/features/archive/` and re-link any active plan that pointed at it.
7. **Surface what changed** in the end-of-turn summary in 1–2 sentences. Do not narrate the diff — point at the user-visible delta and the test that locks it.

new_string:
4. **Close or advance the linked issue.** Put `Closes #NN` in the PR body for a full delivery (`Refs #NN` for a partial), and confirm the issue's `area:`/`moscow:` labels still reflect reality. Bugs link their `bug` issue with `Closes #NN` too. This link is verified, not assumed — if none exists at PR-creation time, one is auto-filed and linked without pausing to ask (see [Model routing → PR-gate issue verification](.claude/skills/model-routing/SKILL.md#pr-gate-issue-verification)); `.github/workflows/pr-issue-link.yml` mechanically backstops the check on every PR. Once `main`'s required-status-check ruleset for it is wired (a one-time, user-run setup step — see `docs/features/235-model-routing-review-gates.md`), a missing link blocks merge; until then it only fails a visible check.
5. **Run `npm run verify`** locally — same battery as pre-push. Catches typecheck + all tests + e2e + build in one shot.
6. **If shipping a plan** (status → `stable`): fill its **Ship notes** section with the shipped date and the commit SHA, then `git mv` it under `docs/features/archive/` and re-link any active plan that pointed at it.
7. **Surface what changed** in the end-of-turn summary in 1–2 sentences. Do not narrate the diff — point at the user-visible delta and the test that locks it.
8. **Independent PR review.** Once every item above is done (or explicitly marked not-applicable) and the branch is pushed, run the mandatory `code-review` pass — see [Model routing → Mandatory independent review (PRs)](.claude/skills/model-routing/SKILL.md#mandatory-independent-review-prs). Triage and fold findings before merge.
```

- [ ] **Step 2: Amend "Opening the PR"**

```
old_string:
Every non-trivial change merges via a GitHub PR. The PR title MUST match the
[commit-convention subject format](CONTRIBUTING.md#commit-convention) — a
GitHub Actions workflow rejects malformed titles. GitHub pre-fills the body
from [.github/pull_request_template.md](.github/pull_request_template.md);
keep the `## Summary` and `## Test plan` sections, fill them in, and link
the regression plan under `docs/features/` when one applies. Merges use the
"Create a merge commit" button (squash / rebase merge are disabled at the
repo level) and the head branch is auto-deleted on merge. Full spec:
[CONTRIBUTING.md "Pull requests"](CONTRIBUTING.md#pull-requests). Regression
plan: [docs/features/archive/44-pr-hygiene.md](docs/features/archive/44-pr-hygiene.md).

**Requesting a CI run on a PR (plan 215).** CI is opt-in (see "Commit gate"

new_string:
Every non-trivial change merges via a GitHub PR. The PR title MUST match the
[commit-convention subject format](CONTRIBUTING.md#commit-convention) — a
GitHub Actions workflow rejects malformed titles. GitHub pre-fills the body
from [.github/pull_request_template.md](.github/pull_request_template.md);
keep the `## Summary` and `## Test plan` sections, fill them in, and link
the regression plan under `docs/features/` when one applies. Merges use the
"Create a merge commit" button (squash / rebase merge are disabled at the
repo level) and the head branch is auto-deleted on merge. Full spec:
[CONTRIBUTING.md "Pull requests"](CONTRIBUTING.md#pull-requests). Regression
plan: [docs/features/archive/44-pr-hygiene.md](docs/features/archive/44-pr-hygiene.md).

**Every PR body must link a GitHub issue** (`Closes #NN` / `Refs #NN`) —
verified at creation time, not assumed. If none exists yet, one is
auto-filed and linked without pausing to ask, labeled per `CONTRIBUTING.md`'s
two-shape convention (bug-shaped work → standalone `bug` label; backlog-
shaped work → `type:feature`/`type:chore` + `area:<prefix>`, `moscow:` left
for you to set). `.github/workflows/pr-issue-link.yml` surfaces a failing
check on every PR that skips this, mirroring `pr-title-lint.yml`. Once wired
into `main`'s required status checks (a one-time, user-run ruleset setup —
see
[docs/features/235-model-routing-review-gates.md](docs/features/235-model-routing-review-gates.md)),
a missing link blocks merge; until that setup is done, a missing link only
fails a visible, non-blocking check.
Full mechanics: [`.claude/skills/model-routing/SKILL.md`](.claude/skills/model-routing/SKILL.md#pr-gate-issue-verification).

**Requesting a CI run on a PR (plan 215).** CI is opt-in (see "Commit gate"
```

- [ ] **Step 3: Also list the new workflow where CLAUDE.md documents automatic checks**

```
old_string:
What still runs automatically: `pr-title-lint.yml` on every PR, `app.yml` on
`apps/android/**` changes (the only automated coverage for the Flutter
companion — no local hook runs `flutter analyze`/`test`), `release.yml` on a
`vX.Y.Z` tag, and `cross-os.yml` on its weekly Sunday cron.

new_string:
What still runs automatically: `pr-title-lint.yml` and `pr-issue-link.yml` on
every PR, `app.yml` on `apps/android/**` changes (the only automated coverage
for the Flutter companion — no local hook runs `flutter analyze`/`test`),
`release.yml` on a `vX.Y.Z` tag, and `cross-os.yml` on its weekly Sunday cron.
```

- [ ] **Step 4: Verify the edits**

```bash
grep -n "pr-issue-link.yml" CLAUDE.md
grep -n "^8\. \*\*Independent PR review" CLAUDE.md
```

Expected: `pr-issue-link.yml` appears 3 times (checklist item 4, "Opening the PR" paragraph, the "What still runs automatically" sentence); the new checklist item 8 line is found once.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(docs): wire PR review + issue-link gates into CLAUDE.md"
```

---

### Task 4: `CLAUDE.md` — new "Task tracking & checkpoint flagging" section

**Files:**
- Modify: `CLAUDE.md` (append at end of file, after the existing sidecar pytest-coverage paragraph that currently ends the file)

**Interfaces:**
- Produces: a `## Task tracking & checkpoint flagging` heading documenting Decision 4/Design §4 (mandatory task tracking) and Decision 10/Design §6 (checkpoint `/compact` flagging).

- [ ] **Step 1: Append the new section**

The file currently ends (confirmed this session) with:

```
...header is per-response — Coqui and Kokoro covered separately. Wired
into `npm run test:all` via `npm run test:sidecar` (skips with a
banner on an unbootstrapped venv).
```

Append after that, with a leading blank line:

```markdown

## Task tracking & checkpoint flagging

**Task tracking is mandatory, not discretionary, once spec-writing ends.**
Plan-writing itself is tracked (drafting each of `writing-plans`' own
tasks/steps is itself a task via `TaskCreate`/`TaskUpdate`/`TaskList`), and
tracking continues through implementation at one-task-per-implementation-step
granularity. Reconcile the task list against the plan document at task/step
boundaries — not on every edit — preserving the status of steps that didn't
change, but catching structural changes (a step added, removed, or reworded)
before the next one begins.

**Three checkpoints get a `/compact` suggestion**, left to the user to
accept: spec approved (end of `brainstorming`), plan approved (end of
`writing-plans`), and PR merged/shipped. There is no tool to trigger
compaction directly — this is a suggestion at a good moment, not a
state-preservation mechanism.
```

- [ ] **Step 2: Verify**

```bash
tail -20 CLAUDE.md
grep -c "^## Task tracking & checkpoint flagging$" CLAUDE.md
```

Expected: the heading count is `1`, and `tail` shows the new section as the last thing in the file.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(docs): add task tracking & compact checkpoint section"
```

---

### Task 5: PR issue-link validator (TDD)

**Files:**
- Create: `scripts/validate-pr-issue-link.mjs`
- Test: `scripts/tests/validate-pr-issue-link.test.mjs`

**Interfaces:**
- Produces: `hasIssueLink(body: string): boolean` and `helpMessage(): string`, exported from `scripts/validate-pr-issue-link.mjs`. Consumed by Task 6's GitHub Actions workflow via the script's CLI mode (`node scripts/validate-pr-issue-link.mjs <pr-body-file>`, exit 0/1/2 — same convention as `scripts/validate-commit-msg.mjs`). Auto-discovered by the existing `npm run test:hooks` runner (`scripts/run-hooks-tests.mjs` globs `scripts/tests/*.test.mjs` — no wiring needed beyond dropping the file in place).

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/validate-pr-issue-link.test.mjs`:

```javascript
// Tests for the PR issue-link validator.
// Run via `npm run test:hooks` (node --test, no extra deps).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasIssueLink } from '../validate-pr-issue-link.mjs';

const accepted = [
  'Closes #123',
  'This PR Refs #45 for a partial delivery.',
  'Some text.\n\nCloses #1\n\nMore text.',
  'refs #99',
  'CLOSES #7',
  'See `npm run verify` first.\n\nCloses #55',
];

const rejected = [
  '',
  'No issue link here.',
  'See issue 123 for details.',
  '`Closes #123`',
  '```\nCloses #123\n```',
  'This encloses #123 something unrelated.',
  'Closesnt #123',
  'Closed #123',
];

for (const body of accepted) {
  test(`accepts: ${JSON.stringify(body)}`, () => {
    assert.equal(hasIssueLink(body), true, `expected true for ${JSON.stringify(body)}`);
  });
}

for (const body of rejected) {
  test(`rejects: ${JSON.stringify(body)}`, () => {
    assert.equal(hasIssueLink(body), false, `expected false for ${JSON.stringify(body)}`);
  });
}

test('rejects non-string input', () => {
  assert.equal(hasIssueLink(undefined), false);
  assert.equal(hasIssueLink(null), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test scripts/tests/validate-pr-issue-link.test.mjs
```

Expected: FAIL — `Cannot find module '../validate-pr-issue-link.mjs'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `scripts/validate-pr-issue-link.mjs`:

```javascript
// PR-body issue-linkage validator for the pr-issue-link CI check
// (.github/workflows/pr-issue-link.yml). See CONTRIBUTING.md "Issues" and
// docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md
// (Decision 9 / Decision 11) for the spec and rationale.

import { readFileSync } from 'node:fs';

// GitHub's own auto-close keywords are case-insensitive; "Refs" is this
// repo's own convention for a partial/multi-wave delivery (does not
// auto-close on GitHub, but still satisfies this gate's linkage check).
const ISSUE_LINK_PATTERN = /\b(?:closes|refs)\s+#\d+/i;

// A Closes/Refs keyword wrapped in inline code or a fenced code block reads
// as a real link but does NOT actually trigger GitHub's auto-close — strip
// both before testing so this check can't be satisfied by a false positive
// (see docs/superpowers/specs/... memory note: backtick-wrapped Closes #NN
// does not auto-close).
function stripCodeSpans(text) {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

export function hasIssueLink(body) {
  if (typeof body !== 'string') return false;
  return ISSUE_LINK_PATTERN.test(stripCodeSpans(body));
}

export function helpMessage() {
  return [
    `PR body doesn't link a GitHub issue.`,
    ``,
    `Expected somewhere in the PR body, written plainly (not inside`,
    `backticks or a code block):`,
    `  Closes #123     (full delivery — auto-closes the issue on merge)`,
    `  Refs #123       (partial / multi-wave delivery — does not auto-close)`,
    ``,
    `See CLAUDE.md "Opening the PR" and CONTRIBUTING.md "Issues" for the`,
    `full convention.`,
  ].join('\n');
}

// CLI mode: `node scripts/validate-pr-issue-link.mjs <pr-body-file>`
const invokedAsCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').endsWith('scripts/validate-pr-issue-link.mjs');

if (invokedAsCli) {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: validate-pr-issue-link.mjs <pr-body-file>');
    process.exit(2);
  }
  const body = readFileSync(path, 'utf8');
  if (!hasIssueLink(body)) {
    console.error(helpMessage());
    process.exit(1);
  }
  process.exit(0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test scripts/tests/validate-pr-issue-link.test.mjs
```

Expected: PASS — all cases green, 0 failures.

- [ ] **Step 5: Run the full hooks-test runner to confirm auto-discovery**

```bash
npm run test:hooks
```

Expected: PASS, and the output includes the new test file's cases alongside `validate-commit-msg.test.mjs`'s (confirms `scripts/run-hooks-tests.mjs`'s `scripts/tests/*.test.mjs` glob picked it up with no wiring change).

- [ ] **Step 6: Manually verify the CLI mode**

```bash
printf 'Closes #123\n' > /tmp/pr-body-ok.txt
node scripts/validate-pr-issue-link.mjs /tmp/pr-body-ok.txt; echo "exit=$?"
printf 'no link here\n' > /tmp/pr-body-bad.txt
node scripts/validate-pr-issue-link.mjs /tmp/pr-body-bad.txt; echo "exit=$?"
rm -f /tmp/pr-body-ok.txt /tmp/pr-body-bad.txt
```

Expected: first call prints nothing and `exit=0`; second call prints the help message and `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add scripts/validate-pr-issue-link.mjs scripts/tests/validate-pr-issue-link.test.mjs
git commit -m "feat(scripts): add PR issue-link validator"
```

---

### Task 6: `.github/workflows/pr-issue-link.yml`

**Files:**
- Create: `.github/workflows/pr-issue-link.yml`

**Interfaces:**
- Consumes: `scripts/validate-pr-issue-link.mjs`'s CLI mode (Task 5).

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/pr-issue-link.yml`:

```yaml
name: PR issue link

on:
  pull_request:
    # Unlike pr-title-lint.yml (which drops `edited` — title typo-fixes
    # gain nothing from re-firing), `edited` stays here: the primary way a
    # PR resolves a missing issue link is editing the body after opening
    # (adding `Closes #NN` retroactively), not pushing a new commit. Without
    # `edited`, that fix wouldn't clear the failing check until the next
    # `synchronize` push.
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read

jobs:
  lint:
    name: Verify PR body links a GitHub issue
    runs-on: ubuntu-latest
    # Tiny validator; cap explicitly so a hung run can't bill the 360-min
    # default (same rationale as pr-title-lint.yml).
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Set up Node
        uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Write PR body to a temp file
        # Same file-passing pattern as pr-title-lint.yml's PR_TITLE handling
        # — the body can't be interpreted as a shell expression this way.
        env:
          PR_BODY: ${{ github.event.pull_request.body }}
        run: |
          printf '%s\n' "$PR_BODY" > "$RUNNER_TEMP/pr-body.txt"

      - name: Validate PR issue link
        run: node scripts/validate-pr-issue-link.mjs "$RUNNER_TEMP/pr-body.txt"
```

**Note on the job's `name:` field**: `Verify PR body links a GitHub issue` is not just a label — Task 7's required-status-check ruleset references this exact string as the check's context. Do not rename it without also updating Task 7's ruleset command. (Whether this workflow's own introducing PR shows the check at all is a harmless either-way ambiguity — GitHub Actions workflows added in a PR do run for that PR's own `pull_request` events, so it should appear; if it doesn't, that's cosmetic for this one PR and irrelevant to every PR after it, since the check exists on `main` once merged.)

- [ ] **Step 2: Validate the YAML syntax locally**

```bash
node -e "const {load}=require('js-yaml'); const fs=require('fs'); load(fs.readFileSync('.github/workflows/pr-issue-link.yml','utf8')); console.log('YAML OK')"
```

Expected: prints `YAML OK`. (`js-yaml` is already a transitive dep in this repo's `node_modules`; if the `require` fails with `Cannot find module`, fall back to `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/pr-issue-link.yml'))"` or simply eyeball the indentation against `pr-title-lint.yml`.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/pr-issue-link.yml
git commit -m "feat(ci): enforce PR issue-linkage via pr-issue-link.yml"
```

---

### Task 7: Regression plan, INDEX entry, ship

**Files:**
- Create: `docs/features/235-model-routing-review-gates.md` (from `docs/features/TEMPLATE.md`, product-specific fields marked `n/a` — see Global Constraints)
- Modify: `docs/features/INDEX.md` (new entry under "K. Cross-cutting invariants", matching plans 163/166's shape)

**Interfaces:** none — terminal task.

- [ ] **Step 1: Write the regression plan**

Create `docs/features/235-model-routing-review-gates.md`:

```markdown
---
status: active
shipped: null
owner: null
---

# Model routing & review gates

> Status: active — mechanized gate (issue-linkage) is tested + CI-enforced;
> the other five gates are self-enforced prose, not locked by automated
> tests, so `stable` (which this repo's INDEX.md lifecycle defines as
> "behavior locked by automated tests") does not yet apply.
> Key files: `CLAUDE.md`, `.claude/skills/model-routing/SKILL.md`,
> `scripts/validate-pr-issue-link.mjs`, `.github/workflows/pr-issue-link.yml`
> URL surface: n/a — process/tooling change, no application UI
> OpenAPI ops: none

## Benefit / Rationale

- **User:** n/a — this repo has one operator (the user); "user" and
  "developer" are the same person for this change.
- **Technical:** subagent/session model choice stops defaulting to habit;
  spec/plan and PR review gates run by default instead of only when asked;
  a PR without a linked GitHub issue is mechanically caught, not just
  conventionally expected.
- **Architectural:** locks in a durable place for routing + review-gate
  rules (`.claude/skills/model-routing/SKILL.md`) that future sessions read
  without re-deriving; opens the precedent (Decision 11) of mechanizing a
  self-enforced convention when it's cheap enough to be worth it.

## Architectural impact

- **New seams**: a new project skill directory (`.claude/skills/model-routing/`);
  a new validator module shape (`scripts/validate-*.mjs` + CLI mode) alongside
  the existing `validate-commit-msg.mjs`; a second always-on `pull_request`
  workflow alongside `pr-title-lint.yml`.
- **Invariants preserved**: no application code, test suite, or product
  surface changes (spec "Out of scope"); `brainstorming`/`writing-plans`
  (global plugin skills) are not edited, only project-level `CLAUDE.md` /
  `.claude/skills/` content, which the standing instruction-precedence rule
  already gives priority over skill defaults.
- **Migration story**: none — no stored data shape changes.
- **Reversibility**: every CLAUDE.md edit and the skill file are plain
  markdown, revertible with a single `git revert`. The workflow is inert
  until wired into a required-status-check ruleset (Task 7 Step 8, the
  manual step — see the implementation plan); if that step is reverted, the
  check becomes advisory-only again, not broken.

## Invariants to preserve

1. The four-tier routing table (`CLAUDE.md` "Model routing" section, and the
   full copy in `.claude/skills/model-routing/SKILL.md`) never routes a fork
   — forks always inherit the dispatching session's model (`Agent` tool
   schema; see Decision 1 in the design spec).
2. `scripts/validate-pr-issue-link.mjs`'s `hasIssueLink()` strips fenced +
   inline code spans before testing for `Closes #NN` / `Refs #NN` — a
   backtick-wrapped keyword must not satisfy the check (it doesn't actually
   auto-close on GitHub either).
3. `.github/workflows/pr-issue-link.yml`'s job `name:` field
   ("Verify PR body links a GitHub issue") is the exact string referenced by
   the required-status-check ruleset (Task 7 Step 8, the manual step) — renaming the job
   without updating the ruleset silently breaks the required-check binding.

## Test plan

### Automated coverage

- `node:test` (`scripts/tests/validate-pr-issue-link.test.mjs`) — asserts
  `hasIssueLink()` accepts `Closes #NN`/`Refs #NN` (case-insensitive, amid
  other text), and rejects missing links, near-miss words ("Closed",
  "Closesnt", "encloses"), and backtick/fenced-code-wrapped occurrences.
  Auto-discovered by `npm run test:hooks` via
  `scripts/run-hooks-tests.mjs`'s `scripts/tests/*.test.mjs` glob.
- **Explicitly untested** (self-enforced prose, per the design spec's "Out
  of scope" honesty note): the routing table's tier selection, the
  escalation ladder, session-drift flagging, both review-gate loops'
  triggers/caps, task-tracking granularity, and `/compact` checkpoint
  flagging. None of these are checkable by an automated test — they're
  judged by the dispatching session in the moment. Only Decision 11's
  issue-linkage slice is mechanized.

### Manual acceptance walkthrough (process walkthrough, not a UI click-through)

1. Open a PR against `main` with a body that does **not** contain `Closes`
   or `Refs` → expect the `Verify PR body links a GitHub issue` check to
   fail (red ✗) on the PR.
2. Edit the PR body to add `Closes #<some real issue number>` (plain, not
   inside backticks) → expect the check to re-run (the `edited` trigger)
   and turn green.
3. Confirm `pr-title-lint.yml` (`.github/workflows/pr-title-lint.yml`) is
   unaffected — both workflows run independently on the same PR events.
4. After Task 7 Step 8 (the manual ruleset step) is applied: repeat step 1
   and confirm the PR's merge button is now disabled/blocked by GitHub until
   the check passes (not just red).

## Out of scope

Everything the design spec's own "Out of scope" section names: application
code, the `assumption-checker`/`code-review` skill implementations
themselves, and full mechanization of the other five gates. See
[docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md](../superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md).

## Ship notes

(Filled in once merged: shipped date, commit SHA.)
```

- [ ] **Step 2: Add the INDEX.md entry**

Add one line under the `### K. Cross-cutting invariants` heading in `docs/features/INDEX.md`, matching the real shape of the existing 163/166 entries: `- [235 — Model routing & review gates](235-model-routing-review-gates.md) — `active`. <one dense paragraph>.` Neither 163 nor 166 ends with a trailing `Closes #NN` (163 ends "…node:test coverage under `npm run test:hooks`.", 166 ends "…run as PRs 2–3."), so don't add one either — cite the filed issue naturally inside the paragraph instead, once the issue number is known from Step 4 below (e.g. "… Filed as #NN.").

- [ ] **Step 3: Run the full battery**

```bash
npm run verify
```

Expected: typecheck + all tests (including the new `test:hooks` cases from Task 5) + e2e + build all green.

- [ ] **Step 4: File the GitHub issue**

```bash
gh issue create \
  --title "Model routing & review gates: embed governance spec into CLAUDE.md" \
  --label "type:feature" --label "area:ops" \
  --body "Implements docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md — see the linked PR for the full diff."
```

Note the returned issue number (`#NN`) — fill it into the INDEX.md entry from Step 2 and the PR body in Step 6.

- [ ] **Step 5: Commit the regression plan + INDEX entry**

```bash
git add docs/features/235-model-routing-review-gates.md docs/features/INDEX.md
git commit -m "docs(docs): add regression plan for model routing & review gates"
```

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin docs/docs-model-routing-review-gates
gh pr create \
  --title "docs(docs): model routing & review gates governance" \
  --body "Closes #NN

## Summary
- Embeds the 11-decision governance spec into CLAUDE.md: model-routing table, mandatory spec/plan + PR review gates, task-tracking/checkpoint rules.
- New .claude/skills/model-routing/SKILL.md holds the full routing table + review-gate mechanics.
- New scripts/validate-pr-issue-link.mjs (node:test covered) + .github/workflows/pr-issue-link.yml mechanically check every PR body links an issue.
- Regression plan: docs/features/235-model-routing-review-gates.md.

## Test plan
- [x] npm run verify green
- [x] node --test scripts/tests/validate-pr-issue-link.test.mjs green
- [ ] Manual: open a throwaway PR without a Closes/Refs link, confirm pr-issue-link.yml fails; add the link, confirm it passes"
```

(Replace `#NN` with the real issue number from Step 4.)

- [ ] **Step 7: Run the mandatory independent PR review**

Per the before-shipping checklist item 8 this same PR just added — once pushed, run the `code-review` skill at `high` effort, without `--fix`, and triage the findings by hand (see [`.claude/skills/model-routing/SKILL.md`](../../.claude/skills/model-routing/SKILL.md#mandatory-independent-review-prs)). This is the first real dogfood of that gate; do not skip it because "this PR already went through unusually heavy review" — the checklist item doesn't carve out an exception for that.

> **Step 8 (MANUAL — not a checkbox task; the implementing agent does NOT run this): wire the required status check.** This is a distinct step from Step 6 above (which only pushes and opens the PR). It wires `pr-issue-link.yml` into `main`'s branch protection as a required status check — a repo security-setting change. Per this harness's action-care rules, that is never auto-performed, regardless of prior approval for the general approach. Do not run the command below as part of automated task execution. Present it to the user and let them run it themselves, after this PR (Step 6) merges.
>
> `main` already carries one ruleset (id `17654264`, "main — block force-push & deletion" — see `docs/features/163-protected-push-guard.md`). This adds a **second**, independent ruleset rather than editing that one; rulesets are additive, so both apply simultaneously with no conflict.
>
> ```bash
> gh api repos/dudarenok-maker/Castwright/rulesets -X POST --input - <<'JSON'
> {
>   "name": "main — require PR issue link",
>   "target": "branch",
>   "enforcement": "active",
>   "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
>   "rules": [
>     {
>       "type": "required_status_checks",
>       "parameters": {
>         "required_status_checks": [
>           { "context": "Verify PR body links a GitHub issue" }
>         ],
>         "strict_required_status_checks_policy": false
>       }
>     }
>   ]
> }
> JSON
> ```
>
> (The repo slug `dudarenok-maker/Castwright` was confirmed live this session via `gh api repos/dudarenok-maker/Castwright/rulesets` — it returned real ruleset data, including the id `17654264` cited above. `163`'s own doc still shows the pre-rename slug `dudarenok-maker/AudioBook-Generator`, which is stale — that file is an archival regression plan, not something this plan updates; don't copy its slug.)
>
> Safer alternative to the raw API call: GitHub web UI → repo Settings → Rules → Rulesets → New branch ruleset → Require status checks to pass → search/add "Verify PR body links a GitHub issue". The UI autocompletes from checks that have actually run, so it can't silently no-op on a typo'd context string the way the API call can. Run this only after the PR from Step 6 has merged, so the check has run at least once on `main`.

---

## Self-Review

- **Spec coverage**: Decision 1/Design §1 → Task 1 + Task 2. Decision 2/3 (escalation, drift) → Task 2. Decision 4/5/6/Design §2 (spec/plan review) → Task 2. Decision 6/7/Design §3 (PR review) → Task 2 + Task 3 Step 1 item 8. Decision 8/Design §4 (task tracking) → Task 4. Decision 9/Design §5 (issue verification) → Task 2 + Task 3. Decision 10/Design §6 (checkpoints) → Task 4. Decision 11/Design §7 (mechanical enforcement) → Task 5 + Task 6 + Task 7 (required-check wiring, post-review addition — see below). Design "Embedding" → all six file targets accounted for across Tasks 1–4 and 5–6. No spec section is without a task.
- **Two forward-references are intentional, not placeholders**: Task 1 links to `.claude/skills/model-routing/SKILL.md` before Task 2 creates it, and Task 3 links to `.github/workflows/pr-issue-link.yml` before Task 6 creates it. Both resolve within the same plan/PR, in task order — flagged here so a reviewer doesn't mistake them for a real gap.
- **This plan does not implement Decision 3's "session-level drift" flagging as a runtime check** — it's a standing behavioral instruction (Task 2's skill content), same as every other self-enforced gate in the spec. No code makes this happen; the spec is explicit that only Decision 11 gets a real mechanical check (Task 5/6/7).

### Round-1 adversarial-review findings folded (this plan's own mandatory review, per Decision 5)

An Opus-tier subagent ran a real `assumption-checker` pass against this plan (session was Sonnet-tier, so per Decision 4 the mechanism was subagent dispatch, not in-session). It tripped the re-review threshold: 1 `Critical`+`Contradicted`, 1 `Significant`+`Contradicted` (both counted; several `Minor`/informational notes did not trip the threshold on their own).

- **Critical, Contradicted — "unavoidable" enforcement overclaim.** The original Task 6 called `pr-issue-link.yml` "real, external, unavoidable" enforcement, but a failing GitHub Actions check does not block a merge unless wired into a required-status-check ruleset — confirmed via `gh api repos/.../rulesets` (only force-push/deletion protection exists) and `docs/features/215-ci-label-gated-verify.md`, which deliberately excludes required checks so opt-in PRs can't deadlock. Surfaced to the user (branch-protection wiring is a repo security-setting judgment call, not something to silently patch either direction) rather than auto-resolved; user chose to wire it as a required check, scoped to `pr-issue-link.yml` only. Folded as: the design spec's Decision 11/Design §7 correction note, this plan's Task 6 note + Global Constraints, and the new Task 7 Step 8 manual instructions (originally mis-numbered "Step 6" in four places — round 2 of this plan's own review caught and fixed that; see the round-2 summary below) (not an automated task step — a repo security-setting change is never auto-performed by an implementing agent, per the harness's own action-care rules, regardless of prior approval for the general approach).
- **Significant, Contradicted — docs/features regression-plan skip misclassified.** The original Global Constraints justified skipping a `docs/features/` plan entry as "small/localized." `CONTRIBUTING.md:337` says cross-cutting work "still gets" one, and this change (rewriting CLAUDE.md's core instructions, adding an always-on CI gate) is cross-cutting, not small. It also missed real precedent — INDEX.md's "K. Cross-cutting invariants" section already holds tooling/CI-gate plans of exactly this shape (163, 166). Fixed by adding Task 7, which writes `docs/features/235-model-routing-review-gates.md` (product-specific TEMPLATE.md fields marked `n/a` rather than force-fit) and an INDEX.md entry under "K."
- **Caught false positive (not folded)**: the review flagged `node -e "...require(...)"` in Task 2 Step 2 as possibly broken under this package's `"type": "module"`. Verified directly — `node -e` always defaults to CommonJS regardless of `package.json`'s `type` field (confirmed empirically: `node -e "console.log(typeof require)"` → `function` in this repo's root). No change made.
- **Minor/informational notes, addressed lightly**: the review flagged a possible sequence-order mismatch between the skill's stated PR-review sequence and the before-shipping checklist's item numbering — checklist item 8's existing "once every item above is done" phrasing already makes its terminal position explicit, so no further edit was needed. It also flagged that adding a second always-on `pull_request` workflow widens this repo's "always-bills" CI surface — real, but negligible (5-min cap, seconds of runtime, same precedent `pr-title-lint.yml` already sets) and not worth a dedicated constraint beyond this note. It also flagged whether `pr-issue-link.yml` reports a check on the very PR that introduces it — addressed as a harmless-either-way note in Task 6.
- **Loop status**: round 1 tripped the threshold, findings fixed above, which mandated round 2 (see below).

### Round-2 adversarial-review findings folded

A second Opus-tier subagent pass (same mechanism) re-reviewed the round-1-corrected plan. It tripped the threshold again: 1 `Critical`+`Contradicted`, 1 `Significant`+`Contradicted` — both defects introduced *by* round 1's own fix (the new Task 7), so round 1 could not have caught them.

- **Critical, Contradicted — the ruleset step was mis-numbered everywhere it was cited.** Round 1's fix added the required-status-check command as an unnumbered trailing blockquote after Task 7's checkbox Step 7, but four separate places (Global Constraints/Architecture, the 235 doc's invariant #3, its manual walkthrough item 4, and the blockquote's own opening sentence) called it "Task 7 Step 6" — which is actually the "Push and open the PR" step, unrelated to branch protection. The blockquote's own first sentence ("Step 6 above wires...") was factually wrong about the step it was describing. Fixed: the blockquote is now explicitly labeled "Step 8 (MANUAL — not a checkbox task...)", and all four cross-references were corrected to say "Step 8."
- **Significant, Contradicted — Task 7 Step 2 claimed 163/166 end their INDEX.md entries with `Closes #NN`; they don't** (163 ends "…node:test coverage under `npm run test:hooks`.", 166 ends "…run as PRs 2–3."). Fixed: Step 2 no longer claims that shape; it now cites the real 163/166 pattern (link text, status, one dense paragraph) and asks for the issue number to be cited naturally inside the paragraph instead of appended.
- **Additional fixes folded (Minor/informational, not threshold-tripping on their own)**: `main` already carries a ruleset (id `17654264`, force-push/deletion) that the plan's world-model had omitted — Step 8 now names it and clarifies the new ruleset is additive, not a replacement. The repo slug `dudarenok-maker/Castwright` used in the ruleset command was flagged against `163`'s doc, which still shows the pre-rename slug `dudarenok-maker/AudioBook-Generator` — resolved by noting the current slug was independently confirmed live this session (the `gh api` call that surfaced ruleset `17654264` used it successfully), and that `163`'s doc is simply stale, not a discrepancy to reconcile in this plan.
- **Not changed**: the review confirmed the `n/a`/`none` TEMPLATE.md field markers, the free plan number `235`, the `test:hooks` auto-discovery claim, and the ruleset JSON's field shape are all sound. It also flagged the `gh pr create` heredoc's literal `Closes #NN` placeholder as a "benign" failure mode (the step's own text already says to replace it with the real number before running; if run unedited, the validator correctly rejects it rather than silently passing) — no change needed.
- **Loop status**: round 2 tripped the threshold, findings fixed above, which mandated round 3 (see below) — the last round permitted under Decision 5's cap (initial + up to 2 re-review rounds = 3 total).

### Round-3 (final) adversarial-review finding

A third Opus-tier pass re-reviewed the round-2-corrected plan, with explicit instructions to fresh-eyes Tasks 1–6 (not just Task 7, which both prior rounds had concentrated on) and to verify round 2's fix landed cleanly. It confirmed round 2's Step-8 renumbering is fully consistent (no stray "Step 6→ruleset" references remain outside historical review prose), plan number `235` is still free, and Tasks 5–6's infrastructure claims (`test:hooks` auto-discovery, the `pr-title-lint.yml` template match) hold against the real files. It also found one fresh defect — a genuine `Critical`+`Contradicted` — that both prior rounds missed because they were focused on Task 7:

- **Critical, Contradicted — Task 3's CLAUDE.md edits asserted the required-status-check as an already-in-force, present-tense fact.** Before this fix, checklist item 4 read "…and is wired as a required status check on `main`, so a missing link blocks merge" and "Opening the PR" read "…is wired into `main`'s required status checks so a missing link actually blocks merge" — both stated as accomplished fact. But Step 8 is a discretionary, manual, post-merge step the user runs (or may decline) — never something an implementing agent performs. At the moment Task 3's edits land in CLAUDE.md (this PR's merge), Step 8 by definition has not run yet, so CLAUDE.md would ship a false statement — the same "unavoidable/blocks-merge" over-claim class round 1 caught in the design spec's Decision 11, reintroduced here in the CLAUDE.md body text itself. **Fixed by hand, without a fourth automated review round**: this is a factual-accuracy correction, not a judgment call the user needs to weigh (the correct direction — CLAUDE.md should track actual/conditional state, not aspirational state — is already the position every other part of this plan, the 235 doc, and the design spec's own Decision 11 correction take; making Task 3's wording match them is not a new decision). Both sites now read conditionally: "Once `main`'s required-status-check ruleset for it is wired (a one-time, user-run setup step…), a missing link blocks merge; until then it only fails a visible check."
- **Loop status**: round 3 tripped the threshold (1 Critical+Contradicted). Per Decision 5's cap, this was the last permitted automated round — the finding above was fixed directly rather than triggering a round 4, the same disposition the design spec itself used for its own round-3 finding. No further automated adversarial-review round runs against this plan; any additional review is at the user's discretion.
