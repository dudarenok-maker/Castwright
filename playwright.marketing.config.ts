import { defineConfig, devices } from '@playwright/test';

/* Marketing screenshot capture — NOT a regression gate.
   Runs Vite in `--mode marketing` (.env.marketing → VITE_USE_MOCKS=true +
   VITE_DEMO_CAPTURE=1) and drives the scene registry under e2e/marketing/.
   Output PNGs land in git-ignored mockups/marketing-screens/. */
const port = Number(process.env.PLAYWRIGHT_PORT ?? 5175);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e/marketing',
  testMatch: /capture\.spec\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: { baseURL, navigationTimeout: 60_000 },
  expect: { toHaveScreenshot: { animations: 'disabled' } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'tablet', use: { ...devices['iPad Pro 11'], browserName: 'chromium' } },
  ],
  webServer: {
    command: `npx vite --mode marketing --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
