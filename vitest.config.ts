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
    /* One retry to absorb transient jsdom/timer flakes inside a single
       verify run instead of forcing a full pre-push re-execution. See
       docs/features/45-vitest-pool-tuning.md. Pool concurrency left at
       Vitest's defaults — jsdom suites are CPU-bound, not subprocess-
       bound; the server suite is where the worker-crash pattern lives. */
    retry: 1,
  },
});
