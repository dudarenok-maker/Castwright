import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config — browser-level regression net.
 *
 * Runs against the Vite dev server in mock mode (VITE_USE_MOCKS=true),
 * so e2e tests never need the Node analysis backend or TTS sidecar
 * up — they exercise the same in-memory mocks the Vitest specs do, but
 * through a real browser (real router, real timers, real layout).
 *
 * Port 5174 (not 5173) so a running `npm run dev` does not conflict
 * with `npm run test:e2e`.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    /* `--mode e2e` makes Vite load .env.e2e (VITE_USE_MOCKS=true) instead
       of .env.development. We deliberately avoid `--mode test` because
       Vitest defaults to that mode and would also pick up .env.test if
       it were named that — flipping mocks on for unit tests that expect
       the real-api code path. `--port 5174` keeps it off the dev port. */
    command: 'npx vite --mode e2e --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
