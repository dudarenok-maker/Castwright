import { test, expect } from '@playwright/test';

/**
 * Plan 124 — build-version footer.
 *
 * The footer lives in the app shell (layout.tsx), so it must render at the
 * bottom of every stage. This asserts it's present + visible on the cold-boot
 * books library and carries the pinned e2e stamp.
 *
 * The e2e webServer runs `vite --mode e2e` — a DEV server, so
 * `import.meta.env.DEV === true` and the VERBOSE stamp renders. `.env.e2e`
 * sets VITE_PIN_BUILD_STAMP=1 (#4566), which pins version, SHA, branch and
 * build time in vite.config.ts, so the footer text is exact and identical on
 * every checkout (and the stats visual baselines stay deterministic).
 */
test.describe('build-version footer', () => {
  test('renders in the shell with the pinned stamp on the books library', async ({ page }) => {
    await page.goto('/');

    const footer = page.getByTestId('build-stamp');
    await expect(footer).toBeVisible();
    await expect(footer).toHaveText('Castwright · v0.0.0-e2e · e2e0000 · e2e · 00:00');
  });
});
