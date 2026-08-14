# Reasoning-effort routing & named dispatch roles

_Design spec — 2026-08-14 · rev 10 · **FINAL — plan written and reviewed; ready to execute**_

Extends [2026-07-01-model-routing-and-review-gates-design.md](2026-07-01-model-routing-and-review-gates-design.md),
which established model-tier routing. That spec routes *which model*; this one
adds *how hard it thinks*, and gives both axes a mechanism that can be checked
rather than asserted.

## Read this first — the twelve decisions

Everything below is evidence and provenance for these. Nothing is unverified.

| # | Decision |
|---|---|
| **0** | The roster was gated behind a falsifiability probe. **Resolved POSITIVE** — `effort:` is a schema-declared agent key (M2). Settled by reading the harness bundle, *not* by the probe, which could not discriminate. |
| **0b** | **`medium` is the declared repo-wide effort norm**, for roles, sessions *and* CLI worker dispatch. `high`+ are deliberate, work-shaped raises. |
| **1** | The existing model-tier table is **not** modified. A second, separate table holds the named roles. |
| **2** | **Six named roles**, one `.claude/agents/*.md` each, pinning `model:` + `effort:`. Dispatch by `subagent_type`, not `model`. |
| **3** | **No `tools:` list is a security boundary.** `scout` omits write tools for hygiene; the reviewers' prohibition stays with the tree check. |
| **4** | `.gitignore` gains `!.claude/agents/`, mirroring the existing skills negation. |
| **5** | `pr-review-gate`'s "effort ladder" is renamed **"review depth"** — one word, one meaning, repo-wide. |
| **6** | A **session-effort rule**: read `effortLevel`, compare bands, flag and ask. Never silent, never self-applied. |
| **7** | Guard cases **extend the existing test file**; no new one. |
| **8** | `.claude/agents/**` joins `test:hooks`'s scope globs — **without this, none of decision 7 ever runs.** |
| **9** | Cline mirror: **skills now** (fixes F1), definitions only after their own probe. |
| **10** | Escalation overrides **model only**; effort stays pinned. Opus is terminal. **The asymmetry is a property of the `Agent` surface, not of escalation** (rev 9). |

Plus one incidental finding fixed in the same round (**F1**, the mirror's dead
routing links) and one
[**withdrawn**](#withdrawn-f2--the-format-exemplar-citation) (F2 — raised in rev
2, refuted in rev 3; kept as a record of a fabricated finding, not as a task).

### Revision history

Ten revisions, three adversarial review rounds (the full cap), one empirical
gate, and two **convergence passes** against a parallel session. Every round found
a defect in the *previous* round's new prose, so corrections are marked inline as
`(rev N, round-M finding: …)` rather than silently absorbed:

- **Rev 2** — round 1 found the premise unobservable and a guard that would never
  run on the diffs it guards. Roster gated behind decision 0.
- **Rev 3** — round 2 retracted a finding rev 2 **invented** (F2) and a Cost
  claim built on a category error.
- **Rev 4** — round 3 found rev 3's own reorder had made decision 0's `Negative`
  outcome **unreachable**: a falsifiability gate that could not fail.
- **Rev 5** — decision 0 resolved POSITIVE from the harness schema; the guard's
  effort enum corrected to admit the schema's integer branch.
- **Revs 6–7** — `medium` declared the norm (0b), reversing Cost's direction from
  net-down to net-**up**; bands re-anchored and the top band narrowed to
  *adversarial* work.
- **Rev 8** — final consistency pass.
- **Rev 9 — convergence pass.** A parallel session building CLI-worker
  orchestration reported that the spec's load-bearing sentence — *"effort is not
  settable per dispatch, only per role"* — is true of the `Agent` tool and false
  as a general claim, since `claude`/`copilot`/`cline` all accept effort per
  invocation. Reproduced and confirmed (M10). Checking it turned up a **second,
  stronger counterexample the report missed**: `Workflow`'s `agent()` takes an
  `effort` option per call, *inside* the harness the spec studied (M11). The
  sentence is scoped, and the two decisions that reasoned from the unscoped
  version — 10 and the per-PR-scaling rejection — are repaired. Five smaller
  findings folded; one deferred with the decision named.
- **Rev 10 — second convergence pass**, after the plan was written and the same
  session reviewed spec and plan together. **The deferred intake question is
  answered** (declared-default-with-exceptions) with no rework to the roster,
  and its consequence recorded: execution governance now lives in two files
  that agree on the norm and differ on model, so decision 2's surface-scoping
  sentence under-informs unless it names the second one. That review also found
  a **blocking defect in the plan, not in this spec** — a two-commit split whose
  first commit could not pass `pre-commit`, because the staged file put
  `test:hooks` in scope and the link guard fired on a deliberately-dangling
  anchor. Recorded here because it is the same shape as decision 8's own
  rationale, inverted: reasoning about a scope glob without checking which hook
  consumes it, once producing a guard that silently *did not* run and once one
  that *did*.

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

One further problem surfaced while probing the first three and is fixed here as
an incidental finding rather than filed — F1, see
[Incidental findings](#incidental-findings). (A second, F2, was raised and then
refuted; it is recorded there as withdrawn.)

This is a governance spec. No application code changes; the deliverables are
project instructions, six agent-definition files, one probe record, one
sync-script extension, one scope-glob addition, and guard-test cases.

## Verified mechanism facts

Every decision below rests on one of these. Each was checked on this box on
2026-08-14 — the predecessor spec's round-1 correction (a routing rule that was
"silently void" for forks) is the failure mode being avoided. **All eleven are
Confirmed.** M2 was the spec's central risk through revs 1–4 and was the reason
decision 0 existed; it is now settled. M10 and M11 are rev 9's, and exist because
M1 was generalised one step too far — see the paragraph below the table.

| # | Fact | How it was checked | Status |
|---|---|---|---|
| M1 | The `Agent` tool has **no** `effort` parameter. Its properties are `description`, `isolation`, `model`, `prompt`, `subagent_type`. | The tool's own schema. | Confirmed |
| M2 | `effort:` is a **real, schema-declared agent-definition key**, accepting the five named levels **or an integer**. | The harness's own bundled schema, `~/.local/share/claude/versions/2.1.232`: `effort: Cs([Nr(["low","medium","high","xhigh","max"]), at().int()]).optional().describe("Reasoning effort level for this agent. Either a named level or an integer")`. `model: inherit` is handled explicitly in the config resolver (`l!=="inherit"`). | **Confirmed** — see [decision 0](#0-probe-before-roster--the-falsifiability-gate) for why the *probe* could not settle this and the schema could. |
| M3 | Session effort is **readable**: `"effortLevel": "high"` in `~/.claude/settings.json`, sibling to `"model": "opus[1m]"`. | Read directly. | Confirmed |
| M4 | `.claude/agents/` is **git-ignored**. `.gitignore:33` is `.claude/*`; line 34 negates `!.claude/skills/` only, and five files are tracked beneath it. | `git check-ignore -v .claude/agents/pr-reviewer.md` → `.gitignore:33`; `git ls-files .claude`. | Confirmed |
| M5 | Cline resolves skills from `~/.agents/skills/` only, **cannot select a subagent's model**, and its agent-definition resolution is **untested**. `~/.agents/agents/` does not exist. | [`agent-skill-resolution-probe.md`](../../testing/agent-skill-resolution-probe.md): `CLINE_TIER_SELECTABLE: no — observed deepseek-v4-flash`. Directory absence checked directly. | Confirmed |
| M6 | `test:hooks` runs `scripts/tests/*.test.mjs` under `node:test`, and is in pre-commit, pre-push and `test:all`. Its scope-filter inputs are `scripts/**/*.{mjs,cjs,js,mts,cts,ts}`, `scripts/tests/fixtures/**`, `pinokio-scripts/**`, `.github/workflows/**`, `.github/actions/**`, `.claude/skills/**`. **`.claude/agents/**` is not among them.** | `scripts/run-hooks-tests.mjs:10`; `scripts/verify-cache.mjs:76–153`. | Confirmed |
| M7 | Real PR comments carry `effort <level>` in their header: 7 across PRs #2339, #2337, #2350 — all `effort high`. | `gh pr view <n> --json comments`. | Confirmed — **but this measures the prose *depth ladder*, not the model setting.** It is admissible only for decision 5's migration count. Rev 2 wrongly cited it as evidence about session effort; see [Cost](#cost). |
| M8 | `tools:` is honoured, and the **resolved** list is surfaced in the agent-type listing. | Probe-c (`tools: Read, Glob, Grep`) enumerated as exactly `(Tools: Read, Glob, Grep)` while the two controls, which set no `tools:`, did not. Corroborated by the same schema block as M2, which carries `tools` plus a sibling "Tools removed from the default set. Ignored if `tools` is set." | **Confirmed** |
| M9 | Project-level `.claude/agents/*.md` definitions are loaded and become dispatchable agent types. | All three probe definitions appeared in the agent-type list after restart. | **Confirmed** |
| M10 | All three worker CLIs accept reasoning effort **per invocation**: `claude --effort {low,medium,high,xhigh,max}` — described as *"Effort level for the current session"*, and identical to M2's named enum; `copilot --effort`/`--reasoning-effort {none,minimal,low,medium,high,xhigh,max}`; `cline --thinking {none,low,medium,high,xhigh}`, whose help states bare `--thinking` uses `medium` and **omitting it "leaves provider default"**. | `--help` on each, re-run on this box 2026-08-14 rather than taken from the report that raised it. | **Confirmed** |
| M11 | `Workflow`'s `agent()` accepts **`opts.effort`** — `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` — overriding reasoning effort **for that one call**, and "omit to inherit the session effort". This is a true per-dispatch effort control inside the same harness as M1. | The `Workflow` tool's own schema — the same evidence class M1 is read from. | **Confirmed** |

M1 and M2 together are the load-bearing pair. Stated precisely — *(rev 9,
convergence finding: revs 1–8 said "**effort is not settable per dispatch, only
per role**", full stop. That is true of the `Agent` tool and false of this repo's
other dispatch surfaces, and two decisions reasoned from the unscoped version.)*

> **Effort is settable per session, per role, and — on two surfaces — per
> dispatch. It is not settable on an `Agent`-tool dispatch, which is the surface
> `CLAUDE.md`'s execution model actually uses.** Every decision below follows
> from that, and is scoped to `Agent`-surface dispatch unless it says otherwise.

The two exceptions are M10 (the worker CLIs, where each invocation *is* a fresh
session — `claude --help` calls `--effort` "Effort level for the current
session", so this is the session axis reached through a different door) and M11
(`Workflow`'s `agent()`, which is genuinely per-call inside one session). M11 is
the sharper counterexample of the two, and it sits in the same harness M1 was
read from; it was missed for eight revisions because the spec only ever asked
what the `Agent` tool could do. *(This is `f_probed_defaults_not_what_the_app_sends`
one level out: the question "can effort be set per dispatch?" was answered by
checking one dispatch mechanism, not by enumerating them.)*

## Decisions

### 0. Probe before roster — the falsifiability gate

*(New in rev 2. Round-1 finding: the design's premise was unobservable, and its
own guard test could only ever assert that a file's text says `xhigh` — never
that a dispatch ran at `xhigh`. A subagent cannot report its own reasoning
effort. Building six definitions on that would have been the
`f_measurement_instrument_cannot_fail` shape the spec's own Problem section
warns about.)*

**RESOLVED — see [Result](#result--positive-and-the-probe-is-not-what-settled-it)
below.** The gate and its pre-registered outcome table are kept in full rather
than collapsed into their answer: the point of deciding outcomes in advance is
lost if the record is rewritten once the answer is known.

**As pre-registered:** nothing in decisions 1–10 is built until one throwaway
definition has produced a positive observable. Task zero creates
`.claude/agents/probe-*.md` and looks for **any** signal that the harness parses
the key, in this order — the first positive is enough:

1. **Validation — run this first.** Does `effort: not-a-level` produce a load
   error, warning, or rejection? A harness that *rejects* an invalid value
   demonstrably *parses* the key. Sharpest of the three, costs one restart, and
   it is the only step that can return a clean **negative**.
2. **Enumeration.** Does the definition appear in the session's available
   agent-type list after a restart? *(Rev 3: rev 2 also asked whether that
   listing discloses `model:`/`effort:` "the way it discloses `Tools:`". Round 2
   settled that without a probe — the listing renders `(Tools: …)` and nothing
   else, and `code-simplifier:code-simplifier` appears there with no model shown
   despite its definition setting `model: opus`. So enumeration can show only
   that the **file was found**, never that the **key was parsed**. Kept for that
   narrower value; the overclaim is removed.)*
3. **Differential.** Same non-trivial prompt dispatched to two otherwise
   identical definitions at `effort: low` and `effort: max`; compare wall-clock
   and output length. Noisy and weakest — used only if 1 and 2 are silent, and
   a null result here is recorded as **inconclusive, not negative.**

Outcomes, decided in advance so the result cannot be read favourably after the
fact:

**Outcomes are keyed to steps by NAME, never by number** *(rev 4, round-3
finding rated `Critical` + `Contradicted`: rev 3 reordered the steps and left the
outcome table pointing at "2", which the reorder had turned into Enumeration —
the one step the spec itself says can never show the key ignored. Read literally,
**Negative became unreachable** and every result shipped definitions. A
falsifiability gate that cannot return its own failure verdict is the exact trap
this decision exists to escape. Numbers are removed so the next reorder cannot
disarm it again.)*

- **Positive** (any step) → proceed to decisions 1–10 unchanged.
- **Negative** (**Validation** shows the key ignored — i.e. the control rejects
  and `effort:` does not) → the roster is abandoned. What survives is decision 6
  (the session rule, whose input M3 confirms), decision 9 (the Cline skill
  mirror), and F1. The spec is amended to say so; no definition files ship.
- **Silent** (nothing observable either way) → definitions ship **with the table
  marked `effort:` unverified — declares intent, effect unconfirmed**, and the
  probe doc records it. The one thing that must not happen is the table
  asserting routing that was never shown to occur.
- **Parsed-but-inert** (**Validation** rejects an invalid value, yet
  **Differential** shows no difference) *(rev 4, round-3 gap: rev 3's table had
  no owner for this, and sent a bare "the key parsed" straight to "proceed
  unchanged" — the false-confidence path)* → treated as **Silent**, not
  Positive. Parsing is not effect.

**What decision 7's guard proves, in every outcome:** that the table and the
definition files **agree with each other**. Never that a dispatch ran at the
stated effort — a subagent cannot report its own reasoning effort, so *the guard*
has no access to that fact. *(Rev 3, round-2 finding: in the "silent" outcome the
guard would otherwise enforce agreement between two things both marked
unverified, and a green suite would read as coverage. The guard's own comment
must say what it does not prove. **Rev 4, round-3 finding:** rev 3 wrote "no
instrument **in this design** can show that", which contradicts the Differential
step one paragraph above — an instrument in this design built to show exactly
that. The claim is narrowed to the guard, which is what was meant.)*

Results are recorded in a new `docs/testing/agent-effort-resolution-probe.md`,
following the format of the Cline probe doc — a verdict block with the same
`KEY: value` shape, so the finding is greppable later.

### Result — POSITIVE, and the probe is not what settled it

Run 2026-08-14. All three definitions **loaded and enumerated**, including
`probe-b-invalid-model`, the positive control carrying a bogus `model:` value.

**That control passing is what made the probe useless, and it is why the control
was worth having.** An unrecognized key and a known key with an invalid value
both load silently, so `probe-a` loading was never going to discriminate. Without
the control, "no error on invalid `effort:`" would have read as evidence the key
was fine. The probe design was sound; its *discriminating power* was zero, and
only the control revealed that. Recorded as a live instance of
`f_measurement_instrument_cannot_fail`.

The mechanism is now understood: there are **two schema layers**. The
frontmatter-parsing layer types `effort` as a loose string
(`effort:n2().optional().describe("Thinking effort: \`low\`, \`medium\`,
\`high\`, \`max\`, or an integer.")`), so any value parses; the resolved-agent
layer enforces the real enum (M2). Load-time acceptance therefore cannot report
on validity **for any key at all** — the control proved that generally, not just
for `effort`.

**What settled it was reading the harness's own bundled schema** (M2), which took
one grep and no restart. Two things follow, and the second is the reusable one:

- **Decision 0 = Positive.** Decisions 1–10 proceed. `effort:` is real, and the
  five-value enum the guard case asserts is exactly right — with one correction,
  below.
- **Any future capability probe reads the harness's schema FIRST.** Three
  revisions were spent designing behavioural probes for a question the binary
  answers directly. Behavioural probing is what you do when there is no schema to
  read, not before checking whether there is.

Two side results, both Confirmed: `tools:` **is** honoured and is surfaced in the
listing (M8) — closing round 3's open question — and project-level definitions
**are** loaded and dispatchable (M9), which was Asserted in every prior rev.

### 0b. `medium` is the declared repo-wide norm

*(New in rev 6, answering round 3's question #3. Revs 1–5 measured every role's
effort as "up" or "down" without naming a baseline; the implicit one was
`effortLevel` **on the repo owner's box**, a per-user setting, so the same spec
described opposite changes on two machines.)*

**`medium` is this repo's declared default reasoning effort — for roles, for
sessions, and for CLI worker dispatch.** It is the anchor every `effort:` is
stated against, and it is a
*declaration*, not a mechanism: nothing reads it at runtime. It exists so
"raised" and "lowered" mean the same thing to every reader, on every machine.
`high` and above are deliberate, work-shaped raises rather than a resting state
— see decision 6's bands for which shapes earn which.

Three consequences:

1. **Every role declares `effort:` explicitly — including the two sitting at the
   norm** (`implementer`, `fix-agent`). Omitting the key would make them inherit
   the dispatching session's effort, which is precisely the ungoverned behaviour
   this spec exists to end. At-norm is a stated value, not an absent one.
2. **The session rule's bands re-anchor on it** — see decision 6.
3. **The net direction of this change is upward.** See [Cost](#cost).
4. **A CLI worker dispatch passes the flag explicitly** *(rev 9, convergence
   finding)* — `claude --effort medium`, `copilot --effort medium`,
   `cline --thinking medium`. This is consequence 1 on a second surface, and it
   is the surface where the cost of omission is documented rather than inferred:
   `cline --help` says omitting `--thinking` "leaves provider default", i.e. an
   effort this repo neither declares nor observes. **The rule is
   pass-it-explicitly, including at the norm** — the same reason roles at
   `medium` still write the key.

   *Already true downstream:* the parallel session that raised M10 reports its
   orchestrator config pins `medium` across all three engine templates. That is
   an application of this decision, not evidence for it, and it lives outside
   this repo — nothing here reads or checks it.

### 1. The tier table is not modified

It answers a different question — ad-hoc dispatch and session judgment ("this
work is Premium-shaped"). Roles do not map onto tiers 1:1 (two roles sit on Opus
at different efforts), so an Effort column would assert a correspondence that
does not exist. `model-routing` gains a **second table** for named roles instead,
each row naming the tier it sits on so the two cannot drift apart conceptually.

### 2. Six named roles, one definition file each

Under `.claude/agents/`. Dispatch changes from `Agent({model: 'opus'})` to
`Agent({subagent_type: 'pr-reviewer'})`. The roster is taken from the dispatch
surface `CLAUDE.md`'s execution model already describes:

**This table governs one surface: Claude Code `subagent_type` dispatch.**
*(Rev 9, convergence finding: it reads as repo-wide policy.)* Nothing else reads
`.claude/agents/` — not the worker CLIs of M10, not Cline (M5, and decision 9
defers even the skills-style mirror until probed). Editing `implementer` here
changes what `Agent({subagent_type: 'implementer'})` does and nothing else.

**But the other lane is governed too, and the skill must say so** *(rev 10,
second convergence pass)*. With the intake path settled — see [Open questions
#2](#open-questions-deferred-to-implementation) — the queue is the **default**
execution path and `subagent_type` dispatch the minority one, so a table that
correctly scopes itself and stops there leaves a reader believing the majority
lane is ungoverned. It is not: the Ringer engine config pins each engine's model
and passes `--effort`/`--thinking` explicitly. `model-routing` names that file.
Not because this repo can check it — it is outside version control and nothing
here reads it — but so that someone editing `implementer` knows which lane they
are *not* changing. Same norm, different file.

| Role | Tier | `model:` | `effort:` | `tools:` |
|---|---|---|---|---|
| `pr-reviewer` | Premium | opus | xhigh | *(unrestricted — see decision 3)* |
| `spec-checker` | Premium | opus | xhigh | *(unrestricted — see decision 3)* |
| `task-reviewer` | Default | sonnet | high | *(unrestricted)* |
| `implementer` | Default | sonnet | medium | *(unrestricted)* |
| `fix-agent` | Cheap | haiku | medium | *(unrestricted)* |
| `scout` | Cheap | haiku | low | Read, Glob, Grep, Bash |

Choices rather than transcription:

- **`fix-agent` is `medium`, not `low`.** `CLAUDE.md` routes it to Haiku ("the
  typing is Haiku's"), but it owes a paired regression test that fails before the
  fix and passes after. This repo's most-repeated recorded failure is a red-phase
  test that could not have failed. Cheap model, not cheap reasoning.
- **`scout` duplicates the built-in `Explore` agent, deliberately.** `Explore`'s
  model and effort come from its own definition, which this repo cannot set. A
  repo-local `scout` is what makes the Cheap row actually cheap.
- **`scout` carries `Bash`.** *(Rev 3, round-2 finding: rev 2 gave it
  `Read, Glob, Grep` only, but `CLAUDE.md`'s Cheap row is "Mechanical
  search-and-report subagents, boilerplate/scaffolding, **running commands and
  summarizing output**…". Without `Bash` no role in the roster could run a
  command, orphaning one of the highest-volume Cheap dispatches this repo makes.
  Adding a seventh role was rejected as speculative; giving `scout` `Bash` costs
  one word and closes the gap.)*
- **`xhigh`, not `max`, on the adversarial roles.** `max` is what
  `/code-review ultra` is for — user-triggered and billed. `xhigh` also matches
  the only pre-existing precedent on this box: the official `claude-security`
  plugin's `patch-generator`, itself an adversarial role, pins `effort: xhigh`.
  *(Rev 8: revs 1–7 cited this as "M2's `patch-generator`". M2 was rewritten in
  rev 5 to carry the harness schema instead, so the citation pointed at evidence
  that row no longer holds. The observation stands on its own and is stated
  directly.)*
- **`model: inherit` is not used**, though M2 confirms it legal: `pr-reviewer`
  and `spec-checker` must land on Opus even when dispatched from a Sonnet
  session, which is the whole point of the Premium row.

### 3. No `tools:` list is a boundary — `scout` omits the write tools for hygiene

*(Reversed in rev 2. Round-1 finding, **contradicted vs `pr-review-gate/SKILL.md:176`**:
that skill mandates the reviewer post its own comment with `gh pr comment
--body-file <file>`, which requires **creating a file**. Strip `Write` and the
reviewer's normal, every-pass path becomes a Bash heredoc — so the restriction
would not merely fail to close the hole, it would make routing around it routine
and unremarkable. A prohibition that is defeated on the happy path is worse than
a stated prohibition with a check behind it.)*

- **`scout` omits the write tools** — `Read, Glob, Grep, Bash`. *(Rev 3: rev 2
  called this "genuinely restricted… the tool list **is** the boundary." That
  claim died with the `Bash` addition above. `Bash` can write files, so **no**
  role's `tools:` list is a boundary here.)* What the omission buys is **hygiene,
  not enforcement**: a search-and-report agent has no business holding `Edit`,
  and a role that never asks for it will not reach for it. The spec claims
  nothing more.
- **The reviewer roles carry no `tools:` key.** Their prohibition stays where it
  already works: prose in `pr-review-gate`, enforced by **the tree check**
  (`git rev-parse HEAD && git status --porcelain` before and after, any delta a
  gate failure). Unchanged and still mandatory.
- `pr-review-gate` gains one sentence recording *why* the tool list is not the
  mechanism, so this is not re-proposed in six months.
- **Omitting `tools:` is assumed to mean *all tools*, not *no tools*.** Inferred
  from the `Agent` tool's description, not observed.
- **`tools:` is honoured — Confirmed (M8), no longer a risk.** *(Rev 4 flagged it
  as resting on the same unverified parsing as `effort:`, and had decision 0's
  probe test it. It did: `probe-c` carried `tools: Read, Glob, Grep` and
  enumerated as exactly `(Tools: Read, Glob, Grep)` while the two controls, which
  set no `tools:`, did not.)* This is the one question the behavioural probe
  actually answered, because the listing renders the **resolved** tool set rather
  than reporting on load-time acceptance.

### 4. `.gitignore` gains `!.claude/agents/`

Mirroring the existing `!.claude/skills/` negation (M4). Not `git add -f` per
file: force-add works once, then the *next* definition added silently vanishes —
the recorded `.claude/`-is-ignored trap re-armed. This line is also what makes
decision 7's guard cases possible; an untracked definition is invisible to CI.

### 5. `pr-review-gate`'s "effort ladder" is renamed to "review depth"

Pinning `effort: xhigh` on `pr-reviewer` contradicts that skill's existing
`low`/`medium`/`high` ladder, which scales off the PR's commit type and is
stamped into every PR comment header. They genuinely are two different things —
one a model setting, the other prompt-stated scope — but a reader meeting
`effort: xhigh` in the definition and `effort: low` in a comment header has no
way to tell. One word, one meaning:

- The ladder keeps its values and its commit-type derivation. Only the noun
  changes.
- The header becomes `## PR review — pass N (head <sha>, depth <level>)`.
- **Migration cost, now counted (M7):** 7 existing comments across PRs #2339,
  #2337 and #2350 read `effort high`. They are historical records and are not
  rewritten; `pr-review-gate` carries one sentence noting that comments before
  2026-08-14 use the old noun for the same thing.
- The word `effort` thereafter means only the model setting, repo-wide.
- **`npm run skills:sync` must be re-run** after this rename — a per-machine step
  CI cannot perform. Listed in the footprint, not left implicit.

### 6. A session-effort rule, mirroring the model-drift rule in shape

Flag and ask; never silent; never claim to have changed it. Its input is real
(M3): read `effortLevel` from project `.claude/settings.local.json` first, then
`~/.claude/settings.json`, and **state which file the value came from.**

*(Rev 2: the band table omitted `medium` entirely, leaving a legal `effortLevel`
value unclassifiable and the drift trigger undefined for it. All five values now
have a home.)*

| Band | Values | The session is doing |
|---|---|---|
| Mechanical | `low` | Running commands, transcribing a decided edit, formatting. |
| **Norm** | **`medium`** | **The declared default (0b):** routine implementation against a settled plan, coordination, summarizing output. |
| Raised | `high` | **Design and brainstorming**, non-obvious debugging, triage of a failure whose cause is unknown. |
| Adversarial | `xhigh`, `max` | Hunting for what is *wrong*: an in-session review gate, an ambiguous defect hunt, an irreversible call. |

*(Rev 6: revs 3–5 labelled `high` "the working default", which described this box's
setting rather than a decision. With 0b declaring `medium` the norm, `high`
becomes a deliberate raise. **Rev 7:** the top band was called "Judgment" and
listed "spec design" in it — which would have flagged a session doing design work
at `high` as drifted one band low, i.e. mis-fired on the exact case the repo owner
names as the correct reason to raise. Design moves to `high`; the top band
narrows to **adversarial** work, matching the two roles that sit there
(`pr-reviewer`, `spec-checker`) — both of which hunt for defects rather than
produce designs.)* An integer `effort:` — legal per M2 — maps to the band
containing its nearest named level.

**The norm covers sessions, not just roles.** `effortLevel` should sit at
`medium`, with `high` and above as deliberate, work-shaped raises. **This spec's
own authoring session is the worked example**: design work at `high` is a correct
raise, not drift — which is why the rule reports the band it read and asks,
rather than treating any deviation as an error.

**Honest limit: the repo cannot enforce this half.** `effortLevel` lives in
`~/.claude/settings.json`, outside version control and outside any check this
repo can run. 0b declares the norm; decision 6 reads the value and flags a
mismatch; **neither can set it.** A session is compliant only because someone
chose to be.

**And it observes one harness of three** *(rev 9, convergence finding)*. Both
files this rule reads are Claude Code's. A Cline or Copilot session has neither,
so the drift check is silently inapplicable to two of the three lanes this repo
dispatches to — it does not misfire there, it simply never fires. On those lanes
0b's consequence 4 is the whole mechanism: pass `--effort`/`--thinking`
explicitly at dispatch, because there is no file to read afterwards and no band
to compare against. **A session-effort rule that cannot see a session is not a
weaker rule; it is a different one**, and this is the second half of the same
honest limit rather than a separate caveat.

**"Drifted" means** the current unit of work sits in a different *band* than the
band containing the value read — not a different value, which would fire on
every routine shift. Raised **once per unit of work**, not per step. Two limits
are stated in the skill rather than left implicit: the file holds the
**configured** value, so if the user changed it mid-session their statement wins
over the file; and the reading is reported, never acted on unilaterally.

### 7. Guard cases extend the existing test — no new file

*(Rev 2. Round-1 finding: `review-gate-mechanism.test.mjs` already reads
`ROUTING_SKILL_PATH` (line 47), already derives a link scan set over every
markdown file under `.claude/skills/**` (line 240), and already covers the sync
(20 references). A second file parsing the same two skills is the enumeration
and divergence trap that file's own Task-4 comment exists to close.)*

New cases in `scripts/tests/review-gate-mechanism.test.mjs`. For every row in the
role table in `model-routing/SKILL.md`:

- a `.claude/agents/<name>.md` exists and is **tracked by git**;
- its `name:`, `model:` and `effort:` frontmatter equal the row's values;
- every `effort:` is one of `low`/`medium`/`high`/`xhigh`/`max` **or an integer**
  *(rev 5: the schema in M2 is `Cs([Nr([…five names…]), at().int()])` — a union
  with an int branch. Revs 1–4 asserted the names only, so the guard as specced
  would have **failed a legal definition**. This repo does not use integer efforts
  today; the guard still admits them, because a guard that rejects what the
  harness accepts is a guard that will be deleted the first time someone needs
  one.)*;
- `scout` lists no write tool (`Edit`, `Write`, `NotebookEdit`);
- **both directions** — a definition file with no table row fails too.

**The reverse direction makes the role table a closed registry, and that is
intended** *(rev 9, convergence finding: revs 2–8 stated the bidirectionality as
a guard detail, so its real consequence — that **every** `.claude/agents/*.md`
in this repo, whoever adds it and for whatever system, must appear in
`model-routing`'s table or turn the build red — emerged as a surprise rather than
as a decision).* Stated as one: **`.claude/agents/` holds the roster and nothing
else.** A future definition has exactly two legal paths — add its row to the
table, which is one line and makes it a governed role; or keep it out of
`.claude/agents/`, since decision 4 tracks only that directory and an untracked
scratch definition is unaffected. There is deliberately no third path, no
`# unmanaged` escape comment, and no allowlist: an ungoverned definition file is
the exact thing 0b exists to prevent, and a registry with an opt-out is not one.

Plus, for the incidental finding: **every relative cross-skill link in the
mirrored output resolves to a path the mirror also writes.** Computed from
`buildMirrorContent`'s return value and the `FILES` list — **not** by reading
`~/.agents/skills/`, which does not exist in CI, where a disk-based check would
skip exactly as the existing mirror-drift guard does.

**And the step's scope filter must be widened, or none of this runs.**

### 8. `.claude/agents/**` joins `test:hooks`'s input globs

*(New in rev 2, and the round-1 finding rated `Critical` + `Contradicted`.
**M6**: `test:hooks`'s globs cover `scripts/**`, fixtures, `pinokio-scripts/**`,
`.github/workflows/**`, `.github/actions/**` and `.claude/skills/**` — but not
`.claude/agents/**`. A definitions-only diff, e.g. flipping `effort: xhigh` to
`low`, would print `test:hooks [cached]` and run nothing, locally **and** in
cloud CI, since `ci-scope.mjs` derives from the same `STEPS[]`. `verify-cache.mjs`
documents this exact trap (#1847) three separate times, including at line 146 —
the comment that added `.claude/skills/**` for precisely this reason.)*

`scripts/verify-cache.mjs`'s `test:hooks` entry gains `.claude/agents/**`, with a
comment in the established idiom naming what would otherwise silently skip.

### 9. The Cline mirror: skills now, definitions after a probe

Two halves with different evidence behind them (M5):

- **Proven, ship it:** `model-routing/SKILL.md` joins `sync-agent-skills.mjs`'s
  `FILES` list. Cline demonstrably reads `~/.agents/skills/`. This fixes the
  first incidental finding and puts the role table where Cline can read it —
  with the `model:`/`effort:` columns marked **Claude Code only — Cline cannot
  select these**, exactly as `pr-review-gate` already marks its tier row.
- **Unproven, do not mirror blind:** the definition files are **not** mirrored
  this round. Cline cannot select a subagent's model, and whether it resolves
  agent definitions at all was never probed. Writing files carrying `model: opus`
  / `effort: xhigh` into a harness that can honour neither is a sync reporting
  files written and changing nothing. A **second probe run** is appended to
  `docs/testing/agent-skill-resolution-probe.md`, asking whether `spawn_agent`
  accepts a persona/definition name, whether `~/.agents/agents/` is resolved, and
  whether the frontmatter is honoured. Definitions are mirrored only for what the
  probe says lands.

### 10. Escalation overrides model only, and says so

*(New in rev 2. Round-1 gap: `model-routing` mandates "a subagent that fails
twice is re-dispatched one rung up," and the role world had no expression for
that — there is no `implementer-opus`.)*

Escalation from a named role re-dispatches the **same** `subagent_type` with an
explicit `model` override (`Agent({subagent_type: 'implementer', model: 'opus'})`),
which the `Agent` tool's schema states takes precedence over the definition's
`model:`. **Effort stays at the role's pinned value** — M1 leaves no way to raise
it on an `Agent` dispatch. `model-routing` states this asymmetry plainly rather than
leaving a reader to discover it: escalation buys capability, not depth. Should
effort later prove the more load-bearing axis, a follow-up may add `-escalated`
variants; that is not built speculatively now. *(Rev 8: revs 2–7 made this
conditional on "if the decision-0 probe shows…". The probe ran and measured
nothing about relative axis weight — it was never designed to — so the
conditional pointed at evidence that will never arrive.)*

**The asymmetry belongs to the surface, not to escalation** *(rev 9, convergence
finding: as written it read as a property of escalation itself, which is what
made it look like a law rather than a consequence).* On the `Agent` surface it is
a hard limit — M1, no parameter exists. On the two surfaces of M10/M11 both axes
are available per dispatch, and a retry there **can** raise effort: a CLI worker
by re-invoking with a higher `--effort`, a `Workflow` stage by passing a higher
`opts.effort`. So the rule is *"escalation buys capability, not depth, **because
the `Agent` tool has no depth control**"* — and `model-routing` must say the
because-clause, or a reader who has just used `Workflow` will read the rule as
false and discount the rest.

**This does not change what the roster does.** `CLAUDE.md`'s execution model
dispatches through the `Agent` tool, and `Workflow` is gated behind an explicit
user request — so the pinned-effort behaviour is what this repo actually gets on
its default path. What changes is the *reason* stated: it holds because of the
dispatch path this repo chose, not because the harness offers nothing. That
distinction is the difference between a rule that survives someone finding M11
and one that does not.

**Opus is terminal.** *(Rev 3, round-2 finding: rev 2 stated the mechanism as if
it applied at every tier.)* A twice-failing `pr-reviewer` or `spec-checker` is
already at the top of the ladder and has no rung above it — that case escalates
**to the user**, not to a model, which is the same place the review loop's cap
already routes an unresolved disagreement.

## Cost

*(New in rev 2. Round-1 gap: a spec whose parent exists because "token
utilization has been driven by habit rather than policy" proposed `xhigh` on
every gate with no estimate.)*

**The spend impact of this change is unmeasured. No estimate is offered.**

*(Rev 3. Rev 2 wrote that "M7 shows every observed pass ran at the equivalent of
the session default." Round 2 killed it: M7 counts `effort high` in **PR comment
headers**, which decision 5 establishes is the prose **depth ladder** — a
different quantity from the model setting, and the very conflation decision 5
exists to end. The spec committed its own target error one section later. The
claim is withdrawn rather than repaired, because there is no substitute
measurement to put in its place.)*

**Direction: upward.** Against the `medium` norm declared in 0b — a fixed
anchor, not a per-machine reading — three roles are **raised** (`pr-reviewer`,
`spec-checker` to `xhigh`, two rungs; `task-reviewer` to `high`, one), two sit
**at the norm** (`implementer`, `fix-agent`), and one is **lowered** (`scout` to
`low`). Six roles.

*(Rev 6 reversed this section's conclusion. Revs 3–5 said "two up, three down" —
true only against a baseline of `high`, which was `effortLevel` on the repo
owner's box (M3), not a decision. Declaring the norm re-anchors it and flips the
sign: the same roster that read as a net reduction is a net **increase**. Stated
plainly rather than left as the flattering reading — it is also the correct
outcome for driver 1, "hard passes underthink", which asks for exactly this.)*

**How much it costs is still unmeasured**, and this spec does not estimate it:
magnitude depends on relative dispatch volume, which this repo does not record.
The one downward move (`scout`) is the highest-volume role, so the arithmetic is
not obviously dominated either way — but "not obviously" is not a number. No
claim of savings **or of cost** goes into `CLAUDE.md` or the skill. If the
decision-0 Differential step is ever run, its wall-clock figures land in the
probe doc as the only ones anyone should cite.

## Incidental findings

One finding, F1, found while checking decision 9; unrelated to the feature;
**fixed in this round rather than filed**, per `CLAUDE.md`'s incidental-findings
protocol. A second, F2, was raised in rev 2 and **withdrawn** in rev 3 — kept
below as a record, not a task.

**F1 — the mirror's dead routing links.** `.claude/skills/pr-review-gate/` links
to `../model-routing/SKILL.md` four times (three in `SKILL.md`, one in
`references/findings-triage.md`), including the link naming which tier to
dispatch at. `sync-agent-skills.mjs` mirrors `pr-review-gate` only, so in
`~/.agents/skills/` every one resolves to a directory that is not there. Cline has
been reading a runbook with dead routing references since the mirror was created.
The existing link scan could not see it: `linkScanSet()` (line 240) validates
links in the **canonical** tree, where they resolve. Decision 9's first half is
the fix; decision 7's mirrored-link case closes the blind spot.

### Withdrawn: F2 — the format-exemplar citation

**Rev 2 raised this as a defect. Round 2 refuted it. Nothing is fixed here, and
the citation must be left alone.**

Rev 2 claimed `pr-review-gate/SKILL.md:144` cites the wrong PR, because #2320
carries no `PR review — pass N` header. It carries review comments in an
**earlier format that today's header was derived from** — `## Full PR review`,
`## Second full review (head 4a58615f, all fixes included)`,
`## Adversarial sub-agent review (different angles) — found & fixed a NEW
fabrication vector`, and `## Fresh full review - head 1d36ac31 (all fixes
folded)`. The skill says the format *follows* those comments; that is provenance,
not a claim they match the current template.

*(Rev 4, round-3 finding: rev 3 wrote that #2320 "carries **three** review
comments" and listed three — omitting the adversarial-sub-agent one. There are
**four**, and which three the skill's author meant is unknown and does not
matter. Three was the number the citation needed, and three is what rev 3
produced: **the section written to record a constructed claim contained a
constructed claim.** Corrected to four; the conclusion — leave the citation
alone — is unchanged.)*

The error was in the instrument: rev 2 grepped for **today's** header regex,
found none, and read that absence as "no review comments exist". Recorded here
rather than deleted, because the shape recurs — *a search for the current form
cannot find the ancestor it evolved from, and reports it as missing.* Any future
pass tempted to "fix" that citation should read #2320's comments first.

## Footprint

| File | Change |
|---|---|
| `docs/testing/agent-effort-resolution-probe.md` | **New — the decision-0 record.** The probe has already run; this file writes up the verdict block (`KEY: value`, matching the Cline probe doc) so the result is greppable rather than living only in this spec |
| `.claude/agents/*.md` ×6 | New — the roster. **Unblocked**: decision 0 returned Positive |
| `.gitignore` | +1 line, `!.claude/agents/` |
| `scripts/verify-cache.mjs` | `.claude/agents/**` → `test:hooks` globs (decision 8) |
| `.claude/skills/model-routing/SKILL.md` | Role table; session-effort rule; escalation asymmetry. **Rev 9 adds three sentences, all scoping:** the role table governs `subagent_type` dispatch only (decision 2); the session-effort rule observes Claude Code's settings files only (decision 6); the escalation asymmetry holds *because* the `Agent` tool has no depth control (decision 10). Plus 0b's CLI clause — pass `--effort`/`--thinking` explicitly, including at the norm |
| `.claude/skills/pr-review-gate/SKILL.md` | effort→depth; dispatch by `subagent_type`; why `tools:` is not the mechanism; **"Per-agent mapping" reworded** — it currently says "a non-fork `Agent` dispatch at the routing table's Premium tier", which becomes a `subagent_type` dispatch, and the Cline comparison table under it moves with it. **The #2320 citation at line 144 is NOT touched** (see F2 withdrawn) |
| `.claude/skills/pr-review-gate/references/*.md` | effort→depth where it appears |
| `CLAUDE.md` "Model routing" | **The `medium`-norm declaration (0b) + a link to the role table. No second table** — the section is the quick reference and must not become a third home for the same rows. The norm is the one sentence worth putting there, since it is what every other statement of effort is relative to. **Rev 9:** that sentence names all three surfaces the norm covers — roles, sessions, CLI workers — because naming two of three is how the unscoped claim happened the first time. |
| `scripts/sync-agent-skills.mjs` | `model-routing` joins the mirror (F1) |
| `scripts/tests/review-gate-mechanism.test.mjs` | New cases (decision 7) |
| `docs/testing/agent-skill-resolution-probe.md` | Second probe run (decision 9) |
| — | **Run `npm run skills:sync`** — per-machine, CI cannot |

## Testing

- **Guard cases** (decision 7) in the existing test file — the primary automated
  coverage, both directions, plus the mirrored-link case from F1.
- **Scope wiring** (decision 8) — `verify-cache.test.mjs` already asserts
  `stepTouchedByDiff` against real paths; a case is added for
  `.claude/agents/**`, so the glob cannot be removed without a red test.
- **`sync-agent-skills.mjs`** — its cases in the same file gain the two-skill
  `FILES` list: `model-routing/SKILL.md` is written, frontmatter stays the first
  line, provenance header spliced below it.
- **No e2e, no on-box acceptance.** Nothing crosses a router/redux/layout seam;
  nothing needs real hardware.

**Landing order matters in one place** *(rev 3, round-2 gap)*: decision 9's
`FILES` change must land **with or before** decision 7's mirrored-link case. The
case asserts every cross-skill link resolves to a path the mirror writes, and
`model-routing` is not among those paths until `FILES` grows — so the guard
first, alone, is red by construction.

## Explicitly out of scope

- **Release notes: skipped.** Process-only, no user- or operator-visible delta —
  the exemption `CLAUDE.md` before-shipping step 5 names.
- **Reproducible/pinned gate depth.** Offered and not selected as a driver.
- **Per-PR effort scaling for the reviewer** (three `pr-reviewer-{low,medium,high}`
  definitions). On the `Agent` surface M1 means three files, and the tier would no
  longer be pinned. *(Rev 9, convergence finding: revs 1–8 rested the rejection on
  M1 alone, as though the cost were a fact about the idea. Via M11 it costs one
  `opts.effort` and zero files — so the honest rejection is that **`pr-review-gate`
  already scales the right thing**: decision 5's review-depth ladder scales the
  reviewer's remit by commit type, and this would add a second, model-level
  scaling axis over the same input. One knob per dimension. The three-files cost
  is a consequence of the chosen surface, not the argument.)*
- **Mirroring definitions to Cline** — deferred to its own probe (decision 9),
  which has **not** been run. Distinct from decision 0's, which has.
- **`-escalated` role variants** — deferred indefinitely (decision 10); no
  evidence is pending that would trigger them.
- **Changing `effortLevel` on any machine.** 0b declares the norm; decision 6
  reads and flags. Neither sets it, and this spec does not ask CI to.

## Open questions deferred to implementation

**1. `effortLevel` precedence.** Whether `.claude/settings.local.json` overrides
`~/.claude/settings.json` for `effortLevel` specifically was **not** verified —
only that the user-level key exists (M3). Decision 6 is written to read
project-then-user and *state which file it read*, which is correct under either
precedence; the implementation confirms the precedence and records it in the
skill.

**2. Which intake path a piece of work takes — ANSWERED, rev 10.**

> **Declared-default-with-exceptions.** The queue is the default: anything with
> more than one step, or that will outlive a single session, goes through Open
> Engine sub-issues and executes on the `cline` CLI.
> `superpowers:subagent-driven-development` is reserved for same-session work
> the operator is actively watching.

Settled by the session that raised it, on the same day, during its convergence
review of this spec and its plan. **Nothing in the roster changes** — which is
what the deferral predicted: the six roles were defined by what `CLAUDE.md`'s
execution model dispatches today, and that is still true. `implementer` is not
orphaned; it governs the minority path.

**One consequence is worth stating, because it is the thing a reader will get
wrong.** Execution-path governance now lives in **two** files that agree on the
norm and differ on model — `.claude/agents/implementer.md` for the
`subagent_type` lane, and the Ringer engine config for the queue lane, which
pins each engine's model and passes `--effort`/`--thinking` explicitly (0b's
consequence 4, already applied there). Decision 2's surface-scoping sentence
therefore under-informs on its own: saying "nothing else reads
`.claude/agents/`" is true and leaves a reader believing the other lane is
ungoverned. `model-routing` names the second file for that reason — not because
this repo can check it (it cannot; the file is outside version control) but so
that someone editing `implementer` knows which lane they are *not* changing.

The original deferral is kept below as a record of what was owed and why, per
this spec's convention that withdrawn and superseded claims are not deleted.

---

*(Superseded — the deferral as written in rev 9.)* The parallel
session that raised M10 is standing up a CLI-worker queue that routes execution
work to `cline` rather than to `Agent({subagent_type: 'implementer'})`. If that
queue becomes the intake path, `implementer` — and, with it, `fix-agent` and
`task-reviewer` — are roles this repo defines and rarely dispatches.

**The decision owed is not "keep or drop `implementer`."** It is: **does a unit
of work choose its execution surface by work-shape, by who is dispatching, or by
a declared default with named exceptions?** All three are defensible, they
produce different rosters, and only one of them leaves the six-role table as
written. That is the "more than one defensible outcome" test `CLAUDE.md` sets for
the one class of finding that may be deferred rather than fixed in-round — so it
is deferred deliberately, not by omission.

Two reasons it does not block this spec:

- **The roster is correct under all three answers.** Every role here is defined
  by what `CLAUDE.md`'s execution model already dispatches today. A role that
  later goes quiet costs one unused file, and the guard of decision 7 keeps it
  honest in the meantime.
- **Nothing here has been verified.** This spec's standard is that every claim
  traces to a mechanism row; the queue's design, its sub-task vocabulary, and
  whether it will be the intake path are all **reported, not observed** — M10 is
  the only part of that session's work reproduced on this box. Writing a
  reconciliation into the spec would be importing an unverified system's
  vocabulary into a document whose whole discipline is that it does not do that.

**Owner: the repo owner**, who is running both sessions and is the only party who
can say whether the queue is the intake path or an adjunct. Until then the two
systems overlap on paper and not in any mechanism either one can check.
