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
- **Pre-push unchanged (AT THE TIME THIS PLAN LANDED).** Pre-push still ran
  the FULL `npm run verify:fast:branch` battery (not bare `npm run verify` —
  corrected 2026-09-01, review finding on #2839: this line was stale even
  before the --changed addendum below, which only ever fixed its
  CI-vs-pre-push clause, not this one), preserving the "local is the full
  coverage net, CI is the scoped one" invariant as it stood then.
  **Superseded 2026-09 by ops-2997**
  (docs/superpowers/specs/2026-09-05-commit-gate-rebalance-design.md): that
  battery cost ~35 minutes even healthy, and under concurrency degraded to
  hours-long deadlock, so pre-push no longer runs it automatically at all —
  only its guards plus a scope-gated `test:sidecar` check. Cloud `verify.yml`
  is now the enforcing gate the "local is the full coverage net" half of that
  invariant depended on; see [CLAUDE.md "Commit gate"](../../CLAUDE.md#commit-gate).

### 2026-09-01 addendum (#2834)

- **Sibling-worktree contention guard.** The GPU probe above missed the more
  common local cause: another worktree's own `vitest`/`verify-cache.mjs`
  process already running (observed: six worktrees running full `test:server`
  at once). `detectSiblingContention()` enumerates other matching node
  processes via `Get-CimInstance` (excluding this process's own PID) and
  throttles to `LOW_CONCURRENCY=1` the same soft way the GPU probe does.
- **`--changed HEAD`-only test/test:server on an UNSHARED `--scope-staged`
  diff.** The scope filter above is step-granular, not file-granular — any
  touched file under a step's globs still reran that step's WHOLE suite. Under
  `--scope-staged` only, and only when `computeShared` is false, `test`/
  `test:server` now run `test:changed`/`test:server:changed`
  (`vitest run --changed HEAD`) instead. A shared-scope diff (root
  manifest/lockfile/`.github/actions/**`) still runs the full script —
  `--changed` against a file no test's dependency graph reaches would
  otherwise select zero tests and exit 0. **Never cached as a full run**: a
  `--changed`-only pass's `cache.steps` write is skipped entirely, because the
  cache key is the step's full declared-input hash — caching a narrower run
  under that hash let a later `--scope-branch`/CI run with no new diff read
  `[cached]` and silently skip a full run that never happened (an actual bug,
  caught in review before merge, not a design choice).
- **The "CI is the scoped one" line above is corrected, not new**: CI already
  narrowed its own PR runs via `vitest run --changed <PR base>` before this
  addendum (`.github/workflows/verify.yml`'s Frontend/Server test legs,
  `docs/features/118-ci-cost-round-2.md`) — pre-push's full local run, not
  CI, is the actual full-suite gate before merge, and was already the actual
  gate before this addendum too.
- **`computeShared` alone under-covers "shared" for the --changed substitution
  (review finding, PR #2839 pass 2).** It only catches the ROOT
  package.json/package-lock.json/`.github/actions/**` — a step's OWN
  `extraFiles` (config files, docs, fixtures a test reads at runtime) or the
  SERVER lockfile via `includeLockfiles: ['server']` are the identical shape
  one level down: `server/package-lock.json`, `server/tsconfig.json`,
  `index.html` all bypassed `computeShared` and got --changed-narrowed
  anyway, selecting and running ZERO tests.
- **Excluding known-bad categories was still not enough — a third spelling of
  the same gap (review finding, PR #2839 pass 3, live against real commits on
  this branch).** `test:server`'s own `globs` include root-level `*.{mjs,ts}`
  and `scripts/**` — files genuinely in this step's declared scope, matched
  neither by `extraFiles` nor a lockfile, but that vitest's own `--changed`
  selection still cannot reach: `eslint.config.mjs` (commits `2b010fb1`/
  `b07b3bb2` touch only this file) selects zero test files under
  `vitest related`. Separately, `src/styles.css` sitting UNDER the frontend
  `test` step's own primary source glob (`src/**`) is unsafe too — its two
  guard tests (`styles-neutrals.test.ts`, `dark-mode-css.test.ts`) read it via
  `readFileSync`, not import, so being under `src/` is not sufficient on its
  own. Three rounds each narrowing a scope-based exclusion list converged on
  the conclusion that exclusion lists are the wrong shape for this check:
  `diffSafeForChangedOnly` replaces every exclusion attempt above with one
  POSITIVE allowlist — every file in the diff must sit under the step's own
  primary source root (`src/**` for `test`, `server/src/**` for
  `test:server`) AND carry a TS/TSX/JS source extension. Narrower than
  "matches this step's scope" (a config-only or CSS-only commit now runs the
  full suite rather than being narrowed), which is the deliberate trade: the
  one guarantee that actually matters is never silently running zero tests.

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
