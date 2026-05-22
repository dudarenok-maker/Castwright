import { defineConfig } from 'vitest/config';

/* BACKLOG Could #33 — slow-test config that runs the 5 hot files in
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
];

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: SLOW_FILES,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 1,
        minForks: 1,
      },
    },
    retry: 1,
  },
});
