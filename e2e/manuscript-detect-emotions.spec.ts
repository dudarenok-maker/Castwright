/* fs-33 (#510) / fs-35 — the "Detect emotions" split button in the manuscript
 * header. The primary now runs a per-chapter pass IMMEDIATELY (no confirm
 * popover); whole-book detection moved behind the ⌄ menu, which still shows
 * the confirm popover before running. In mock mode `api.detectEmotions`
 * resolves synchronously and streams one annotation, so we can assert both
 * flows end to end at the browser level.
 *
 * Pairs with the fs-33/fs-34/fs-35 plans; mirrors manuscript-emotion-preview.spec.ts. */

import { test, expect } from '@playwright/test';
import { goToConfirm, confirmCastAndReachManuscript } from './helpers';

test.describe('manuscript — Detect emotions (fs-33 / fs-35)', () => {
  test('primary runs the current chapter with no confirm, and the done summary shows', async ({ page }) => {
    await goToConfirm(page);
    await confirmCastAndReachManuscript(page);

    const button = page.getByTestId('detect-emotions-button');
    await expect(button).toBeVisible({ timeout: 5_000 });
    await expect(button).toBeEnabled();
    await button.click();

    // No confirm popover on the per-chapter primary — it runs immediately.
    const done = page.getByTestId('detect-emotions-done');
    await expect(done).toBeVisible({ timeout: 5_000 });
    await expect(done).toContainText(/in this chapter/i);
  });

  test('whole book via the ⌄ menu keeps the confirm popover', async ({ page }) => {
    await goToConfirm(page);
    await confirmCastAndReachManuscript(page);

    await page.getByTestId('detect-emotions-menu-toggle').click();
    await page.getByTestId('detect-emotions-wholebook').click();
    const confirm = page.getByTestId('detect-emotions-confirm');
    await expect(confirm).toBeVisible();
    await confirm.click();

    const done = page.getByTestId('detect-emotions-done');
    await expect(done).toBeVisible({ timeout: 5_000 });
    await expect(done).toContainText(/across \d+ chapter/i);
  });
});
