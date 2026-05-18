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
     instances + node processes the developer left running, and Playwright
     defaults to ~half the CPU cores in parallel workers. Several specs
     issue `page.goto('/')` near-simultaneously; under sustained contention
     Vite's first-response can stall past the default 30 s navigation
     budget even though the dev server boots in ~270 ms. Two levers:
       - 2 retries on local (matching CI) so a cold-load race doesn't
         need to pass first time.
       - `use.navigationTimeout: 60_000` raises the per-goto ceiling so
         a slow first response gets absorbed within one attempt.
     Genuine breakage still fails all retries. CI keeps `workers: 1` so
     contention isn't a factor there; locally we leave parallelism on so
     the suite stays under 2 min. */
  retries: 2,
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
    /* See the retries comment above — 60 s absorbs the cold-load race
       on the first `page.goto('/')` of each worker when the suite is
       running fully parallel. Playwright's default is 30 s. */
    navigationTimeout: 60_000,
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
