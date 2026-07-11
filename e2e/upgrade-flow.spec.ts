/* fs-1 — Account → Application updates e2e. Drives the in-app upgrade across the
   router/redux/layout seams in a real browser: open Account, pick a release
   zip, see the confirm dialog with the version delta, apply, and see the
   full-screen upgrading overlay. Runs against the MOCK api (mockUpgradeStage
   stages the next minor above the running build version; mockGetAppInfo stays
   on the running version so the overlay persists for the assertion — no route
   stubs needed). Assertions are version-agnostic so a release cut can't break
   this spec. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test.describe('fs-1 — in-app upgrade flow', () => {
  test('stage → confirm → apply shows the upgrading overlay', async ({ page }) => {
    await page.goto('/#/account');
    await waitForRouteReady(page);

    const card = page.getByTestId('upgrade-card');
    await expect(card).toBeVisible();
    /* Wait for the RESOLVED running version, not just the sentence — the card
       renders "v…" until /api/info settles, and staging the zip before that
       would put the placeholder into the confirm dialog's version delta. */
    await expect(card.getByText(/You.?re running v\d+\.\d+\.\d+/)).toBeVisible();

    // Pick a (fake) zip — the mock api stages a next-minor candidate.
    await card
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'castwright-release.zip',
        mimeType: 'application/zip',
        buffer: Buffer.from('PK'),
      });

    const confirm = page.getByTestId('upgrade-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(/→ v\d+\.\d+\.\d+/)).toBeVisible();
    /* The staged candidate must be a DIFFERENT version from the running one —
       a regression that stages the running version itself would render a
       no-op "vX → vX" dialog and still satisfy the bare format match above. */
    const delta = /v(\d+\.\d+\.\d+)\s*→\s*v(\d+\.\d+\.\d+)/.exec(
      (await confirm.textContent()) ?? '',
    );
    expect(delta, 'confirm dialog shows a "vX → vY" version delta').not.toBeNull();
    expect(delta![1]).not.toBe(delta![2]);

    await confirm.getByRole('button', { name: 'Apply upgrade' }).click();

    await expect(page.getByTestId('upgrading-screen')).toBeVisible();
    await expect(page.getByText(/Upgrading to v\d+\.\d+\.\d+/)).toBeVisible();
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
