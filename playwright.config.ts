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
 * with `npm run test:e2e`. PLAYWRIGHT_PORT can override this so parallel
 * worktrees running e2e don't collide on :5174 either — see
 * scripts/wt-new.mjs for the per-worktree port-offset story.
 */
const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? 5174);
const baseURL = `http://127.0.0.1:${playwrightPort}`;

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
  /* #698 — local worker cap. Unbounded (Playwright default ≈ cpus/2 ⇒ 8 on a
     16-core box) makes the first specs to run cold-load the heavy SPA all at
     once: N Chromium instances saturate CPU and each page's `load` stalls past
     budget. The `warmup` setup project warms the server transform cache; a
     moderate cap bounds the client-side cold-load herd. Together they keep the
     parallel battery green. CI stays at 1 (no herd there). Local dropped 4→2
     (2026-06-26): 4 Chromium+Vite instances thrashed memory on dev boxes and
     the cold-load herd exhausted the 2 retries under peak battery load (the
     advanced-settings flake). Two workers halves peak memory and tames the herd
     while keeping the suite well under the navigation budget. */
  workers: process.env.CI ? 1 : 2,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  /* Per-platform AND per-project visual-regression baselines. {platform}
     resolves to 'win32' | 'linux' | 'darwin' under Node's process.platform.
     {projectName} resolves to 'chromium' | 'mobile-chrome' | 'tablet-chrome'.
     Without {platform}, Playwright would commingle baselines from different
     OSes and fail on chromium font/sub-pixel drift. Without {projectName},
     mobile-chrome (Pixel 7) and tablet-chrome (iPad Pro 11) would compete
     against the desktop chromium baseline and always fail. Documented in
     docs/features/archive/37-e2e-playwright.md under "Visual baselines". */
  snapshotPathTemplate: '{snapshotDir}/{platform}/{testFilePath}/{projectName}/{arg}{ext}',
  /* #698 — sweep orphaned ms-playwright browser processes after each run; on
     Windows they leak (~52/run) and degrade later runs. See e2e/global-teardown.ts. */
  globalTeardown: './e2e/global-teardown.ts',
  expect: {
    /* Default per-assertion budget. Playwright's stock default is 5 s;
       under sustained local contention (80+ specs sharing one Vite dev
       server, parallel workers, route-level React.lazy chunks queueing)
       the first-mount `toBeVisible()` after a `page.goto(...)` can race
       past 5 s while the Suspense fallback is still painting. Bumping to
       15 s absorbs the cold-load window without softening the signal for
       genuine breakage — failures that actually break the UI still trip
       within the new budget. CI keeps `workers: 1` so the bump is a
       no-op there; locally it's the safety margin that turns a flake
       into a reliable pass. Per-spec overrides are still honoured. */
    timeout: 15_000,
    toHaveScreenshot: {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    },
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    /* See the retries comment above — 60 s absorbs the cold-load race
       on the first `page.goto('/')` of each worker when the suite is
       running fully parallel. Playwright's default is 30 s. */
    navigationTimeout: 60_000,
  },
  /* Plan 81 mobile + tablet support — three viewport projects.

     `chromium`: runs every spec under `e2e/` (the desktop default, unchanged
     from before plan 81).

     `mobile-chrome` / `tablet-chrome`: scoped to specs under `e2e/responsive/`
     via testMatch. Pre-plan-81 specs assume a desktop viewport and would
     fail under 375×667 — restricting the mobile/tablet projects to the
     responsive subfolder keeps existing specs single-project (no triple
     run-time, no false failures) while letting waves 1 / 3 / 5 land
     dedicated specs that run across all three.

     Filter locally with `npm run test:e2e -- --project=chromium`. */
  projects: [
    {
      /* #698 — transform-cache warm-up. Runs once before `chromium` (see its
         `dependencies`) so the parallel battery doesn't cold-start a thundering
         herd against the single-threaded Vite dev server. See e2e/warmup.setup.ts. */
      name: 'warmup',
      testMatch: /warmup\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      /* Don't run the warm-up file as a normal spec — it runs as a dependency. */
      testIgnore: /warmup\.setup\.ts$/,
      dependencies: ['warmup'],
    },
    {
      /* Phone viewport. We pin the engine to Chromium (already installed
         via `npx playwright install chromium`) and pull only the viewport +
         user-agent + deviceScaleFactor from the Pixel 7 preset — not the
         engine, because Playwright's iOS presets default to WebKit and
         iOS WebKit isn't installed on the dev box / CI. Wave 5 can add
         WebKit projects if we want real iOS Safari coverage later. */
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'], browserName: 'chromium' },
      testMatch: /responsive[\\/].*\.spec\.ts$/,
    },
    {
      /* Tablet viewport, same engine pin as mobile-chrome — iPad Pro 11's
         default defaultBrowserType is 'webkit', which we override. */
      name: 'tablet-chrome',
      use: { ...devices['iPad Pro 11'], browserName: 'chromium' },
      testMatch: /responsive[\\/].*\.spec\.ts$/,
    },
  ],
  webServer: {
    /* `--mode e2e` makes Vite load .env.e2e (VITE_USE_MOCKS=true) instead
       of .env.development. We deliberately avoid `--mode test` because
       Vitest defaults to that mode and would also pick up .env.test if
       it were named that — flipping mocks on for unit tests that expect
       the real-api code path. `--port <playwrightPort>` keeps it off the
       dev port (and off other worktrees' e2e ports). */
    command: `npx vite --mode e2e --port ${playwrightPort} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
