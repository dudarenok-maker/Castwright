import { defineConfig } from 'vitest/config';

/* Server-side test harness. Node environment (no jsdom) — most suites are
   pure helpers + supertest against Express routers. Tests that shell out
   to ffmpeg (e.g. mp3.test.ts) need a generous timeout because the encoder
   subprocess spawn + libmp3lame init costs a few hundred ms cold.

   Pool concurrency is capped (maxForks=4) and one retry is allowed: see
   docs/features/45-vitest-pool-tuning.md for the rationale. The default
   forks pool grows to N=logical-CPUs (16+ on dev boxes); with subprocess-
   spawning tests (ffmpeg, supertest servers, sidecar mocks) that exhausts
   pipe/handle budgets and one worker dies mid-suite ("Worker exited
   unexpectedly"), failing the whole verify. Cap + retry absorbs both the
   root cause and the residual transients without forcing a full re-push. */

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    testTimeout: 15_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
    retry: 1,
  },
});
