# Reasoning-Effort Routing & Named Dispatch Roles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give reasoning effort the same explicit, checkable routing that model tier already has — by pinning `model:` + `effort:` into six named agent-definition files, declaring `medium` the repo-wide norm, and guarding the whole thing with tests that actually run on the diffs they guard.

**Architecture:** Six `.claude/agents/*.md` definitions become the dispatch surface (`Agent({subagent_type: 'pr-reviewer'})` replaces `Agent({model: 'opus'})`). `model-routing/SKILL.md` gains a role table that is the **single registry** for those files — a definition without a table row, or a row without a definition, turns the build red in both directions. Nothing about the existing four-tier model table changes.

**Tech Stack:** Markdown skills/definitions, Node `node:test` guard tests (`npm run test:hooks`), `scripts/verify-cache.mjs` scope filtering, `scripts/sync-agent-skills.mjs` cross-agent mirror.

**Spec:** [`docs/superpowers/specs/2026-08-14-model-effort-routing-design.md`](../specs/2026-08-14-model-effort-routing-design.md) — rev 9, commit `b7cbc32f`. **Read it before starting.** This plan argues from it and does not restate its evidence; every decision number cited below (`decision 7`, `M6`, `F1`) resolves there.

---

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **Legal `effort:` values are `low`, `medium`, `high`, `xhigh`, `max`, **or an integer**.** The schema is a union with an int branch (M2). A guard that admits only the five names would fail a legal definition — revs 1–4 of the spec made exactly that mistake.
- **`medium` is the declared repo-wide norm** (decision 0b), for roles, sessions **and** CLI worker dispatch. Every role declares `effort:` explicitly *including the two sitting at the norm* — an absent key inherits the dispatching session's effort, which is the ungoverned behaviour this work exists to end.
- **The roster is exactly six roles**, with these exact values (decision 2). Do not add a seventh; do not change a value:

  | Role | `model:` | `effort:` | `tools:` |
  |---|---|---|---|
  | `pr-reviewer` | `opus` | `xhigh` | *(key omitted)* |
  | `spec-checker` | `opus` | `xhigh` | *(key omitted)* |
  | `task-reviewer` | `sonnet` | `high` | *(key omitted)* |
  | `implementer` | `sonnet` | `medium` | *(key omitted)* |
  | `fix-agent` | `haiku` | `medium` | *(key omitted)* |
  | `scout` | `haiku` | `low` | `Read, Glob, Grep, Bash` |

- **`model: inherit` is not used.** Legal, but `pr-reviewer`/`spec-checker` must land on Opus even when dispatched from a Sonnet session.
- **No `tools:` list is a security boundary.** `scout` omits write tools for *hygiene only* — `Bash` can write files. Claim nothing stronger anywhere in prose.
- **The PR-comment header becomes `## PR review — pass N (head <sha>, depth <level>)`** (decision 5). The word `effort` thereafter means only the model setting, repo-wide.
- **DO NOT touch the `#2320` citation** at `.claude/skills/pr-review-gate/SKILL.md:144`. The spec records a fabricated finding about it as **withdrawn** (F2). A pass that "fixes" it is repeating the error the record exists to prevent.
- **Existing PR comments are not rewritten.** 7 historical comments across #2339/#2337/#2350 read `effort high`; they are records.
- **`npm run skills:sync` is per-machine and CI cannot run it.** It must be run by hand after Tasks 5 and 6.
- **Scope discipline:** this is a governance change. **No application code changes.** If a task tempts you into `src/` or `server/`, stop — you have misread it.

## Convergence with the CLI-worker queue — reviewed, and the intake question is settled

The parallel Open Engine / Ringer session reviewed this plan against the spec on
2026-08-14. Its findings are folded in; two outcomes matter to anyone executing:

1. **The intake path is decided: declared-default-with-exceptions.** The queue is
   the default — anything with more than one step, or that will outlive a single
   session, goes through Open Engine sub-issues and executes on the `cline` CLI.
   `superpowers:subagent-driven-development` is reserved for same-session work the
   operator is actively watching. **This plan needs no rework under that answer**
   — `implementer` is not orphaned, it governs the minority path, and
   `sonnet`/`medium` remains right for it.
2. **Two execution-governance surfaces now exist, and they agree on the norm.**
   The `subagent_type` lane is governed by `.claude/agents/` (this plan); the
   queue lane by the Ringer engine config, which pins each engine's model and
   passes `--effort`/`--thinking` explicitly. Decision 0b holds on both. Task 3's
   role-table prose names the other surface so a reader editing `implementer`
   knows which lane they are *not* changing.

**The review also caught a blocking defect** — Tasks 3 and 4 were a split that
could not commit. They are now one task; see its banner for why, and do not
re-split it.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/verify-cache.mjs` | Adds `.claude/agents/**` to `test:hooks` globs — **without this nothing else in this plan is enforced** | 1 |
| `scripts/tests/verify-cache.test.mjs` | Locks that glob so it cannot be removed silently | 1 |
| `.gitignore` | `!.claude/agents/` negation, mirroring the existing skills one | 2 |
| `.claude/agents/*.md` ×6 | The roster — one file per role, `model:` + `effort:` pinned | 2 |
| `.claude/skills/model-routing/SKILL.md` | The role table (the registry), the session-effort rule, the escalation asymmetry, surface scoping | 3 |
| `CLAUDE.md` | The `medium`-norm sentence + link to the role table. **No second table** | 3 |
| `scripts/tests/review-gate-mechanism.test.mjs` | Bidirectional roster guard; retargeted depth assertion; mirrored-link case | 4, 5, 6 |
| `.claude/skills/pr-review-gate/SKILL.md` + `references/*.md` | effort→depth rename; `subagent_type` dispatch; why `tools:` is not the mechanism | 5 |
| `scripts/sync-agent-skills.mjs` | `model-routing` joins the mirror (fixes F1) | 6 |
| `docs/testing/agent-effort-resolution-probe.md` | **New** — the decision-0 record, greppable | 7 |
| `docs/testing/agent-skill-resolution-probe.md` | Second probe run appended (decision 9) | 7 |

**Landing order is load-bearing in five places:**

- **Task 3 is one commit and must stay one.** It writes an anchor and its target
  into the same file. Splitting them puts a dangling link in the tree at a moment
  `pre-commit` runs `test:hooks` — which is in scope, because the staged diff
  touches `.claude/skills/**` — so the link guard rejects the commit outright.
  This was a real defect in the first draft of this plan, caught in review.

- **Task 1 first.** M6: `test:hooks`'s globs do not cover `.claude/agents/**`. Until they do, a definitions-only diff prints `test:hooks [cached]` and runs nothing — locally *and* in cloud CI, since `ci-scope.mjs` derives from the same `STEPS[]`. Every guard added later would sit stale-green on exactly the diff that breaks it.
- **Task 2 before Task 4.** The bidirectional guard needs both the definitions and the table to exist, or it is red by construction.
- **Task 6's `FILES` change lands with its own guard case**, never after it. The mirrored-link case asserts every cross-skill link resolves to a path the mirror writes; `model-routing` is not such a path until `FILES` grows.
- **Tasks 5 and 6 run `npm run skills:sync` BEFORE their commit, not after** — both edit inputs to the mirror-drift test, which does *not* take its fails-open skip on a machine where `~/.agents/skills/` exists. A stale mirror is a red `test:hooks`, and both tasks stage paths that put `test:hooks` in scope, so the commit is refused. *(Ruled at pre-flight; the plan originally had the sync after the commit in both.)*

> **All four of the constraints above are one defect class**, found three separate
> times in this plan's own life: reasoning about what a guard *reports* without
> asking which hook *consumes* it. If you are about to write "this is
> intentionally red, the next step fixes it" — check `stepTouchedByDiff` for the
> paths you are staging first.

---

## Task 1: Scope wiring — `.claude/agents/**` becomes a `test:hooks` input

**Why first:** decision 8, the round-1 finding rated `Critical` + `Contradicted`. This is the task that makes every other task's guard real.

**Files:**
- Modify: `scripts/verify-cache.mjs:153` (append to the `test:hooks` `inputs.globs` array)
- Test: `scripts/tests/verify-cache.test.mjs:457` (append after the existing brand-new-skill-file case)

**Interfaces:**
- Consumes: nothing.
- Produces: `stepTouchedByDiff(stepByName['test:hooks'], ['.claude/agents/<anything>'])` returns `true`. Tasks 4–6 rely on this being true or their guards never run.

- [ ] **Step 1: Write the failing test**

Append to `scripts/tests/verify-cache.test.mjs`, immediately after the `'stepTouchedByDiff: a brand-new skill file is in scope for test:hooks'` test:

```js
test('stepTouchedByDiff: an agent-definition diff is in scope for test:hooks', () => {
  // decision 8 / M6. review-gate-mechanism.test.mjs reads .claude/agents/*.md
  // as TEXT at RUNTIME — no module-graph edge — so without this glob a
  // definitions-only diff (e.g. flipping pr-reviewer's `effort: xhigh` to
  // `low`, the single highest-value mutation anyone could make here) would
  // print test:hooks [cached] and gate nothing, locally AND in cloud CI,
  // since ci-scope.mjs derives from this same STEPS[]. Same #1847 trap the
  // fixtures/** and .claude/skills/** comments document at length.
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], ['.claude/agents/pr-reviewer.md']), true);
});

test('stepTouchedByDiff: an agent definition added later is in scope for test:hooks', () => {
  // The enumeration half, matching the brand-new-skill-file case above: the
  // glob must see a file that does not exist when it is written, or the next
  // role added needs hand-registering here and silently does not get it.
  assert.equal(stepTouchedByDiff(stepByName['test:hooks'], ['.claude/agents/some-future-role.md']), true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd C:/Claude/Projects/wt-model-effort-routing && node --test scripts/tests/verify-cache.test.mjs
```

Expected: **both new tests FAIL** with `Expected values to be strictly equal: false !== true`. Any other failure message means you edited the wrong thing — stop and reread.

- [ ] **Step 3: Add the glob**

In `scripts/verify-cache.mjs`, inside the `test:hooks` step's `inputs.globs` array, immediately after `'.claude/skills/**',` (line 153):

```js
        /* .claude/agents/** is an input for the same reason .claude/skills/**
           is: review-gate-mechanism.test.mjs reads the six role definitions as
           TEXT at RUNTIME to check them against model-routing's role table.
           Without this glob a definitions-only diff — flipping an `effort:`
           value being the obvious one — prints test:hooks [cached] and runs
           the guard on nothing, locally AND in cloud CI (ci-scope.mjs derives
           from this same STEPS[]). The guard would certify the value it just
           stopped checking. Same #1847 trap as fixtures/** above. */
        '.claude/agents/**',
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd C:/Claude/Projects/wt-model-effort-routing && node --test scripts/tests/verify-cache.test.mjs
```

Expected: PASS, whole file green.

- [ ] **Step 5: Commit**

```bash
cd C:/Claude/Projects/wt-model-effort-routing
git add scripts/verify-cache.mjs scripts/tests/verify-cache.test.mjs
git commit -m "build(scripts): scope test:hooks to .claude/agents/** so role guards actually run"
```

---

## Task 2: Track `.claude/agents/` and land the six role definitions

**Files:**
- Modify: `.gitignore:34` (add one line after `!.claude/skills/`)
- Create: `.claude/agents/pr-reviewer.md`, `spec-checker.md`, `task-reviewer.md`, `implementer.md`, `fix-agent.md`, `scout.md`

**Interfaces:**
- Consumes: Task 1's glob (so a later change to these files is actually checked).
- Produces: six tracked files whose frontmatter Task 4's guard reads. Exact keys: `name`, `description`, `model`, `effort`, and `tools` on `scout` only.

**Note on ordering:** the `.gitignore` line must land in the *same commit* as the definitions. `.claude/*` (line 33) ignores the directory wholesale — this is the recorded [`.claude/` is gitignored wholesale](../../../CLAUDE.md) trap. Without the negation, `git add .claude/agents/` silently adds nothing and Task 4's `git ls-files` assertion fails with a confusing message.

- [ ] **Step 1: Add the `.gitignore` negation**

In `.gitignore`, immediately after `!.claude/skills/`:

```gitignore
!.claude/agents/
```

Do **not** use `git add -f` per file instead. Force-add works once; the *next* definition added silently vanishes, re-arming the same trap.

- [ ] **Step 2: Verify the negation works before writing six files**

```bash
cd C:/Claude/Projects/wt-model-effort-routing
mkdir -p .claude/agents && echo "probe" > .claude/agents/_probe.tmp
git check-ignore -v .claude/agents/_probe.tmp; echo "exit=$?"
rm .claude/agents/_probe.tmp
```

Expected: **no output line, `exit=1`** (nothing matched, i.e. not ignored). If it prints `.gitignore:33:.claude/*`, the negation is wrong or in the wrong place — fix it before continuing.

- [ ] **Step 3: Write the two Premium adversarial roles**

`.claude/agents/pr-reviewer.md`:

```markdown
---
name: pr-reviewer
description: Adversarial PR reviewer for the mandatory pre-merge gate. Dispatch per the pr-review-gate skill, which owns the full runbook. Returns findings only — never applies them.
model: opus
effort: xhigh
---

You are running this repo's mandatory pre-merge PR review gate.

**Invoke the `pr-review-gate` skill and follow it exactly.** It owns the
sequence, the docs-only exemption, the review-depth ladder, the comment
format, findings triage, and the re-review loop. This definition pins only
*how you are dispatched* — model and reasoning effort — not what you do.

Two things this definition is responsible for, because they are properties of
the dispatch rather than of the runbook:

- **You report findings. You never apply them.** The tree check in
  `pr-review-gate` (`git rev-parse HEAD && git status --porcelain` before and
  after, any delta a gate failure) is the mechanism that holds you to it.
- **You are `xhigh`, not `max`.** `max` is what `/code-review ultra` is for —
  user-triggered and billed.
```

`.claude/agents/spec-checker.md`:

```markdown
---
name: spec-checker
description: Adversarial reviewer for specs and plans. Dispatch for the mandatory assumption-checker pass before the user is asked to approve a non-trivial spec or plan. Returns the skill's own tagged output, never a summary of it.
model: opus
effort: xhigh
---

You are running this repo's mandatory adversarial review of a spec or plan.

**Invoke the `assumption-checker` skill against the artifact and return its
actual output** — the evidence tags (`Confirmed` / `Contradicted` /
`Asserted` / `Unverifiable`) and load-bearing tags (`Critical` /
`Significant` / `Minor`) as the skill produced them. A hand-summarised
version defeats the gate: the tags are what the re-review trigger reads.

Never paraphrase the skill's posture instead of invoking it. `model-routing`
states this as a mechanism requirement, not a stylistic one.
```

- [ ] **Step 4: Write the two Default roles**

`.claude/agents/task-reviewer.md`:

```markdown
---
name: task-reviewer
description: Reviews a single completed implementation task against its spec and this repo's quality bar, between tasks in a subagent-driven-development run. Returns findings; does not fix.
model: sonnet
effort: high
---

You review ONE completed task from a plan — spec conformance and quality —
before the next task starts.

- **Check the task's stated acceptance criteria first**, then quality.
- **Report incidental findings; do not fix them.** `CLAUDE.md`'s
  incidental-findings protocol routes a finding to a *separately dispatched*
  fix agent. Widening your own diff is the thing that protocol exists to
  prevent.
- **A red-phase test that could not have failed is a finding**, not a pass.
  This repo's most-repeated recorded defect is a test whose red phase was
  never real — check that the test actually exercises the change.
```

`.claude/agents/implementer.md`:

```markdown
---
name: implementer
description: Implements one task from a plan, test-first, in an existing worktree and branch. The default execution role for subagent-driven development.
model: sonnet
effort: medium
---

You implement ONE task from a plan, exactly as written.

- **Test first.** Write the failing test, run it and confirm it fails **for
  the right reason**, then write the minimal code to pass.
- **Stay inside the task's file list.** Anything you notice outside it is a
  finding you report in your return value — not an edit. `CLAUDE.md`'s
  incidental-findings protocol dispatches a separate agent for it.
- **Match the surrounding code's style**, including comment density and
  naming, even where you would write it differently.
- **Report what you did not do.** A task you could not finish is reported as
  unfinished; do not narrow the scope silently.
```

- [ ] **Step 5: Write the two Cheap roles**

`.claude/agents/fix-agent.md`:

```markdown
---
name: fix-agent
description: Fixes one narrowly-scoped incidental finding — one finding, one fix, one paired regression test — briefed from the report that surfaced it.
model: haiku
effort: medium
---

You fix exactly ONE finding, briefed from the report that surfaced it.

- **One finding, one fix, one paired test.** Not "and while you're there."
- **The regression test must fail before your fix and pass after.** Run it
  before you write the fix and confirm the failure is the one your change
  addresses — a test that was already going to pass proves nothing, and is
  the single most-repeated defect in this repo's recorded history.
- **`medium`, not `low`, is deliberate** — cheap model, not cheap reasoning.
  The paired test is the part that needs the thinking.
```

`.claude/agents/scout.md`:

```markdown
---
name: scout
description: Mechanical search-and-report over the codebase — locate files, symbols, usages, or run a command and summarise its output. Returns findings; holds no write tools.
model: haiku
effort: low
tools: Read, Glob, Grep, Bash
---

You search and report. You do not change anything.

- **Return the conclusion, not the file dumps.** The dispatching session is
  paying context for your answer, which is the whole reason you exist.
- **Quote exact paths and line numbers** (`path/to/file.ts:123`) so the
  caller can act without re-searching.
- **Say what you did NOT find**, and where you looked. "I cannot check X" and
  "X is not there" are different answers and must not be conflated.

Your `tools:` list omits the write tools. That is **hygiene, not a security
boundary** — `Bash` can write files. It exists so a search-and-report role
does not reach for `Edit`, not to make reaching impossible.
```

- [ ] **Step 6: Verify all six are tracked**

```bash
cd C:/Claude/Projects/wt-model-effort-routing
git add .gitignore .claude/agents/
git status --short .claude/agents/
git ls-files .claude/agents/ | wc -l
```

Expected: six `A` lines in `git status`, and `6` from `git ls-files`. **If `git ls-files` prints `0`, the negation failed** — do not proceed; the guard in Task 4 depends on these being tracked.

- [ ] **Step 7: Commit**

```bash
cd C:/Claude/Projects/wt-model-effort-routing
git commit -m "feat(docs): add the six named dispatch roles and track .claude/agents/"
```

---

## Task 3: All of `model-routing`'s new prose, plus `CLAUDE.md`'s norm — **one commit**

> **This was two tasks until the convergence review.** The split had the role
> table commit first, linking a `#session-level-effort-drift` anchor the next
> task would create — and called the intervening dangling link "expected".
> **That commit cannot succeed.** `.husky/pre-commit` runs
> `verify:fast:scoped`, whose `--steps` include `test:hooks`, whose globs
> include `.claude/skills/**`. Staging `model-routing/SKILL.md` puts
> `test:hooks` in scope, the link guard fires on the dangling anchor, and the
> hook refuses the commit. `--no-verify` is forbidden. Verified, not inferred:
> `stepTouchedByDiff(test:hooks, ['.claude/skills/model-routing/SKILL.md'])`
> returns `true`.
>
> **Do not re-split this task.** If you must stage it in pieces, the anchor and
> its target have to land together in whichever piece commits first.

**Files:**
- Modify: `.claude/skills/model-routing/SKILL.md` — three insertions (role table; session-effort rule; escalation asymmetry)
- Modify: `CLAUDE.md` — the `## Model routing` section

**Interfaces:**
- Consumes: the six definitions from Task 2 (values must match exactly).
- Produces: a markdown table under the heading `## Named dispatch roles` whose rows Task 4's guard parses. **The guard's parser and this table's format are a contract** — Task 4 parses rows of the form `| \`name\` | Tier | \`model\` | \`effort\` | … |`.
- Produces: the heading `## Session-level effort drift`, which the role table's own prose links.

- [ ] **Step 1: Insert the role table section**

In `.claude/skills/model-routing/SKILL.md`, after the routing table (ending line 25) and before `## Escalation (subagent dispatch)`:

```markdown
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
```

**Do not commit yet.** The section you just wrote links
`#session-level-effort-drift`, which step 2 creates. Committing here is the
rejected commit the banner above describes.

- [ ] **Step 2: Add the session-effort rule**

In `.claude/skills/model-routing/SKILL.md`, immediately after the `## Session-level drift (main session's own model)` section (ending line 52) and before `## Mandatory adversarial review (specs & plans)`:

```markdown
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
```

- [ ] **Step 3: Add the escalation asymmetry**

Append to the end of `## Escalation (subagent dispatch)`, after the "silent/non-interrupting by design" paragraph:

```markdown
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
```

- [ ] **Step 4: Update `CLAUDE.md`'s Model routing section**

In `CLAUDE.md`, immediately after the four-row tier table and before the paragraph beginning "A subagent that fails twice on its assigned tier", insert:

```markdown
**Reasoning effort is the second axis, and `medium` is this repo's declared
norm** — for dispatched roles, for the main session, and for CLI worker
dispatch (`claude --effort`, `copilot --effort`, `cline --thinking`; pass it
explicitly, since omitting it inherits an undeclared default). `high` and
above are deliberate, work-shaped raises rather than a resting state. Dispatch
by named role — `Agent({subagent_type: 'pr-reviewer'})` — rather than by raw
`model:`; the six roles and their pinned `model:`/`effort:` values live in the
role table in
[`.claude/skills/model-routing/SKILL.md`](.claude/skills/model-routing/SKILL.md),
which is also the registry every `.claude/agents/*.md` file must appear in.
```

**Do not add a second role table to `CLAUDE.md`.** That section is the quick
reference; a third home for the same six rows is exactly the drift this work
is closing. The norm sentence is the one thing worth putting there, because it
is what every other statement of effort is relative to.

- [ ] **Step 5: Run the link guard — it must be fully green before you commit**

```bash
cd C:/Claude/Projects/wt-model-effort-routing && node --test scripts/tests/review-gate-mechanism.test.mjs
```

Expected: **whole file green, zero dangling links.** This is not a courtesy check — `test:hooks` is in scope for this staged diff, so pre-commit runs this same file and a red result *rejects the commit*. If `#session-level-effort-drift` still dangles, the heading text does not match the anchor: GitHub slugs `## Session-level effort drift` to `session-level-effort-drift`.

- [ ] **Step 6: Commit — everything from steps 1–4 in one commit**

```bash
cd C:/Claude/Projects/wt-model-effort-routing
git add .claude/skills/model-routing/SKILL.md CLAUDE.md
git commit -m "docs(docs): add the role registry, session-effort rule, and the medium norm"
```

Expect pre-commit to actually run `test:hooks` here (not `[skip] … (out of scope)`) — that is the gate this task was restructured around. If it skips, `.claude/skills/**` is missing from the step's globs, which would be a separate defect worth reporting before continuing.

---

## Task 4: The bidirectional roster guard

**Files:**
- Modify: `scripts/tests/review-gate-mechanism.test.mjs` (append new tests; add two constants near the existing path constants at lines 44–48)

**Interfaces:**
- Consumes: Task 2's six definitions, Task 3's role table.
- Produces: `parseRoleTable()` and `readAgentFrontmatter()` — module-local helpers, not exported.

**This is the task the whole plan exists to make real.** Its red phase must be proven by **mutation**, not by absence: the guard is written against a tree where everything already passes, so "it fails before" has to be demonstrated by breaking something on purpose and putting it back.

- [ ] **Step 1: Add the constants and helpers**

After `const CLAUDE_MD_PATH = ...` (line 48) in `scripts/tests/review-gate-mechanism.test.mjs`:

```js
const AGENTS_DIR = join(REPO_ROOT, '.claude', 'agents');

/** Legal `effort:` values per the harness's own schema: five named levels OR
 *  an integer (`Cs([Nr(["low","medium","high","xhigh","max"]), at().int()])`).
 *  The int branch is admitted deliberately even though this repo uses no
 *  integer efforts today — a guard that rejects what the harness accepts is a
 *  guard that gets deleted the first time someone legitimately needs one. */
const NAMED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
function isLegalEffort(value) {
  return NAMED_EFFORTS.includes(value) || /^\d+$/.test(value);
}

/** Parses the role table out of model-routing/SKILL.md. Rows look like:
 *    | `pr-reviewer` | Premium | `opus` | `xhigh` | Dispatch for … |
 *  Derived, never hand-listed here: a literal roster in this file would be a
 *  third copy of the same six rows, which is the drift this guard exists to
 *  catch. */
function parseRoleTable() {
  const src = readNormalized(ROUTING_SKILL_PATH);
  const section = /\n## Named dispatch roles\n([\s\S]*?)(?=\n## )/.exec(src);
  assert.ok(section, 'model-routing/SKILL.md has no "## Named dispatch roles" section');
  const rows = [];
  for (const line of section[1].split('\n')) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/.exec(line);
    if (m) rows.push({ name: m[1], tier: m[2], model: m[3], effort: m[4] });
  }
  return rows;
}

/** Reads an agent definition's YAML frontmatter into a flat key→string map.
 *  readNormalized, not readFileSync: the frontmatter regex needs a literal
 *  '\n---', which misses on a CRLF checkout (#2291). */
function readAgentFrontmatter(name) {
  const path = join(AGENTS_DIR, `${name}.md`);
  assert.ok(existsSync(path), `missing agent definition ${path}`);
  const fm = /^---\n([\s\S]*?)\n---/.exec(readNormalized(path));
  assert.ok(fm, `${name}.md has no --- frontmatter block`);
  return Object.fromEntries(
    fm[1]
      .split('\n')
      .map((l) => /^([a-z-]+):\s*(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
}
```

- [ ] **Step 2: Write the guard tests**

Append after the `'model-routing/SKILL.md no longer carries the moved PR-review sections'` test:

```js
test('the role table is non-empty and parses', () => {
  // The green-on-awkward-input case, matching githubAnchor's above. Without
  // it, every assertion below is vacuously true the moment the table heading
  // is renamed or the row format drifts: an empty rows[] passes each of them
  // by iterating nothing. This is the assertion that makes the others able
  // to fail at all.
  const rows = parseRoleTable();
  assert.equal(rows.length, 6, `expected 6 roles in the table, parsed ${rows.length}`);
});

test('every role-table row has a tracked definition file whose frontmatter matches', () => {
  const tracked = new Set(
    execFileSync('git', ['ls-files', '.claude/agents'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((p) => basename(p, '.md')),
  );
  for (const row of parseRoleTable()) {
    assert.ok(
      tracked.has(row.name),
      `.claude/agents/${row.name}.md is not tracked by git — an untracked ` +
        'definition is invisible to CI, so the guard would certify a file no ' +
        'other machine has. Check .gitignore carries !.claude/agents/',
    );
    const fm = readAgentFrontmatter(row.name);
    assert.equal(fm.name, row.name, `${row.name}.md frontmatter name: disagrees with its filename`);
    assert.equal(fm.model, row.model, `${row.name}.md model: is ${fm.model}, table says ${row.model}`);
    assert.equal(fm.effort, row.effort, `${row.name}.md effort: is ${fm.effort}, table says ${row.effort}`);
    assert.ok(
      isLegalEffort(fm.effort),
      `${row.name}.md effort: "${fm.effort}" is not a named level or an integer`,
    );
  }
});

test('every definition file has a role-table row — the registry is closed', () => {
  // The reverse direction, and the one with teeth: without it a definition
  // can be added with any model/effort it likes and nothing notices, which
  // makes the "table is the registry" claim in model-routing false.
  const named = new Set(parseRoleTable().map((r) => r.name));
  const onDisk = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => basename(f, '.md'));
  const orphans = onDisk.filter((n) => !named.has(n));
  assert.deepEqual(
    orphans,
    [],
    `agent definitions with no row in model-routing's role table: ${orphans.join(', ')}. ` +
      'Add a row (it becomes a governed role) or move the file out of .claude/agents/.',
  );
});

test('scout holds no write tool', () => {
  const fm = readAgentFrontmatter('scout');
  assert.ok(fm.tools, 'scout.md declares no tools: key — it is the one role that must');
  for (const writeTool of ['Edit', 'Write', 'NotebookEdit']) {
    assert.doesNotMatch(
      fm.tools,
      new RegExp(`\\b${writeTool}\\b`),
      `scout.md lists ${writeTool} — a search-and-report role must not hold it`,
    );
  }
});
```

- [ ] **Step 3: Add the `execFileSync` import**

The tracked-files assertion needs it. Change line 37–40's import block by adding:

```js
import { execFileSync } from 'node:child_process';
```

- [ ] **Step 4: Run — expect GREEN, then prove the guard can go red**

```bash
cd C:/Claude/Projects/wt-model-effort-routing && node --test scripts/tests/review-gate-mechanism.test.mjs
```

Expected: PASS. That is *not* evidence the guard works. Prove it with four mutations, **one at a time**, restoring between each:

```bash
cd C:/Claude/Projects/wt-model-effort-routing

# Mutation A — a value drifts between file and table
sed -i 's/^effort: xhigh/effort: low/' .claude/agents/pr-reviewer.md
node --test scripts/tests/review-gate-mechanism.test.mjs 2>&1 | grep -c "table says xhigh"
git checkout .claude/agents/pr-reviewer.md

# Mutation B — an ungoverned definition appears
printf -- '---\nname: rogue\nmodel: opus\neffort: max\n---\n' > .claude/agents/rogue.md
node --test scripts/tests/review-gate-mechanism.test.mjs 2>&1 | grep -c "no row in model-routing"
rm .claude/agents/rogue.md

# Mutation C — scout gains a write tool
sed -i 's/^tools: Read, Glob, Grep, Bash/tools: Read, Glob, Grep, Bash, Edit/' .claude/agents/scout.md
node --test scripts/tests/review-gate-mechanism.test.mjs 2>&1 | grep -c "scout.md lists Edit"
git checkout .claude/agents/scout.md

# Mutation D — the table heading is renamed (the vacuous-pass case)
sed -i 's/^## Named dispatch roles/## Roles/' .claude/skills/model-routing/SKILL.md
node --test scripts/tests/review-gate-mechanism.test.mjs 2>&1 | grep -c "has no \"## Named dispatch roles\" section"
git checkout .claude/skills/model-routing/SKILL.md
```

Expected: each `grep -c` prints **≥1**. A `0` means that mutation passed the guard — fix the guard, not the mutation. **Do not skip mutation D**: it is the one that catches a guard which silently checks nothing.

- [ ] **Step 5: Confirm the tree is clean, then commit**

```bash
cd C:/Claude/Projects/wt-model-effort-routing
git status --porcelain   # must show ONLY scripts/tests/review-gate-mechanism.test.mjs
node --test scripts/tests/review-gate-mechanism.test.mjs
git add scripts/tests/review-gate-mechanism.test.mjs
git commit -m "test(scripts): guard the role registry in both directions"
```

---

## Task 5: Rename `pr-review-gate`'s effort ladder to review depth

**Files:**
- Modify: `.claude/skills/pr-review-gate/SKILL.md` — lines 3 (description), 39 (heading), 41, 148 (comment header), 232–233
- Modify: `.claude/skills/pr-review-gate/references/reviewer-brief.md:106`
- Modify: `.claude/skills/pr-review-gate/references/findings-triage.md:107`
- Modify: `.claude/skills/model-routing/SKILL.md` — one phrase, see step 4b (locate by search; Task 3 shifted this file's line numbers)
- Modify: `docs/features/235-model-routing-review-gates.md` — one phrase, see step 4b
- Modify: `scripts/tests/review-gate-mechanism.test.mjs:108–116` — **the existing assertion reads `## Effort level` and will go red the moment you rename the heading. Retargeting it is part of this task, not a follow-up.**

**Interfaces:**
- Consumes: nothing.
- Produces: heading `## Review depth`, anchor `#review-depth`, header format `## PR review — pass N (head <sha>, depth <level>)`.

- [ ] **Step 1: Rename the heading and its prose**

`.claude/skills/pr-review-gate/SKILL.md:39–43` becomes:

```markdown
## Review depth

For every non-exempt PR, **review depth** scales with the PR's commit
type/scope, reusing CONTRIBUTING.md's existing commit-convention vocabulary
rather than a new classification:
```

Leave the three bullets (`low` / `medium` / `high`) and the mixed-commit rule
below it **unchanged** — the ladder keeps its values and its derivation. Only
the noun changes.

- [ ] **Step 2: Add the disambiguation and migration sentences**

Immediately after the `ultra` paragraph that closes the section (line 56):

```markdown
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
```

- [ ] **Step 3: Change the comment header format**

`.claude/skills/pr-review-gate/SKILL.md:148`:

```markdown
## PR review — pass N (head <sha>, depth <level>)
```

`.claude/skills/pr-review-gate/references/reviewer-brief.md:106` — same substitution in the `Heading:` line:

```markdown
Heading: `## PR review — pass N (head <sha>, depth <level>)`. The head SHA is
```

- [ ] **Step 4: Update the two remaining prose references**

`.claude/skills/pr-review-gate/SKILL.md:232–233`:

```markdown
  rather than firing on every push. Re-review re-derives the review depth
  from the PR's current commit set (per [Review depth](#review-depth))
```

`.claude/skills/pr-review-gate/references/findings-triage.md:107`:

```markdown
  Re-review re-derives the review depth from the
```

`.claude/skills/pr-review-gate/SKILL.md:3` (frontmatter `description:`) — change `the effort ladder` to `the review-depth ladder`. **Change nothing else in that line**; it is one long single-line value.

- [ ] **Step 4b: Fix the two sentences OUTSIDE `pr-review-gate` that this rename makes false**

*(Added during execution. The rename's blast radius reaches two files the
original step list never named — both describe `pr-review-gate`'s contents in
the present tense, so after the rename both assert a section that no longer
exists. `CLAUDE.md`'s rule is explicit that a comment your change made false is
a chore, not taste, and is fixed in the same round.)*

1. **`.claude/skills/model-routing/SKILL.md`**, in the `## PR review` section
   that lists what moved out of that file on 2026-08-13. It reads
   *"…the docs-only exemption, the effort ladder, dispatch, the PR comment…"* —
   change `the effort ladder` to `the review-depth ladder`. **Find it by
   searching for the phrase, not by line number**: Task 3 inserted two sections
   into this file, so every line number below its role table has moved.
2. **`docs/features/235-model-routing-review-gates.md`**, the line reading
   *"which is now the full runbook (preconditions, exemption, effort ladder,"* —
   same one-word change. This is an **active** plan (not under `archive/`), and
   the sentence describes the runbook as it *is*, so it is live prose rather
   than a historical record.

**Do not go hunting further than these two.** They were found by
`grep -rn "effort ladder" --include="*.md"` across the repo; that grep is the
complete list. In particular, the seven historical **PR comments** carrying
`effort <level>` are deliberately NOT rewritten — step 2's migration sentence
exists precisely to leave them alone.

- [ ] **Step 5: Add the sentence recording why `tools:` is not the mechanism**

In the section that describes the reviewer's no-writes prohibition (search for the tree check, `git status --porcelain`), append:

```markdown
**The reviewer's `tools:` list is not what stops it writing**, and was
deliberately not used for that. Stripping `Write` from the role would make
this skill's own mandated path — `gh pr comment --body-file <file>`, which
requires creating a file — run through a Bash heredoc instead, i.e. it would
make routing around the restriction the normal, unremarkable happy path.
`Bash` can write files regardless. The prohibition stays prose, and the tree
check above is its enforcement.
```

- [ ] **Step 6: Retarget the existing guard assertion**

`scripts/tests/review-gate-mechanism.test.mjs` — change the test name on line 92 and the ladder block at 108–116:

```js
test('pr-review-gate/SKILL.md carries the dispatch mechanism and the review-depth ladder', () => {
```

```js
  const ladder = /\n## Review depth\n([\s\S]*?)(?=\n## )/.exec(src);
  assert.ok(ladder, 'pr-review-gate/SKILL.md has no "## Review depth" section');
  for (const level of ['low', 'medium', 'high']) {
    assert.match(
      ladder[1],
      new RegExp('`' + level + '`'),
      `the review-depth ladder no longer names \`${level}\``,
    );
  }
```

Also update the file-header comment at line 19 — it says "carries the dispatch mechanism and the effort ladder" — to read "the review-depth ladder".

- [ ] **Step 7: Re-sync the mirror BEFORE running the guard or committing**

```bash
cd C:/Claude/Projects/wt-model-effort-routing && npm run skills:sync
```

**This is not bookkeeping you can defer to after the commit.** You just edited the
canonical `pr-review-gate/*` files, and `review-gate-mechanism.test.mjs`'s
mirror-drift test asserts `mirrored === buildMirrorContent(canonical)`. On any
machine where `~/.agents/skills/` exists, that test does **not** take its
fails-open skip — it compares, finds the mirror stale, and goes red. This task
stages `.claude/skills/**` and `scripts/**`, both of which put `test:hooks` in
scope at `pre-commit`, so a stale mirror means **the commit is refused**.

*(Ruling made at pre-flight scan: the plan originally had this at step 9, after
the commit. Same defect class as the merged-task banner in Task 3 — reasoning
about a guard's output without asking which hook consumes it.)*

- [ ] **Step 8: Run the guard**

```bash
cd C:/Claude/Projects/wt-model-effort-routing && node --test scripts/tests/review-gate-mechanism.test.mjs
```

Expected: green, including the link test — `#review-depth` must resolve, since step 4 links it — and the mirror-drift test, which step 7 just made current.

- [ ] **Step 9: Confirm no stray "effort" remains in the depth sense**

```bash
cd C:/Claude/Projects/wt-model-effort-routing && grep -rn -i "effort" .claude/skills/pr-review-gate/
```

Expected: matches only in (a) the new "not effort" disambiguation paragraph, (b) the historical-comments sentence, and (c) `reviewer-brief.md:9`'s "don't reward effort", which is unrelated English. **Any other match is a missed rename.**

- [ ] **Step 10: Commit**

```bash
cd C:/Claude/Projects/wt-model-effort-routing
git add .claude/skills/pr-review-gate/ \
        .claude/skills/model-routing/SKILL.md \
        docs/features/235-model-routing-review-gates.md \
        scripts/tests/review-gate-mechanism.test.mjs
git commit -m "docs(docs): rename pr-review-gate's effort ladder to review depth"
```

**All six edited files go in this one commit** — the four paths above cover
`pr-review-gate/SKILL.md` plus its two `references/*.md`, step 4b's two files,
and the retargeted test. *(The step-4b files were missing from this `git add`
when step 4b was first added; the executing implementer caught it and committed
all six rather than leaving two required edits behind. Fixed here so the next
reader of this plan is not handed the same trap. The general lesson: when a step
is inserted into a task, its files must be added to that task's `git add` in the
same edit — an insertion that only appears in the prose is half-applied.)*

The mirror was already re-synced in step 7 — that ordering is load-bearing, not
stylistic. `skills:sync` is per-machine and CI cannot run it.

---

## Task 6: `model-routing` joins the cross-agent mirror (fixes F1)

**Why:** `.claude/skills/pr-review-gate/` links `../model-routing/SKILL.md` four times — three in `SKILL.md`, one in `references/findings-triage.md`, including the link that names which tier to dispatch at. The mirror carries only `pr-review-gate`, so in `~/.agents/skills/` every one of those resolves to a directory that is not there. **Cline has been reading a runbook with dead routing references since the mirror was created.**

**Files:**
- Modify: `scripts/sync-agent-skills.mjs` — `FILES` becomes skill-qualified
- Modify: `scripts/tests/review-gate-mechanism.test.mjs` — generalise the mirror test; add the mirrored-link case

**Interfaces:**
- Consumes: `buildMirrorContent(canonicalContent, rel)`, `syncOneFile(srcPath, destPath, rel)` — both already exported.
- Produces: `rel` becomes **skill-qualified** (`'pr-review-gate/SKILL.md'`, `'model-routing/SKILL.md'`) instead of skill-relative (`'SKILL.md'`). This changes the exported functions' contract — every existing caller and test that passes a bare `'SKILL.md'` must be updated in this same task. Also newly exports `FILES`, so the guard derives the mirrored set instead of restating it.

- [ ] **Step 1: Restructure `FILES` to be skill-qualified**

In `scripts/sync-agent-skills.mjs`, replace the `SKILL_NAME` / `CANONICAL_ROOT` / `MIRROR_ROOT` / `FILES` block (lines 33–37):

```js
const SKILLS_ROOT = join(REPO_ROOT, '.claude', 'skills');
const MIRROR_ROOT = join(homedir(), '.agents', 'skills');

/** Skill-QUALIFIED relative paths, mirroring the store's own layout. Was a
 *  bare list under one skill root until 2026-08-14, when model-routing joined:
 *  pr-review-gate links ../model-routing/SKILL.md four times, including the
 *  link naming which tier to dispatch at, and every one of them resolved to a
 *  directory the mirror did not write. Cline had been reading a runbook with
 *  dead routing references since the mirror was created. */
export const FILES = [
  'pr-review-gate/SKILL.md',
  'pr-review-gate/references/reviewer-brief.md',
  'pr-review-gate/references/findings-triage.md',
  'model-routing/SKILL.md',
];
```

**`export`, not module-local.** The guard in step 5 must import this list rather
than restate it: a hand-copied second roster in the test is the same
enumeration trap the `.claude/skills/**` glob comment documents — the next file
added to the mirror would be checked by neither copy noticing it was missing
from the other.

- [ ] **Step 2: Update `header()` and the SKILL.md check for qualified paths**

`header(rel)` — the canonical-source line no longer needs `SKILL_NAME`:

```js
    `     Canonical source: <repo>/.claude/skills/${rel}\n` +
```

In `syncOneFile`, the frontmatter check keys on the basename now:

```js
  if (basename(rel) === 'SKILL.md' && !mirrored.startsWith('---\n')) {
```

Add `basename` to the `node:path` import at line 27.

- [ ] **Step 3: Update `syncAgentSkills()` to use the qualified paths**

```js
export function syncAgentSkills() {
  const written = [];
  for (const rel of FILES) {
    written.push(syncOneFile(join(SKILLS_ROOT, rel), join(MIRROR_ROOT, rel), rel));
  }
  return written;
}
```

Also update the module header comment (lines 1–12) — it says the script mirrors `pr-review-gate` only, which is about to be false, and the trailing `console.log` hint at line 148 says "after any change under .claude/skills/pr-review-gate/".

- [ ] **Step 4: Update the four `buildMirrorContent` unit tests**

In `scripts/tests/review-gate-mechanism.test.mjs`, the four tests near line 472 pass a bare `'SKILL.md'` / `'references/reviewer-brief.md'`. Qualify them: `'pr-review-gate/SKILL.md'`, `'pr-review-gate/references/reviewer-brief.md'`. The assertions themselves do not change.

- [ ] **Step 5: Generalise the mirror-drift test**

Replace the `MIRRORED_SKILL` constant and the hardcoded three-file loop (lines 362, 370–394):

Change the import at line 42 to pull the list in rather than restate it:

```js
import { FILES as MIRRORED_FILES, buildMirrorContent, syncOneFile } from '../sync-agent-skills.mjs';
```

Then:

```js
test('the agent-store mirror matches its canonical source, when it exists', () => {
  // FAILS OPEN BY CONSTRUCTION, and that is not an oversight. The target is
  // in $HOME: absent on a fresh clone and in CI. Making this a hard failure
  // would turn every never-synced machine red. The trade is deliberate — but
  // it means a GREEN run here proves nothing about a machine that has not
  // synced, so never report this as "the mirror is in sync".
  if (!existsSync(AGENT_SKILL_STORE)) {
    console.log(`[skip] no agent-store mirror at ${AGENT_SKILL_STORE} — run npm run skills:sync`);
    return;
  }
  for (const rel of MIRRORED_FILES) {
    const mirrored = join(AGENT_SKILL_STORE, rel);
    assert.ok(existsSync(mirrored), `mirror is missing ${rel} — run npm run skills:sync`);
    assert.equal(
      readNormalized(mirrored),
      buildMirrorContent(readNormalized(join(REPO_ROOT, '.claude', 'skills', rel)), rel),
      `${rel} has drifted from its canonical copy — run npm run skills:sync`,
    );
  }
});
```

- [ ] **Step 6: Add the mirrored-link guard case (the F1 regression test)**

Append after the mirror-drift test:

```js
test('every cross-skill link in the mirrored output resolves to a path the mirror also writes', () => {
  // Computed from buildMirrorContent's return value and the FILES list — NOT
  // by reading ~/.agents/skills/, which does not exist in CI. A disk-based
  // check here would skip exactly as the mirror-drift test above does, i.e.
  // it would never run on the machine that gates the merge, which is the
  // whole reason F1 survived unnoticed since the mirror was created.
  const mirroredPaths = new Set(MIRRORED_FILES);
  const broken = [];
  for (const rel of MIRRORED_FILES) {
    const content = buildMirrorContent(readNormalized(join(REPO_ROOT, '.claude', 'skills', rel)), rel);
    for (const [, relPath] of stripFencedBlocks(content).matchAll(INTRA_REPO_MD_LINK)) {
      // `rel` is already skills-root-relative, so resolve the link inside that
      // root and compare exactly — no suffix matching.
      const target = posix.normalize(posix.join(posix.dirname(rel), relPath));
      // A link that ESCAPES the skills root is a repo document (CLAUDE.md,
      // CONTRIBUTING.md, a spec under docs/). The mirror never writes those and
      // never should: the provenance header buildMirrorContent splices in says
      // outright that relative links resolve against a Castwright checkout. Not
      // a defect, so not a finding.
      if (target.startsWith('../')) continue;
      if (!mirroredPaths.has(target)) {
        broken.push(`${rel} -> ${relPath} (mirror does not write this path)`);
      }
    }
  }
  assert.deepEqual(broken, [], `mirrored cross-skill links with no mirrored target:\n  ${broken.join('\n  ')}`);
});
```

- [ ] **Step 7: Prove this case would have caught F1**

The whole point is that it fails on the pre-fix `FILES`. Demonstrate it:

**Save and restore by hand — do NOT use `git checkout` here.** *(Corrected
during execution. This step used to say "the mutation is one line in the script,
and the test file is untouched — so restoring it cannot revert your work." That
is **wrong**: steps 1–3 edit that same script, and at this point none of it is
committed, so `git checkout scripts/sync-agent-skills.mjs` throws away all of it.
The executing implementer hit exactly that and had to redo steps 1–3. The
mutation was moved off the test file to protect the test file, and I then forgot
that the script is where the rest of the work lives.)*

```powershell
Set-Location C:\Claude\Projects\wt-model-effort-routing
$f = 'scripts/sync-agent-skills.mjs'
$saved = Get-Content $f -Raw -Encoding utf8            # save YOUR work, not git's
(Get-Content $f -Encoding utf8) -notmatch "^\s*'model-routing/SKILL\.md',\s*$" |
  Set-Content $f -Encoding utf8                        # pre-fix state
node --test scripts/tests/review-gate-mechanism.test.mjs 2>&1 |
  Select-String -Pattern 'mirror does not write this path' |
  ForEach-Object { $_.Line }                           # READ these, do not count them
Set-Content -Path $f -Value $saved -NoNewline -Encoding utf8   # restore YOUR version
git diff --stat $f                                     # must show your steps 1-3 still present
```

**Expected: 4 distinct broken links** — the three `../model-routing/SKILL.md`
links in `pr-review-gate/SKILL.md` plus the one in `references/findings-triage.md`,
which is precisely the set F1 describes.

**Do not count with `grep -c`.** *(Also corrected during execution: the original
said `grep -c` and expected 4, and it returned **9**. `grep -c` counts OUTPUT
LINES containing the phrase, and node's test reporter prints the same finding
several times — assertion message, diff block, and the one-line array. Nine
lines, four findings. The implementer diagnosed it correctly and verified 4 via
the captured array; the controller confirmed 4 independently with a standalone
reproduction. **The instrument was miscalibrated, not the guard** — which is the
same class of defect this plan's own guards exist to catch, committed in the
plan's own verification step.)*

Read the printed lines and count the **distinct** `rel -> relPath` pairs. Four,
and all four naming `model-routing/SKILL.md`, is the pass. A `0` means the case
never reaches those links; anything else means the resolution logic is off — fix
the guard, not the mutation.

> **The logic above was pre-verified by the controller against the real files
> before this task was dispatched** *(ruling at Task 2 time)*. The first draft
> filtered on `relPath.includes('../')`, intending "links that leave this
> skill's directory" — but that also matches `../../../CLAUDE.md`, and the
> mirror neither writes nor should write repo-root docs. Measured: that version
> reported **9 broken links on the correct post-fix state**, i.e. it was red on
> success. The version now in step 6 measures 0 post-fix and exactly 4 pre-fix.
> It also covers same-skill links (`references/*.md`), which the old filter
> skipped — so the guard is strictly stronger, and the old comment claiming
> those were "covered by the repo-side link test" is gone with it.

Add `posix` to the `node:path` import at the top of the file if it is not already there; `resolve`/`dirname` remain in use elsewhere.

- [ ] **Step 8: Sync FIRST, then run everything, then commit**

**The order below is load-bearing** *(ruling made at pre-flight scan; the plan
originally ran `test:hooks` before `skills:sync`)*. This task does two things
that stale every mirrored file at once: it adds `model-routing/SKILL.md` to
`FILES`, and it changes the provenance header format for **all** of them. Until
`skills:sync` runs, the mirror-drift test compares a stale mirror against a
changed builder and goes red — and this task stages `scripts/**`, which puts
`test:hooks` in scope at `pre-commit`, so the commit would be refused.

```bash
cd C:/Claude/Projects/wt-model-effort-routing
npm run skills:sync
ls ~/.agents/skills/model-routing/SKILL.md   # must now exist
npm run test:hooks
git add scripts/sync-agent-skills.mjs scripts/tests/review-gate-mechanism.test.mjs
git commit -m "fix(scripts): mirror model-routing so pr-review-gate's routing links resolve for Cline"
```

---

## Task 7: The two probe records

**Files:**
- Create: `docs/testing/agent-effort-resolution-probe.md`
- Modify: `docs/testing/agent-skill-resolution-probe.md` (append a section)

**Interfaces:** none — documentation only.

- [ ] **Step 1: Write the effort-resolution probe record**

Create `docs/testing/agent-effort-resolution-probe.md`:

```markdown
# Agent effort-resolution probe (2026-08-14)

Run to decide whether `.claude/agents/*.md` can pin reasoning effort at all,
per [the effort-routing design](../superpowers/specs/2026-08-14-model-effort-routing-design.md).
The roster was gated behind this: a Negative would have cancelled it.

## Verdict

```
EFFORT_KEY_IS_SCHEMA_DECLARED: yes
EFFORT_LEGAL_VALUES: low | medium | high | xhigh | max | <integer>
TOOLS_KEY_HONOURED: yes — resolved list is surfaced in the agent-type listing
PROJECT_DEFINITIONS_LOADED: yes — .claude/agents/*.md become dispatchable types
AGENT_TOOL_HAS_EFFORT_PARAM: no
WORKFLOW_AGENT_HAS_EFFORT_OPT: yes — opts.effort, same five names
CLI_EFFORT_FLAGS_DECLARED: claude --effort | copilot --effort/--reasoning-effort | cline --thinking
```

## Method — and why the behavioural probe could not answer it

Three throwaway definitions were written to `.claude/agents/` and the harness
restarted: one with an invalid `effort:` value, one **positive control** with an
invalid `model:` value on a key that is definitely in the schema, and one
all-valid with `tools: Read, Glob, Grep`.

**All three loaded.** Including the positive control. That is what makes the
probe *inconclusive rather than confirmatory*: an unknown key and a known key
with a bad value both load silently, so the invalid-`effort:` definition
loading was never going to discriminate. The mechanism is two schema layers —
frontmatter parsing types `effort` as a loose string, and only the
resolved-agent layer enforces the enum.

The probe did answer one thing, because the listing renders the **resolved**
tool set rather than reporting on load-time acceptance: `tools:` is honoured,
and the all-valid definition enumerated as exactly `(Tools: Read, Glob, Grep)`
while the two controls, which set no `tools:`, did not.

## What actually settled it

`grep -a` over the harness's own bundle (`~/.local/share/claude/versions/2.1.232`):

```js
effort: Cs([Nr(["low","medium","high","xhigh","max"]), at().int()]).optional()
  .describe("Reasoning effort level for this agent. Either a named level or an integer")
```

Note the **integer branch**. The guard as first specced admitted only the five
names and would have failed a legal definition.

## The reusable lesson

**Read the harness's schema first.** Three revisions went into designing
behavioural probes for a question one `grep` of the binary answered. Behavioural
probing is for when there is no schema to read — not before checking whether
there is one.

The design was not *bad*: it carried a positive control, which is the only
reason the result was read as "inconclusive" rather than as confirmation. A
probe without that control would have shipped a false Positive.
```

- [ ] **Step 2: Append the second probe run to the skill-resolution doc**

At the end of `docs/testing/agent-skill-resolution-probe.md`:

```markdown
## Second run — OWED, not yet performed (2026-08-14)

Decision 9 of [the effort-routing design](../superpowers/specs/2026-08-14-model-effort-routing-design.md)
mirrors `model-routing/SKILL.md` into `~/.agents/skills/` (proven — Cline reads
that store) but **deliberately does not mirror the six agent definitions**,
because nothing here establishes that Cline resolves them.

This run is owed before any definition is mirrored. Three questions:

1. Does Cline's `spawn_agent` accept a persona/definition **name**, or only an
   inline prompt?
2. Is `~/.agents/agents/` resolved as a definition store? (It does not exist
   today — checked directly.)
3. If a definition is found, is its **frontmatter honoured** — specifically
   `model:` and `effort:`?

**Do not mirror definitions on a partial answer.** Cline cannot select a
subagent's model (`CLINE_TIER_SELECTABLE: no — observed deepseek-v4-flash`),
so writing files carrying `model: opus` / `effort: xhigh` into a harness that
can honour neither produces a sync that reports files written and changes
nothing — a mirror that looks maintained and governs nothing. Mirror only what
the probe says lands.
```

- [ ] **Step 3: Verify the new doc's links resolve**

```bash
cd C:/Claude/Projects/wt-model-effort-routing && node --test scripts/tests/review-gate-mechanism.test.mjs
```

The link scan covers `CLAUDE.md`, `CONTRIBUTING.md` and `.claude/skills/**` — `docs/testing/**` is deliberately out of scope, so this will not catch a typo in the new file. Check the two relative links by hand:

```bash
cd C:/Claude/Projects/wt-model-effort-routing/docs/testing
ls ../superpowers/specs/2026-08-14-model-effort-routing-design.md
```

- [ ] **Step 4: Commit**

```bash
cd C:/Claude/Projects/wt-model-effort-routing
git add docs/testing/agent-effort-resolution-probe.md docs/testing/agent-skill-resolution-probe.md
git commit -m "docs(docs): record the effort-resolution probe and the owed Cline definition probe"
```

---

## Task 8: Ship

**Files:** none new — this is the before-shipping checklist for this branch.

- [ ] **Step 1: Run the branch-scoped battery**

```bash
cd C:/Claude/Projects/wt-model-effort-routing && npm run verify:fast:branch
```

Expected: green. This diff touches `scripts/**` and `.claude/**`, so `test:hooks` **must** actually run rather than print `[cached]` — if it prints `[cached]`, Task 1 did not land correctly.

- [ ] **Step 2: Confirm the deliberate non-applicable checklist items**

State these explicitly in the PR body rather than omitting them:

- **Release notes: skipped.** Process-only change, no user- or operator-visible delta — the exemption `CLAUDE.md` before-shipping step 5 names.
- **On-box acceptance: none.** Nothing here needs a live GPU, sidecar, analyzer, or real book. No register row is owed.
- **e2e: none.** Nothing crosses a router/redux/layout seam.
- **Regression plan under `docs/features/`: not applicable** — this is a governance change with a spec and this plan; the guard tests are the durable record.

- [ ] **Step 3: File the issue and open the PR**

There is no issue for this work yet. File one (`type:chore`, `area:docs`), then:

```bash
cd C:/Claude/Projects/wt-model-effort-routing
git push -u origin docs/docs-model-effort-routing
gh pr create --title "feat(docs): route reasoning effort via six named dispatch roles" --body-file <path>
```

The PR body must carry `Closes #NN` literally. Include in `## Summary`: the six roles, the `medium` norm, and — declared, not buried — **"Also fixed, found in passing: F1, the cross-agent mirror's four dead `model-routing` links (Cline has been reading a runbook with dead routing references since the mirror was created)."**

- [ ] **Step 4: The mandatory review gate**

Run the `pr-review-gate` skill. Depth: **`high`** — this is a multi-scope PR (`docs`, `scripts`, `build`). Triage and fold findings before merge.

- [ ] **Step 5: Post-merge, per-machine**

```bash
npm run skills:sync
```

CI cannot do this. A machine that skips it has a mirror that is stale in exactly the way Task 6 just fixed.

---

## Self-review — spec coverage

Every decision in the spec, mapped to the task that implements it:

| Spec decision | Task | Note |
|---|---|---|
| 0 — probe gate | 7 | Resolved POSITIVE; Task 7 writes the greppable record |
| 0b — `medium` norm | 3 | Role table paragraph + `CLAUDE.md` sentence + CLI clause |
| 1 — tier table unmodified | — | Nothing to do; Task 3 **adds** a table rather than editing the existing one |
| 2 — six roles | 2, 3 | Definitions + registry table |
| 3 — `tools:` is not a boundary | 2, 3, 5 | `scout.md` prose, role-table paragraph, `pr-review-gate` sentence |
| 4 — `.gitignore` negation | 2 | Same commit as the definitions, deliberately |
| 5 — effort → review depth | 5 | Includes retargeting the existing guard assertion |
| 6 — session-effort rule | 3 | Bands + both halves of the honest limit |
| 7 — guard cases, both directions | 4, 6 | Roster guard + mirrored-link case |
| 8 — scope glob | 1 | **First**, or nothing else is enforced |
| 9 — Cline mirror | 6, 7 | Skills now; definitions deferred to the owed probe |
| 10 — escalation asymmetry | 3 | With its because-clause |
| F1 — mirror dead links | 6 | Fixed in-round, declared in the PR body |
| M10/M11 — CLI + Workflow surfaces | 3 | Surface-scoping sentences in the role table and escalation section |
| Open question 2 — intake path | 3 | **Settled by the reviewing session: declared-default-with-exceptions.** No rework followed; Task 3's role-table prose names the other governed surface |

**Open-question 1** (`settings.local.json` precedence) is not verified by any task here — decision 6 is written to be correct under either precedence and to state which file it read. Confirming it is a nice-to-have the implementer can do in Task 3 if cheap; it does not block.
