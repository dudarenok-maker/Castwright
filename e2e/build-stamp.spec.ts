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
 */
test.describe('build-version footer', () => {
  test('renders in the shell with the app version on the books library', async ({ page }) => {
    await page.goto('/');

    const footer = page.getByTestId('build-stamp');
    await expect(footer).toBeVisible();
    await expect(footer).toContainText('v1.4.0');
    /* Verbose (dev) stamp uses the middle-dot separator. */
    await expect(footer).toContainText('·');
  });
});
