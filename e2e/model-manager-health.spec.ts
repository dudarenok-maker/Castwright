/* Task 12 — Model Manager health-state e2e.
 *
 * Pins the browser-level rendering of three health states that the
 * mock inventory (mockGetModelInventory in api.ts) now emits:
 *
 *   1. package-missing (qwen-base)  → "Needs repair" badge + "Repair" toggle,
 *                                      no Load pill (engine not usable).
 *   2. verified integrity (kokoro)  → integrity chip labelled "verified".
 *   3. unpinned integrity (qwen-base)→ integrity chip labelled "unpinned".
 *   4. not-installed + secondary tier (coqui) → "Install" toggle, "Not installed"
 *                                               badge, rendered under "Optional add-ons".
 *   5. Tier subheadings — "Standard" and "Optional add-ons" — appear when at
 *      least one TTS item carries a `tier` field.
 *
 * The mock layer (VITE_USE_MOCKS=true) fulfils api.getModelInventory() in-process
 * without a network hop, so page.route() interception is not applicable here —
 * the health states are baked into mockGetModelInventory in api.ts. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('Model Manager — health states', () => {
  test('package-missing row shows "Needs repair", "Repair" toggle, no Load pill', async ({
    page,
  }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);

    /* Wait for the inventory section to hydrate (the async mock fetch lands
       in ~80 ms; 15 s is the global Playwright default and enough for a
       cold Vite chunk load to resolve before the inventory renders). */
    await expect(page.getByTestId('model-inventory')).toBeVisible();

    const qwenRow = page.getByTestId('model-row-qwen-base');
    await expect(qwenRow).toBeVisible();

    /* 1a — residency badge reads "Needs repair". */
    await expect(qwenRow.getByText('Needs repair', { exact: true })).toBeVisible();

    /* 1b — installer toggle is labelled "Repair" (not "Install" / "Update"). */
    await expect(qwenRow.getByTestId('model-install-toggle-qwen-base')).toContainText(/Repair/i);

    /* 1c — no Load pill (engine is not usable while package is missing). */
    await expect(qwenRow.getByRole('button', { name: /load model/i })).not.toBeVisible();
  });

  test('integrity chips render — kokoro: verified, qwen-base: unpinned', async ({ page }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);
    await expect(page.getByTestId('model-inventory')).toBeVisible({ timeout: 10_000 });

    const kokoroRow = page.getByTestId('model-row-kokoro');
    await expect(kokoroRow).toBeVisible();
    /* IntegrityChip uses aria-label="integrity: verified". */
    await expect(kokoroRow.getByLabel('integrity: verified')).toBeVisible();

    const qwenRow = page.getByTestId('model-row-qwen-base');
    await expect(qwenRow.getByLabel('integrity: unpinned')).toBeVisible();
  });

  test('secondary (coqui) row shows "Not installed" badge and "Install" toggle', async ({
    page,
  }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);
    await expect(page.getByTestId('model-inventory')).toBeVisible({ timeout: 10_000 });

    const coquiRow = page.getByTestId('model-row-coqui');
    await expect(coquiRow).toBeVisible();

    /* Not installed → badge reads "Not installed". */
    await expect(coquiRow.getByText('Not installed', { exact: true })).toBeVisible();

    /* Installer toggle labelled "Install" (not "Repair" / "Update"). */
    await expect(coquiRow.getByTestId('model-install-toggle-coqui')).toContainText(/Install/i);
  });

  test('"Standard" and "Optional add-ons" tier subheadings are present', async ({ page }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);
    await expect(page.getByTestId('model-inventory')).toBeVisible({ timeout: 10_000 });

    await expect(page.getByText('Standard', { exact: true })).toBeVisible();
    await expect(page.getByText('Optional add-ons', { exact: true })).toBeVisible();
  });
});
