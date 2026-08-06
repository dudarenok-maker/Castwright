import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import type { Reporter, TestCase } from 'vitest/node';
import { isAgent } from 'std-env';

/* Contention throttle (plan 156). When LOW_CONCURRENCY is set — manually, or
   automatically by scripts/verify-cache.mjs when it detects a busy GPU — cap
   the frontend pool to half the cores so a co-running generation can't starve
   the run into setup stalls / worker crashes. When unset, leave vitest's
   default in place (plan 45: this jsdom suite is CPU-bound and intentionally
   uncapped). Mirrors frontendPoolCap() in scripts/test-concurrency.mjs (the
   unit-tested copy); this file can't import it (tsconfig allowJs:false). */
const lowConcurrency =
  process.env.LOW_CONCURRENCY === '1' || process.env.LOW_CONCURRENCY === 'true';
const poolCap = lowConcurrency
  ? Math.max(1, Math.floor(availableParallelism() / 2))
  : undefined;

/* #2063 (survey of #2028 for the frontend suite) — retry: 1 below can turn a
   genuine red-phase test green: for a test asserting on module-level mutable
   state (a Map/Set/counter at module scope, or fixture state on disk keyed
   by a fixed path), attempt 1 fails and leaks its mutation; attempt 2 reads
   state attempt 1 already touched and passes for the wrong reason. See
   CONTRIBUTING.md's "When you ship a change" section (the "#2028" note) for
   the full writeup and the `--retry=0` verification convention this
   reporter exists to surface.

   Ported from server/vitest.config.ts's retryHazardReporter (#2028), which
   carries the full narrow-vs-global rationale. The frontend-specific survey
   for THIS suite: `npx vitest run --retry=0` against unmodified `main` came
   back 328 files / 4560 tests, all passing, on 2026-08-06 — clean. A clean
   survey does not by itself justify dropping retry:1 (it says nothing about
   the transient jsdom/timer flakes the retry exists to absorb — see the
   comment above `retry: 1` below), so this ships the same shape server did:
   keep the retry, and make any test that only passes because of it
   impossible to miss. Any test that fails on attempt 1 and only passes
   after a retry prints a `[retry-hazard]` line naming the file and test. A
   human then re-runs it with `--retry=0` to judge whether it's a genuine
   transient (route through quarantinedIt, docs/testing/flaky-register.md)
   or a red-phase test the retry hid. */
export const retryHazardReporter: Reporter = {
  onTestCaseResult(testCase: TestCase) {
    const diagnostic = testCase.diagnostic();
    if (diagnostic && diagnostic.retryCount > 0 && testCase.result().state === 'passed') {
      console.warn(
        `[retry-hazard] ${testCase.module.moduleId} :: "${testCase.fullName}" failed on its ` +
          `first attempt and only passed after ${diagnostic.retryCount} retry(ies). If this test ` +
          'asserts on module-level mutable state, retry:1 may be hiding a genuine red-phase ' +
          'failure (#2028) — re-run with --retry=0 to check. See CONTRIBUTING.md "When you ' +
          'ship a change" (the "#2028" note).',
      );
    }
  },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'skills/**/*.test.ts'],
    /* #2063 (ported from server/vitest.config.ts's identical exclude entry,
       PR #2049 review Finding 6) — vitest-retry-hazard-reporter.test.ts's
       runVitestOnFixture() writes throwaway wire-test fixtures under this
       directory and deletes them in a `finally` block; a kill between write
       and cleanup could leave one behind. Excluding it here means a
       surviving `__wire-fixtures__/*.test.ts` is structurally invisible to
       THIS suite regardless — vitest.config.wire-fixtures.ts is the only
       config that ever includes it, and only that config is what
       runVitestOnFixture() spawns against. Setting `exclude` replaces
       vitest's defaults rather than extending them, so the first two
       entries re-list them. */
    exclude: ['node_modules/**', 'dist/**', 'src/__wire-fixtures__/**'],
    /* `vitest run --changed <base>` (CI cost round 2 — verify.yml frontend leg)
       narrows the run to tests whose module graph touches the diff. The setup
       file is injected by the runner, NOT imported by any test, so a change to
       it wouldn't appear in any test's graph and --changed would miss every
       test that depends on its behaviour. The third entry below lists it so a
       setup change forces a FULL run. The first two entries below are vitest's
       built-in defaults (package.json + the vite/vitest config files) — they
       must be re-listed because setting this key replaces the defaults rather
       than extending them.

       Every entry is a brace alternation of two halves, each load-bearing
       against a DIFFERENT picomatch failure. (The globs are spelled out in
       the array below rather than quoted here: a comment cannot contain a
       star immediately followed by a slash without ending itself.)

         1. The extension is pinned to `.ts`, and no entry carries a trailing
            globstar suffix. Under picomatch 4 a wildcard inside a path
            segment kills the trailing-globstar-also-matches-the-file
            behaviour, so vitest's own documented config-file default matches
            NOTHING and a config-only diff silently selected zero tests —
            ops-30/#1848.
         2. The second alternative in each entry names a dot segment
            explicitly. picomatch's globstar refuses to cross a dot-prefixed
            path segment unless `{ dot: true }` is passed, and vitest passes
            no options when it builds these matchers. Claude-Code-harness
            worktrees live under `.claude/worktrees/…`, so without that half
            every glob entry here matches nothing when the suite runs from
            one — silently, as "0 tests found, exit 0" — ops-33/#1868.
            (Vitest also appends resolved `setupFiles` as ABSOLUTE paths,
            which carry no wildcard and so cross dot segments regardless;
            that one implicit trigger was never affected.)

            The tolerance is exactly ONE dot segment deep — a path with two,
            e.g. a dotted checkout nested under a dotted parent, still misses.
            That is a known bound, not an oversight: no such path exists here,
            and if one ever did, the `this checkout` case in
            src/test/force-rerun-triggers.test.ts goes RED rather than
            under-selecting silently.

       Shared fixtures/mocks need NO entry: tests import them statically, so
       the module graph already covers them.
       See docs/features/118-ci-cost-round-2.md. */
    forceRerunTriggers: [
      '{**/package.json,**/.*/**/package.json}',
      '{**/{vitest,vite}.config.ts,**/.*/**/{vitest,vite}.config.ts}',
      '{**/src/test/setup.ts,**/.*/**/src/test/setup.ts}',
      /* Tests that pin a value against the contract (e.g. the clone-transcript
         cap in api.clone-voice.test.ts) read openapi.yaml at RUNTIME, so they
         have no module-graph edge to it and `vitest --changed` — which CI uses
         — would never select them for an openapi-only diff. That is exactly
         the drift they exist to catch. Every api-types import is `import
         type`, erased at transform time, so regenerating the types doesn't
         create an edge either. */
      '{**/openapi.yaml,**/.*/**/openapi.yaml}',
    ],
    /* One retry to absorb transient jsdom/timer flakes inside a single
       verify run instead of forcing a full pre-push re-execution. See
       docs/features/archive/45-vitest-pool-tuning.md. Pool concurrency left at
       Vitest's defaults — jsdom suites are CPU-bound, not subprocess-
       bound; the server suite is where the worker-crash pattern lives. */
    retry: 1,
    // #2063 (ported from server/vitest.config.ts) — see retryHazardReporter
    // above for why retry:1 stays and what this adds on top of it. Vitest
    // only auto-selects its OWN built-in reporters when the resolved
    // `reporters` array is EMPTY — setting one explicitly, unconditionally,
    // would silently override TWO separate auto-selections (PR #2049
    // review, Findings 1 and 4, reproduced here rather than repeated):
    //   1. The base reporter: vitest's own resolver pushes
    //      `[isAgent ? 'agent' : 'default', {}]` — 'agent' under an AI
    //      coding agent (std-env's isAgent, true here under CLAUDECODE —
    //      also Cursor, Replit, Codex, etc.), 'default' otherwise.
    //      Hardcoding 'default' unconditionally would silently downgrade
    //      every agent-driven local run.
    //   2. 'github-actions' (inline PR annotations + the "Flaky Tests"
    //      $GITHUB_STEP_SUMMARY panel), appended only when GITHUB_ACTIONS
    //      is 'true'; verify.yml runs `vitest run`/`vitest run --changed`
    //      directly against this config, so suppressing it would silence
    //      that panel on every CI run of this suite.
    // Mirroring both selections below keeps this config's behaviour
    // identical to what an EMPTY `reporters` array would already do, plus
    // retryHazardReporter layered on top — never a downgrade from it. No
    // sibling config has this bug: vitest.config.wire-fixtures.ts pulls
    // `reporters` straight off this file's resolved default export rather
    // than re-declaring it.
    reporters:
      process.env.GITHUB_ACTIONS === 'true'
        ? [isAgent ? 'agent' : 'default', 'github-actions', retryHazardReporter]
        : [isAgent ? 'agent' : 'default', retryHazardReporter],
    /* Vitest 4 removed `poolOptions`; `maxThreads`/`maxForks` collapsed into a
       single top-level `maxWorkers` (and `minWorkers` was dropped — only the
       cap affects scheduling). The contention throttle now just sets that cap. */
    ...(poolCap ? { maxWorkers: poolCap } : {}),
  },
});
