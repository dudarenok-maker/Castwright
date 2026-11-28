import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

/**
 * #2303 — a cancelled export stays in the Listen queue until it has stopped.
 *
 * In mock mode (VITE_USE_MOCKS=true) DELETE flips the job to `cancelling`, and
 * to `cancelled` 1200 ms later. The row must read "Cancelling…" in between and
 * then leave the rail, removed by the store-level `exportPollMiddleware`; the
 * modal is closed before the job reaches `cancelled`.
 */
test.describe('listen export — cancel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);
  });

  test('queue-rail row reads Cancelling… and then disappears', async ({ page }) => {
    await page
      .getByTestId('download-tile-m4b')
      .getByRole('button', { name: /Download/i })
      .click();

    const modal = page.getByTestId('export-audiobook-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('export-submit').click();
    await page.getByTestId('export-cancel').click();
    await modal.getByRole('button', { name: 'Close' }).first().click();
    await expect(modal).toBeHidden({ timeout: 5_000 });

    const rail = page.getByTestId('export-queue-rail');
    await expect(rail.getByText('Cancelling…')).toBeVisible({ timeout: 5_000 });
    await expect(rail.getByText('Mock audiobook.m4b')).toBeVisible();

    await expect(rail.getByText('Mock audiobook.m4b')).toBeHidden({ timeout: 10_000 });
    await expect(rail.getByText('Cancelling…')).toBeHidden();
  });
});
