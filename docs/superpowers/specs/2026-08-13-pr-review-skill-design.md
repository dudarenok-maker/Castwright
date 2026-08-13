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
| Cross-agent sync | Canonical copy in `.claude/skills/`, mirrored by script, drift caught by a guard |
| Record | Every pass posts a summary comment on the PR |

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

**The shipping session posts it, verbatim.** Header added, body untouched. The
reviewer keeps its "changes nothing, no write access" boundary, and a session
cannot soften its own reviewer's findings between receiving them and
publishing them. The alternative — the subagent posting directly — removes one
relay but hands `gh` write access to an agent whose entire value is that it
writes nothing.

**Standing authorization.** Posting to a public PR is an outward-facing
action. The repo owner has authorized it as a standing part of this process,
recorded in the skill, so the agent posts each round without pausing to ask.

## Portability across agents

The skill states the properties a reviewer must have, not one agent's tool
names:

- **fresh context** — not a fork of the shipping session, whose framing and
  blind spots are exactly what the pass exists to escape;
- **the strongest tier available** to that agent;
- **no write access** — it returns a report;
- **the rubric read from `references/reviewer-brief.md`**, in full.

Underneath, a short per-agent mapping (Claude Code: a non-fork `Agent`
dispatch at the routing table's Premium tier; Cline: its own subagent
mechanism). An agent that genuinely cannot dispatch runs the rubric in-session
and reports it as a **self-run pass, never as the independent gate** — which
preserves the standing rule that a gate which did not run is never reported as
having run.

## Cross-agent sync

`.claude/skills/pr-review-gate/` is canonical. A committed script mirrors it
into the workspace paths other agents read, and a guard test fails when a
mirror drifts from its source, so staleness surfaces as a red test rather than
a silently outdated copy. The mirror paths join `test:hooks`'s `extraFiles` in
`scripts/verify-cache.mjs` for the same reason the reference files do — without
that, a diff touching only mirrored files prints `[cached]` and skips the guard
it would break.

**Open, to be resolved by probe as the plan's first task: which workspace
paths actually need a mirror.** `npx skills list --json` reports this repo's
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

- **assertion 3 retargets** from `model-routing`'s
  `## Mandatory independent review (PRs)` section to `SKILL.md`'s own dispatch
  and effort ladder — it must move because the section it reads is being
  moved;
- **new**: both `references/*.md` exist *and* are named by `SKILL.md`. This
  layout's new failure mode is a dispatch prompt pointing at a file that is not
  there, which fails silently by handing the reviewer no rubric at all;
- **new**: `model-routing` does not still carry a second copy of the moved
  sections, so the drift this move fixes cannot quietly reappear;
- **new**: each mirror matches its canonical source.

Each new assertion is mutation-verified — broken deliberately, observed red,
restored — rather than asserted to work.

## Testing

Node's `node --test` under `npm run test:hooks`, alongside the existing
assertions. There is no runtime surface here beyond the guard, so the guard is
the test plan.

## Bookkeeping

- **Not docs-only.** The change touches `scripts/**`, so `verify.yml`'s
  doc-only fast path does not apply and this gate applies to itself.
- **Release notes: not applicable** — process and tooling, no user- or
  operator-visible delta. Stated explicitly rather than skipped silently.
- **On-box acceptance: not applicable** — nothing here needs hardware.
- **Issue**: filed as `area:ops` + `type:chore`; no `docs/BACKLOG.md` row,
  since chores never render there.
- [`docs/features/235-model-routing-review-gates.md`](../../features/235-model-routing-review-gates.md)
  is updated to record that the PR-review sections moved out of
  `model-routing`.
