import { defineConfig } from 'vitest/config';

/* Server-side test harness. Node environment (no jsdom) — most suites are
   pure helpers + supertest against Express routers. Tests that shell out
   to ffmpeg (e.g. mp3.test.ts) need a generous timeout because the encoder
   subprocess spawn + libmp3lame init costs a few hundred ms cold. */

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.{test,spec}.ts'],
    testTimeout: 15_000,
  },
});
