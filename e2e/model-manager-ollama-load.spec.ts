/* Model Manager — per-model Ollama Load/Unload.
 *
 * Every installed Ollama analyzer model (not just the configured default) now
 * carries its own Load/Unload pill. The mock api exposes a second, NON-default
 * model (`llama3.1:8b`) that starts un-resident; loading it flips the row's
 * `data-loaded` (the mock keeps per-model residency in the same JS context),
 * and Stop flips it back. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady, stubAccountModelProbes } from './helpers';

test.beforeEach(async ({ page }) => {
  await stubAccountModelProbes(page);
});

test('loads and unloads a non-default Ollama model from the Model Manager', async ({ page }) => {
  await page.goto('/#/models');
  await waitForRouteReady(page);

  const row = page.getByTestId('model-row-ollama:llama3.1:8b');
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-loaded', 'false');

  await row.getByRole('button', { name: /load model/i }).click();
  await expect(row).toHaveAttribute('data-loaded', 'true');

  await row.getByRole('button', { name: /stop/i }).click();
  await expect(row).toHaveAttribute('data-loaded', 'false');
});
