import type { Reporter, TestCase } from 'vitest/node';

/* #2063 (survey of #2028 for the frontend suite) — `retry: 1` in
   vitest.config.ts can turn a genuine red-phase test green: for a test
   asserting on module-level mutable state (a Map/Set/counter at module scope,
   or fixture state on disk keyed by a fixed path), attempt 1 fails and leaks
   its mutation; attempt 2 reads state attempt 1 already touched and passes for
   the wrong reason. See CONTRIBUTING.md's "When you ship a change" section
   (the "#2028" note) for the full writeup and the `--retry=0` verification
   convention this reporter exists to surface.

   Ported from server/vitest.config.ts's retryHazardReporter (#2028), which
   carries the full narrow-vs-global rationale. The frontend-specific survey
   for THIS suite: `npx vitest run --retry=0` against unmodified `main` came
   back 328 files / 4560 tests, all passing, on 2026-08-06 — clean. A clean
   survey does not by itself justify dropping `retry: 1` (it says nothing about
   the transient jsdom/timer flakes the retry exists to absorb — see the
   comment above `retry: 1` in vitest.config.ts), so this ships the same shape
   server did: keep the retry, and make any test that only passes because of it
   impossible to miss. Any test that fails on attempt 1 and only passes after a
   retry prints a `[retry-hazard]` line naming the file and test. A human then
   re-runs it with `--retry=0` to judge whether it's a genuine transient (route
   through quarantinedIt, docs/testing/flaky-register.md) or a red-phase test
   the retry hid.

   WHY ITS OWN MODULE rather than a named export from vitest.config.ts (PR
   #2160 review, finding 5): a config file carrying both a default and a named
   export makes rolldown emit a `[MIXED_EXPORTS]` warning on the first line of
   stdout for EVERY root `vitest` invocation. The server config gets away with
   the same shape; the root one does not. Splitting it keeps vitest.config.ts
   default-only and the warning disappears, while the test that pins this
   reporter still has a real module-graph edge to it. */
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
