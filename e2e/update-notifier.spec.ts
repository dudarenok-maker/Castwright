/* fe-27 — in-app update notifier across the layout/router/localStorage seams.
   Mock mode is in-process (page.route can't force "update available"), so the
   ?e2eUpdate=<version> mock seam supplies a deterministic trigger. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test.describe('fe-27 — update notifier', () => {
  test('appears when behind, dismiss persists across reload, reappears on a newer version', async ({
    page,
  }) => {
    await page.goto('/?e2eUpdate=9.9.9#/books');
    await waitForRouteReady(page);

    const banner = page.getByTestId('update-notifier-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByText(/Update available — v9\.9\.9/)).toBeVisible();

    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toBeHidden();

    // Reload, same latest version → stays dismissed (localStorage).
    await page.goto('/?e2eUpdate=9.9.9#/books');
    await waitForRouteReady(page);
    await expect(page.getByTestId('update-notifier-banner')).toBeHidden();

    // A newer release → notifier returns.
    await page.goto('/?e2eUpdate=9.9.10#/books');
    await waitForRouteReady(page);
    await expect(page.getByTestId('update-notifier-banner')).toBeVisible();
  });
});
