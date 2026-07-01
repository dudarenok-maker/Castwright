# Model routing & workflow governance

_Design spec — 2026-07-01_

## Problem

Token utilization has been driven by habit rather than policy: work defaults
to whichever model the session happens to be running, with an unspoken bias
toward over-using Opus/Fable even on mechanical work. Separately, several
steps in the existing brainstorm → plan → implement → ship pipeline
(`CLAUDE.md` "Branching workflow" / "Before-shipping checklist") are
correct-but-optional in practice: adversarial review of a spec or plan only
happens if explicitly requested, a combined code+docs review of a finished PR
only happens if explicitly requested, post-spec task tracking is left to
discretion rather than being systematic, and PR-to-issue linkage is a
documented convention rather than a verified one. This spec codifies five
rules to close those gaps, so they hold by default instead of requiring a
repeated ask.

This is a governance spec, not a feature spec: there is no application code
change here, only new/amended project instructions (`CLAUDE.md`, a new
project skill) that change how work gets executed in this repo going forward.

## Decisions

These were reached interactively across several rounds of brainstorming
(see conversation) and are restated here as the binding rules.

1. **Four-tier model routing, not three.** Fable is not a peer of Opus in the
   routing table — it is gated separately (explicit per-task user approval
   only, never auto-selected), because it is materially more expensive than
   Opus and should never be reached by an automatic escalation path.
2. **Escalation is silent, not interrupt-driven.** A Sonnet-tier subagent
   that fails twice is auto-re-dispatched at Opus without asking first; the
   escalation is reported after the fact. This differs from session-level
   model mismatches (item 3), which _do_ interrupt — the asymmetry is
   deliberate: subagent dispatch is a disposable, cheap-to-retry decision;
   switching the user's own session model is not something I can silently do
   for them, so it has to surface as a question instead of an action.
3. **Session-level tier mismatches are flagged, not silently absorbed.**
   Because I cannot change my own running model, a task that drifts into a
   different tier than the active session model produces an explicit
   sentence naming the mismatch and asking whether to switch — it does not
   get silently worked through on the "wrong" tier.
4. **Adversarial review of specs/plans is mandatory for non-trivial work,**
   using the existing `assumption-checker` skill on Opus, with findings shown
   alongside the artifact rather than gating it beforehand. "Non-trivial"
   reuses brainstorming's own existing complexity-scaling judgment — this
   spec does not introduce a second definition of triviality.
5. **The re-review loop is severity-gated and capped.** Re-review is
   mandatory only when the finding is both load-bearing (`Critical` or
   `Significant`) _and_ actually shown false (`Contradicted`) — a
   correctly-flagged-but-confirmed-true assumption is not a defect and does
   not trigger a loop. The cap (initial + 2 re-reviews) exists so an
   unresolved disagreement escalates to the user rather than silently
   consuming unbounded Opus-tier passes.
6. **Judgment calls are never auto-resolved, in either review loop.** A
   finding that requires a decision only the user can make (a genuinely
   ambiguous or load-bearing assumption) suspends the fix-and-re-review loop
   and routes through the normal ask-first behavior already established in
   `CLAUDE.md` ("Think before coding"). This rule is shared verbatim between
   the spec/plan re-review loop (§ Decision 5) and the PR review loop
   (§ Decision 7) rather than restated separately, because it is the same
   failure mode in both places: an automated loop mistaking a decision for a
   defect.
7. **A combined, independent review is mandatory after every PR is opened,**
   using the `code-review` skill's existing 8-angle fan-out (line-by-line
   diff, removed-behavior audit, cross-file tracer, reuse, simplification,
   efficiency, altitude, CLAUDE.md conventions) at `high` effort against the
   _pushed_ PR diff — not the separate `/review` PR-comment command, and not
   the working-tree diff pre-push. Running it post-push means it reviews
   exactly what is now public, including the staged docs updates from the
   before-shipping checklist, as one combined artifact.
8. **Task tracking becomes mandatory, not discretionary, once spec-writing
   ends.** Plan-writing itself is tracked (drafting each plan section is a
   task), and this continues through implementation at per-step granularity.
   The task list is reconciled against the plan document at phase/section
   boundaries rather than on every edit, preserving the status of steps that
   did not change — this avoids task-list churn on minor wording edits while
   still catching structural changes (a step added, removed, or reworded)
   before the next phase begins.
9. **PR-gate issue verification is mandatory and self-sufficient.** At PR
   creation, a linked GitHub issue (`Closes #NN` / `Refs #NN`) is verified,
   not assumed. If none exists, one is auto-filed (with `area:`/`moscow:`/
   `type:` labels per `CONTRIBUTING.md`'s taxonomy) and linked — without
   pausing to ask. This upgrades the existing "Closes #NN" convention
   already documented in `CLAUDE.md`'s "Opening the PR" section from a
   manual habit to an enforced, self-sufficient check, matching how
   Decision 2 treats subagent escalation: cheap-to-take, low-risk actions
   proceed without interruption, unlike Decision 3's session-model flagging.

## Design

### 1. Model routing table

| Tier | Model | Selected for |
|---|---|---|
| Cheap | Haiku 4.5 | Mechanical search-and-report subagents, boilerplate/scaffolding, running commands and summarizing output, single well-specified bug fixes with a clear repro and no design decisions, high-volume parallel fan-out |
| Default | Sonnet 5 | Everything else — standard feature work, most debugging, most subagent/fork dispatch, code review, the main session itself |
| Premium | Opus 4.8 | Ambiguous specs needing judgment, architecture/design tradeoffs with multiple viable options, adversarial review passes (§2/§3 below), cases where Sonnet visibly got stuck (2 failed attempts), irreversible/high-blast-radius decisions |
| Reserved | Fable 5 | Never auto-selected. Explicit user approval only, per task |

Applies uniformly to subagent/fork/`Workflow` dispatch and to the main
session's own model choice (as guidance + proactive flagging, since only the
user can actually switch the running session model).

### 2. Mandatory adversarial review — specs & plans

- **Trigger**: every non-trivial spec (`brainstorming`) and plan
  (`writing-plans`). Trivial/direct-to-main work is exempt.
- **Mechanism**: `assumption-checker` skill, on Opus, invoked automatically.
- **Timing**: findings are presented alongside the spec/plan at the same
  review checkpoint — not before the user sees it, not after they've
  separately approved it.
- **Re-review trigger**: ≥1 assumption rated `Critical` (load-bearing) _and_
  `Contradicted` (evidence), OR ≥2 rated `Significant` _and_ `Contradicted`.
- **Loop cap**: initial pass + up to 2 re-review rounds (3 total). Still
  tripping the threshold after that stops the loop and hands it to the user.
- **Judgment-call carve-out**: see Decision 6.

### 3. Mandatory independent review — PRs

- **Sequence**: finalize implementation → local `npm run verify` → `gh pr
  create` → stage all docs (regression plan, `INDEX.md`, PR body — the
  existing before-shipping checklist) → mandatory final review.
- **Mechanism**: `code-review` skill's 8-angle fan-out, `high` effort,
  against the pushed PR diff.
- **Findings handling**: any findings → `--fix` → a re-review pass to
  confirm, capped at 2 re-review rounds (same shape as § 2's loop). Zero
  findings means nothing to loop on.
- **Judgment-call carve-out**: see Decision 6.

### 4. Task tracking, post-spec

- Starts at plan-writing (drafting plan sections is itself tracked), and
  continues through implementation.
- Granularity: one task per individual implementation step, not per
  section/phase.
- Sync: the task list is reconciled against the plan document at
  phase/section boundaries, preserving completed/in-progress status for
  unaffected steps. Uses the existing `TaskCreate`/`TaskUpdate`/`TaskList`
  tooling — this spec formalizes when it is mandatory, not how it works
  mechanically.

### 5. PR-gate issue verification

- **Trigger**: every `gh pr create` for non-trivial work.
- **Check**: the PR body must contain `Closes #NN` or `Refs #NN` referencing
  an existing GitHub issue.
- **Missing case**: auto-file a new issue capturing the work, labeled per
  `CONTRIBUTING.md`'s `area:`/`moscow:`/`type:` taxonomy, then add
  `Closes #NN` to the PR body — proceeds without interruption.
- **Timing**: performed at PR creation, distinct from and prior to the
  mandatory independent review (§3), which reviews code + docs combined
  once the PR (and its issue link) already exist.

## Embedding

- **`CLAUDE.md`**: a new "Model routing" section (§1's table) placed near
  the existing "Working principles"; amendments to "Before-shipping
  checklist" and "Opening the PR" stating the mandatory review gates (§2,
  §3) and the PR-gate issue verification (§5); a note under "Branching
  workflow" or a new subsection covering mandatory task tracking (§4).
- **New project skill**: `.claude/skills/model-routing/SKILL.md` — holds the
  full decision table and escalation logic in one place, referenced (not
  duplicated) from `CLAUDE.md`, following the existing pattern set by
  `.claude/skills/run-app/SKILL.md`.
- **Mechanism note**: `brainstorming` and `writing-plans` are global plugin
  skills (versioned under the Superpowers plugin cache) and are not edited
  by this change. The mandatory gates are enforced as project-level
  `CLAUDE.md` instructions, which take precedence over skill defaults per
  the standing rule already stated in this environment ("User instructions
  ... take precedence over skills, which in turn override default
  behavior").

## Out of scope

- No change to application code, tests, or the audiobook-generation product
  surface.
- No change to the `assumption-checker` or `code-review` skill
  implementations themselves — both are reused as-is.
- No automated enforcement mechanism (e.g. a hook that blocks a commit if a
  review didn't run) — these are process rules I follow, not a technical
  gate. Automating enforcement is a possible future follow-up, not part of
  this spec.
