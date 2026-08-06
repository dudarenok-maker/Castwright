import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import mainConfig from './vitest.config.js';

/* #2063 (ported from server/vitest.config.wire-fixtures.ts, PR #2049 review
   Finding 6) — the ONLY config that includes src/__wire-fixtures__/**, the
   throwaway location src/vitest-retry-hazard-reporter.test.ts's
   runVitestOnFixture() writes to and spawns against. vitest.config.ts
   EXCLUDES that directory outright (so a fixture that survives a `finally`
   block not running — e.g. a kill between write and cleanup — can never
   poison the real suite), which means the wire tests need a config of their
   own to run at all.

   retry/reporters are pulled straight off the main config's resolved
   default export rather than re-typed here, so a wire test keeps proving
   the REAL, on-disk retry:1 + reporters behaviour — not a copy that could
   silently drift from it if the main config changes. */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/__wire-fixtures__/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    retry: mainConfig.test?.retry,
    reporters: mainConfig.test?.reporters,
  },
});
