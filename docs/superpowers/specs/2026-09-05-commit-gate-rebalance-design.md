# Commit-gate rebalance — design

- **Date:** 2026-09-05
- **Issue:** [#2997](https://github.com/dudarenok-maker/Castwright/issues/2997)
- **Status:** draft, revised after adversarial review
- **Supersedes the local-gate half of:** [2026-07-06-verify-ci-rebalance-design.md](2026-07-06-verify-ci-rebalance-design.md)

## Problem

The local commit gate has stopped functioning as a gate. Measured on the primary checkout on
2026-09-05, before any intervention:

| Metric | Value |
|---|---|
| `verify-cache` batteries running concurrently | **11** |
| Oldest battery age | **273.8 min (4h34m)** |
| Batteries making progress | **0 of 11** |
| Orphaned vitest (parent dead) | 2, aged 392m and 389m |
| `node.exe` total | 86 |
| Worktrees | 19 (9 of 14 side trees 0 commits ahead of `main`) |

Per-battery subtree CPU. A live vitest subtree burns **30–100 CPU-seconds per minute**:

| PID | Age | Procs | Subtree CPU | CPU/min |
|---|---|---|---|---|
| 47184 | 273.8m | 8 | 37.9s | 0.1 |
| 50836 | 216.7m | 8 | 53.0s | 0.2 |
| 25500 | 183.9m | 12 | 14.3s | 0.1 |
| 24932 | 181.5m | 9 | 40.4s | 0.2 |
| 46848 | 156.1m | 9 | 27.3s | 0.2 |
| 37016 | 130.3m | 10 | 28.8s | 0.2 |
| 46604 | 127.2m | 8 | 27.5s | 0.2 |
| 20328 | 119.1m | 8 | 23.1s | 0.2 |
| 50148 | 108.5m | 9 | 37.1s | 0.3 |
| 12120 | 105.0m | 8 | 17.3s | 0.2 |
| 41696 | 90.4m | 9 | 28.4s | 0.3 |

335 CPU-seconds across ~24 hours of cumulative wall-clock. Reaping the 13 roots freed 96
processes and took `node.exe` from 86 → 9.

### The threshold is two, not "many"

Fifteen minutes after the box was reaped to zero, two batteries had started from other
sessions. Two-sample subtree-CPU delta over 45 s:

| PID | Age | Procs | Subtree CPU | Δ over 45 s |
|---|---|---|---|---|
| 21928 (`verify-cache.mjs --scope-staged`, primary) | 8.6m | 11 → 9 | 23.5s | **1.3s** |
| 47832 (`vitest run`, `wt-2947-slow-lane`) | 8.5m | 5 → 3 | 22.4s | **1.3s** |

Both ~1.7 CPU-s/min, process counts falling while CPU stayed flat. **Two concurrent batteries
are enough to stall both.** Both later exited on their own; whether they completed or died was
not observed, so this measures onset, not terminal state. The 11-battery census above is the
terminal state.

With **76 open `[agent instructions]` tickets**, two-at-once is the steady state, not a spike.
`SIBLING_CONTENTION_THRESHOLD = 1` (`scripts/verify-cache.mjs:1111`) was itself set to 1
because the recorded crashes happened "with as few as two concurrent full batteries."

## Root cause

**The mechanism is Windows tmpdir and handle-budget contention, and it is machine-global.**
The repo's own configs name it: `server/vitest.config.ts:12-29` ("the default forks pool grows
to N=logical-CPUs; with subprocess-spawning tests that exhausts pipe/handle budgets and one
worker dies mid-suite") and `server/vitest.config.slow.ts:4-33` ("`mkdtempSync` + module
imports in `beforeAll` racing on **Windows tmpdir** under parallel-fork pressure"). Two
batteries share one `%TEMP%` and one handle budget regardless of how many forks each uses.

Three defects let that mechanism run unchecked:

**1. Every commit runs the whole world.** `pre-commit` runs `verify:fast:scoped` (~13,500
tests). `pre-push` runs `verify:fast:branch` — 11 steps including both suites, a production
build, and two *network* `npm audit` calls. `--scope-staged`'s `--changed` narrowing applies
only to a diff confined to `src/**` or `server/src/**` with a JS/TS extension
(`diffSafeForChangedOnly`, `verify-cache.mjs:903-915`), so a `scripts/**`, config, or mixed
diff runs the full suite.

**2. Nothing bounds concurrency.** N sessions start N batteries independently. Nothing counts
them, nothing queues them, nothing refuses.

**3. Nothing is ever reaped.** Timed-out and killed commits orphan their fork pools; residue
accumulates monotonically.

### Corrections from adversarial review — do not re-propose these

The first draft of this design blamed the `LOW_CONCURRENCY` GPU throttle. **That was wrong**,
and the correction is recorded here so it is not re-derived:

- **The GPU probe never fired.** `GPU_BUSY_THRESHOLD = 40` (`verify-cache.mjs:1028`) and the
  incident's measured GPU utilisation was **0%**. A mechanism that did not run cannot be the
  cause, and deleting it fixes nothing.
- **A second probe exists that the first draft never mentioned.**
  `detectSiblingContention` (`verify-cache.mjs:1131-1145`) is a separate PowerShell
  `Win32_Process` probe with its own threshold. It is the one that fired.
- **Neither probe explains the failure anyway.** Both set `LOW_CONCURRENCY` on the running
  process's own env, which propagates only to *that* battery's children. The **first** battery
  to start sees zero siblings and an idle GPU, so it runs at `maxWorkers: 2` — and it stalled
  too. The latch is downstream of the real contention, not its cause.
- **"All 11 were latched into single-fork mode" was not observable** and is false for at least
  the first one. Reading it would require dumping each process's environment block.

Deleting the GPU throttle is therefore **out of scope** for this change (see Out of scope).

### The enforcing gate is already elsewhere — with two real exceptions

- `npm run verify` is a **required status check on `main`** (ruleset 17654264).
- Recent `verify.yml` durations: **1–6 minutes**, against a local gate measured at 4h34m.
- Every one of the eleven `verify:fast:branch` legs has a `verify.yml` counterpart. Note
  `test:sidecar` **is** in CI (`verify.yml:403-418`), contrary to `.husky/pre-push:19-21`'s
  claim that it is the one check needing this machine — that prose is stale and gets fixed.

But CI is **not** a superset today, in two dimensions this repo actually breaks in. Both are
closed by this design rather than waved away:

- **Windows.** Every PR-time leg runs `ubuntu-latest`. Windows coverage exists only in
  `cross-os.yml`'s twice-weekly cron and `release.yml`. The failure history here is
  overwhelmingly Windows-specific — the tmpdir race above, CRLF, `windowsHide`, junctions,
  `taskkill`. → **Part 6.**
- **The sidecar's ML stack.** `verify.yml:394-401` installs `requirements/base.txt` +
  `requirements-dev.txt` only. 37+ `pytest.importorskip("torch")` sites across ~14 files skip
  in CI and run only on this box. → **Part 7.**

## Design principles

1. **CI enforces; local informs — except where CI provably cannot.** Windows and the sidecar's
   ML stack are the two exceptions, and each gets an explicit mechanism.
2. **A hook may never spawn a process pool.** Swarming becomes impossible by construction.
   Load-bearing; gets a guard test built as an **allowlist**.
3. **Bounded, not throttled.** Limit how many heavy runs exist; never make each one slower.
4. **Fail fast, never queue.** Queueing produced a 4h34m battery.
5. **No run may outlive a budget.**
6. **Distinguish "ran and found nothing" from "declined to run."** A check that runs blocks on
   findings and passes on infrastructure failure (missing tool, timeout) because CI still
   enforces. A check that *declines to run* — the governor refusing a slot — exits non-zero and
   says so, because silently not running is how a gate becomes theatre.

## The design

### Part 1 — Hook tiers become instant

| Hook | Now | After | Budget |
|---|---|---|---|
| `commit-msg` | `validate-commit-msg.mjs` | unchanged | ~0.3s |
| `pre-commit` | `verify:fast:scoped` (~13,500 tests) | ESLint over **staged files only**, one process | ~2–3s |
| `pre-push` | 3 guards + `verify:fast:branch` (11 steps) | the guards only | ~1–2s |

`pre-commit` → `scripts/hooks/pre-commit-lint.mjs`: staged set from `git diff --cached
--name-only --diff-filter=ACMR`, filtered to JS/TS extensions; empty set exits 0 without
spawning anything; one `eslint` process, no pool, no `--fix`. **Blocks on lint findings; warns
and passes** when eslint is absent or a 60 s budget is exceeded (principle 6).

`pre-push` keeps `guard-protected-push.mjs` and `guard-commit-subjects.mjs` — pure git/text.
Drops the `verify:fast:branch` invocation.

### Part 2 — Admission control at the vitest layer

**The first draft put this in `verify-cache.mjs`. That gates one door out of many.**
`npm run test:server`, the eight subsystem scripts (`package.json:45-55`) that CLAUDE.md
promotes as the local fast loop, and a bare `npx vitest` all reach vitest without touching
`verify-cache.mjs` — and PID 47832 in the census above came through exactly that door.

Admission therefore lives in **`vitest.config.ts` and `server/vitest.config.ts`**, which every
entrance passes through. `verify-cache.mjs` acquires once up front and passes a token down so
its child suites do not double-acquire.

`scripts/lib/verify-slots.mjs`:

- **Slot directory:** resolved from `git rev-parse --git-common-dir`, **explicitly resolved to
  an absolute path against the invoking `cwd`**. This is a trap: the command returns the
  relative `.git` from the primary checkout and an absolute path from a linked worktree. It
  works today only because `runPipeline` is called with `cwd: repoRoot`
  (`verify-cache.mjs:1518`); a bare `join()` splits the directory per-worktree — a **silent
  total failure** of this part. A test asserts the primary checkout and a linked worktree
  compute the *same absolute* slot directory.
- **Acquire:** exclusive create (`flag: 'wx'`) of `slot-<i>.json` for `i` in `0..N-1`, body
  `{ pid, startedAt, worktree, host }`.
- **Liveness — not `process.kill(pid, 0)`.** On Windows that returns `EPERM` for a live process
  the caller cannot open, indistinguishable from a dead one under a naive `ESRCH` check, and
  PIDs recycle. With one slot, a single stale entry whose PID got reused would refuse **every**
  verify on the box, permanently and silently. Instead: read `CreationDate` from
  `Get-CimInstance Win32_Process` (already spawned at `verify-cache.mjs:1131-1145`) and require
  it to match the slot's `startedAt`; plus an absolute age ceiling as a belt. **Reclaim requires
  the whole subtree gone, not just the root** — Part 4 kills trees, and on Windows a dead root
  routinely leaves live forks.
- **On no free slot:** exit non-zero naming the holder's pid, age, and worktree. Never queue.
- **Config:** `CASTWRIGHT_VERIFY_SLOTS` (default **1**), `CASTWRIGHT_VERIFY_NO_SLOT=1` to
  bypass.

Default 1 is not merely cautious: two concurrent batteries demonstrably stall each other, and
the repo's own `SIBLING_CONTENTION_THRESHOLD` was set to 1 on the same evidence.

**Documented tension:** CLAUDE.md's worktree-setup item 4 names `npm run verify:fast:branch`
as the verification of last resort. Part 2 can refuse it. `CASTWRIGHT_VERIFY_NO_SLOT=1` is the
sanctioned escape and the refusal message must name it; the CLAUDE.md line gets updated to say
so.

### Part 3 — No run outlives a budget

**Wall-clock is primary.** `CASTWRIGHT_STEP_TIMEOUT_MIN` (default **20**) per step: kill the
child *tree* and fail the step. It needs no evidence about output behaviour, fires
unconditionally, and covers the observed failure on its own.

**This is not a small addition.** Steps run via `spawnSync` with `stdio: 'inherit'`
(`verify-cache.mjs:1289-1297`), which blocks the event loop so no timer can fire, and hands the
child's output straight to the terminal so the parent sees nothing. Implementing any budget
requires converting step execution to async `spawn`. `runPipeline` is a synchronous exported
function (`:1320`, `:1518`) consumed by `scripts/ci-scope.mjs`, so the conversion must preserve
its contract and its tests. **This is the largest single piece of work in the design and is
scoped accordingly.**

**The silence watchdog is deferred pending measurement.** The claim that the wedged batteries
"produced no output for hours" was inference from near-zero CPU, and is *unobservable* under
`stdio: 'inherit'` — nobody could have seen it. Before building it, run the experiment: reap
the box, start one battery with output redirected to a file, start a second concurrently in
another worktree, and sample the log's size and `LastWriteTime` every 30 s for 15 minutes.
Static for >5 min confirms the mechanism; growing proves it inert. Note also that piping flips
vitest off its TTY reporter (`server/vitest.config.ts:268-271`), so the experiment measures the
piped cadence — which is the cadence the watchdog would actually see. Ship it only on a
positive result, and never with a 5-minute default over legitimately quiet steps (`audit`,
`build`, `typecheck`).

### Part 4 — A reaper

`scripts/reap-stale-batteries.mjs`, exposed as `npm run doctor`. Enumerates processes
(`Win32_Process` on Windows, `ps` on POSIX), classifies roots by **subtree CPU per minute** and
**dead-parent orphan** status — the logic validated against this incident. Reports by default;
`--kill` acts. Never touches `python.exe` (TTS sidecars, Ringer) or the caller's own ancestor
chain. The governor calls its reclaim path before acquiring.

`classify(snapshot, now, thresholds) → verdicts` is a pure function; that is the testable seam.

### Part 5 — Worktree GC

`scripts/wt-gc.mjs`, exposed as `npm run wt:gc`. Lists worktrees with commits-ahead-of-`main`,
merged status, and (when `gh` is available) PR state; offline-tolerant. Reports by default,
`--prune` acts. Junctions dropped **first** via `[System.IO.Directory]::Delete($p, $false)`
gated on the `ReparsePoint` attribute — never on `.LinkTarget`, which reads empty on Windows
PowerShell 5.1 and silently skips the delete. Refuses to prune the primary checkout, any tree
with uncommitted changes, and any tree with unpushed commits.

### Part 6 — A Windows leg in PR-time CI

`verify.yml` gains a `windows-latest` job running `test` and `test:server`, scope-filtered like
every other leg. This moves Windows coverage to where it is *enforced* rather than deleting it
with the hooks. Standard-runner minutes are free and uncapped on this public repo; the job runs
in parallel so it does not extend the critical path materially.

Without this, Part 1 would trade a 4h34m gate for a class of regression that reaches `main` and
surfaces at most twice a week — in exactly the dimension this repo breaks in.

### Part 7 — Scope-triggered local acceptance for hardware-dependent areas

The sidecar's ML stack cannot be covered by adding torch to every PR — gigabytes of wheels for
a leg that fires rarely. Instead, **when a change touches these areas, a proper local
end-to-end run is required, and recorded.** Not on every PR: only when the diff reaches them.

Trigger paths: `server/tts-sidecar/**`, `server/src/tts/**`, `server/src/gpu/**`,
`server/src/analyzer/**`.

A PR touching them must record the local run — command, date, outcome — and the existing
[`docs/testing/onbox-acceptance-register.md`](../../testing/onbox-acceptance-register.md)
machinery is the home for it, since it already exists for precisely this class. **Open question
O2** covers whether to mechanise this as a required check (mirroring
`.github/workflows/pr-issue-link.yml`) or leave it a checklist item.

This is deliberately a *stronger* requirement than the hook it replaces: a real end-to-end run
when it matters, rather than a unit slice on every commit.

## Testing

| Area | Test |
|---|---|
| Slot acquire / reclaim / exhaustion | exclusive create; `CreationDate`-vs-`startedAt` liveness; **primary and linked worktree resolve the same absolute slot dir**; recycled-PID does not false-reclaim; subtree-gone required |
| Reaper classification | pure `classify()` over fixture snapshots **including the 11-battery census above** |
| Worktree GC classification | merged / ahead / dirty / unpushed refusal cases |
| Staged-file selection | extension filter, empty-set short-circuit, missing-eslint pass, timeout pass |
| Step budgets | wall-clock fires; **the whole child tree dies**, not just the direct child |
| **The invariant** | `hook-no-pool.test.mjs` — an **allowlist** of permitted hook invocations. A denylist misses `npm test`, `npm run verify`, `npm run test:server`, `playwright`, `pytest` — the most likely re-additions — and would be the `f_test_cannot_fail` shape this very table warns about. |

Every test asserts against input that would otherwise make the guard fire.

**On-box acceptance rows are owed** (CLAUDE.md checklist step 3 — a merge gate). All six unit
tests above pass on fixture snapshots while the real mechanism could still fail on a live box.
Rows required for: the reaper's `Win32_Process` classification against real processes; the
governor's cross-worktree behaviour under genuine concurrent load; and the budget's
kill-the-whole-tree semantics on Windows.

## Rollout order

**Part 1 goes first, and its first commit touches `.husky/**` only.** This is forced, not
preferred. `test:server`'s inputs include `scripts/**/*.{mjs,cjs,js}`
(`verify-cache.mjs:399`), and `diffSafeForChangedOnly` is a positive allowlist limited to
`src/` and `server/src/` — so any commit adding `scripts/lib/verify-slots.mjs` or
`scripts/reap-stale-batteries.mjs` pulls in the **full** `test:server` suite and must pass the
exact gate being fixed, under the exact contention being fixed. A `.husky/**`-only diff matches
`test:hooks` and nothing else (pinned at `scripts/tests/verify-cache.test.mjs:647-648`), which
is the one cheap door out.

1. **Hooks slimmed** — `.husky/**`-only commit. Unblocks everything downstream.
2. `scripts/hooks/pre-commit-lint.mjs` + the allowlist guard test.
3. **Reaper** (Part 4) — standalone, no dependants.
4. **Governor** (Part 2) — depends on 3's reclaim path, not on 5. Slot acquisition is
   synchronous and lives in the vitest configs, so it does not wait on the async conversion.
5. **Step budgets** (Part 3) — the async `spawn` conversion of step execution.
6. **Windows CI leg** (Part 6) and **local acceptance gate** (Part 7).
7. **Worktree GC** (Part 5).
8. **Docs** — four sites, not one: CLAUDE.md "Commit gate", Before-shipping step 7 ("same
   battery as pre-push" becomes false), "Working practice" default loop, and Worktree-setup
   item 4 (the last-resort verification is now refusable). Plus CONTRIBUTING.md and release
   notes.

## Risks and trade-offs

| Risk | Mitigation |
|---|---|
| Broken code reaches a PR branch more often | Cannot reach `main` — required checks. Feedback goes from 4h34m to 1–6 min. |
| Windows regressions escape | **Part 6** puts Windows in the PR gate for the first time. |
| Sidecar ML-stack regressions escape | **Part 7** requires a recorded local end-to-end run when those paths change. |
| Slot exhaustion blocks a deliberate run | `CASTWRIGHT_VERIFY_NO_SLOT=1`, named in the refusal message and in CLAUDE.md. |
| Async step-execution conversion breaks `ci-scope.mjs` | `runPipeline`'s contract is preserved; `ci-scope.mjs` imports `STEPS`/`stepTouchedByDiff`/`computeShared`, not the runner. Covered by existing tests. |
| Reaper kills a healthy run | Report-only by default; `--kill` is explicit; thresholds calibrated against the measured census. |

## Out of scope

- **Deleting the GPU throttle.** The first draft proposed it; the review established the probe
  never fired (0% against a 40% threshold), that removing it would break
  `scripts/run-golden-audio.mjs:68`'s import of `maxNvidiaSmiUtil`/`GPU_BUSY_THRESHOLD`, and
  that it would invalidate the pins at `scripts/tests/verify-cache.test.mjs:1183-1224` — all
  for a bystander. The *real* defect the incident exposed in that area is that **both probes
  decide once at entry and never re-evaluate**; that is a separate, smaller change and should
  be filed as its own issue rather than ridden in on this one.
- `verify-cache.mjs`'s input-hash/STEPS table. **And note it is not local-only:**
  `scripts/ci-scope.mjs:13` imports `STEPS`, `stepTouchedByDiff`, and `computeShared`, and
  `verify.yml:127` runs it — CI's entire per-leg scope detection derives from this file. After
  Part 1 nothing local exercises it, so a future "it's only local now" simplification would
  silently degrade CI scoping with every check green. Recorded here so that trap is not walked
  into.
- Reducing the Open Engine queue's concurrency. This design makes concurrency *safe*; how many
  lanes run is an operator decision.

## Open questions

- **O1 — `is-docs-only-push.mjs`.** With the battery gone it has no caller, but deletion is not
  clean: the filename is hardcoded at `scripts/tests/entry-point-guard-convention.test.mjs:301`
  (prose at `:74`, `:293`) and referenced in `CLAUDE.md:948` and `CONTRIBUTING.md:586`.
  Recommendation: **retain the script and its tests**, drop only the `pre-push` invocation. The
  cost of keeping it is one unused module; the cost of removing it is four edits across two
  test files and two docs for no functional gain.
- **O2 — Mechanise Part 7?** A required check mirroring `pr-issue-link.yml` that fails when a
  PR touches the trigger paths without a recorded local-run block, versus a Before-shipping
  checklist item. Recommendation: **mechanise** — this repo's record is that unmechanised
  checklist items drift, and `pr-issue-link.yml` is the working precedent.
- **O3 — `SKIP_CONTENTION_CHECK`.** It gates both probes (`verify-cache.mjs:1339`, `:1348`) and
  is documented at `CLAUDE.md:927`. With Part 2 bounding concurrency properly, do the probes
  and this flag still earn their place, or does the flag become the vestige of a superseded
  mechanism? Deferred with the throttle question above.
- **O4 — `wt-2947-slow-lane`.** #2947 proposes moving a twelfth file to the serial lane, and
  that worktree produced one of the two stalled batteries measured here. It should be
  re-evaluated under bounded concurrency before a twelfth entry lands — this is not a neutral
  deferral, and the ticket should be linked to this one.
