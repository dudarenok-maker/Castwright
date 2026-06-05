import { defineConfig } from 'vitest/config';

/* Golden-audio Suite B (ops-11, GPU-free assembly golden). Runs ONLY the
   `*.golden.test.ts` files, which the default vitest.config.ts EXCLUDES so the
   normal `test:server` tier never touches them. Invoked on demand via
   `npm run test:golden-audio` / `:assembly` — NOT part of `test:all` / `verify`.

   These tests shell out to real ffmpeg (2-pass loudnorm encode), so a generous
   timeout + single worker keeps the encoder subprocess from racing. Same node
   env + user-settings redirect (src/test-setup.ts) as the main config. */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.golden.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'src/test-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 1,
  },
});
