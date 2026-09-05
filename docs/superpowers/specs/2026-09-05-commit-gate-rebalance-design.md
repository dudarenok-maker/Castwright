# Commit-gate rebalance — design

- **Date:** 2026-09-05
- **Issue:** [#2997](https://github.com/dudarenok-maker/Castwright/issues/2997)
- **Status:** draft, revised after **three** adversarial review passes
- **Supersedes the local-gate half of:** [2026-07-06-verify-ci-rebalance-design.md](2026-07-06-verify-ci-rebalance-design.md)

## Problem

Two problems, and the first one is not about contention at all.

### 1. The gate was never viable, even healthy

Recorded `durationMs` from the last **green** run of each step
(`.verify-cache.json`, primary checkout — 16 independent last-green runs spanning
2026-07-05 → 2026-09-04, *not* one pipeline's wall-clock):

| Step | Green duration |
|---|---|
| `test:server` | **19.45 min** |
| `test:e2e` | 8.33 min |
| `test:sidecar` | 6.85 min |
| `test:hooks` | 3.35 min |
| `build` | 1.62 min |
| `test` | 1.59 min |
| `lint` | 1.20 min |
| `typecheck` | 0.84 min |
| everything else | < 1 min each |

`verify:fast:branch`'s eleven legs sum to **35.1 minutes**. A full `npm run verify` reaches
**44.9 minutes** — and that is a **floor**: `check:cycles` is in `STEPS`
(`verify-cache.mjs:513`) and has no cache entry at all, because it shells `npx --yes
madge@8.0.0`.

**So a completely healthy pre-push cost ~35 minutes.** No contention required. The hooks were
non-viable on their own arithmetic.

### 2. Under concurrency it degrades to deadlock

Measured 2026-09-05 before intervention:

| Metric | Value |
|---|---|
| `verify-cache` batteries running concurrently | **11** |
| Oldest battery age | **273.8 min (4h34m)** |
| Batteries making progress | **0 of 11** |
| Orphaned vitest (parent dead) | 2, aged 392m and 389m |
| `node.exe` total | 86 |

Per-battery subtree CPU; a live vitest subtree burns **30–100 CPU-seconds per minute**:

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

Reaping the 13 roots freed 96 processes and took `node.exe` from 86 → 9. Fifteen minutes later
two fresh batteries were both at **1.3 CPU-seconds per 45 s** with falling process counts — so
**two concurrent batteries are enough.**

> **Known gap in this census: no command lines were captured.** Age, PID, process count and CPU
> were recorded; *what each root was running* was not. This matters — see "Deferred work" — and
> Part 3 exists partly to stop it recurring.

## Root cause

**Asserted mechanism, not proven mechanism.** `server/vitest.config.ts:12-29` and
`server/vitest.config.slow.ts:4-33` attribute the failure to Windows tmpdir races and
pipe/handle exhaustion under fork pressure. Those comments describe **one battery's own forks**;
neither this design nor any review pass has demonstrated the *inter*-battery interaction
directly. The plausible bridge is that two batteries share one `%TEMP%` and one per-user handle
budget, but that is inference. It is called out here rather than stated as fact, because a
cheap experiment would settle it (see "Deferred work").

Three defects let it run unchecked:

1. **Every commit runs the whole world** — see the arithmetic above. `--changed` narrowing
   applies only to diffs confined to `src/**` or `server/src/**`
   (`diffSafeForChangedOnly`, `verify-cache.mjs:903-915`).
2. **Nothing bounds concurrency.**
3. **Nothing is ever reaped.**

### Corrections carried forward — do not re-derive these

- **The GPU probe never fired.** `GPU_BUSY_THRESHOLD = 40` (`verify-cache.mjs:1028`); measured
  utilisation was **0%**. It also cannot be deleted cheaply: `scripts/run-golden-audio.mjs:68`
  imports `maxNvidiaSmiUtil` and `GPU_BUSY_THRESHOLD`, and
  `scripts/tests/verify-cache.test.mjs:1183-1224` pins `detectGpuContention`'s **source text**.
- **A second probe exists** — `detectSiblingContention` (`verify-cache.mjs:1131-1145`);
  `SKIP_CONTENTION_CHECK` gates both at `:1340` and `:1350`.
- **Neither probe explains the failure.** Both set `LOW_CONCURRENCY` on their own process env,
  reaching only that battery's children. The **first** battery sees zero siblings and an idle
  GPU, runs at `maxWorkers: 2`, and stalls anyway.
- **`.husky/pre-push:19-21`'s "the one check that genuinely needs this machine" is CORRECT.** CI
  runs `test:sidecar` **without torch**, deliberately (`verify.yml:396-400`), so all 38
  `pytest.importorskip("torch")` tests (14 files, all under `server/tts-sidecar/`) execute only
  here. Part 6 depends on it. *(But the surrounding comment block at `.husky/pre-push:1-21` does
  go stale under Part 1 — it is in the doc-update list.)*

## Scope: what ships, and what is deferred

The concurrency governor is **deferred, not designed.** Config-level admission would break the
repo on day one: `vitest.config.wire-fixtures.ts` and `server/vitest.config.wire-fixtures.ts`
are spawned as nested vitest processes *from inside running tests*
(`src/vitest-retry-hazard-reporter.test.ts:137`,
`server/src/vitest-retry-hazard-reporter.test.ts:148`), and both `import mainConfig from
'./vitest.config.js'`. Slot liveness has no sound implementation, and leaked slots would be the
normal case. The full constraint list is in "Deferred work".

**Ships here:** instant hooks · bounded run duration · an automatically-invoked reaper ·
worktree GC · a Windows CI leg · a sidecar acceptance gate.

## Design principles

1. **CI enforces; local informs — except where CI provably cannot.** The sidecar's ML stack is
   the one real exception (Part 6).
2. **A hook may never spawn a process pool.** Enforced by an **allowlist** guard test. *(A
   process *scan* is not a pool — Part 3's census is one `Win32_Process`/`ps` query, ~300 ms,
   which the existing sibling probe already pays.)*
3. **No run may outlive a budget**, and the budget is on the *pipeline*, not only its steps.
4. **Fail on findings; pass on a missing tool; FAIL on a budget breach.** An absent `eslint`
   must not block a commit — CI still enforces. A timeout is the opposite: a timeout that passes
   is not a cap. *(An earlier draft collapsed these into one clause that told timeouts to pass —
   the inverse of Part 2.)*

## The design

### Part 1 — Hook tiers become instant

| Hook | Now | After | Budget |
|---|---|---|---|
| `commit-msg` | `validate-commit-msg.mjs` | unchanged | ~0.3s |
| `pre-commit` | `verify:fast:scoped` (~13,500 tests) | ESLint over **staged files only**, one process | **0.14s / ~4s** |
| `pre-push` | 3 guards + `verify:fast:branch` (**~35 min**) | the guards + `test:sidecar`, scope-gated | ~1–2s / 6.85 min |

**Measured on the shipping implementation** (commit `faa273cb`), not estimated:

| Path | Cost |
|---|---|
| `pre-commit`, no JS/TS staged — docs, config, most commits | **0.14s** (short-circuits before spawning anything) |
| `pre-commit`, JS/TS staged, warm | **~4s** |
| `pre-commit`, JS/TS staged, cold cache under box contention | up to ~50s — dominated by ESLint startup, not file count |
| `pre-push`, no `server/tts-sidecar/**` in the branch diff | ~1–2s (step out of scope) |
| `pre-push`, sidecar touched | + 6.85 min |

The cold-vs-warm spread is ESLint's fixed startup cost; a single-file run measured 73.6s cold
and 3.7s warm on the same box. If that first-commit cost proves annoying in practice, the lever
is `--cache`, or dropping local lint entirely — CI's `lint` leg is a required check either way.

`pre-commit` → `scripts/hooks/pre-commit-lint.mjs`: staged set from `git diff --cached
--name-only --diff-filter=ACMR`, filtered to JS/TS extensions; empty set exits 0 without
spawning anything; one `eslint` process, no pool, no `--fix`. **Blocks on lint findings; warns
and passes** when eslint is absent or a 60 s budget is exceeded.

It must be a **script, not an inline hook body.** Husky executes user hooks as `sh -e "$s"`
(`.husky/_/h:17`) — under `errexit`, `FILES=$(git diff … | grep -E …)` fails the hook whenever
grep matches nothing, rejecting every commit with no staged JS/TS; `xargs` without `-r` would
invoke `eslint` with zero args, which under the flat `eslint.config.mjs` lints the whole tree —
a pool, violating principle 2; and a missing `eslint` exits 127, contradicting principle 4.

`pre-push` keeps `guard-protected-push.mjs` and `guard-commit-subjects.mjs`, drops the
`verify:fast:branch` invocation, and gains Part 3's census. `is-docs-only-push.mjs` is
**retained**; only its invocation goes (`.husky/pre-push:25-27` exists solely to guard line 28).

### Part 2 — No run outlives a budget

**Budget shape: per-step TOTAL, not per-attempt.** An earlier draft argued that a per-step
budget "would have let those two alone reach 120 minutes" and then adopted per-attempt — but
120 = 2 steps × 3 attempts × 20 **is the per-attempt shape**; per-step-total at 20 caps the pair
at 40. The labels were swapped and the looser shape was chosen on the argument against it.
Per-step-total is also the only shape that composes additively with a pipeline cap.

| Knob | Interim default | Basis |
|---|---|---|
| `CASTWRIGHT_STEP_TIMEOUT_MIN` | **45** | `test:server`'s measured green total is 19.45 min; 20 gave a 3% margin and would false-positive constantly |
| `CASTWRIGHT_RUN_TIMEOUT_MIN` | **180** | a full `verify` floors at 44.9 min; still cuts the 273.8-min incident by a third |

**Target design — self-calibrating, replacing both constants.** `verify-cache.json` already
records `durationMs` per step. Derive the budget as `max(FLOOR, K × lastGreenDurationMs)`: no
magic numbers, adapts to the box, and degrades to `FLOOR` when cold.

**One measurement is owed before these are final.** `durationMs` is recorded around the whole
retry loop (`verify-cache.mjs:1478-1481`), so 19.45 min is a **step total** and the per-attempt
figure is unknown by up to 3×. Run one `test:server --no-cache` on a reaped box and record
per-attempt timings.

**Implementation is an async `spawn` conversion of step execution — the largest piece of work
here, and its real risk is source-text pins, not caller compatibility.**

- `scripts/tests/verify-cache.test.mjs:1288` extracts `runStepProcess`'s body by regex and
  `:1298-1302` asserts it contains the literal **`spawnSync('npm', ['run', npmScript]`**. This
  fails the moment `spawnSync` becomes `spawn`.
- `:1305-1311` extracts `runPipeline`'s loop body with a regex anchored on a trailing `return
  0;` at **exactly two-space indent**; `:1332-1341` and `:1391-1399` depend on that match and
  throw if it fails to locate.
- **`server/src/spawn-windows-hide.test.ts`** scans `scripts/**` and its `SPAWN_NAMES` (`:134`)
  covers `spawn` as well as `spawnSync`; the rule (`:459-478`) requires the literal
  `windowsHide: true` **inside the call's own balanced-paren argument text**, so hoisting
  options into a variable fails it. This guard will also scan the new reaper, `wt-gc.mjs`, and
  `pre-commit-lint.mjs`.

**Two stdio shapes to preserve**, plus two options the earlier draft omitted: non-retriable
steps use `stdio: 'inherit'`; `test:server`/`test:server-slow` use `['inherit','inherit','pipe']`
with `encoding:'utf8'` and `maxBuffer: 64MB`, feeding `isVitestPoolCrash()` and
`MAX_POOL_ATTEMPTS = 3`. Both also pass **`shell: true`** and **`windowsHide: true`**
(`verify-cache.mjs:1288-1318`).

**The stderr accumulator must keep the TAIL, not the head.** `maxBuffer` kills the child and
keeps the head; an accumulator does neither by default. `isVitestPoolCrash` matches "Worker
exited unexpectedly", which appears at the **end** of a crashed run — so a head-keeping
accumulator silently loses the signature under exactly the high-output contention where crashes
happen, and the retry stops firing with every test green.

**`runPipeline`'s return contract is NOT preserved** — async makes it `Promise<number>`, and its
one live caller (`verify-cache.mjs:1518-1519`, `const code = runPipeline({…}); process.exit(code)`)
must `await`. `ci-scope.mjs:13` imports only `{STEPS, stepTouchedByDiff, computeShared}` and is
genuinely unaffected — but it was never the risk.

**Tree-kill on Windows.** `shell: true` means `child.pid` is `cmd.exe`, and the tree is
`cmd.exe → npm.cmd → node(npm) → node(vitest) → N forks`; `child.kill()` reaps only the shell.
`taskkill /T /F` is the mechanism, with prior art at `scripts/stop-app.mjs:34-40`,
`server/src/tts/spawn-sidecar.ts:452-460`, `server/src/mdns-owner.ts:162-172`. **Its blind spot
is load-bearing:** `/T` walks live parent-PID links at the moment it runs, so a fork whose
parent already died is invisible to it — exactly the two 390-minute orphans in the census above.
**The timeout path is therefore a manufacturer of orphans, which is why Part 3 must run
automatically and must classify by dead-parent, not only by CPU.**

### Part 3 — A reaper that actually runs

`scripts/reap-stale-batteries.mjs`, exposed as `npm run doctor` **and invoked automatically**.

An earlier draft left this as a manual, report-only CLI that nothing in the design ever called —
while the risk table credited it with automatic cleanup. That gap is closed here:

- **On every `pre-push`:** run the census (one `Win32_Process`/`ps` query, ~300 ms, no pool) and
  **append it to a log** — including **each root's command line**, which the 2026-09-05 census
  omitted. Kill **only provably-orphaned trees** (parent dead). Never blocks the push.
- **From Part 2's timeout path:** after `taskkill /T /F`, sweep for survivors the `/T` walk
  could not see.
- **`npm run doctor --kill`:** the manual, wider-scoped path.

`classify(snapshot, now, thresholds) → verdicts` is a pure function — the testable seam. Never
touches `python.exe` (TTS sidecars, Ringer) or the caller's own ancestor chain.

The pre-push log is also the dataset that decides the governor question (see "Deferred work"),
which is why it is mechanised rather than left to a weekly manual sample.

### Part 4 — Worktree GC

`scripts/wt-gc.mjs` / `npm run wt:gc`. Lists worktrees with commits-ahead-of-`main`, merged
status, and (when `gh` is available) PR state; offline-tolerant. Reports by default, `--prune`
acts. Junctions dropped **first** via `[System.IO.Directory]::Delete($p, $false)` gated on the
`ReparsePoint` attribute — never `.LinkTarget`, which reads empty on Windows PowerShell 5.1.
Refuses to prune the primary checkout, any tree with uncommitted changes, and any tree with
unpushed commits. Independent of Parts 1–3 and cuttable.

### Part 5 — A Windows leg in PR-time CI

**What it runs:** a `windows-latest` job executing `test` and `test:server`, with its scope
conditions on **steps**, reusing `.github/actions/setup` (already used on `windows-latest` by
`cross-os.yml`) and `.github/actions/install-ffmpeg-windows` for the server leg. Every step pins
`shell: bash` — `verify.yml` sets no `defaults: run: shell:` and relies on ubuntu's default.
Sets `timeout-minutes` like every other job in the file.

**Three wiring traps, all verified against the workflow:**

- **The job must join the aggregator's `needs:` list** (`verify.yml:560`). The only required
  context is the aggregator job `name: npm run verify` (`:558`); a job outside that list is
  decorative. The "Check leg results" step iterates `jq -r 'keys[]'` over all of `needs`, so no
  second edit is required, and the required-check name does not change.
- **Scope conditions go on steps, never the job.** The aggregator fails on `'skipped'`
  (`:629`, `:634-640`); a job-level `if:` would permanently block every docs-only PR. No
  existing leg uses a job-level `if:`.
- **`concurrency: cancel-in-progress: true`** makes a slow Windows leg a new source of
  `cancelled`, which the aggregator also treats as failure.

**Honest payoff: detection latency, not coverage.** `cross-os.yml` already runs full
`verify:quick` + audits + build on `windows-latest` twice weekly, and `release.yml` gates every
tag on Windows. Part 5 moves Windows detection from ≤3.5 days to per-PR. It does **not** close
the tmpdir/handle race — that is a concurrency artifact and a `windows-latest` runner is
single-tenant, so it structurally cannot reproduce there.

### Part 6 — Scope-triggered local acceptance for the sidecar

38 `pytest.importorskip("torch")` tests across 14 files, all under `server/tts-sidecar/`, run
only on this box. Part 1 deletes the automatic `test:sidecar` push trigger that exercised them.

**Trigger path: `server/tts-sidecar/**` only.** An earlier draft also listed
`server/src/tts/**`, `server/src/analyzer/**`, `server/src/gpu/**` — 177 TypeScript test files
Ubuntu CI already covers; that requirement would be waived by habit within a week.

**Mechanised, not a checklist item** — Part 1 replaces an *automatic* trigger, and an unenforced
item is strictly weaker than what it replaces. A required check mirroring
`.github/workflows/pr-issue-link.yml` fails a PR touching `server/tts-sidecar/**` unless the body
records the local run (command, date, outcome) or links an [on-box acceptance
register](../../testing/onbox-acceptance-register.md) row.

## Testing

| Area | Test |
|---|---|
| Reaper classification | pure `classify()` over fixtures **including the 11-battery census**; dead-parent orphans detected independently of CPU rate |
| Reaper auto-invocation | pre-push census writes the log incl. command lines; kills orphans only; never blocks the push |
| Worktree GC | merged / ahead / dirty / unpushed refusal cases |
| Staged-file selection | extension filter, empty-set short-circuit, missing-eslint **passes**, timeout passes |
| Step budgets | per-step-total fires; pipeline cap fires independently; **timeout is not retried as a pool crash**; tail-keeping accumulator still matches `isVitestPoolCrash`; both stdio shapes + `shell`/`windowsHide` preserved |
| **The invariant** | `hook-no-pool.test.mjs` — an **allowlist** of permitted hook invocations |
| Hook-scope exclusivity | pin that a `.husky/**` diff selects `test:hooks` and nothing else. `verify-cache.test.mjs:647-651` asserts only the positive; true today, **unpinned**. Also fix the stale comment at `:636-646` claiming `.husky/**` matches no step. |

Every test asserts against input that would otherwise make the guard fire.

**Source-text pins are part of the work, not a surprise:** `verify-cache.test.mjs:1288-1311` and
`server/src/spawn-windows-hide.test.ts` must be updated in the same commit as the async
conversion.

**On-box acceptance rows are owed** (CLAUDE.md step 3 — a merge gate): the reaper's
`Win32_Process` classification against real processes, and the budget's kill-the-whole-tree
semantics on Windows including the `taskkill /T` orphan blind spot.

## Rollout order

**Commit 1 touches `.husky/**` only, and its `pre-commit` is a NO-OP.** Verified safe:
`.husky/_/h:6` passes on an absent file, an empty file exits 0 under `sh -e`, and **no test in
the repo asserts on hook file content.** It must not call `scripts/hooks/pre-commit-lint.mjs`,
which commit 2 creates — between the two, every commit would die on `MODULE_NOT_FOUND`,
including commit 2 itself.

*Correction to an earlier draft's rationale:* commit 1 was justified by "a `.husky/**`-only diff
selects `test:hooks` alone." True, but it does not bind — git resolves the hook from the
**working tree** (`.husky/_/h:4`), so commit 1 is gated by its own already-slimmed hook and pays
nothing at all. The **ordering** is still right (the reverse order pays the full ~35-minute
gate); the stated mechanism was wrong, and a reader trusting it might reorder the commits.

1. **Hooks slimmed** — `.husky/**`-only, no-op `pre-commit`.
2. `scripts/hooks/pre-commit-lint.mjs` + allowlist guard test + hook-scope exclusivity pin.
3. **Reaper** (Part 3) incl. pre-push census wiring.
4. **Budgets** (Part 2) — async `spawn` conversion + the source-text pin updates.
5. **Windows CI leg** (Part 5) and **sidecar acceptance gate** (Part 6).
6. **Worktree GC** (Part 4).
7. **Docs — five sites:** CLAUDE.md "Commit gate"; Before-shipping step 7 ("same battery as
   pre-push" becomes false); "Working practice" default loop; Worktree-setup item 4; **and
   `.husky/pre-push`'s own comment block (lines 1-21)**, which describes three mechanisms Part 1
   deletes. Plus CONTRIBUTING.md and release notes.

## Deferred work — the governor

**The deferral rests on a premise this design cannot yet support, and says so.** The argument is
that Part 1 removes most concurrent batteries. But the 11-battery census **captured no command
lines**, so not one of them was attributed to a hook; and on the single sample where attribution
was recorded, one root was a hook (`verify-cache.mjs --scope-staged`) and one was a bare `vitest
run` outside it. CLAUDE.md Before-shipping step 7 still instructs every agent to run
`verify:fast:branch` by hand, and rollout item 7 rewords that line rather than deleting the
instruction. With 76 open agent tickets, deliberate starts may well be the steady state.

**This is why Part 3's census is mechanised and logs command lines.** After Part 1 ships, the
log answers the question with data instead of assertion. If two-or-more concurrent batteries
remain common, admission control is warranted — and must then satisfy:

- not in the vitest configs (nested wire-fixture spawns break);
- a liveness check surviving PID recycling and hard kills;
- leaked slots as the normal case, not the edge;
- coverage of Playwright, pytest and Pester, not vitest alone.

**Cheaper candidate to test first: per-process `TMPDIR`.** If the mechanism really is tmpdir
contention — asserted by the configs, never demonstrated — giving each vitest process its own
`TMPDIR` removes it with no coordination layer and nothing to leak. The experiment: run two
batteries with separate `TMPDIR`s and see whether they still wedge. Cheap, and it would obviate
the governor entirely.

## Risks and trade-offs

| Risk | Mitigation |
|---|---|
| Broken code reaches a PR branch more often | Cannot reach `main` — required checks. Feedback goes from ~35 min (healthy) or 4h34m (wedged) to 1–6 min. |
| Windows CRLF/path regressions detected late | **Part 5**, wired into the aggregator's `needs:`. |
| Sidecar ML-stack regressions escape | **Part 6**, mechanised. |
| Concurrent batteries still wedge after Part 1 | Bounded by Part 2's pipeline cap; orphans cleaned by Part 3's **automatic** pre-push sweep; measured by its log before any governor is built. |
| Async conversion lands red on source-text pins | Named explicitly above; pin updates are in the same commit. |
| Timeout kill leaves orphans `taskkill /T` cannot see | Part 3 sweeps after every timeout and classifies by dead-parent. |

## Out of scope

- **The concurrency governor** — deferred with a measurement plan, above.
- **Deleting the GPU throttle** — the probe never fired; removal breaks
  `run-golden-audio.mjs:68` and `verify-cache.test.mjs:1183-1224`. The real defect there (both
  probes decide once at entry, never re-evaluate) is a separate issue.
- `verify-cache.mjs`'s input-hash/STEPS table. **Not local-only:** `ci-scope.mjs:13` imports
  from it and `verify.yml:127` runs it, so CI's per-leg scoping derives from this file. A future
  "it's only local now" simplification would silently degrade CI scoping with every check green.
- **Open Engine queue concurrency.** Noted as a gap: with the governor deferred, this was the
  only other lever on battery count, and both are now out. If Part 3's log shows deliberate
  starts dominate, this becomes the live option alongside the governor.

## Open questions

- **O1 — `is-docs-only-push.mjs`:** retain script + tests, drop only the invocation. Deleting it
  reddens `scripts/tests/entry-point-guard-convention.test.mjs:301` and needs edits to
  `CLAUDE.md:948` and `CONTRIBUTING.md:586` for no gain. **Settled unless challenged.**
- **O2 — `SKIP_CONTENTION_CHECK`** (`verify-cache.mjs:1340`, `:1350`; `CLAUDE.md:927`). With
  hooks no longer running batteries, do the probes still earn their place? Deferred with the
  throttle question.
- **O3 — `wt-2947-slow-lane`.** #2947 proposes a twelfth serial-lane file, and that worktree
  produced one of the two stalled batteries measured here. Re-evaluate once hooks stop firing
  batteries; link the ticket to this one.
