# Worktree exclusivity — design

- **Date:** 2026-09-06
- **Issue:** [#3011](https://github.com/dudarenok-maker/Castwright/issues/3011)
- **Status:** draft, revised after one adversarial review pass
- **Implementation lands in:** [`open-engine`](https://github.com/dudarenok-maker/open-engine) — this repo carries the design of record only

## Problem

Two writers in one worktree is the failure CLAUDE.md records this repo hitting **three separate
times** (2026-08-29, 2026-08-30, 2026-09-04/05). It produces bundled commits, contention flakes,
and — worst — a subagent concluding the contention it caused itself is an external blocker and
reaching for `--no-verify`.

### What actually happened on 2026-09-05

A lane parked #2914 at `Agent Needs Input` to hold `wt-2913-a29-retry` while a human hand-committed
in it. A fresh tick launched a second lane into the same tree.

The sequence, from `~/.open-engine/tick.log` and the issue's own comment log — **the log is the
evidence; the comment text alone is only an inference**:

| Time (UTC) | Event | Source |
|---|---|---|
| 22:55:15 | `AGENT BLOCKED` posted | issue #2914 |
| 22:59:10 | board status → `Agent Needs Input` | REST timeline (`project_v2_item_status_changed`) |
| **22:59:11** | **human comment: "Parking at Agent Needs Input temporarily…"** | issue #2914 |
| 23:00:44 | `claimable: #2914[claude](answered)` | tick.log |
| **23:08:44** | **`--- lane: claude claim #2914 (answered) via ringer ---`** | tick.log |
| 23:14:37 | `AGENT RESUMED` posted by the second lane | issue #2914 |

`answered` is emitted **only** by the gate's `Agent Needs Input` branch, whose rule is *newest
comment is not an `AGENT_*` receipt ⇒ a human replied ⇒ claimable*. The 22:59:11 comment is human
prose, so it satisfied that rule 93 seconds later.

**The act of announcing the park is what un-parked it.** To the gate, "do not touch this" is
indistinguishable from a human answering the question the issue was paused on.

**The overlap was minutes, not seconds.** The lane launched at 23:08:44 and ran ~6 minutes before
posting `AGENT RESUMED`. The issue's "a few seconds either way" framing is wrong by two orders of
magnitude, and the exposure window is correspondingly larger.

### A proximate cause, not background risk

`open-engine` commit `f741933` raised `EngineLaneCap` from 1 to 3 at 2026-09-05T20:49Z — **2h25m
before the incident** — and the tick log shows #2914 riding that exact cap: refused at 21:08:02
(*"only 1 runs at a time"*), admitted at 21:15:33 (*"only 3 runs at a time"*), and launched at
23:08:44 from a slot freed under cap 3. The constant is **global**, not claude-scoped as its commit
subject implies, and `MaxLanes = 4` still bounds total concurrency.

Reverting that experiment is a one-line change and is **not** part of this design. It is noted
because any measurement of whether this class recurs is confounded while the cap sits at 3.

### There are two resume routes, not one

[#3011](https://github.com/dudarenok-maker/Castwright/issues/3011) states that "the resumable-claim
fast path reads the ticket's comment/claim history, not the board `Status` field." That is **false
of `oe-tick.ps1`** — its gate branches on status explicitly, and `resumable-claim` is produced only
under `Agent Working`.

It is **true of `runner/prompt.md`**. The runner's fallback sweep matches (a) `AGENT HUMAN HOLD`
plus a newer human comment and (b) `AGENT BLOCKED` plus a strictly-later human comment, prescribes
*"Move it to Agent Working, leave AGENT UNBLOCKED then AGENT RESUMED"*, and **names no board status
at all**. #2914's shape — `AGENT BLOCKED` 22:55:15, human comment 22:59:11 — satisfies (b) exactly.

This incident travelled the gate's route, not the sweep's (the log proves the claim was
`answered`). But the sweep is a live, status-blind resume path, and any design that closes only the
gate leaves it open. **Both routes must be closed.**

### The invariant being broken is not the one the code guards

The resource that cannot take two writers is the **worktree**. Every mechanism above asserts
exclusivity on the **ticket**. A ticket and a worktree are not 1:1 — they diverge the moment a chain
reassigns or a claim resets mid-flight, which both #2910 and #2914 did on the same night.

### Why this survived #2999

Every other concurrency problem chased on 2026-09-05 arrived through the git hooks, and #2999
removed that source. **This route has nothing to do with hooks.** Merging every worktree onto `main`
does not touch it, and a quiet box is not evidence the class is closed.

## Design

### Part 1 — the gate refuses a second lane on an occupied tree

This is the correctness floor.

**The tick can already resolve a lane's worktree; it simply never uses that to gate.** Two
independent resolvers exist today:

- `Find-LaneWorktrees` matches `git worktree list` against the sequence by name convention — its own
  comment notes that `wt-new.mjs` names the tree after the sequence;
- **the ticket body declares it outright** — #2914's body reads ``Worktree `C:\Claude\Projects\wt-2913-a29-retry`, branch …``.

The tick already prints the resolved path when it reaps (`in C:/Claude/Projects/wt-2913-a29-retry`).
So this is a gate applied to a lookup the tick performs today, not the relocation of unavailable
context that the first draft of this document claimed.

**The rule:** a candidate whose resolved worktree is occupied by a lane this tick still considers
live is dropped from `$claimable` for that tick, with a logged reason. Occupancy is derived from the
tick's own lane bookkeeping — it launches lanes and reaps them, so it already knows which are
running and which tree each was dispatched against.

**Ambiguity fails closed.** If the tree cannot be resolved for a candidate, that candidate is not
dispatched this tick. This is the one place this design deliberately inverts the file's prevailing
doctrine — see below.

### Part 2 — a board state that means "reserved"

Add an `Agent Reserved` option to the project board's Status field, for holding a tree without
claiming to be waiting on an answer.

**The gate needs no change to honour it.** `oe-tick.ps1` has exactly three `if ($status -eq …)`
branches — `Agent Todo`, `Agent Working`, `Agent Needs Input` — and no `else`. An unrecognised
status contributes nothing to `$claimable`, the same way `Agent Waiting` is already ineligible by
construction.

**But "no gate change" is not "no code change", and the first draft of this document wrongly
concluded that it was.** The reserved state touches:

- **`oe-doctor.ps1`**, which *does* have the `else` the tick lacks and would report every reserved
  ticket as a defect — *"its board Status is '…' … so it is not queued"* — with the fix text *"move
  it to Agent Todo when it is ready to run."* Left alone, the doctor instructs the operator to
  un-reserve exactly the trees this design reserves.
- **the hard-coded Status option-ID registry** in `~/.claude/skills/open-agent-engine/SKILL.md`.
- **eight `open-engine/agents/*.md` files**, `oe-route.ps1`, `docs/deliverable-model.md` and
  `docs/runbook.md`, which enumerate statuses.
- **the board's own automation** — `github-project-automation[bot]` writes Status on this project,
  and `add-to-project.yml` adds items. A new option interacts with built-in workflows; the schema
  change is not inert.

`Agent Needs Input` keeps its meaning, and its documentation gains the sentence that was missing:
**a comment on it is a resume trigger, including the comment that says not to resume.**

### Part 3 — close the runner's status-blind sweep

`runner/prompt.md`'s fallback matches (a) and (b) must consult board status before resuming, so
`Agent Reserved` is honoured on that route too. Without this, Part 2 protects one of the two resume
paths and the ticket's original complaint remains true of the other.

## Occupancy and staleness

With the lock file dropped (below), "occupied" is no longer a file on disk with an epoch problem —
it is **lane liveness, which the tick already tracks**. That removes three defects the first draft
had:

- no undefined lock-age epoch (per-run or per-occupancy — both were implementable, and the draft
  did not say which);
- no lock surviving a crashed lane for 105 minutes while the queue relaunches every ~90 s;
- no lock file to leave behind, git-ignore, or clean up.

**Uncommitted work is a third signal, and the tick already computes it.** `Get-UnpushedWork` returns
`Ahead`/`Dirty`. A tree holding another lane's uncommitted changes must not be dispatched into even
when no process is live — tick.log records exactly that state for `wt-2913-a29-retry`
(*"0 unpushed commit(s) and 6 uncommitted file(s)"*). Liveness alone would have released it.

**Where a staleness window is still needed** — a lane the tick has lost track of across a restart —
reuse `Get-ClaimStaleMin`, which derives its window from the lane ceiling per engine. The concrete
values that implies are **105 minutes hosted and 195 local** (`LaneCeilingMin = 90`,
`LocalLaneCeilingMin = 180`, `ClaimStaleMin = 105`). Those numbers are the cost of a wrong
fail-closed decision and belong in the plan, not buried in a helper.

### The inversion, stated explicitly

`oe-tick.ps1` teaches, correctly and repeatedly, that its gate **fails open**: *"if we cannot tell,
wake the lanes."* A frozen queue costs every issue behind it.

**Occupancy must fail closed.** Failing open here *is* the defect. But the cost is real and is
stated rather than waved at: a candidate wrongly judged occupied is **delayed**, not lost — it is
re-evaluated on the next tick, ~90 s later, and the queue behind it still moves because other
candidates are unaffected. That is what makes fail-closed affordable here and not affordable in the
gate at large: this refusal is per-candidate and self-healing, whereas the gate's own failure mode
is total.

## Considered and dropped: a lock file enforced in `.husky/pre-commit`

The first draft made this the correctness floor. **It was wrong, and it is recorded here so it is
not re-proposed.**

- **It would not have prevented the incident on the ticket.** The collision was an OE lane versus a
  **human hand-committing**. A human has no lane identity, so with the lane holding the lock the
  hook refuses *the human's* commit while the intruding lane writes freely — the exact inversion of
  intent.
- **There is no identity to compare.** `oe-tick.ps1` exports `OE_CLAIM_ISSUE` and `OE_CLAIM_WHY` and
  nothing else; there is no lane or engine variable anywhere in the tick or the heartbeat. The only
  identity a hook could read is the issue number — the very noun this design argues is wrong.
- **Nothing would acquire it.** Acquisition would have to be runner prose, which is the mechanism
  this design exists because agents do not reliably follow.
- **"Every write passes through the hook" is false.** `.husky/*` is tracked, so every worktree keeps
  its old hooks until it merges `main` — **16 non-primary worktrees are registered right now**, and
  the ops-2997 sweep needed a deliberate pass per tree. A tool-created worktree has no `.husky/_` at
  all, so git runs no hook, **silently**. (An earlier draft said "~45 worktrees", conflating
  registered trees with the 44 `wt-*` directories on disk; **28 of those are orphaned leftovers**,
  which is a separate finding — ops-2997's unbuilt Part 4, worktree GC.)
- **The mandated write path is invisible to the probe anyway.** `runner/prompt.md` requires commits
  to run from a detached helper launched as `powershell.exe -File <temp>\helper.ps1`; the worktree
  path lives *inside* that file via `Set-Location`, and never appears on any command line. A probe
  that greps command lines returns zero for a tree actively being committed to.

## Testing

**Part 1 — occupancy.**

- two candidates resolving to the same tree: the second is dropped, with its reason logged;
- candidates resolving to different trees: both dispatch;
- a tree whose lane has been reaped is dispatchable again;
- a candidate whose tree cannot be resolved is **not** dispatched (fail-closed), and says why;
- a tree that is idle but `Dirty`/`Ahead` per `Get-UnpushedWork` is **not** dispatched;
- the reported shape end to end: status `Agent Needs Input`, newest comment a human note, a lane
  already live on that tree ⇒ **no second lane launched**. This is the regression the issue asks for.

**Part 2 — the reserved state.**

- `Agent Reserved` yields no candidate, and an unrecognised status contributes nothing;
- `Agent Needs Input` with a newer human comment **still** yields `answered` — pinning today's
  correct behaviour so Part 2 cannot silently change it;
- `oe-doctor.ps1` does not report a reserved ticket as a defect.

**Part 3 — the sweep.** The runner's (a)/(b) matches do not resume a ticket in `Agent Reserved`.

**Mutation-verify the occupancy comparison**: deleting it must redden a named test. Note explicitly
that "both candidates dispatch when trees differ" and "an idle tree is dispatchable" both pass
against a gate that never refuses anything — they are necessary but must never be the only
coverage. This repo has shipped that shape before.

## Risks and trade-offs

- **A wrongly-occupied tree delays a candidate by one tick.** Acceptable, and self-healing —
  but only because the refusal is per-candidate. If a future change makes it batch-wide, this
  argument no longer holds.
- **Tree resolution is heuristic.** Name convention and a ticket-body string are both operator-set
  and can drift. Fail-closed on unresolvable trees converts drift into a stall rather than a
  collision, which is the safe direction but is still a stall.
- **`Agent Reserved` is a board schema change** — manual, per-project, not enforceable by CI, and it
  interacts with project automation.
- **The per-machine skill store.** `~/.claude/skills/oe-*` is not version-controlled; a status-ID
  registry edit there has no history, no review, and no backup. That is a real exposure this design
  depends on and does not fix — see #3000's closing note.

## Out of scope

- Reworking what `Agent Needs Input` means. Its rule is correct for its meaning; the gap was a
  missing state.
- Reverting `EngineLaneCap`. Noted as a confounder above; it is an operational decision, not this
  design's.
- Anything about the commit gate's cost — ops-2997's territory, closed.

## Open questions

- **O1 — where does occupancy state live across a tick restart?** The tick's in-memory lane
  bookkeeping does not survive one. Options: re-derive from `git worktree list` plus live-process
  inspection at startup, or persist alongside the existing tick state. This is the one place the
  dropped lock file's problem genuinely recurs, and it needs an answer before implementation.
- **O2 — is the ticket body or the name convention authoritative** when both resolve and disagree?
- **O3 — does the sweep fix belong in prose or should the sweep move into the tick?** Part 3 as
  written is another prose instruction, which is the mechanism this design distrusts.
