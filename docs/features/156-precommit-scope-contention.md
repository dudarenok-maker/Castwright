---
status: active
title: Pre-commit scope filter + GPU-contention test throttle
area: scripts
---

# Pre-commit scope filter + GPU-contention test throttle

## Problem / Why

Pre-commit flaked constantly under machine contention and re-ran suites
unrelated to the staged change, so commits were repeatedly redone by hand. Two
observed cases:

1. A **sidecar-only Python** change triggered the **full frontend vitest suite**
   (133 files, 2083 tests), which timed out because the box was loaded with GPU
   generation ("254 s environment setup"). The frontend tests had no business
   running for that change.
2. A `test:server-slow` leg crashed a worker (tinypool "Worker exited
   unexpectedly") under sustained load during a full-verify push — a
   load-induced infra flake, not a test assertion.

Root cause of (1): `.husky/pre-commit` → `npm run verify:fast` runs
`test:hooks,test,test:server` on every commit, suppressed only by the
input-hash cache, which records a step skippable **only after it passes**. A
contention flake → no green entry → the next commit re-runs the full suite even
when the diff never touched that scope. The cache is content-diff-vs-last-green,
not scope-diff-vs-this-commit. CI already path-filters
(`.github/workflows/verify.yml`); local pre-commit did not.

Root cause of (2): the test legs have no awareness of a co-running GPU workload,
so they fan out at full concurrency into a starved box.

## What changed

- **Pre-commit scope filter.** `scripts/verify-cache.mjs` gained a
  `--scope-staged` flag. Pre-commit now runs `verify:fast:scoped`, which derives
  the changed set from `git diff --cached --name-only` and skips any step whose
  scope the staged diff never touched — `[skip] <step> (out of scope)` — *before*
  the input-hash cache. Diff-driven and stateless, so it skips reliably even on
  a cold or flake-poisoned cache. The STEPS table's `inputs.globs` ARE the scope
  map (mirrors verify.yml's bash matcher). A root `package.json`/`package-lock`
  change is global (`computeShared`), matching CI's `shared` scope.
- **Contention guard + throttle.** `verify-cache.mjs` probes `nvidia-smi` once at
  start; if GPU utilization ≥ 40% it warns and sets `LOW_CONCURRENCY=1` for the
  child test runs (soft — never blocks). `LOW_CONCURRENCY` can also be set
  manually. The vitest configs honor it: frontend caps its pool to half the
  cores (otherwise untouched — plan 45 left it uncapped), and the server drops
  `maxForks` 2 → 1. Disable the probe with `SKIP_CONTENTION_CHECK=1`.
- **Pre-push unchanged.** Pre-push still runs the FULL `npm run verify` battery,
  preserving the "local is the full coverage net, CI is the scoped one"
  invariant.

## Invariants

1. A staged diff touching only files outside a step's `inputs.globs` /
   `extraFiles` / server-lockfile → that step is skipped under `--scope-staged`.
2. A staged root `package.json` / `package-lock.json` change → every selected
   step is in scope (global).
3. `git diff --cached` failing → scope filter disabled, all selected steps run
   (never skip on uncertainty).
4. The scope map is the STEPS `inputs.globs`; it must stay mirrored with
   `.github/workflows/verify.yml`'s scope matcher — changing one without the
   other drifts local vs CI coverage.
5. `LOW_CONCURRENCY` unset → vitest pools stay at their plan-45 defaults
   (frontend uncapped, server `maxForks: 2`). The config formulas mirror
   `scripts/test-concurrency.mjs` (the unit-tested copy).
6. The contention probe is soft: nvidia-smi absent/erroring (CI, non-NVIDIA) →
   no throttle, no failure.
7. Pre-push runs the full battery; only pre-commit is scope-filtered.

## Test plan

## Automated coverage

- `scripts/tests/verify-cache.test.mjs` — `stepTouchedByDiff` (sidecar/frontend/
  server/hooks/extraFiles/server-lockfile/empty-diff cases), `computeShared`,
  `parseNvidiaSmiUtil`, and `parseFlags` `--scope-staged`. Locks invariants 1–4, 6.
- `scripts/tests/test-concurrency.test.mjs` — `lowConcurrency`,
  `frontendPoolCap` (undefined when off, half-cores when on, min 1),
  `serverMaxForks` (2 / 1). Locks invariant 5.

## Manual acceptance

1. Stage a sidecar-only change, run `npm run verify:fast:scoped` → all three fast
   legs print `[skip] … (out of scope)`, exit 0, frontend suite never starts.
   (Verified live during implementation.)
2. Stage a `src/**` change → `test` runs (or `[cached]`), `test:server` skipped.
3. Stage `package.json` → all three legs in scope.
4. With a generation run active (GPU busy), run `npm run verify` → `[contention]`
   warning prints and the test legs run throttled.

## Ship notes

<Filled in when status → stable: shipped date + commit SHA.>
