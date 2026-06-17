import { defineConfig } from 'vitest/config';

/* Plan 45 (vitest pool tuning) — slow-test config that runs the 10 hot files in
   a single fork (maxForks=1), separate from the main parallel `test`
   battery. The hot files all share the same shape: mkdtempSync +
   module imports in beforeAll racing on Windows tmpdir under
   parallel-fork pressure. Serialising them eliminates the contention
   entirely; the main `test` step skips them via `exclude` so its
   wall-clock isn't impacted.

   Hot files (timeout symptoms in their full-suite-load failures):
     - src/analyzer/gemini.test.ts            — timer-based abort race
     - src/routes/analysis-pipelining.test.ts — waitFor on long pipeline
     - src/routes/book-state.test.ts          — Hook timed out
     - src/routes/chapters-restructure.test.ts — Hook timed out
     - src/routes/generation.test.ts          — Hook timed out
     - src/routes/generation-boundary-recycle.test.ts — cross-file mock
       contamination (importOriginal "No X export on the mock") + a fake-sidecar
       HTTP server in beforeAll; flaked sibling generation tests under fast-pool
       parallelism (side-11/plan 158).
     - src/parsers/pdf-real.test.ts — the only suite that loads the REAL
       pdf-parse 2 (and its bundled pdfjs); under fast-pool parallelism it
       crashes a sibling fork ("Worker exited unexpectedly"), ~2/3 of full
       runs. Passes 3/3 single-fork. Not slow (~0.4s) — pool-destabilising,
       same class as generation-boundary-recycle (deps round 3).
     - src/routes/setup-readiness.route.test.ts — SSE + tempdir bootstrap
       under load; serialised to prevent cross-fork workspace collisions.
     - src/routes/kokoro-install.route.test.ts  — long-running install mock +
       tempdir; serialised alongside the other route integration tests.
     - src/routes/venv-bootstrap.route.test.ts  — venv-bootstrap SSE mock +
       tempdir; same contention class as the other install route tests.

   Mirror invariant: each entry in SLOW_FILES below MUST also appear
   in server/vitest.config.ts's `test.exclude` array. Add a file in
   one place and the main run picks it up too (double-runs). Add in
   the other only and the file is not exercised.

   Note: NOT extending the main config via mergeConfig — that unions
   include arrays, so the slow run would match everything. This config
   stands on its own with all settings explicit. */

export const SLOW_FILES = [
  'src/analyzer/gemini.test.ts',
  'src/routes/analysis-pipelining.test.ts',
  'src/routes/book-state.test.ts',
  'src/routes/chapters-restructure.test.ts',
  'src/routes/generation.test.ts',
  'src/routes/generation-boundary-recycle.test.ts',
  'src/parsers/pdf-real.test.ts',
  'src/routes/setup-readiness.route.test.ts',
  'src/routes/kokoro-install.route.test.ts',
  'src/routes/venv-bootstrap.route.test.ts',
];

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    /* Same user-settings redirect as the main config (plan 122). */
    setupFiles: ['src/test-setup.ts'],
    include: SLOW_FILES,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: 'forks',
    /* Vitest 4 removed `poolOptions`; the single-fork serialisation
       (`maxForks: 1`) is now the top-level `maxWorkers: 1`. */
    maxWorkers: 1,
  },
});
