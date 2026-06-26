/* Dedicated e2e for the pre-generation voice-model prompt (#1160 StartGenerationModal).
 *
 * The other generation specs only DISMISS the prompt (confirmTierPromptIfPresent);
 * this spec asserts the prompt's OWN behaviour: for a Qwen book it appears before
 * the run starts, offers both Qwen tiers with the cast-pin-aware default
 * pre-selected, and confirming a chosen tier starts generation. The mock
 * upload-flow cast renders on Qwen, so clicking the start CTA opens the prompt
 * (a non-Qwen book starts directly — covered by the start-generation-flow thunk
 * unit test). One test = one (cold-start-flaky) upload setup; Playwright's
 * configured retries ride out the shared goToConfirm helper's cold-load race. */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

test('voice-model prompt before a Qwen run: both tiers, 0.6B default, confirm starts (#1160)', async ({
  page,
}) => {
  /* Fresh Qwen book: confirm cast → manuscript → "Approve cast & start
     generating" lands on the generate view with the prompt open. */
  await goToConfirm(page);
  await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
  await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });

  /* The prompt appears with both Qwen tiers. */
  const heading = page.getByRole('heading', { name: /Choose the voice model/i });
  await expect(heading).toBeVisible({ timeout: 5_000 });
  const tier06 = page.getByTestId('start-gen-tier-qwen3-tts-0.6b');
  const tier17 = page.getByTestId('start-gen-tier-qwen3-tts-1.7b');
  await expect(tier06).toBeVisible();
  await expect(tier17).toBeVisible();
  /* A freshly-analysed cast carries no 1.7B pin → 0.6B is the default selection. */
  await expect(tier06).toHaveAttribute('aria-pressed', 'true');
  await expect(tier17).toHaveAttribute('aria-pressed', 'false');

  /* Pick 1.7B, then confirm → the prompt closes and generation starts. */
  await tier17.click();
  await expect(tier17).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Start generating', exact: true }).click();
  await expect(heading).toBeHidden({ timeout: 5_000 });
  /* Generation is live once a chapter-row "Generating" pill shows. */
  await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
    timeout: 20_000,
  });
});
