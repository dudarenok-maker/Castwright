# Reasoning-effort routing & named dispatch roles

_Design spec — 2026-08-14 · rev 3 (after adversarial review rounds 1–2)_

Extends [2026-07-01-model-routing-and-review-gates-design.md](2026-07-01-model-routing-and-review-gates-design.md),
which established model-tier routing. That spec routes *which model*; this one
adds *how hard it thinks*, and gives both axes a mechanism that can be checked
rather than asserted.

**Rev 2 changed the shape of the work, not just its wording.** Round 1 found the
design resting on an unobservable premise, and a guard test that would not have
run on the diffs it guards. The roster is now gated behind a falsifiability
probe, and four other decisions changed.

**Rev 3 retracts a finding rev 2 invented.** Round 2 attacked the new material
and killed two pieces of it: a fabricated incidental finding (F2, see
[Withdrawn](#withdrawn-f2--the-format-exemplar-citation)) and a Cost claim built
on a category error. The evidence for the central mechanism also got *weaker*,
not stronger — see M2. Corrections are marked inline.

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

Two further problems surfaced while probing the first three, and are fixed here
as incidental findings rather than filed — see
[Incidental findings](#incidental-findings).

This is a governance spec. No application code changes; the deliverables are
project instructions, a probe, up to six agent-definition files, one
sync-script extension, one scope-glob addition, and guard-test cases.

## Verified mechanism facts

Every decision below rests on one of these. Each was checked on this box on
2026-08-14 — the predecessor spec's round-1 correction (a routing rule that was
"silently void" for forks) is the failure mode being avoided. **M2 is the one
that is not settled, and decision 0 exists because of it.**

| # | Fact | How it was checked | Status |
|---|---|---|---|
| M1 | The `Agent` tool has **no** `effort` parameter. Its properties are `description`, `isolation`, `model`, `prompt`, `subagent_type`. | The tool's own schema. | Confirmed |
| M2 | Agent-definition frontmatter **carries** `effort:` alongside `model:`; `model: inherit` is legal. | `claude-security/agents/patch-generator.md` in the plugin cache declares `model: inherit` + `effort: xhigh`. Tally across installed definitions: `effort: xhigh` ×6, `effort: medium` ×1, `model: inherit` ×21. | **Asserted, and weaker after round 2.** The key exists in one file, in a plugin **not enabled in this session**. Round 2 searched for a schema: the official `plugin-dev/.../frontmatter-reference.md` documents `description`, `allowed-tools`, `model`, `argument-hint`, `disable-model-invocation` — **for commands**, using `allowed-tools` not `tools`, so it does not transfer — and contains **no** `effort`. **No agent-definition frontmatter reference exists in the installed docs at all.** Nothing shows this harness *honours* the key for a project-level definition. |
| M3 | Session effort is **readable**: `"effortLevel": "high"` in `~/.claude/settings.json`, sibling to `"model": "opus[1m]"`. | Read directly. | Confirmed |
| M4 | `.claude/agents/` is **git-ignored**. `.gitignore:33` is `.claude/*`; line 34 negates `!.claude/skills/` only, and five files are tracked beneath it. | `git check-ignore -v .claude/agents/pr-reviewer.md` → `.gitignore:33`; `git ls-files .claude`. | Confirmed |
| M5 | Cline resolves skills from `~/.agents/skills/` only, **cannot select a subagent's model**, and its agent-definition resolution is **untested**. `~/.agents/agents/` does not exist. | [`agent-skill-resolution-probe.md`](../../testing/agent-skill-resolution-probe.md): `CLINE_TIER_SELECTABLE: no — observed deepseek-v4-flash`. Directory absence checked directly. | Confirmed |
| M6 | `test:hooks` runs `scripts/tests/*.test.mjs` under `node:test`, and is in pre-commit, pre-push and `test:all`. Its scope-filter inputs are `scripts/**/*.{mjs,cjs,js,mts,cts,ts}`, `scripts/tests/fixtures/**`, `pinokio-scripts/**`, `.github/workflows/**`, `.github/actions/**`, `.claude/skills/**`. **`.claude/agents/**` is not among them.** | `scripts/run-hooks-tests.mjs:10`; `scripts/verify-cache.mjs:76–153`. | Confirmed |
| M7 | Real PR comments carry `effort <level>` in their header: 7 across PRs #2339, #2337, #2350 — all `effort high`. | `gh pr view <n> --json comments`. | Confirmed — **but this measures the prose *depth ladder*, not the model setting.** It is admissible only for decision 5's migration count. Rev 2 wrongly cited it as evidence about session effort; see [Cost](#cost). |

M1 and M2 together are the load-bearing pair: **effort is not settable per
dispatch, only per role.** Every decision follows from that — which is exactly
why M2 being merely Asserted is the spec's central risk.

## Decisions

### 0. Probe before roster — the falsifiability gate

*(New in rev 2. Round-1 finding: the design's premise was unobservable, and its
own guard test could only ever assert that a file's text says `xhigh` — never
that a dispatch ran at `xhigh`. A subagent cannot report its own reasoning
effort. Building six definitions on that would have been the
`f_measurement_instrument_cannot_fail` shape the spec's own Problem section
warns about.)*

**Nothing in decisions 1–9 is built until one throwaway definition has produced
a positive observable.** Task zero creates a single
`.claude/agents/probe-effort.md` and looks for **any** signal that the harness
parses the key, in this order — the first positive is enough:

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

- **Positive** (any of 1–3) → proceed to decisions 1–9 unchanged.
- **Negative** (2 actively shows the key ignored) → the roster is abandoned.
  What survives is decision 6 (the session rule, whose input M3 confirms),
  decision 8 (the Cline skill mirror), and the incidental findings. The spec is
  amended to say so; no definition files ship.
- **Silent** (nothing observable either way) → definitions ship **with the table
  marked `effort:` unverified — declares intent, effect unconfirmed**, and the
  probe doc records it. The one thing that must not happen is the table
  asserting routing that was never shown to occur.

**What decision 7's guard proves, in every one of the three outcomes:** that the
table and the definition files **agree with each other**. Never that a dispatch
ran at the stated effort — no instrument in this design can show that, because a
subagent cannot report its own reasoning effort. *(Rev 3, round-2 finding: in the
"silent" outcome the guard would otherwise enforce agreement between two things
both marked unverified, and a green suite would read as coverage. The guard's
own comment must say what it does not prove.)*

Results are recorded in a new `docs/testing/agent-effort-resolution-probe.md`,
following the format of the Cline probe doc — a verdict block with the same
`KEY: value` shape, so the finding is greppable later.

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
  `/code-review ultra` is for — user-triggered and billed. `xhigh` matches the
  only precedent on this box (M2's `patch-generator`, itself an adversarial role).
- **`model: inherit` is not used**, though M2 confirms it legal: `pr-reviewer`
  and `spec-checker` must land on Opus even when dispatched from a Sonnet
  session, which is the whole point of the Premium row.

### 3. Tool restriction applies to `scout` only — not the reviewers

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
  from the `Agent` tool's description, not observed; the probe's enumeration step
  reports which it is.

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
| Routine | `medium` | Straightforward implementation against a settled plan; summarizing output. |
| Working default | `high` | Coordination, debugging, triage, non-obvious implementation. |
| Judgment | `xhigh`, `max` | Adversarial or design work in-session: spec design, an ambiguous defect hunt, an irreversible call. |

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
- every `effort:` is one of `low`/`medium`/`high`/`xhigh`/`max`;
- `scout` lists no write tool (`Edit`, `Write`, `NotebookEdit`);
- **both directions** — a definition file with no table row fails too.

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
it per dispatch. `model-routing` states this asymmetry plainly rather than
leaving a reader to discover it: escalation buys capability, not depth. If the
decision-0 probe shows effort is the more load-bearing axis, a follow-up may add
`-escalated` variants; that is not built speculatively now.

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

What can be said without measuring: two roles move **up** (`pr-reviewer`,
`spec-checker` → `xhigh`), three move **down** (`implementer`, `fix-agent` →
`medium`; `scout` → `low`). Which direction dominates depends on relative
dispatch volume, **which this repo does not currently record.** No claim of
savings — or of cost — goes into `CLAUDE.md` or the skill. If the decision-0
differential step runs, its wall-clock numbers land in the probe doc as the only
figures anyone should cite.

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
carries no `PR review — pass N` header. It carries **three review comments** —
`## Full PR review`, `## Second full review (head 4a58615f, all fixes included)`,
`## Fresh full review - head 1d36ac31 (all fixes folded)` — in an **earlier
format that today's header was derived from.** The skill says the format
*follows* those comments; that is provenance, not a claim they match the current
template.

The error was in the instrument: rev 2 grepped for **today's** header regex,
found none, and read that absence as "no review comments exist". Recorded here
rather than deleted, because the shape recurs — *a search for the current form
cannot find the ancestor it evolved from, and reports it as missing.* Any future
pass tempted to "fix" that citation should read #2320's comments first.

## Footprint

| File | Change |
|---|---|
| `docs/testing/agent-effort-resolution-probe.md` | **New — decision 0, gates everything below** |
| `.claude/agents/*.md` ×6 | New — the roster (only if the probe permits) |
| `.gitignore` | +1 line, `!.claude/agents/` |
| `scripts/verify-cache.mjs` | `.claude/agents/**` → `test:hooks` globs (decision 8) |
| `.claude/skills/model-routing/SKILL.md` | Role table; session-effort rule; escalation asymmetry |
| `.claude/skills/pr-review-gate/SKILL.md` | effort→depth; dispatch by `subagent_type`; why `tools:` is not the mechanism; **"Per-agent mapping" reworded** — it currently says "a non-fork `Agent` dispatch at the routing table's Premium tier", which becomes a `subagent_type` dispatch, and the Cline comparison table under it moves with it. **The #2320 citation at line 144 is NOT touched** (see F2 withdrawn) |
| `.claude/skills/pr-review-gate/references/*.md` | effort→depth where it appears |
| `CLAUDE.md` "Model routing" | **One sentence + a link to the role table. No second table** — the section is the quick reference and must not become a third home for the same rows. |
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
  definitions). M1 means it would take three files, and the tier would no longer
  be pinned.
- **Mirroring definitions to Cline** — deferred to the probe (decision 9).
- **`-escalated` role variants** — deferred to the probe (decision 10).

## Open question deferred to implementation

Whether `.claude/settings.local.json` overrides `~/.claude/settings.json` for
`effortLevel` specifically was **not** verified — only that the user-level key
exists (M3). Decision 6 is written to read project-then-user and *state which
file it read*, which is correct under either precedence; the implementation
confirms the precedence and records it in the skill.
