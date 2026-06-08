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
