/* fs-23 — Model Manager inventory + remove e2e.
 *
 * Pins the in-browser inventory surface: the per-model list (size + residency)
 * and the Remove → confirm → row-flips-to-Not-installed round-trip. Mock mode
 * (VITE_USE_MOCKS=true) fulfils GET /api/models/inventory + POST
 * /api/models/:id/remove in-memory (mockGetModelInventory / mockRemoveModel),
 * and a removed id is reflected on the next poll. The server route + guards are
 * locked independently by models-inventory.test.ts. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('Model Manager — inventory', () => {
  test('lists models with a residency badge', async ({ page }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);

    await expect(page.getByTestId('model-inventory')).toBeVisible();
    await expect(page.getByTestId('model-row-kokoro')).toBeVisible();
    await expect(page.getByTestId('model-row-qwen-base')).toBeVisible();
    /* Kokoro is the resident fallback in the mock inventory. */
    await expect(page.getByTestId('model-row-kokoro').getByText('Loaded')).toBeVisible();
  });

  test('removing an idle non-default model flips its row to Not installed', async ({ page }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);

    /* qwen-design is present, not loaded, not default/fallback → removable. */
    const row = page.getByTestId('model-row-qwen-design');
    await expect(row).toBeVisible();
    await row.getByTestId('model-remove-qwen-design').click();

    const modal = page.getByTestId('model-remove-confirm');
    await expect(modal).toBeVisible();
    await modal.getByTestId('model-remove-confirm-button').click();

    await expect(page.getByTestId('model-row-qwen-design').getByText('Not installed')).toBeVisible({
      timeout: 5_000,
    });
  });

  test('blocks removing the loaded fallback engine', async ({ page }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);

    await page.getByTestId('model-row-kokoro').getByTestId('model-remove-kokoro').click();
    const modal = page.getByTestId('model-remove-confirm');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('model-remove-confirm-button')).toBeDisabled();
  });
});
