/* fs-1 — Account → Application updates e2e. Drives the in-app upgrade across the
   router/redux/layout seams in a real browser: open Account, pick a release
   zip, see the confirm dialog with the version delta, apply, and see the
   full-screen upgrading overlay. Runs against the MOCK api (mockUpgradeStage
   returns a v1.7.0 candidate; mockGetAppInfo stays on v1.6.0 so the overlay
   persists for the assertion — no route stubs needed). */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test.describe('fs-1 — in-app upgrade flow', () => {
  test('stage → confirm → apply shows the upgrading overlay', async ({ page }) => {
    await page.goto('/#/account');
    await waitForRouteReady(page);

    const card = page.getByTestId('upgrade-card');
    await expect(card).toBeVisible();
    await expect(card.getByText(/You.?re running/)).toBeVisible();

    // Pick a (fake) zip — the mock api stages a v1.7.0 candidate.
    await card
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'audiobook-generator-v1.7.0.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('PK'),
      });

    const confirm = page.getByTestId('upgrade-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/→ v1\.7\.0/)).toBeVisible();

    await confirm.getByRole('button', { name: 'Apply upgrade' }).click();

    await expect(page.getByTestId('upgrading-screen')).toBeVisible();
    await expect(page.getByText(/Upgrading to v1\.7\.0/)).toBeVisible();
  });

  test('cancel on the confirm dialog returns to the picker', async ({ page }) => {
    await page.goto('/#/account');
    await waitForRouteReady(page);

    const card = page.getByTestId('upgrade-card');
    await card
      .locator('input[type="file"]')
      .setInputFiles({ name: 'rel.zip', mimeType: 'application/zip', buffer: Buffer.from('PK') });

    const confirm = page.getByTestId('upgrade-confirm');
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    /* Mock getUpdateStatus reports "up to date", so the manual-apply affordance
       is the demoted label (the prominent "Apply update package…" only shows
       when a newer release is detected). Either way the picker is back. */
    await expect(card.getByRole('button', { name: /Apply a package manually/ })).toBeVisible();
  });
});
