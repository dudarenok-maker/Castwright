# Reasoning-effort routing & named dispatch roles

_Design spec — 2026-08-14_

Extends [2026-07-01-model-routing-and-review-gates-design.md](2026-07-01-model-routing-and-review-gates-design.md),
which established model-tier routing. That spec routes *which model*; this one
adds *how hard it thinks*, and gives both axes a mechanism that can be checked
rather than asserted.

## Problem

The routing table governs one axis — model tier — and reaches it through the
`Agent` tool's `model` parameter. Reasoning effort is the other axis of the same
decision and is currently ungoverned: every subagent this repo dispatches
inherits the dispatching session's effort, whatever it happens to be set to.

That produces three concrete failures, all named by the repo owner:

1. **Hard passes underthink.** The adversarial gates (`pr-review-gate`,
   `assumption-checker`) are the passes that catch evidence-level defects, and
   they run at whatever effort the session was left at.
2. **Cheap fan-out overthinks.** Mechanical search-and-report and
   summarize-output dispatches — routed to Haiku precisely because they have one
   right answer — still reason at full session effort.
3. **The session drifts.** `CLAUDE.md` has a session-level *model*-drift rule
   ("flag it, ask, never silently absorb"). There is no effort equivalent, so a
   session doing design work at `low`, or transcription at `xhigh`, goes
   unremarked.

A fourth problem surfaced while probing the first three, and is fixed here as an
incidental finding rather than filed: **the Cline mirror's links to
`model-routing` are dead** (see [Incidental finding](#incidental-finding-the-mirrors-dead-routing-links)).

This is a governance spec. No application code changes; the deliverables are
project instructions, six agent-definition files, one sync-script extension, and
one guard test.

## Verified mechanism facts

Every decision below rests on one of these. Each was checked on this box on
2026-08-14, not assumed — the predecessor spec's round-1 correction (a routing
rule that was "silently void" for forks) is the failure mode being avoided.

| # | Fact | How it was checked |
|---|---|---|
| M1 | The `Agent` tool has **no** `effort` parameter. Its properties are `description`, `isolation`, `model`, `prompt`, `subagent_type`. | The tool's own schema. |
| M2 | Agent-definition frontmatter **does** carry `effort:`, alongside `model:`. `model: inherit` is legal. | `claude-security/agents/patch-generator.md` in the installed plugin cache declares `model: inherit` + `effort: xhigh`. Tally across all installed definitions: `effort: xhigh` ×6, `effort: medium` ×1, `model: inherit` ×21. |
| M3 | Session effort is **readable**: `"effortLevel": "high"` in `~/.claude/settings.json`, sibling to `"model": "opus[1m]"`. | Read directly. |
| M4 | `.claude/agents/` is **git-ignored**. `.gitignore:33` is `.claude/*`; line 34 negates `!.claude/skills/` only. | `git check-ignore -v .claude/agents/pr-reviewer.md` → `.gitignore:33`. |
| M5 | Cline resolves skills from `~/.agents/skills/` only, **cannot select a subagent's model**, and its agent-definition resolution is **untested**. `~/.agents/agents/` does not exist. | [`docs/testing/agent-skill-resolution-probe.md`](../../testing/agent-skill-resolution-probe.md): `CLINE_TIER_SELECTABLE: no — observed deepseek-v4-flash`. Directory absence checked directly. |

M1 and M2 together are the load-bearing pair: **effort is not settable per
dispatch, only per role.** Every design decision follows from that.

## Decisions

1. **The tier table is not modified.** It answers a different question —
   ad-hoc dispatch and session judgment ("this work is Premium-shaped"). Roles
   do not map onto tiers 1:1 (two roles sit on Opus at different efforts), so an
   Effort column would assert a correspondence that does not exist. `model-routing`
   gains a **second table** for named roles instead, each row naming the tier it
   sits on so the two cannot drift apart conceptually.

2. **Six named roles, one definition file each,** under `.claude/agents/`.
   Dispatch changes from `Agent({model: 'opus'})` to
   `Agent({subagent_type: 'pr-reviewer'})`. The roster is taken from the dispatch
   surface `CLAUDE.md`'s execution model already describes, not invented:

   | Role | Tier | `model:` | `effort:` | `tools:` |
   |---|---|---|---|---|
   | `pr-reviewer` | Premium | opus | xhigh | Read, Glob, Grep, Bash |
   | `spec-checker` | Premium | opus | xhigh | Read, Glob, Grep, Bash, Skill |
   | `task-reviewer` | Default | sonnet | high | Read, Glob, Grep, Bash |
   | `implementer` | Default | sonnet | medium | Read, Write, Edit, Bash, Glob, Grep, Skill |
   | `fix-agent` | Cheap | haiku | medium | Read, Write, Edit, Bash, Glob, Grep |
   | `scout` | Cheap | haiku | low | Read, Glob, Grep |

   Four of those values are choices rather than transcription:

   - **`fix-agent` is `medium`, not `low`.** `CLAUDE.md` routes it to Haiku
     ("the typing is Haiku's"), but it owes a paired regression test that fails
     before the fix and passes after. This repo's most-repeated recorded failure
     is a red-phase test that could not have failed. Cheap model, not cheap
     reasoning.
   - **`scout` duplicates the built-in `Explore` agent, deliberately.**
     `Explore`'s model and effort come from its own definition, which this repo
     cannot set. A repo-local `scout` is what makes the Cheap row actually cheap.
   - **`xhigh`, not `max`, on the adversarial roles.** `max` is what
     `/code-review ultra` is for — user-triggered and billed. `xhigh` also
     matches the only precedent on this box (M2's `patch-generator`, itself an
     adversarial role).
   - **Both reviewer roles lose `Edit`/`Write`/`NotebookEdit`.** See decision 3.

3. **The reviewer roles' tool lists are a structural prohibition, not a
   replacement for the tree check.** `pr-review-gate` today enforces "never
   auto-apply" with a **post-hoc** `git rev-parse HEAD && git status --porcelain`
   comparison — it detects a violation after it happened. Removing the edit tools
   makes the common case impossible up front. The honest limit, stated in the
   skill rather than glossed: **both roles still need `Bash`** (`pr-reviewer` must
   run `gh pr comment`), and `Bash` can write files. So this reduces accidents; it
   does not close the hole. **The tree check stays, unchanged and still
   mandatory.**

4. **`.gitignore` gains `!.claude/agents/`,** mirroring the existing
   `!.claude/skills/` negation (M4). Not `git add -f` per file: force-add works
   once, then the *next* definition added silently vanishes — the recorded
   `.claude/`-is-ignored trap re-armed. This line is also what makes decision 7's
   guard test possible at all; an untracked definition is invisible to CI.

5. **`pr-review-gate`'s "effort ladder" is renamed to "review depth".** Pinning
   `effort: xhigh` on `pr-reviewer` (decision 2) contradicts that skill's existing
   `low`/`medium`/`high` ladder, which scales off the PR's commit type and is
   stamped into every PR comment header. They genuinely are two different things —
   one is a model setting, the other is prompt-stated scope — but a reader meeting
   `effort: xhigh` in the definition and `effort: low` in a comment header has no
   way to tell. One word, one meaning:

   - The ladder keeps its `low`/`medium`/`high` values and its commit-type
     derivation, unchanged. Only the noun changes.
   - The PR comment header becomes `## PR review — pass N (head <sha>, depth <level>)`.
   - **Accepted cost, stated rather than discovered later:** comments already on
     merged PRs (#2320 and others) say `effort <level>`. They are historical
     records and are not rewritten. `pr-review-gate` carries one sentence noting
     that comments before 2026-08-14 use the old noun for the same thing.
   - The word `effort` thereafter means only the model setting, repo-wide.

6. **A session-effort rule, mirroring the model-drift rule in shape.** Flag and
   ask; never silent; never claim to have changed it. Its input is real (M3):
   read `effortLevel` from project `.claude/settings.local.json` first, then
   `~/.claude/settings.json`, and **state which file the value came from.** Three
   bands:

   | Band | The session is doing |
   |---|---|
   | `low` | Mechanical work: running commands, transcribing a decided edit, formatting. |
   | `high` | The working default: coordination, debugging, triage, implementation. |
   | `xhigh` / `max` | Adversarial or design judgment in-session: spec design, an ambiguous defect hunt, an irreversible call. |

   **"Drifted" means** the current unit of work sits ≥1 band from the value read —
   by the same standard the model rule already uses, not "I would have phrased
   that differently." Two limits are stated in the skill, not left implicit: the
   file holds the **configured** value, so if the user changed it mid-session
   their statement wins over the file; and the reading is reported, never acted
   on unilaterally.

7. **A guard test keeps the table and the files honest.** In `scripts/tests/`,
   following the existing `review-gate-mechanism.test.mjs` idiom. For every row in
   the role table in `model-routing/SKILL.md`, assert:
   - a `.claude/agents/<name>.md` exists and is **tracked by git**;
   - its `name:`, `model:` and `effort:` frontmatter equal the row's values;
   - `pr-reviewer` and `spec-checker` list no `Edit`, `Write` or `NotebookEdit`
     in `tools:`;
   - every definition's `effort:` is one of `low`/`medium`/`high`/`xhigh`/`max`.

   The test parses the table out of the skill file and the frontmatter out of the
   definitions, and compares them **in both directions** — a definition file with
   no table row fails too. A row without a file is a routing instruction with no
   mechanism; a file disagreeing with the table is worse, because both look right
   in isolation.

8. **The Cline mirror is extended for skills, and probed before anything else.**
   Two halves with different evidence behind them (M5):
   - **Proven, ship it:** `model-routing/SKILL.md` joins
     `sync-agent-skills.mjs`'s `FILES` list. Cline demonstrably reads
     `~/.agents/skills/`. This also fixes the incidental finding below, and puts
     the role table where Cline can read it — with the `model:`/`effort:` columns
     marked **Claude Code only — Cline cannot select these**, exactly as
     `pr-review-gate` already marks its tier row.
   - **Unproven, do not mirror blind:** the six definition files are **not**
     mirrored in this round. Cline cannot select a subagent's model, and whether
     it resolves agent definitions at all was never probed. Writing six files
     carrying `model: opus` / `effort: xhigh` into a harness that can honour
     neither is a sync that reports six files written and changes nothing.
     Instead, a **second probe run** is appended to
     `docs/testing/agent-skill-resolution-probe.md`, asking whether `spawn_agent`
     accepts a persona/definition name, whether `~/.agents/agents/` is resolved,
     and whether `model:`/`effort:` frontmatter is honoured. Definitions are
     mirrored only for whatever the probe says lands. This is the same idiom that
     caught the original design's wrong workspace-mirror assumption.

## Incidental finding: the mirror's dead routing links

Found while checking decision 8, unrelated to the feature, **fixed in this round
rather than filed** per `CLAUDE.md`'s incidental-findings protocol.

`.claude/skills/pr-review-gate/` links to `../model-routing/SKILL.md` four times
— three in `SKILL.md`, one in `references/findings-triage.md` — including the
link that tells a reviewer which tier to dispatch at. `sync-agent-skills.mjs`
mirrors `pr-review-gate` only, so in `~/.agents/skills/` every one of those
resolves to a directory that is not there:

```
~/.agents/skills/pr-review-gate/{SKILL.md, references/}   present
~/.agents/skills/model-routing/                            ABSENT
```

Cline has been reading a runbook with dead routing references since the mirror
was created. Decision 8's first half is the fix; decision 7's guard test gains a
case asserting that **every relative cross-skill link in a mirrored file
resolves to a mirrored path**, so a future skill added to the mirror cannot
re-open the same hole.

## Footprint

| File | Change |
|---|---|
| `.claude/agents/*.md` ×6 | New — the roster |
| `.gitignore` | +1 line, `!.claude/agents/` |
| `.claude/skills/model-routing/SKILL.md` | Role table; session-effort rule |
| `.claude/skills/pr-review-gate/SKILL.md` | effort→depth rename; dispatch by `subagent_type` |
| `.claude/skills/pr-review-gate/references/*.md` | effort→depth where it appears |
| `CLAUDE.md` "Model routing" | Pointer + one sentence (it is the quick reference) |
| `scripts/sync-agent-skills.mjs` | `model-routing` joins the mirror |
| `scripts/tests/` | New guard test (decision 7) |
| `docs/testing/agent-skill-resolution-probe.md` | Second probe run (decision 8) |

## Testing

- **Guard test** (decision 7) — the primary automated coverage, in both
  directions, plus the mirrored-link case from the incidental finding.
- **`sync-agent-skills.mjs`** — its existing test file gains cases for the
  two-skill `FILES` list: `model-routing/SKILL.md` is written, its frontmatter
  stays the first line, and its provenance header is spliced below the
  frontmatter (the trap the script's own header documents).
- **No e2e, no on-box acceptance.** Nothing here crosses a router/redux/layout
  seam and nothing needs real hardware to prove.

## Explicitly out of scope

- **Release notes: skipped.** Process-only, no user- or operator-visible delta —
  the exemption `CLAUDE.md` before-shipping step 5 already names.
- **Reproducible/pinned gate depth.** Offered and **not** selected as a driver;
  the roles happen to pin effort, but nothing here is designed to guarantee a
  gate's depth is independent of the dispatching session.
- **Per-PR effort scaling for the reviewer** (three `pr-reviewer-{low,medium,high}`
  definitions). Considered and rejected: M1 means it would take three files to
  express, and the tier would no longer be pinned.
- **Mirroring the definitions to Cline.** Deferred to the probe (decision 8),
  not dropped.

## Open question deferred to implementation

Whether `.claude/settings.local.json` overrides `~/.claude/settings.json` for
`effortLevel` specifically was **not** verified — only that the user-level key
exists (M3). Decision 6 is written to read project-then-user and *state which
file it read*, which is correct under either precedence; the implementation
should confirm the precedence and record it in the skill.
