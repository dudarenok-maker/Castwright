import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
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
  },
});
