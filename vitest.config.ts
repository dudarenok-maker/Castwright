import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { availableParallelism } from 'node:os';

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
    /* Vitest 4 removed `poolOptions`; `maxThreads`/`maxForks` collapsed into a
       single top-level `maxWorkers` (and `minWorkers` was dropped — only the
       cap affects scheduling). The contention throttle now just sets that cap. */
    ...(poolCap ? { maxWorkers: poolCap } : {}),
  },
});
