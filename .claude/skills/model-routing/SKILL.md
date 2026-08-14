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

## Named dispatch roles

**This table governs one surface: Claude Code `subagent_type` dispatch.**
Nothing else reads `.claude/agents/` — not the worker CLIs (`claude`,
`copilot`, `cline`), not Cline, which resolves skills from `~/.agents/skills/`
and cannot select a subagent's model at all. Editing a row here changes what
`Agent({subagent_type: '<name>'})` does, and nothing else.

**The other execution lane is governed too — just not here, and not by this
repo.** Work routed to a CLI worker queue is dispatched by the Ringer engine
config (`~/.config/ringer/config.toml`), which pins each engine's model and
passes `--effort`/`--thinking` explicitly. Same norm, different file. This
table is therefore not the whole story of how work gets dispatched: it governs
the `subagent_type` lane, which is the minority path. That file lives outside
version control, so nothing here reads or checks it — it is named so a reader
editing `implementer` below knows which lane they are and are not changing.

Dispatch by role, not by model: `Agent({subagent_type: 'pr-reviewer'})`, not
`Agent({model: 'opus'})`. The definition pins both axes, so the depth of a
gate stops depending on what the dispatching session happened to be set to.

| Role | Tier | `model:` | `effort:` | Dispatch for |
|---|---|---|---|---|
| `pr-reviewer` | Premium | `opus` | `xhigh` | The mandatory pre-merge PR review gate (see [`pr-review-gate`](../pr-review-gate/SKILL.md)) |
| `spec-checker` | Premium | `opus` | `xhigh` | The mandatory adversarial pass on a non-trivial spec or plan |
| `task-reviewer` | Default | `sonnet` | `high` | Reviewing one completed task between steps of a plan |
| `implementer` | Default | `sonnet` | `medium` | Implementing one task from a plan, test-first |
| `fix-agent` | Cheap | `haiku` | `medium` | One incidental finding: one fix, one paired regression test |
| `scout` | Cheap | `haiku` | `low` | Mechanical search-and-report; running a command and summarising it |

**`model:` and `effort:` are Claude Code only — Cline cannot select either.**

**This table is a closed registry.** Every `.claude/agents/*.md` file in this
repo must have a row here, and every row must have a file — the guard in
`scripts/tests/review-gate-mechanism.test.mjs` checks **both** directions. A
new definition has exactly two legal paths: add its row (one line, and it
becomes a governed role), or keep the file out of `.claude/agents/`, which
`.gitignore` leaves untracked and unaffected. There is deliberately no third
path — no `# unmanaged` escape comment, no allowlist. An ungoverned definition
file is precisely what the declared effort norm exists to prevent, and a
registry with an opt-out is not a registry.

**Reasoning effort: `medium` is the declared repo-wide norm** — for these
roles, for the main session, and for CLI worker dispatch. Every role above
declares `effort:` explicitly, *including the two sitting at the norm*:
omitting the key inherits the dispatching session's effort, which is the
ungoverned behaviour the norm exists to end. `high` and above are deliberate,
work-shaped raises — see [Session-level effort drift](#session-level-effort-drift)
for which shapes earn which.

**Dispatching a CLI worker? Pass the flag.** `claude --effort medium`,
`copilot --effort medium`, `cline --thinking medium`. This is the same rule as
"declare it even at the norm", on a surface where the cost of omission is
documented rather than inferred: `cline --help` states that omitting
`--thinking` "leaves provider default" — an effort this repo neither declares
nor observes.

**No `tools:` list here is a security boundary.** `scout` omits the write
tools for hygiene — a search-and-report role has no business holding `Edit` —
but `Bash` can write files, so the omission buys tidiness, not enforcement.
The reviewer roles' no-writes prohibition lives where it actually works: prose
in `pr-review-gate`, enforced by its tree check.

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

**Escalation raises the model, not the effort — and here is why that is not
arbitrary.** Re-dispatch the **same** `subagent_type` with an explicit model
override (`Agent({subagent_type: 'implementer', model: 'opus'})`), which the
`Agent` tool's schema states takes precedence over the definition's `model:`.
Effort stays at the role's pinned value **because the `Agent` tool has no
effort parameter** — the asymmetry belongs to that surface, not to escalation
as an idea. On surfaces that do expose the axis (a worker CLI's `--effort`, a
`Workflow` stage's `opts.effort`) a retry can raise both. Stated with its
because-clause so a reader who has just used `Workflow` does not read the rule
as false and discount the rest.

**Opus is terminal.** A twice-failing `pr-reviewer` or `spec-checker` is
already at the top of the ladder and has no rung above it. That case escalates
**to the user** — the same place the review loop's cap routes an unresolved
disagreement.

## Session-level drift (main session's own model)

You cannot switch your own running model. When the current unit of work,
judged against the routing table above, matches a different row than the
model the active session is actually running, say so explicitly and ask
whether to switch — do not silently work through it on the "wrong" tier.

**"Drifted" means:** the current unit of work now matches a different table
row than the one the active session model sits on, by the same criteria used
for subagent dispatch above.

## Session-level effort drift

The same shape as the model-drift rule above, for the other axis: flag and
ask, never silent, never claim to have changed it.

Read `effortLevel` from the project's `.claude/settings.local.json` first,
then `~/.claude/settings.json`, and **state which file the value came from.**

| Band | Values | The session is doing |
|---|---|---|
| Mechanical | `low` | Running commands, transcribing a decided edit, formatting. |
| **Norm** | **`medium`** | **The declared default:** routine implementation against a settled plan, coordination, summarizing output. |
| Raised | `high` | Design and brainstorming, non-obvious debugging, triage of a failure whose cause is unknown. |
| Adversarial | `xhigh`, `max` | Hunting for what is *wrong*: an in-session review gate, an ambiguous defect hunt, an irreversible call. |

An integer `effortLevel` — legal per the harness schema — maps to the band
containing its nearest named level.

**"Drifted" means** the current unit of work sits in a different *band* than
the band containing the value read — not a different value, which would fire
on every routine shift. Raise it **once per unit of work**, not per step.

Two limits, stated rather than left implicit:

- The file holds the **configured** value. If the user says they changed it
  mid-session, their statement wins over the file.
- The reading is **reported, never acted on unilaterally.** You cannot set
  this, and must not imply you have.

**Honest limit — this rule is unenforceable, twice over.** `effortLevel`
lives outside version control, so no check this repo runs can see it; a
session is compliant only because someone chose to be. And both files it
reads are Claude Code's, so the rule is silently inapplicable to a Cline or
Copilot session — it does not misfire there, it never fires. On those lanes
the whole mechanism is passing `--effort`/`--thinking` explicitly at dispatch,
because there is no file to read afterwards and no band to compare against.

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

## PR review

Moved out of this file 2026-08-13. The sequence, the docs-only exemption, the
review-depth ladder, dispatch, the PR comment, findings triage, the re-review trigger
and loop cap, and issue verification at PR creation all live in
[`pr-review-gate`](../pr-review-gate/SKILL.md). Routing keeps routing; that file
owns the PR process.

The judgment-call carve-out below is shared by both review loops and stays here.

## Judgment-call carve-out (shared by both review loops)

A finding that requires a decision only the user can make (a genuinely
ambiguous or load-bearing assumption) suspends the fix-and-re-review loop
and routes through the normal ask-first behavior in `CLAUDE.md`'s "Think
before coding" — it does not get silently resolved just to keep the loop
moving. This is the same failure mode in both loops: an automated loop
mistaking a decision for a defect.
