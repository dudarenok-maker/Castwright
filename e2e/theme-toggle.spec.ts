/* Plan 41 — golden path for the top-bar theme toggle + account default.
 *
 * Asserts:
 *   1. cold boot paints `<html data-theme="light">` (account default
 *      is 'system' and the test browser reports prefers-color-scheme:
 *      light by default).
 *   2. clicking the top-bar toggle cycles system → light → dark; the
 *      DOM attribute updates without a refresh.
 *   3. the override survives a reload (redux-persist + pre-mount
 *      paint guard in src/main.tsx).
 *   4. navigating to the Account view surfaces the "currently
 *      overridden" pill; clicking "Use account default" clears the
 *      override and the theme reverts to the account-default
 *      resolution.
 */

import { test, expect } from '@playwright/test';

test.describe('plan 41 — theme toggle', () => {
  test('cycles system → light → dark and persists across a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first())
      .toBeVisible({ timeout: 10_000 });

    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'light');

    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toHaveAttribute('data-theme-mode', 'system');

    /* system → light */
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-theme-mode', 'light');
    await expect(html).toHaveAttribute('data-theme', 'light');

    /* light → dark; dataset.theme flips */
    await toggle.click();
    await expect(toggle).toHaveAttribute('data-theme-mode', 'dark');
    await expect(html).toHaveAttribute('data-theme', 'dark');

    /* Reload — pre-mount paint guard reads the persisted override and
       paints dark BEFORE React mounts. */
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByTestId('theme-toggle')).toHaveAttribute('data-theme-mode', 'dark');
  });

  test('account "Use account default" clears the override and reverts the theme', async ({ page }) => {
    /* Pre-seed an override so the Account view renders the pill. */
    await page.addInitScript(() => {
      const wrapper = { themeOverride: JSON.stringify('dark') };
      window.localStorage.setItem('persist:ui', JSON.stringify(wrapper));
    });
    await page.goto('/#/account');

    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');

    const pill = page.getByTestId('theme-override-pill');
    await expect(pill).toBeVisible({ timeout: 5_000 });
    await expect(pill).toContainText(/this device is overridden/i);

    await page.getByRole('button', { name: /Use account default/i }).click();
    await expect(page.getByTestId('theme-override-pill')).toHaveCount(0);
    /* Account default is 'system', test browser is light → reverts to light. */
    await expect(html).toHaveAttribute('data-theme', 'light');
  });
});
