/* Wave 3 — /about brand page renders the primary tagline.

   AboutView renders the Castwright tagline in a <p> scoped to the
   /about route. The locator targets the tagline text directly so it
   survives layout changes; it does NOT match the top-bar wordmark
   (which contains only "Castwright", not the full tagline sentence). */

import { test, expect } from '@playwright/test';

test('/about renders the brand tagline', async ({ page }) => {
  await page.goto('/#/about');

  await expect(
    page.getByText('Any book, performed by a full cast', { exact: false }),
  ).toBeVisible({ timeout: 10_000 });
});

/* side-14 — mock mode ships a ready devices map (kokoro active on cuda), so
   the device panel's ground-truth headline must render on /about. */
test('/about device panel shows the ground-truth device line', async ({ page }) => {
  await page.goto('/#/about');

  const panel = page.getByTestId('device-panel');
  await expect(panel.getByText('Currently running on:', { exact: false })).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByText('NVIDIA GPU (CUDA)', { exact: false }).first()).toBeVisible();
});
