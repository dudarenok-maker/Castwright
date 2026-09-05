# Commit-gate rebalance — design

- **Date:** 2026-09-05
- **Issue:** [#2997](https://github.com/dudarenok-maker/Castwright/issues/2997)
- **Status:** draft, revised after two adversarial review passes
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

Fifteen minutes after that reap, two fresh batteries from other sessions were both measured at
**1.3 CPU-seconds per 45 s** (~1.7/min) with falling process counts — so **two concurrent
batteries are enough to stall both.** With **76 open `[agent instructions]` tickets**,
two-at-once is the steady state.

## Root cause

**The mechanism is Windows tmpdir and handle-budget contention, and it is machine-global.**
The repo's own configs name it: `server/vitest.config.ts:12-29` ("the default forks pool grows
to N=logical-CPUs; with subprocess-spawning tests that exhausts pipe/handle budgets and one
worker dies mid-suite") and `server/vitest.config.slow.ts:4-33` ("`mkdtempSync` + module
imports in `beforeAll` racing on **Windows tmpdir** under parallel-fork pressure").

Three defects let that mechanism run unchecked:

1. **Every commit runs the whole world.** `pre-commit` runs `verify:fast:scoped` (~13,500
   tests); `pre-push` runs 11 steps including both suites, a build, and two *network* audits.
   `--changed` narrowing applies only to diffs confined to `src/**` or `server/src/**`
   (`diffSafeForChangedOnly`, `verify-cache.mjs:903-915`).
2. **Nothing bounds concurrency.**
3. **Nothing is ever reaped.**

### Corrections from adversarial review — do not re-derive these

- **The GPU probe never fired.** `GPU_BUSY_THRESHOLD = 40` (`verify-cache.mjs:1028`); measured
  utilisation was **0%**. Deleting it fixes nothing. It also cannot be deleted cheaply:
  `scripts/run-golden-audio.mjs:68` imports `maxNvidiaSmiUtil` and `GPU_BUSY_THRESHOLD`, and
  `scripts/tests/verify-cache.test.mjs:1183-1224` pins `detectGpuContention`'s source text.
- **A second probe exists**, `detectSiblingContention` (`verify-cache.mjs:1131-1145`), which the
  first draft never mentioned. `SKIP_CONTENTION_CHECK` gates both at `:1340` and `:1350`.
- **Neither probe explains the failure.** Both set `LOW_CONCURRENCY` on their own process env,
  which reaches only that battery's children. The **first** battery sees zero siblings and an
  idle GPU, runs at `maxWorkers: 2`, and stalls anyway. "All 11 were latched" was never
  observable — it would require dumping each process's environment block.
- **`.husky/pre-push:19-21`'s "the one check that genuinely needs this machine" is CORRECT, not
  stale.** An earlier draft called it stale on the grounds that `verify.yml:403-418` runs
  `test:sidecar`. CI runs it **without torch** — deliberately (`verify.yml:396-400`) — so all 38
  `pytest.importorskip("torch")` tests (14 files, all under `server/tts-sidecar/`) skip there
  and execute only on this box. Part 6 depends on that sentence being true. Do not "fix" it.

## Scope: what this design does and does not do

Two adversarial passes established that **admission control / a concurrency governor cannot be
built the way it was specified, and probably should not be built yet at all.**

- Gating inside the vitest configs **breaks the repo on day one**:
  `vitest.config.wire-fixtures.ts` and `server/vitest.config.wire-fixtures.ts` are not entry
  points — they are spawned as nested vitest processes *from inside a running vitest test*
  (`src/vitest-retry-hazard-reporter.test.ts:137`,
  `server/src/vitest-retry-hazard-reporter.test.ts:148`). With one slot held by the outer suite,
  the nested child cannot acquire and exits non-zero by design, failing both test files on every
  local run and in CI. Both configs additionally `import mainConfig from './vitest.config.js'`,
  double-acquiring in one process.
- Slot liveness has no sound implementation yet: `CreationDate`-vs-`startedAt` cannot match
  (they differ by Node boot + config bundling), `process.kill(pid,0)` is unsafe on Windows, and
  release via `process.on('exit')` is bypassed by `taskkill /T /F` and by this design's own
  reaper — making **leaked slots the normal case**, not the edge.
- The cure was narrower than the cause anyway: Playwright (4 scripts, one at `--workers=2`),
  pytest ×2, Pester, and the sidecar all spawn pools against the same `%TEMP%` and handle
  budget, and none would have been gated.

**Decision: the governor is deferred, not designed.** Part 1 removes the source of nearly all
concurrent batteries — after it, a battery only exists because someone deliberately started
one. Building machinery to bound a population we are about to shrink by an order of magnitude
is speculative. **Measure first** (see "Deferred work" below).

What ships here: instant hooks, bounded run duration, a reaper, worktree GC, a Windows CI leg,
and a scope-triggered local acceptance requirement for the sidecar.

## Design principles

1. **CI enforces; local informs — except where CI provably cannot.** The sidecar's ML stack is
   the one real exception and gets an explicit mechanism (Part 6).
2. **A hook may never spawn a process pool.** Load-bearing; enforced by an **allowlist** guard
   test.
3. **No run may outlive a budget**, and the budget is on the *pipeline*, not only its steps.
4. **Distinguish "ran and found nothing" from "declined to run."** A check that runs blocks on
   findings and passes on infrastructure failure (missing tool, timeout), because CI still
   enforces.

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
and passes** when eslint is absent or a 60 s budget is exceeded (principle 4).

`pre-push` keeps `guard-protected-push.mjs` and `guard-commit-subjects.mjs`. Drops the
`verify:fast:branch` invocation. `is-docs-only-push.mjs` is **retained** (its invocation is
dropped, the script and tests stay — see O1).

### Part 2 — No run outlives a budget

Three numbers, and the pipeline cap is the one that actually bounds the incident:

| Knob | Default | Purpose |
|---|---|---|
| `CASTWRIGHT_RUN_TIMEOUT_MIN` | **60** | whole-pipeline cap. A legitimate full `npm run verify` measures well under this; the incident ran 273.8. |
| `CASTWRIGHT_STEP_TIMEOUT_MIN` | **20** | per **attempt**, not per step |
| — | — | a timeout-kill sets an explicit flag so it is **never** re-read as a retriable pool crash |

The first draft specified only a per-step budget. That was arithmetically inadequate: 11 steps ×
20 min is **220 minutes**, against an incident of 273.8 — and `test:server`/`test:server-slow`
each retry up to `MAX_POOL_ATTEMPTS = 3` (`verify-cache.mjs:1247`, `:1253`), so per-step-not-
per-attempt would have let those two alone reach 120 minutes. The pipeline cap is what makes
principle 3 true.

**Implementation is an async `spawn` conversion of step execution, and it is the largest piece
of work here.** Steps currently run via `spawnSync` (`verify-cache.mjs:1288-1318`), which blocks
the event loop so no timer can fire. **There are two stdio shapes to preserve, not one:**

- non-retriable steps: `stdio: 'inherit'`;
- `test:server` / `test:server-slow`: `stdio: ['inherit','inherit','pipe']` with `encoding:
  'utf8'` and `maxBuffer: 64MB`, whose captured stderr feeds `isVitestPoolCrash()` and the
  3-attempt retry loop.

The async version must reproduce both, including a bounded stderr accumulator standing in for
`maxBuffer`. Timeouts kill the **whole child tree**, not the direct child.

`runPipeline`'s signature and return contract are preserved. This is safe:
`scripts/ci-scope.mjs:13` imports only `{ STEPS, stepTouchedByDiff, computeShared }` — never the
runner — and `verify-cache.mjs`'s module body is guarded by `isDirectlyInvoked(import.meta.url)`
(`:1513-1520`), so importing it has no side effects.

**The silence watchdog is not in scope.** Its evidence was inference, and it was unobservable
under `stdio: 'inherit'`. The wall-clock caps need no such evidence. If it is ever revisited,
the experiment is: reap the box, run one battery with output redirected, start a second
concurrently, and sample the log's size and `LastWriteTime` every 30 s for 15 minutes.

### Part 3 — A reaper

`scripts/reap-stale-batteries.mjs`, exposed as `npm run doctor`. Enumerates processes
(`Win32_Process` on Windows, `ps` on POSIX), classifies roots by **subtree CPU per minute** and
**dead-parent orphan** status — the logic validated against this incident. Reports by default;
`--kill` acts. Never touches `python.exe` (TTS sidecars, Ringer) or the caller's own ancestor
chain.

`classify(snapshot, now, thresholds) → verdicts` is a pure function; that is the testable seam.

### Part 4 — Worktree GC

`scripts/wt-gc.mjs`, exposed as `npm run wt:gc`. Lists worktrees with commits-ahead-of-`main`,
merged status, and (when `gh` is available) PR state; offline-tolerant. Reports by default,
`--prune` acts. Junctions dropped **first** via `[System.IO.Directory]::Delete($p, $false)`
gated on the `ReparsePoint` attribute — never on `.LinkTarget`, which reads empty on Windows
PowerShell 5.1 and silently skips the delete. Refuses to prune the primary checkout, any tree
with uncommitted changes, and any tree with unpushed commits.

Independent of Parts 1–3 and cuttable without affecting them.

### Part 5 — A Windows leg in PR-time CI

**Wiring is the whole risk here.** Two traps, both of which would have shipped:

- **The new job must be added to the aggregator's `needs:` list.** The only required context on
  ruleset 17654264 is the aggregator job named `npm run verify` (`verify.yml:557-560`,
  `docs/features/235-model-routing-review-gates.md:37,43-44`). A Windows job outside that list
  is decorative — red on Windows would not block merge.
- **Scope conditions go on steps, never on the job.** The aggregator's "Check leg results" step
  fails on `'skipped'` as well as failure. A job-level `if:` makes the job report `skipped` and
  **permanently blocks every docs-only PR**. Every existing leg puts its condition on steps for
  exactly this reason.
- `verify.yml` has no `defaults: run: shell: bash`, and every multi-line `run:` in it is bash, so
  each new step pins `shell: bash` explicitly. `detect`'s outputs are OS-agnostic and consumable
  via `needs:` from any runner; `.github/actions/setup` already keys its cache on `runner.os`.

**Honest scope of the payoff.** This closes CRLF, `windowsHide`, and path-handling regressions.
It does **not** close the tmpdir/handle race that caused this incident — that is a concurrency
artifact and a `windows-latest` runner is single-tenant, so it structurally cannot reproduce
there. The earlier draft justified Part 5 with that race; that justification was wrong.

### Part 6 — Scope-triggered local acceptance for the sidecar

`verify.yml:396-400` deliberately installs only `requirements/base.txt` +
`requirements-dev.txt`, so **38 `pytest.importorskip("torch")` tests across 14 files — all under
`server/tts-sidecar/`** — skip in CI and run only on this box. Part 1 deletes the automatic
`test:sidecar` push trigger that exercises them.

**Trigger path: `server/tts-sidecar/**` only.** An earlier draft also listed
`server/src/tts/**`, `server/src/analyzer/**`, and `server/src/gpu/**` — 177 TypeScript test
files that Ubuntu CI already covers. Requiring a manual on-box run for those would be waived by
habit within a week and would protect nothing.

**This must be mechanised, not written on a checklist.** Part 1 replaces an *automatic* trigger;
an unenforced checklist item is strictly weaker than what it replaces, and this repo's record is
that unmechanised items drift. A required check mirroring `.github/workflows/pr-issue-link.yml`
fails a PR touching `server/tts-sidecar/**` unless the body records the local run — command,
date, outcome — or links an [on-box acceptance
register](../../testing/onbox-acceptance-register.md) row.

## Testing

| Area | Test |
|---|---|
| Reaper classification | pure `classify()` over fixture snapshots **including the 11-battery census above** |
| Worktree GC classification | merged / ahead / dirty / unpushed refusal cases |
| Staged-file selection | extension filter, empty-set short-circuit, missing-eslint pass, timeout pass |
| Step budgets | per-attempt timeout fires; **pipeline cap fires independently**; the whole child tree dies; a timeout is **not** retried as a pool crash; both stdio shapes preserved; retry loop still triggers on a genuine `isVitestPoolCrash` |
| **The invariant** | `hook-no-pool.test.mjs` — an **allowlist** of permitted hook invocations. A denylist misses `npm test`, `npm run verify`, `npm run test:server`, `playwright`, `pytest`. |
| Hook-scope exclusivity | pin that a `.husky/**` diff selects `test:hooks` **and nothing else**. `scripts/tests/verify-cache.test.mjs:647-648` was cited for this and does **not** assert it — it tests only the positive. True today, unpinned; the rollout depends on it, so pin it. |

Every test asserts against input that would otherwise make the guard fire.

**Where the invariant guard runs.** `scripts/run-hooks-tests.mjs:15` drives `node --test` across
~100 files, forking per file — so `test:hooks` is itself a pool, and after Part 1 no hook runs
it. The guard lives in CI's `test:hooks` leg (a required check) and in a manual `npm run
verify`, not on the commit path. A hook re-fattening is caught at PR time, not commit time.

**On-box acceptance rows are owed** (CLAUDE.md checklist step 3 — a merge gate). Every unit test
above passes on fixture snapshots while the real mechanism could fail on a live box. Rows
required for: the reaper's `Win32_Process` classification against real processes, and the
budget's kill-the-whole-tree semantics on Windows.

## Rollout order

**Commit 1 touches `.husky/**` only, and its hook bodies must be self-contained.** This is
forced. `test:server`'s inputs include `scripts/**/*.{mjs,cjs,js}` (`verify-cache.mjs:399`) and
`diffSafeForChangedOnly` is limited to `src/`/`server/src/`, so any commit adding a file under
`scripts/` pulls in the **full** `test:server` suite and must pass the gate being fixed. A
`.husky/**`-only diff selects `test:hooks` alone (extension-less hook files miss `lint`'s
`**/*.{ts,tsx,js,jsx,cjs,mjs}` glob).

**The trap:** commit 1 must not install a hook that calls
`scripts/hooks/pre-commit-lint.mjs`, because commit 2 creates that file. Between the two, every
commit dies on `MODULE_NOT_FOUND` — including commit 2. So commit 1's `pre-commit` is either a
no-op or an inline `git diff --cached` + `eslint` one-liner, and commit 2 swaps in the script.

1. **Hooks slimmed** — `.husky/**`-only, self-contained bodies. Unblocks everything downstream.
2. `scripts/hooks/pre-commit-lint.mjs` + the allowlist guard test + the hook-scope exclusivity pin.
3. **Reaper** (Part 3) — standalone.
4. **Step + pipeline budgets** (Part 2) — the async `spawn` conversion.
5. **Windows CI leg** (Part 5) and **sidecar acceptance gate** (Part 6).
6. **Worktree GC** (Part 4).
7. **Docs** — four sites: CLAUDE.md "Commit gate"; Before-shipping step 7 ("same battery as
   pre-push" becomes false); "Working practice" default loop; Worktree-setup item 4. Plus
   CONTRIBUTING.md and release notes.

## Deferred work — the governor

Filed as its own issue rather than built here. **The measurement that would justify it:** after
Part 1 ships, sample concurrent battery count on this box for a week (the reaper's classifier
already produces exactly this census). If two-or-more concurrent batteries remain common,
admission control is warranted — and must then be designed against the constraints both review
passes established:

- not in the vitest configs (nested wire-fixture spawns break);
- a sound liveness check that survives PID recycling and hard kills;
- leaked slots treated as the normal case, not the edge;
- coverage of Playwright, pytest and Pester, not vitest alone.

**A cheaper candidate to test first: per-process `TMPDIR`.** If the mechanism really is Windows
tmpdir contention, giving each vitest process its own `TMPDIR` removes it with no coordination
layer, no slots, and nothing to leak. Neither review pass *proved* tmpdir is the mechanism — the
vitest configs assert it — so the experiment is: run two batteries with separate `TMPDIR`s and
see whether they still wedge. Cheap, and it would obviate the governor entirely.

## Risks and trade-offs

| Risk | Mitigation |
|---|---|
| Broken code reaches a PR branch more often | Cannot reach `main` — required checks. Feedback goes from 4h34m to 1–6 min. |
| Windows CRLF/path regressions escape | **Part 5**, correctly wired into the aggregator. |
| Sidecar ML-stack regressions escape | **Part 6**, mechanised so it is not weaker than the automatic trigger it replaces. |
| Concurrent batteries still wedge after Part 1 | Bounded by Part 2's pipeline cap and cleaned by Part 3; measured before any governor is built. |
| Async conversion breaks the retry loop | Explicitly tested: timeout ≠ pool crash; genuine pool crash still retries; both stdio shapes preserved. |

## Out of scope

- **The concurrency governor** — deferred with a measurement plan, above.
- **Deleting the GPU throttle.** The probe never fired; removing it breaks
  `run-golden-audio.mjs:68`'s import and invalidates `verify-cache.test.mjs:1183-1224`. The real
  defect in that area — both probes decide once at entry and never re-evaluate — is a separate,
  smaller issue.
- `verify-cache.mjs`'s input-hash/STEPS table. **It is not local-only:** `ci-scope.mjs:13`
  imports `STEPS`/`stepTouchedByDiff`/`computeShared` and `verify.yml:127` runs it, so CI's
  per-leg scoping derives from this file. After Part 1 nothing local exercises it, so a future
  "it's only local now" simplification would silently degrade CI scoping with every check green.
- Reducing the Open Engine queue's concurrency.

## Open questions

- **O1 — `is-docs-only-push.mjs`.** Retain the script and tests, drop only the `pre-push`
  invocation. Deleting it would redden
  `scripts/tests/entry-point-guard-convention.test.mjs:301` and require edits to `CLAUDE.md:948`
  and `CONTRIBUTING.md:586` for no functional gain. **Recommendation: retain** — recorded as
  settled unless challenged.
- **O2 — `SKIP_CONTENTION_CHECK`.** It gates both probes (`verify-cache.mjs:1340`, `:1350`) and
  is documented at `CLAUDE.md:927`. With hooks no longer running batteries, do the probes still
  earn their place? Deferred with the throttle question.
- **O3 — `wt-2947-slow-lane`.** #2947 proposes moving a twelfth file to the serial lane, and that
  worktree produced one of the two stalled batteries measured here. It should be re-evaluated
  once hooks stop firing batteries — this is not a neutral deferral, and the ticket should be
  linked to this one.
