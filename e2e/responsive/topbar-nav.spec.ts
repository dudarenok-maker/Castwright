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

  /* #916 regression — before the inline-chrome trim, the 44px hamburger (added
     with the responsive nav) pushed the right cluster (Help / Theme / Account)
     ~120px past the 412px phone viewport, where `overflow-x-clip` hid them: the
     controls were in the DOM but positioned off-screen and unclickable (this is
     exactly what timed out the guided-tour spec on the Linux mobile-e2e leg).
     Assert every right-cluster control's box sits inside the viewport on phone. */
  test('phone: Help / Theme / Account are inside the viewport (not clipped off-screen)', async ({
    page,
  }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width >= 640, 'phone-only: at sm+ the full inline chrome fits and is unchanged');

    await page.goto('/#/');
    const inViewport = async (locator: ReturnType<typeof page.locator>, label: string) => {
      await expect(locator, `${label} present`).toBeVisible();
      const box = await locator.boundingBox();
      const vw = page.viewportSize()?.width ?? 0;
      expect(box, `${label} has a box`).not.toBeNull();
      expect(box!.x, `${label} not clipped off the left`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${label} not clipped off the right (vw=${vw})`).toBeLessThanOrEqual(
        vw + 1,
      );
    };

    await inViewport(page.getByTestId('topbar-help'), 'Help button');
    await inViewport(page.getByTestId('theme-toggle'), 'Theme toggle');
    await inViewport(page.getByRole('button', { name: /account/i }), 'Account avatar');
  });

  /* #916 — Admin moves off the inline phone bar into the hamburger drawer (it
     stays inline at sm+). Confirm it is still reachable on phone via the drawer. */
  test('phone: Admin is reachable via the hamburger drawer', async ({ page }) => {
    const width = page.viewportSize()?.width ?? 0;
    test.skip(width >= 640, 'phone-only: Admin stays an inline pill at sm+');

    await page.goto('/#/');
    // Inline Admin pill is hidden on a nav stage at phone width.
    await expect(page.getByTestId('topbar-admin-link')).toBeHidden();

    await page.getByTestId('topbar-nav-toggle').click();
    await expect(page.getByTestId('topbar-nav-drawer')).toBeVisible();
    await page.getByTestId('nav-drawer-link-admin').click();
    await expect(page).toHaveURL(/#\/admin/);
  });
});
