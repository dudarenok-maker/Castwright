# Worktree exclusivity — findings and doctrine

- **Date:** 2026-09-06
- **Issue:** [#3011](https://github.com/dudarenok-maker/Castwright/issues/3011)
- **Status:** closed as **doctrine, not mechanism**
- **Outcome:** an operator rule. **No code change anywhere** — three designs and one reported defect were investigated and all four were refuted.

Two designs were written for this and **both were refuted by adversarial review**; a third
finding, raised by a review itself, was refuted on verification. This document records what was
learned, so none of them is proposed again, and states the rule that replaces them.

## What actually happened on 2026-09-05

A lane parked #2914 at `Agent Needs Input` to hold `wt-2913-a29-retry` while a human hand-committed
in it. A tick launched a second lane into the same tree.

| Time (UTC) | Event | Source |
|---|---|---|
| 22:55:15 | `AGENT BLOCKED` | issue #2914 |
| 22:59:10 | board status → `Agent Needs Input` | REST timeline |
| **22:59:11** | **human comment: "Parking at Agent Needs Input temporarily…"** | issue #2914 |
| 23:00:44 | `claimable: #2914[claude](answered)` | `tick.log` |
| **23:08:44** | `--- lane: claude claim #2914 (answered) via ringer ---` | `tick.log` |
| 23:14:37 | `AGENT RESUMED` from the second lane | issue #2914 |

`answered` is emitted only by the gate's `Agent Needs Input` branch, whose rule is *newest comment
is not an `AGENT_*` receipt ⇒ a human replied ⇒ claimable*. The parking comment is human prose, so
it satisfied that rule 93 seconds later.

**The act of announcing the park is what un-parked it.** The overlap was ~6 minutes, not the
"few seconds" the issue describes.

**The issue's stated mechanism is wrong.** It says the resumable-claim path ignores board `Status`.
`oe-tick.ps1` branches on status explicitly and produces `resumable-claim` only under
`Agent Working`. Remedies 1 and 2 on the issue target a defect that does not exist.

## The two refuted designs

### Rejected — a lock file checked in `.husky/pre-commit`

- **It would have inverted the incident.** The collision was a lane against a **human**. A human
  carries no lane identity, so the lane holds the lock and the hook refuses *the human's* commit
  while the intruder writes freely.
- **Nothing would acquire it.** Acquisition would be runner prose — the mechanism this was meant to
  compensate for.
- **"Every write passes through the hook" is false.** `.husky/*` is tracked, so each worktree keeps
  old hooks until it merges `main`; a tool-created worktree has no `.husky/_` and runs **no hook,
  silently**.
- **The mandated write path is invisible to a process probe.** `runner/prompt.md` requires commits
  from a detached helper; the worktree path lives inside that helper file and never appears on a
  command line.

### Rejected — the gate refuses a second lane on an occupied tree

- **It reproduces the same blind spot.** Its predicate is *lane* liveness; the incident had no
  second lane, it had a human. It sees neither party.
- **Tree resolution does not work.** `Find-LaneWorktrees` matches worktree name against sequence.
  Measured against the live queue: **6 of 13 sequences resolve; the 7 failures cover 35 of 46 open
  tickets (76%)**, because trees are named for batches, not sequences. Fail-closed on that is a
  permanent queue halt, not a one-tick delay.
- **The tick does not know a running lane's tree.** The lane object has no worktree field;
  resolution happens only on the crash path, when a lane exits with no `OE-RESULT`.
- **`Dirty`/`Ahead` cannot serve as occupancy.** **9 of 15** worktrees are dirty right now with no
  process live in them, and the signal cannot attribute work — the log's own "work left behind by
  lane claude" line describes files the *human* wrote.

### And the board already had the state

`Agent Reserved` was proposed on the premise that no state means "reserved." The board carries
**12 Status options**, including **`Parked`**, `Agent Waiting`, and `Waiting/Blocked` — all of which
already yield zero candidates, because the gate has three equality branches and no `else`.

## A third refuted finding — the "one real defect" was not one

Review pass 2 reported that `Select-Lanes`' `$seenSeq` (the one-worker-per-sequence rule) is
initialised empty on every call while the engine cap beside it **is** seeded from running lanes —
concluding that a mid-tick top-up could therefore start two lanes on one worktree, masked until
`EngineLaneCap` went 1 → 3.

**That fix was implemented, then discarded, because the defect does not exist.** The top-up call
site already excludes in-flight sequences before starting anything:

```powershell
$busySeq = @($lanes | Where-Object { -not $_.Proc.HasExited } | ForEach-Object { [string]$_.Sequence })
$extra   = @(Invoke-Gate -TopUp | Where-Object { $busySeq -notcontains [string]$_.Sequence })
```

with its own comment stating the intent: *"SEQUENCES IN FLIGHT ARE EXCLUDED. Children of one parent
share a branch and a worktree, so a top-up must never start a second lane inside a sequence this
tick is already running. `Select-Lanes` cannot know that — it only sees the candidates handed to it
— so the filtering happens here."*

`$seenSeq` being unseeded is **deliberate and documented**, not an oversight. There are exactly two
lane-start paths — `Start-Lanes` at the initial pass and at the top-up — and both are covered: the
first by `$seenSeq`'s within-pass dedupe, the second by the caller's filter.

**No change was made to `open-engine`.** It would have added redundant machinery to a live
scheduler for a defect that is already handled one layer up.

The finding was caught by the implementing agent reporting it as an incidental observation, and
confirmed by enumerating every `Start-Lanes` and `Invoke-Gate` call site. Worth recording as a
method note: three adversarial reviews across this issue produced three refutations, and **the third
refutation was of a review's own finding.** A review's claim is evidence, not a verdict.

## Doctrine — what actually protects a tree

Mechanism cannot see a non-lane writer. The operator, an interactive Claude Code session, a
dispatched fix agent, and an orphaned battery outliving its killed lane are all invisible to any
lane-based predicate, and the first of those is what caused this incident. **This is stated as a
limit rather than papered over.**

1. **Do not hand-commit in a worktree that has an open agent ticket.** Commit from the primary
   checkout, or from a tree no ticket points at.
2. **If you must, park the ticket at `Parked`** — an existing board state that yields no candidate.
   **Not `Agent Needs Input`**: that state means *waiting on a person*, and **any comment on it is a
   resume trigger, including the comment that says not to resume.**
3. **Announcing a park does not park it.** Change the state first; the comment is a courtesy, and
   on `Agent Needs Input` it is actively harmful.
4. **Before writing in a tree an agent may hold, check for live processes against that tree** — and
   exclude your own process ancestry *and its children* from the check, or the probe matches its own
   command line and reports phantom occupants.

## What remains unsolved, and is not being solved

**There is no signal that a non-lane writer is in a tree.** A human or interactive session that has
read but not yet written produces nothing observable, and `Dirty`/`Ahead` cannot attribute what it
sees. Closing that needs a mechanism every writer participates in, which does not exist and was not
worth inventing at the cost of two refuted designs.

If this class recurs *between lanes*, that is new information — the two lane-start paths are both
guarded, so a lane-versus-lane collision would mean one of those guards is wrong — and this
document is wrong. If it recurs between a lane and a human, it is the known limit above.

## Confounder, noted and not addressed

`EngineLaneCap` went 1 → 3 in `open-engine` `f741933` at 2026-09-05T20:49Z, ~2h before the
incident, and #2914 was held back under the old cap earlier the same evening. Causation is not
established — `answered` sorts rank 0, so the ticket would likely have taken the next freed slot
under cap 1 as well, delayed rather than prevented. But **any measurement of whether this class
recurs is confounded while the cap sits at 3**, and it is a one-line revert.
