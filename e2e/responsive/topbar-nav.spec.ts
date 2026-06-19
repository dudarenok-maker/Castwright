/* Plan 2026-06-19 — responsive top-bar nav. With a book open, the inline tab
 * strip is hidden below xl (1280); the hamburger drawer must be the path to
 * Cast/Manuscript/etc. Runs under all three projects (responsive/* glob):
 * skip the collapsed assertions on desktop chromium (1280, inline strip), and
 * skip the inline assertion on mobile/tablet. */
import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from '../helpers';

test.describe('top-bar nav — responsive collapse', () => {
  test('below xl: inline tabs are hidden and the hamburger drawer reaches Cast', async ({
    page,
  }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width >= 1280, 'desktop shows the inline strip; covered by the >=xl test');

    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page);

    // The inline tab exists in the DOM but is display:none below xl.
    await expect(page.getByRole('button', { name: 'Cast', exact: true })).toBeHidden();
    // The hamburger IS the affordance.
    const toggle = page.getByTestId('topbar-nav-toggle');
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(page.getByTestId('topbar-nav-drawer')).toBeVisible();
    await page.getByTestId('nav-drawer-link-cast').click();

    await expect(page).toHaveURL(/books\/sb\/cast/);
    await expect(page.getByTestId('topbar-nav-drawer')).toHaveCount(0);
  });

  test('at/above xl: the inline strip shows and there is no hamburger', async ({ page }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width < 1280, 'mobile/tablet collapses; covered by the <xl test');

    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page);

    await expect(page.getByRole('button', { name: 'Cast', exact: true })).toBeVisible();
    // The hamburger is in the DOM but display:none at xl — assert hidden, not absent.
    await expect(page.getByTestId('topbar-nav-toggle')).toBeHidden();
  });
});
