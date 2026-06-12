import { defineConfig } from 'vitest/config';

/* Server-side test harness. Node environment (no jsdom) — most suites are
   pure helpers + supertest against Express routers. Tests that shell out
   to ffmpeg (e.g. mp3.test.ts) need a generous timeout because the encoder
   subprocess spawn + libmp3lame init costs a few hundred ms cold.

   Pool concurrency is capped (maxForks=2) and one retry is allowed: see
   docs/features/archive/45-vitest-pool-tuning.md for the rationale. The default
   forks pool grows to N=logical-CPUs (16+ on dev boxes); with subprocess-
   spawning tests (ffmpeg, supertest servers, sidecar mocks) that exhausts
   pipe/handle budgets and one worker dies mid-suite ("Worker exited
   unexpectedly"), failing the whole verify. Cap + retry absorbs both the
   root cause and the residual transients without forcing a full re-push.

   Plan 45 (vitest pool tuning, 2026-05-22) — dropped maxForks 4 → 2 and added
   explicit hookTimeout: 30_000 after 4 routes test files (book-state,
   chapters-restructure, generation, plus analyzer/gemini for the timer-
   based abort race) repeatedly timed out across full-suite load. The
   common shape: mkdtempSync + module imports in beforeAll racing on
   Windows tmpdir under maxForks=4. Halving parallel tmpdir pressure
   eliminates the race; the 30s hook budget covers a slow first import
   under pool contention (testTimeout: 15_000 doesn't extend hook budgets
   on its own, so a hook can timeout while the test's per-test override
   sits unused). The 4 hot files now also run in a separate serial
   `test:server-slow` step (root package.json) so even when this main
   parallel run trips, the slow files are independently green. */

/* Mirror invariant: each entry here MUST also appear in
   vitest.config.slow.ts's SLOW_FILES array. The slow config runs these
   files serially (maxForks=1) and the main config excludes them so we
   never double-run. */
const SLOW_FILES_TO_EXCLUDE = [
  'src/analyzer/gemini.test.ts',
  'src/routes/analysis-pipelining.test.ts',
  'src/routes/book-state.test.ts',
  'src/routes/chapters-restructure.test.ts',
  'src/routes/generation.test.ts',
  'src/routes/generation-boundary-recycle.test.ts',
  /* Loads the real pdf-parse 2 / bundled pdfjs; destabilises the parallel
     fork pool ("Worker exited unexpectedly"). Serialised, not slow. */
  'src/parsers/pdf-real.test.ts',
  /* Integration test: makes a real 2s-timeout network probe to the sidecar.
     Slow/flaky under the parallel fast pool — serialised here (fs-21). */
  'src/routes/setup-readiness.route.test.ts',
];

/* Contention throttle (plan 156). LOW_CONCURRENCY (set manually, or
   automatically by scripts/verify-cache.mjs on a busy GPU) drops maxForks
   2 → 1 so a co-running generation can't tip this subprocess-heavy suite into
   "Worker exited unexpectedly". Mirrors serverMaxForks() in
   scripts/test-concurrency.mjs (the unit-tested copy); can't import it here
   (tsconfig allowJs:false). */
const lowConcurrency =
  process.env.LOW_CONCURRENCY === '1' || process.env.LOW_CONCURRENCY === 'true';
const maxWorkers = lowConcurrency ? 1 : 2;

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    /* Redirect user-settings to a temp file before any module loads (plan
       122) so suites never touch the real ~/.audiobook-generator file. */
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    /* `*.golden.test.ts` is the opt-in GPU-free assembly golden (ops-11,
       Suite B) — run only via `npm run test:golden-audio` through
       vitest.config.golden.ts, never in the default `test:server` tier. */
    exclude: [
      'node_modules/**',
      'dist/**',
      'src/test-setup.ts',
      'src/**/*.golden.test.ts',
      ...SLOW_FILES_TO_EXCLUDE,
    ],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: 'forks',
    /* Vitest 4 removed `poolOptions`; `poolOptions.forks.maxForks` is now the
       top-level `maxWorkers` (and `minForks` was dropped). `pool: 'forks'`
       stays — this subprocess-heavy suite still needs fork isolation. */
    maxWorkers,
    retry: 1,
  },
});
