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
       than extending them. Shared fixtures/mocks need NO entry: tests import
       them statically, so the module graph already covers them.
       See docs/features/118-ci-cost-round-2.md. */
    forceRerunTriggers: [
      '**/package.json/**',
      '**/{vitest,vite}.config.*/**',
      '**/src/test/setup.ts',
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
