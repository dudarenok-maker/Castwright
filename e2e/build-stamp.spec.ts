import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

/**
 * Plan 124 — build-version footer.
 *
 * The footer lives in the app shell (layout.tsx), so it must render at the
 * bottom of every stage. This asserts it's present + visible on the cold-boot
 * books library and carries the real injected version from package.json.
 *
 * The e2e webServer runs `vite --mode e2e` — a DEV server, so
 * `import.meta.env.DEV === true` and the VERBOSE stamp renders. We assert only
 * version + the `·` separator; SHA / branch / build-time vary per checkout and
 * CI environment, so pinning them would be flaky.
 *
 * The version is read from package.json at test time (not hard-coded) so a
 * `bump-version` run can't leave this assertion stale — that's exactly how
 * the v1.5.0 bump left it asserting v1.4.0.
 */
const expectedVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

test.describe('build-version footer', () => {
  test('renders in the shell with the app version on the books library', async ({ page }) => {
    await page.goto('/');

    const footer = page.getByTestId('build-stamp');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText(`v${expectedVersion}`);
    /* Verbose (dev) stamp uses the middle-dot separator. */
    await expect(footer).toContainText('·');
  });
});
