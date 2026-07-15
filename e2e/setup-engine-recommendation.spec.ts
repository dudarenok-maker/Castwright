/* Wizard language-aware engine recommendation (fe-51, #1614) — golden path.
 *
 * The Voice step asks a guided question ("Do you want expressive and/or
 * multilingual audio?") before showing any engine card. Answering "yes"
 * leads with the Qwen card, badges it "Recommended for you", and — in the
 * CPU-only mock fixture (mockGetModelsStatus: vramTotalMb null) — surfaces a
 * neutral "may not fit this GPU's memory" caveat rather than silently
 * falling back to Kokoro. That's the deliberate case-4 revision: capability
 * (expressive/multilingual) is a hard filter, VRAM is only ever a soft
 * caveat. See docs/features/259-fe51-engine-recommendation.md.
 *
 * Step order (setup-wizard.tsx): environment, ffmpeg, analysis, voice,
 * defaults, lanCert, finish — Voice is step 4 of 7 (same sequence as
 * e2e/setup-models-status.spec.ts).
 */

import { test, expect } from '@playwright/test';

test('Voice step: answering "yes" recommends Qwen with a may-not-fit caveat', async ({ page }) => {
  await page.goto('/#/?setup=notready');
  await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();

  const next = page.getByRole('button', { name: /^next$/i });
  await next.click(); // step 1 → ffmpeg (step 2)
  await next.click(); // step 2 → analysis (step 3)
  await next.click(); // step 3 → voice (step 4)
  await expect(page.getByText(/step 4 of 7/i)).toBeVisible();

  // Guided question is visible before any answer is given.
  await expect(page.getByText(/do you want expressive and\/or multilingual audio\?/i)).toBeVisible();

  await page.getByRole('radio', { name: /yes — expressive/i }).click();

  await expect(page.getByText(/recommended for you/i)).toBeVisible();

  const caveat = page.getByTestId('recommendation-caveat');
  await expect(caveat).toBeVisible();
  await expect(caveat).toHaveText(/may not fit/i);

  // The recommended lead card is Qwen's, not Kokoro's.
  await expect(page.locator('[data-engine-card="qwen"]')).toBeVisible();
});
