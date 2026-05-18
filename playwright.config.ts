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
  /* Local pre-push runs the e2e battery alongside whatever chrome
     instances + node processes the developer left running, so parallel
     workers occasionally lose a race to fetch+decode the bundled mock
     MP3 or to complete a `page.reload()` navigation. One retry catches
     these environmental flakes without masking real regressions —
     genuine breakage fails the retry too. CI keeps 2 retries for the
     same reason at slightly higher tolerance. */
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  /* Per-platform visual-regression baselines. {platform} resolves to
     'win32' | 'linux' | 'darwin' under Node's process.platform. Without
     this, Playwright would commingle baselines from different OSes
     under one path and fail on chromium font-rendering / sub-pixel
     drift the moment CI on a different OS lands. Documented in
     docs/features/37-e2e-playwright.md under "Visual baselines". */
  snapshotPathTemplate: '{snapshotDir}/{platform}/{testFilePath}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
