---
status: draft
---

# PR review skill — design

Widen `.claude/skills/pr-review-gate/` from "how to dispatch a reviewer" into
the single place that says what this repo expects of a PR review: the
procedure the shipping session runs, the rubric the reviewer actually applies,
what happens to the findings, and the durable record each pass leaves on the
PR itself.

Supersedes the PR-specific half of
[`.claude/skills/model-routing/SKILL.md`](../../../.claude/skills/model-routing/SKILL.md).
Prior design of record for the gate mechanism:
[2026-07-01-model-routing-and-review-gates-design.md](2026-07-01-model-routing-and-review-gates-design.md)
and [docs/features/235-model-routing-review-gates.md](../../features/235-model-routing-review-gates.md).

## The problem

Three things are wrong with the current arrangement.

**The process has no single home.** Running one PR review means reading
`pr-review-gate/SKILL.md` (dispatch + brief), `model-routing/SKILL.md`
(sequence, exemption, effort ladder, findings handling, re-review trigger,
issue verification), CLAUDE.md's before-shipping checklist, and
CONTRIBUTING.md's "Pull requests". The rules are good; they are just not in
one place, and a rule split across four files is a rule that drifts.

**The brief says how to format a finding, not where the bodies are buried.**
Today's brief is a good generic reviewer prompt — severity, `file:line`,
concrete failure scenario, correctness-vs-cleanup split, "found nothing" is
valid. None of it is about *this* repo. The defect shapes that repeatedly
survive into late gate rounds here (a guard that fails open on absent
evidence, a metric blind to a case it must score, an acceptance criterion that
would pass on a null observation, a fix unreachable at the default config) are
transmitted nowhere, so each reviewer rediscovers them or misses them.

**Review history dies with the chat.** A pass returns a report into a session
transcript. When that context is gone, so is the record of what was checked,
what was found, and what was done about it — even though the PR it describes
is permanent and public.

## Decisions

| Question | Decision |
|---|---|
| Scope | One skill covering both the ship procedure and the reviewer rubric |
| Boundary with `model-routing` | Move its PR-specific sections in; routing keeps routing |
| Structure | `SKILL.md` + `references/` the reviewer is pointed at by path |
| Rubric depth | Repo bookkeeping gates + a curated catalogue of recurring defect shapes |
| Migration | Grow `pr-review-gate` in place — no rename |
| Portability | State reviewer *capabilities*, not one agent's tool names |
| Cross-agent sync | **Conditional on a canary probe** — canonical copy in `.claude/skills/`; a mirror + its guard are built only for agents the probe proves need one |
| Record | Every pass posts a comment on the PR — including a pass that finds nothing, and including a docs-only PR's exemption note |
| Who posts it | The **reviewer**, directly. The session verifies the tree is unchanged and the comment landed |

### Why grow in place rather than rename

`pr-review-gate` is referenced by ten files, including a guard test that keys
on both the directory basename and the frontmatter `name:` agreeing with it,
and `scripts/verify-cache.mjs`'s `extraFiles` list. A rename re-points all of
them, rewrites all four guard assertions, and leaves every archived plan
naming a path that no longer resolves — to buy a directory name that reads
slightly better. The name is still honest: the thing is the gate, and the
procedure exists to reach it. Under CLAUDE.md's "surgical changes" rule,
renaming what works is taste.

## Layout

```
.claude/skills/pr-review-gate/
  SKILL.md                       — the shipping session's runbook
  references/reviewer-brief.md   — what the reviewer subagent reads
  references/findings-triage.md  — what happens after the report lands
```

Two readers, two files. The shipping session loads the runbook and never needs
the rubric; the reviewer loads the rubric and never runs the procedure. The
dispatch prompt names `references/reviewer-brief.md` **by path** and instructs
the reviewer to read it in full, so the rubric reaches it verbatim rather than
as well as the dispatching session happens to retype it.

Directory, frontmatter `name:`, and the absence of `disable-model-invocation`
are all unchanged, so guard assertions 1, 2 and 4 keep passing untouched. The
`description:` widens to trigger on preparing and shipping a PR, not only on
dispatching the reviewer.

## SKILL.md — the procedure

An ordered runbook: preconditions ("fully staged") → docs-only exemption →
effort ladder → dispatch → post the pass comment → triage (pointer to
`findings-triage.md`) → re-review trigger and loop cap → issue verification at
`gh pr create` → merge.

**Constraint: name and link, do not restate.** For gates CLAUDE.md already
owns — regression plan, paired test, on-box acceptance register, the
release-notes pair, `docs/features/INDEX.md`, `verify:fast:branch` — the
runbook names them and links them, and does not reproduce their text. A second
copy of a rule is a rule that drifts, which is the failure
`review-gate-mechanism.test.mjs` exists to catch. What moves *into* this skill
is only what `model-routing` owns today and nothing else does.

### What moves out of `model-routing`

`model-routing/SKILL.md` loses `## Mandatory independent review (PRs)` and
`## PR-gate issue verification`, keeping a one-line pointer to this skill. It
retains the routing table, escalation, session-level drift, the spec/plan
adversarial-review loop, and the judgment-call carve-out — which stays there
because both loops share it, and is linked from `findings-triage.md`.

**The move breaks two things in CLAUDE.md, and both are fixed in the same PR.**

1. **`CLAUDE.md:716`** — before-shipping step 10 links
   `.claude/skills/model-routing/SKILL.md#mandatory-independent-review-prs`.
   That anchor dies with the section. It re-points at this skill. Note what
   made this nearly invisible: the existing guard asserts only that the string
   `pr-review-gate` appears on that line, so the line stays green while its
   link 404s — hence the link-integrity assertion below.
2. **`CLAUDE.md:301-306`** — the "Mandatory review gates" bullet already
   **restates the whole effort ladder inline** and closes with "see the
   model-routing skill for the full split." After the move that pointer names a
   file that no longer holds the ladder. It re-points at this skill.

The inline restatement itself **stays**. CLAUDE.md's deliberate convention is
quick-reference-here / full-spec-in-the-skill — the same shape as its routing
table. This design's "name and link, do not restate" constraint governs the
*skill*, which is the full spec and must not fork it; it does not abolish
CLAUDE.md's summary layer.

## references/reviewer-brief.md — the rubric

### Half one: house gates

Mechanically checkable, and the reviewer is expected to actually check them
rather than assume the author did:

- the paired test is a real regression test — red before the fix, green after,
  and red *for the reason claimed*;
- on-box acceptance recorded across all three surfaces (register, per-feature
  run sheet, live view) when the PR ships hardware-provable behaviour;
- the release-notes pair (`docs/release-notes-next.md` + `RELEASE_NOTES.md`),
  or an explicit not-applicable;
- `Closes #NN` / `Refs #NN` present and outside any code span;
- `cast.json` writes locked per the four rules, and lock-timeout errors routed
  through the correct curation seam;
- a new config knob carrying its registry entry, `config:sync`, Settings row
  and `.env.example` line;
- derived artifacts regenerated — `src/lib/api-types.ts`, `docs/BACKLOG.md`,
  brand PNGs;
- incidental findings fixed in this round rather than filed, and declared in
  the PR body.

### Half two: recurring defect shapes

Curated, roughly ten, each stated as *how it hides* rather than as a rule to
recite:

1. **A guard that fails open on absent evidence** — the input it inspects is
   missing, so it passes.
2. **A guard that enumerates syntax** — it loses one spelling per round to
   anything it did not list.
3. **A test that cannot fail** — or that went red before the fix for a
   different reason than the one claimed.
4. **A metric blind to a case it must score** — deletion counted as repair, a
   merge counted as repair, the dominant shape excluded.
5. **An acceptance criterion blind to its own feature** — it would pass on a
   null observation.
6. **Success reported while doing nothing** — the most common shape in this
   repo's history, including inside guards written to catch it.
7. **A fix unreachable at the default configuration** — correct code that runs
   zero times as shipped.
8. **A control group labelled clean but never measured.**
9. **The defect is in the instrument or the document, not the code** — a stale
   comment the change made false, a figure measured under one rule reused as
   evidence for another.
10. **One instance fixed, the class left armed** — sibling call sites, other
    entry points, the second copy.

### Keeping the catalogue current

A catalogue written once is a snapshot that decays, and the next new shape gets
transmitted nowhere — which is the problem statement restated. So it gets an
explicit trigger and owner rather than good intentions: **when a gate round
surfaces a defect shape the catalogue does not already name, appending it is
part of that round's fix work**, in the same PR, on the same footing as any
other chore the work made owed. The catalogue is a living file with a
maintenance rule, not an appendix.

### The finding contract

Unchanged from today's brief, because it works: severity, `file:line`, a
concrete failure scenario showing the break rather than gesturing at a risk,
the mandatory correctness-bug vs cleanup-nit split (it is what drives the
re-review trigger), and explicit authorization for "found nothing" so a
reviewer does not manufacture findings to justify its dispatch.

## references/findings-triage.md

The fix-now bar; the defect / chore / taste seam; the void deferral reasons
reproduced verbatim from CLAUDE.md's "Incidental findings"; the design-pass
carve-out as the single finding allowed to leave the round unfixed, and the
requirement that its issue names the decision owed; one dispatched fix agent
per finding, one paired test each; and how the bug/nit split feeds the
re-review trigger and the loop cap.

## The PR comment

Every pass posts one summary comment on the PR the moment it returns, **before
any fixes**, so the thread reads as found → fixed → re-verified in order.
Format, following the three comments on
[PR #2320](https://github.com/dudarenok-maker/Castwright/pull/2320):

```
## PR review — pass N (head <sha>, effort <level>)

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

Severity maps onto the split the loop already reads: 🔴 and 🟠 are correctness
bugs and re-trigger a pass once fixed and pushed; 🟡 is cleanup — fixed this
round, but not a re-trigger.

### The reviewer posts its own comment

An earlier draft had the shipping session post the report verbatim, justified
by the reviewer having "no write access." **That justification was false.** The
`Agent` tool exposes `description`, `prompt`, `subagent_type`, `model` and
`isolation` — and no per-dispatch tool restriction; even the read-only-ish
`Explore` type retains `Bash`, so it can `gh pr comment` and `git commit`
regardless. The write access was never actually withheld, and routing the
report through the session bought nothing except an unverified relay whose sole
operator is the one party with a motive to soften the findings. In a repo whose
most-documented failure shape is "success reported while doing nothing," that
is the wrong place to put an honour rule.

So the **reviewer posts its own comment directly**, one hop, before returning
its report to the session. Nothing sits between finding and record.

The reviewer's boundary is restated as what it actually is — a prohibition, not
a capability limit: **it must not modify tracked files.** That prohibition is
made checkable rather than trusted. The session captures `git rev-parse HEAD`
and `git status --porcelain` immediately before dispatch and again after the
pass returns; **any delta is a gate failure**, reported as such, never silently
absorbed. This is the one behavioural property of the pass that is verifiable
from outside it, so it is the one that gets verified.

The session then confirms the comment actually landed (`gh pr view --json
comments`) before starting triage. A pass that returned a report but posted
nothing is reported as a pass that did not complete.

### A pass that finds nothing still posts

"Found nothing" is an explicitly valid outcome, so it gets the same header and
a `### ✅ No findings` body. Without this, the record cannot distinguish
*reviewed and clean* from *never reviewed* — which is the single distinction
the whole record exists to preserve.

For the same reason, a **docs-only PR** — exempt from the pass entirely — posts
a one-line exemption note naming the file-set test that exempted it. Absence of
a review becomes a recorded fact rather than a silence. This matters more than
it sounds: a large share of this repo's PRs are docs-only, so without it the
durable record would be missing exactly where the volume is.

**Re-review comments state deltas only** — each prior finding's disposition,
plus anything new. They do not re-list the solid items. Three passes plus fix
commits is already the cap; re-listing would make the thread unreadable at
exactly the point it matters most.

**Standing authorization.** Posting to a public PR is an outward-facing
action. The repo owner has authorized it as a standing part of this process,
recorded in the skill, so the agent posts each round without pausing to ask.

## Portability across agents

The skill states the properties a reviewer must have, not one agent's tool
names:

- **fresh context** — not a fork of the shipping session, whose framing and
  blind spots are exactly what the pass exists to escape;
- **the strongest tier available** to that agent;
- **modifies no tracked file** — a prohibition, not a capability limit (see
  above), enforced by the session's before/after tree check rather than trusted;
- **the rubric read from `references/reviewer-brief.md`**, in full.

Underneath, a short per-agent mapping (Claude Code: a non-fork `Agent`
dispatch at the routing table's Premium tier; Cline: its own subagent
mechanism). An agent that genuinely cannot dispatch runs the rubric in-session
and reports it as a **self-run pass, never as the independent gate** — which
preserves the standing rule that a gate which did not run is never reported as
having run.

**Cline's mapping is unverified and must not be written as settled.** That
Cline dispatches subagents is reported and taken as true; what was never
checked is the load-bearing half — whether its subagent starts **cold or
inherits the session**, and whether its tier is selectable. "Can dispatch" and
"can dispatch an *independent* reviewer" are different claims, and only the
second one satisfies this gate. Establishing this is part of the probe below.
Until it is established, Cline uses the self-run label — the conservative
branch, because the failure it prevents (a fork reported as the independent
gate) is the exact substitution the standing rule forbids.

## Cross-agent sync

`.claude/skills/pr-review-gate/` is canonical. **Everything else in this
section is conditional on a probe, and the probe runs first.**

An earlier draft listed the mirror as a settled decision while leaving its
target unresolved — a decision cannot be settled and its precondition open at
the same time. The mirror script, its guard assertion, and its `extraFiles`
entries are **contingent deliverables**: they are built for the agents the
probe proves need them, and for no others. If the probe returns *no agent needs
a workspace mirror*, the correct outcome is to record that finding and build
none of it — not to ship a synchronization mechanism with zero consumers, which
is how #2314's three-copy problem started, one paragraph from where this design
warns about it.

Where a mirror **is** warranted, the shape is: a committed script mirrors the
canonical directory into that agent's path, a guard test fails when a mirror
drifts from its source so staleness surfaces as a red test rather than a
silently outdated copy, and the mirror paths join `test:hooks`'s inputs in
`scripts/verify-cache.mjs` — without that, a diff touching only mirrored files
prints `[cached]` and skips the guard it would break.

### Probe result (2026-08-13) — the assumption was wrong

The probe ran. Cline was asked directly, headlessly, inside this repo's
worktree (`cline -p -c <dir> "list your skills"`). It returned the 23 **global**
skills from `~/.agents/skills/` and answered `pr-review-gate: NO`. **Cline does
not resolve workspace `.claude/skills/` at all** — the earlier belief that it
did was read off `npx skills list` showing the path, whose `agents` field is
the shared CLI's install bookkeeping.

So there is no workspace path to mirror into. The only store Cline reads is
`~/.agents/skills/`, **outside the repo**, shared with five other agents.

**Owner decision (2026-08-13): ship the per-machine install step** —
`npm run skills:sync` copies the canonical skill into that store — rather than
dropping the mirror and accepting Claude-Code-only. Two consequences are
carried openly in the deliverable:

- **The drift guard fails open.** Its target is in `$HOME`, absent on a fresh
  clone and in CI, so it skips when the directory is missing. That is this
  design's own rubric entry #1 — *a guard that fails open on absent evidence* —
  and here it is unavoidable rather than accidental: the alternative is a
  required check that reddens every machine that never ran the sync. It prints
  a visible skip line, and a green run must never be reported as "the mirror is
  in sync."
- **Relative links do not resolve from the mirror.** The sync injects a
  provenance header telling the reading agent that paths resolve against the
  repository under review, not against the mirrored file.

**A Cline-run pass is independent but flash-tier.** Asked directly, Cline
dispatches via `spawn_agent` with a **fresh empty context** (satisfying the
independence requirement), but **cannot select the subagent's model**; its own
stderr disclosed `deepseek-v4-flash`. The capability phrasing above — *strongest
tier available to that agent* — is satisfied, but the probe record states the
actual model so a Cline pass is never recorded as equivalent to an Opus one.

This adds a fourth consumer to `~/.agents/skills/`, the store #2314 is already
open about consolidating; the sync script is the mechanism that ticket may
later absorb. `npx skills list --json` reports this repo's
three project skills with `"agents": ["Claude Code"]`, but that may be the
shared CLI's install bookkeeping rather than what Cline resolves at project
scope. Measured against `@cline/cli-windows-x64/bin/cline.exe` on 2026-08-13,
`grep -aoE '(\.cline|\.claude|\.agents)[\\/]{1,2}skills'` returns
`.claude/skills` ×3 and `.agents/skills` ×1 — positive evidence that Cline
reads `.claude/skills`, but silent on whether it means the global or the
workspace one, which is precisely the distinction that decides whether a Cline
mirror is needed at all.

So the fact gets established by test, not by reading strings out of a binary:
drop a canary skill, ask each agent to list its skills, and mirror only where
the canary does not appear. Building mirrors for agents that do not need them
is how the three-copy problem in #2314 started.

This work is project-scope and therefore independent of #2314, whose blocked
owner decision concerns the *global* skill stores.

## The guard

`scripts/tests/review-gate-mechanism.test.mjs` grows rather than shrinks:

**Assertions are named, never numbered.** The file's header comment numbers
them 1–4 in one order (exists / model-routing / CLAUDE.md /
name-matches-directory) while the `test()` calls appear in a *different* order
(exists / name-matches-directory / model-routing / CLAUDE.md). "Assertion 3" is
therefore ambiguous — it names the model-routing test by file order and the
CLAUDE.md test by the file's own numbering, and an implementer picking the
wrong one would retarget a healthy assertion and leave the broken one reading a
section that no longer exists. Every reference below is by test-name string.
**Correcting that header comment to match the actual order is a chore this work
made owed**, and lands in the same PR.

- **retarget** `"model-routing/SKILL.md's PR-review Mechanism bullet references
  pr-review-gate"` — it reads a section that is being moved, so it must now
  read `SKILL.md`'s own dispatch and effort ladder instead;
- **new**: both `references/*.md` exist *and* are named by `SKILL.md`. This
  layout's new failure mode is a dispatch prompt pointing at a file that is not
  there, which fails silently by handing the reviewer no rubric at all;
- **new**: `model-routing` does not still carry a second copy of the moved
  sections, so the drift this move fixes cannot quietly reappear;
- **new — link integrity**: every intra-repo anchor link in CLAUDE.md's
  before-shipping step 10 and in the moved sections resolves to a heading that
  actually exists. This exists because of a defect this design would otherwise
  have shipped: `CLAUDE.md:716` links
  `model-routing/SKILL.md#mandatory-independent-review-prs`, and moving that
  section **breaks the anchor while the existing string-match assertion stays
  green** — the guard would have certified the line it broke;
- **conditional**: each mirror matches its canonical source — built only if the
  probe establishes a mirror is needed at all.

Each new assertion is mutation-verified — broken deliberately, observed red,
restored — rather than asserted to work.

### Closing the enumeration trap rather than re-arming it

`scripts/verify-cache.mjs:248-250` registers this guard's inputs as three
**literal paths** (`.claude/skills/pr-review-gate/SKILL.md`,
`.claude/skills/model-routing/SKILL.md`, `CLAUDE.md`), because the step's globs
deliberately exclude `.claude/skills/**`. Simply appending two more literals for
the reference files would work today and re-arm defect shape #2 from this
design's own rubric — *a guard that enumerates loses one spelling per round*:
every future reference file would need hand-registering here or its diff prints
`[cached]` and the guard sits stale-green.

So the two skill literals are replaced by a `.claude/skills/**` glob, which
covers the existing entries, the new reference files, and anything added later.
`CLAUDE.md` stays a literal — it is not under that tree.

### What this guard does not prove

Stated plainly, in the same spirit as the existing guard's own header. Every
assertion above checks **presence**: files exist, are named, match, resolve;
sections are absent where they should be. **None of them proves a pass ran, or
that a comment was posted, or that a posted comment matches the report that
produced it.** The one behavioural property that is checkable from outside the
pass — that the reviewer modified no tracked file — is checked by the session's
before/after tree comparison, not by this test. A summary must not imply more
than that.

## Testing

The `node:test` assertions live alongside the existing ones in
`scripts/tests/review-gate-mechanism.test.mjs`, run by `npm run test:hooks` —
which is `node scripts/run-hooks-tests.mjs` (`package.json:45`), a runner
script, not a bare `node --test` invocation. There is no runtime surface here
beyond the guard, so the guard is the test plan.

## Resolved by adversarial review

The pass over the first draft returned findings against six load-bearing
claims; all are folded above rather than noted. Its three closing questions,
answered:

1. **What compares the posted comment against what the reviewer returned?**
   Nothing could — so the relay was removed instead. The reviewer posts
   directly, and the property that *is* checkable (no tracked file modified) is
   checked by the session's before/after tree comparison.
2. **Is the mirror conditional on the probe, or committed to regardless?**
   Conditional. The probe is task 1, and "no agent needs a mirror" is a valid
   outcome that cancels the mirror, its guard assertion and its cache entries.
3. **Does a pass that finds nothing post a comment?** Yes — and a docs-only PR
   posts an exemption note. Otherwise the record cannot distinguish
   *reviewed and clean* from *never reviewed*, which is the distinction it
   exists for.

Three claims the draft asserted and could not support are now marked as such
rather than dressed up: Cline's subagent independence (probe task 1b), what the
guard does not prove, and the reviewer's write access.

## Bookkeeping

- **Not docs-only.** The change touches `scripts/**`, so `verify.yml`'s
  doc-only fast path does not apply and this gate applies to itself.
- **Release notes: not applicable** — process and tooling, no user- or
  operator-visible delta. Stated explicitly rather than skipped silently.
- **On-box acceptance: not applicable** — nothing here needs hardware.
- **Issue**: filed as `area:ops` + `type:chore`; no `docs/BACKLOG.md` row,
  since chores never render there.
- **Contention.** This design edits four files with heavy concurrent traffic —
  `CLAUDE.md`, `model-routing/SKILL.md`, `scripts/verify-cache.mjs` and the
  guard test — across 17 live worktrees off one `.git`. This session already
  lost a commit to a concurrent HEAD move while writing this spec. So: all work
  happens in the dedicated worktree, and **the `CLAUDE.md` + `model-routing`
  edits land last, in one commit, rebased immediately before** — the smallest
  window between reading those files and committing them.
- [`docs/features/235-model-routing-review-gates.md`](../../features/235-model-routing-review-gates.md)
  is updated to record that the PR-review sections moved out of
  `model-routing`.
