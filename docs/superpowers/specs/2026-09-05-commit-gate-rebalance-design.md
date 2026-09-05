# Commit-gate rebalance — design

- **Date:** 2026-09-05
- **Issue:** [#2997](https://github.com/dudarenok-maker/Castwright/issues/2997)
- **Status:** draft, pending review
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

335 CPU-seconds consumed across ~24 hours of cumulative wall-clock. This is deadlock, not
slowness. Reaping the 13 roots freed 96 processes and took `node.exe` from 86 → 9.

## Root cause

Three independent defects that multiply:

**1. Every commit runs the whole world.** `pre-commit` runs `verify:fast:scoped` (~13,500
tests). `pre-push` runs `verify:fast:branch` — 11 steps including both suites, a production
build, and two *network* `npm audit` calls. `--scope-staged`'s `--changed` narrowing applies
only to a diff confined to `src/**` or `server/src/**` with a JS/TS extension
(`diffSafeForChangedOnly`), so a `scripts/**`, config, or mixed diff runs the full suite.

**2. Nothing bounds concurrency, and the mitigation is positive feedback.** With **76 open
`[agent instructions]` tickets** feeding concurrent agent sessions, N batteries start
independently. Each probes `nvidia-smi` **once at hook start**; a busy GPU sets
`LOW_CONCURRENCY=1`, dropping `maxForks` 2 → 1. Every concurrent suite then runs single-forked
and they deadlock on the Windows tmpdir and fork pool. Three compounding faults in that one
mechanism:

- **The decision never re-evaluates.** Verified today: GPU 0 sat at **0% / 0 MiB** while all
  11 batteries were still latched into single-fork mode. They cannot recover on their own.
- **It reads the wrong GPU.** `detectGpuContention` takes max utilisation across *every*
  `nvidia-smi` line. Unrelated work on the 16 GB card pins the throttle for suites that only
  ever touch the 8 GB card.
- **Halving fork width lengthens each run**, which widens the overlap window, which increases
  contention. The mitigation amplifies the failure it exists to prevent.

**3. Nothing is ever reaped.** Timed-out and killed commits orphan their fork pools; residue
accumulates monotonically, so every subsequent run starts slower than the last.

### Why this is not a test bug

`server/vitest.config.slow.ts`'s header records that **four** route files were moved to the
serial lane for exactly this shape (`mkdtempSync` + module imports in `beforeAll` racing on the
Windows tmpdir under fork pressure). [#2947](https://github.com/dudarenok-maker/Castwright/issues/2947)
is the **fifth**, and proposes moving a twelfth file. The population of files with that shape is
unbounded, so per-file relocation cannot converge. The bounded quantity is *how many batteries
run at once* — which nothing currently limits.

### The enforcing gate is already elsewhere

- `npm run verify` is a **required status check on `main`** (ruleset 17654264). Nothing reaches
  `main` without it.
- Recent `verify.yml` durations: **1–6 minutes**.

The local battery is therefore a **10× slower duplicate of the authoritative gate**, run up to
11× concurrently on one box. Essentially 100% of local test time is redundant work.
[2026-07-06-verify-ci-rebalance-design.md](2026-07-06-verify-ci-rebalance-design.md) already
declared CI the enforcement gate; the hooks were never cut back to match. This design finishes
that migration.

## Design principles

1. **CI enforces; local informs.** Any local check must justify itself against a 1–6 minute
   authoritative alternative.
2. **A hook may never spawn a process pool.** Swarming becomes impossible by construction, not
   by policy. This is the load-bearing invariant and it gets a guard test.
3. **Bounded, not throttled.** Limit *how many* heavy runs exist; never make each one slower.
4. **Fail fast, never queue.** Queueing is what produced a 4h34m battery.
5. **No run may outlive a budget.** A process that stops making progress terminates itself.
6. **Fail on findings, pass on infrastructure.** A local check blocks on a real defect; a
   missing tool or a timeout warns and passes, because CI still enforces.

## The design

### Part 1 — Hook tiers become instant

| Hook | Now | After | Budget |
|---|---|---|---|
| `commit-msg` | `validate-commit-msg.mjs` | unchanged | ~0.3s |
| `pre-commit` | `verify:fast:scoped` (~13,500 tests) | ESLint over **staged files only**, one process | ~2–3s |
| `pre-push` | 3 guards + `verify:fast:branch` (11 steps) | the guards only | ~1–2s |

**`pre-commit` → `scripts/hooks/pre-commit-lint.mjs`**

- Staged set from `git diff --cached --name-only --diff-filter=ACMR`.
- Filter to `.ts .tsx .js .jsx .mjs .cjs .mts .cts`. Empty set → exit 0 without spawning
  anything.
- One `eslint --no-error-on-unmatched-pattern <files>` process. No pool, no `--fix`.
- **Blocks on lint findings.** Warns and passes when eslint is absent (a worktree without
  `node_modules`) or exceeds a 60s wall-clock budget — infrastructure failure is not a defect,
  and CI's `lint` leg still enforces.

**`pre-push`**

Keeps `guard-protected-push.mjs` and `guard-commit-subjects.mjs` — both pure git/text, no
subprocess pool. Drops the `verify:fast:branch` invocation.

`is-docs-only-push.mjs` exists solely to skip that battery. With the battery gone it has no
caller. **Open question (O1)** below.

### Part 2 — A machine-wide governor for heavy runs

Agents and humans still run `npm run verify*` manually. That path gets admission control.

New `scripts/lib/verify-slots.mjs`:

- **Slot directory:** `<git-common-dir>/castwright-verify-slots/`. All 19 worktrees share one
  `.git`, so `git rev-parse --git-common-dir` yields a naturally machine-wide, repo-scoped
  location with no new config and no OS temp-dir guessing.
- **Acquire:** attempt exclusive create (`fs.writeFileSync(path, …, { flag: 'wx' })`) of
  `slot-<i>.json` for `i` in `0..N-1`. Body: `{ pid, startedAt, worktree, steps, host }`.
- **Stale reclaim first:** for each existing slot, `process.kill(pid, 0)`; `ESRCH` → unlink and
  make the slot available. This is what makes a hard-killed battery self-healing.
- **On no free slot:** exit non-zero with a distinct code and a message naming the holder's
  pid, age, and worktree, plus the reminder that CI is the enforcing gate. **Never queue.**
- **Release:** unlink on `exit`, `SIGINT`, `SIGTERM`.
- **Config:** `CASTWRIGHT_VERIFY_SLOTS` (default **1**), `CASTWRIGHT_VERIFY_NO_SLOT=1` to
  bypass for a deliberate parallel run.

Default of 1 is deliberate: the evidence shows two concurrent server suites (4 forks) already
destabilise the pool.

### Part 3 — No run outlives a budget

`verify-cache.mjs` gains two independent kill switches per step. These are the safety net that
makes recurrence impossible even if every other part regresses.

- **Silence watchdog (primary).** If a step emits no stdout/stderr for
  `CASTWRIGHT_STEP_SILENCE_MIN` (default **5**) minutes, kill its process tree and fail the step
  with an explicit "not progressing" message. This is the precise signature of today's failure:
  those 11 batteries produced no output for hours. Chosen over CPU sampling because it needs no
  WMI/`ps` and is portable.
- **Wall-clock backstop.** `CASTWRIGHT_STEP_TIMEOUT_MIN` (default **20**) per step; kill and
  fail. Generous enough that a legitimate `test:server` (~13 min) never trips it.

Both kill the whole child tree, not just the direct child, so vitest forks cannot survive.

### Part 4 — A reaper

`scripts/reap-stale-batteries.mjs`, exposed as `npm run doctor`.

- Enumerates processes (`Get-CimInstance Win32_Process` on Windows, `ps -eo` on POSIX).
- Classifies battery roots by **subtree CPU per minute** and **dead-parent orphan** status —
  the exact logic validated against today's incident.
- **Reports by default; `--kill` acts.** Never touches `python.exe` (TTS sidecars, Ringer) or
  the caller's own ancestor chain.
- The governor calls the reclaim path before acquiring a slot, so residue cannot accumulate.

The classification is a **pure function over a process snapshot**, which is the unit-testable
seam: `classify(snapshot, now, thresholds) → verdicts`.

### Part 5 — Worktree GC

`scripts/wt-gc.mjs`, exposed as `npm run wt:gc`.

- Lists worktrees with commits-ahead-of-`main`, merged status, and (when `gh` is available and
  online) PR state. Offline-tolerant.
- **Reports by default; `--prune` acts.** Junctions are dropped **first** via
  `[System.IO.Directory]::Delete($p, $false)` gated on the `ReparsePoint` attribute — never on
  `.LinkTarget`, which reads empty on Windows PowerShell 5.1 and silently skips the delete.
- **Refuses to prune** the primary checkout, any tree with uncommitted changes, and any tree
  with unpushed commits.

### Part 6 — Remove the GPU throttle

Delete `detectGpuContention`, its `nvidia-smi` probe, and the automatic `LOW_CONCURRENCY`
assignment. **Retain `LOW_CONCURRENCY` as a manual env override** — `server/vitest.config.ts`,
`server/vitest.config.slow.ts`, and `scripts/test-concurrency.mjs` read it, and it remains a
legitimate operator lever.

Rationale: Part 2 bounds concurrency properly, which is what the throttle was approximating;
the throttle's non-re-evaluating latch is the deadlock's proximate cause; and its
max-across-all-GPUs reading is wrong on a two-card box.

`run-golden-audio.mjs` imports the exported contention helper for its bless-time warning. That
call site converts to a plain advisory that warns and never throttles.

## Testing

| Area | Test |
|---|---|
| Slot acquire / reclaim / fail-fast | `scripts/tests/verify-slots.test.mjs` — exclusive create, dead-pid reclaim, exhaustion exit code, release on signal |
| Reaper classification | `scripts/tests/reap-stale-batteries.test.mjs` — pure `classify()` over fixture snapshots incl. the 2026-09-05 census |
| Worktree GC classification | `scripts/tests/wt-gc.test.mjs` — merged/ahead/dirty/unpushed refusal cases |
| Staged-file selection | `scripts/tests/pre-commit-lint.test.mjs` — extension filter, empty-set short-circuit, missing-eslint pass, timeout pass |
| Step budgets | `scripts/tests/verify-cache-budgets.test.mjs` — silence watchdog fires, wall-clock backstop fires, tree is killed |
| **The invariant** | `scripts/tests/hook-no-pool.test.mjs` — greps `.husky/*` for forbidden invocations (`verify:fast`, `vitest`, `tsc`, `npm run build`, `audit`) and fails if any reappears |

The last one is the regression guard that keeps this fix from eroding. All land in the existing
`npm run test:hooks` harness.

Every test asserts against a **snapshot that would otherwise make the guard fire** — a
classification test whose fixture contains no wedged battery proves nothing
(`f_test_cannot_fail`).

## Rollout order

Safety before speed, so no window exists in which the pile-up can rebuild:

1. **Reaper + governor + step budgets** (Parts 4, 2, 3) — recurrence becomes impossible.
2. **Hook slimming** (Part 1) — the 50-minute commit becomes ~3s.
3. **Throttle removal** (Part 6).
4. **Worktree GC** (Part 5).
5. **Docs** — `CLAUDE.md` "Commit gate", `CONTRIBUTING.md`, release notes.

## Risks and trade-offs

| Risk | Mitigation |
|---|---|
| Broken code reaches a PR branch more often | It cannot reach `main` — required checks. Feedback drops from 50 min to 1–6 min, so the loop is *faster*, not looser. |
| Agents stop running local verify entirely | Acceptable and largely already true. CI enforces. |
| Silence watchdog kills a legitimately quiet step | 5-min default with a generous 20-min backstop; both configurable; the failure message names the knob. |
| Slot exhaustion blocks a human's deliberate run | `CASTWRIGHT_VERIFY_NO_SLOT=1`, and the message says so. |
| Losing `--changed` narrowing's value | Retained for manual `verify:fast:scoped` runs; it just stops being on the commit path. |
| CI cost rises | Public repo, standard runners, free and uncapped per `CLAUDE.md`. |

## Out of scope

- Changing `verify.yml`'s legs or `main`'s required checks.
- The `verify-cache` input-hash/STEPS table (1,524 lines) — a real simplification target, but a
  separate change with its own stale-green risk surface.
- Reducing the Open Engine queue's concurrency. This design makes the queue's concurrency
  *safe*; how many lanes run is an operator decision.
- #2947's per-file serial-lane move. If this lands first, that file should be re-evaluated
  under bounded concurrency before a twelfth entry is added.

## Open questions

- **O1 — `is-docs-only-push.mjs`.** With the battery gone it has no caller. Delete it and its
  tests (orphaned by this change, per `CLAUDE.md` "Surgical changes"), or retain because
  `CONTRIBUTING.md`'s doc-only fast-path concept references the same test? Recommendation:
  **delete**, and keep the doc-only concept documented against `verify.yml`'s own scope
  conditions, which is where it still has force.
- **O2 — Default slot count.** 1 (conservative, matches the evidence) vs 2 (allows a human and
  an agent to overlap). Recommendation: **1**, raise later on evidence.
- **O3 — Should `pre-commit` lint at all,** or be empty like `pre-push`? Linting staged files
  is cheap, single-process, and catches real defects before a CI round-trip. Recommendation:
  **keep it**, since it cannot swarm and it preserves a real local signal.
