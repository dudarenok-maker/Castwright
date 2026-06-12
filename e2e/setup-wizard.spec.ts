/* fs-21 wave 2 — C7: first-run setup wizard step-flow e2e.
 *
 * ?setup=notready drives the mock (mockGetSetupReadiness) to return
 * not-ready, which causes the boot gate to redirect to #/setup and
 * render the wizard in guided mode.
 *
 * Assertions are role/text based, not pixel/screenshot, so they stay
 * resilient across layout tweaks. Key wizard labels (from setup-wizard.tsx):
 *   - Back button:  "Back"  (disabled on step 1, enabled on step 2+)
 *   - Next button:  "Next"  (hidden on the last step — StepFinish owns
 *                            its own "Finish setup" button instead)
 *   - Progress:     "Step N of 5"
 */

import { test, expect } from '@playwright/test';

test('first-run wizard renders with step UI when not ready', async ({ page }) => {
  await page.goto('/#/?setup=notready');
  await expect(page).toHaveURL(/#\/setup/);
  await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();
  // Step 1 shows "Step 1 of 5" progress indicator
  await expect(page.getByText(/step 1 of 5/i)).toBeVisible();
  // Next is always enabled in guided mode
  await expect(page.getByRole('button', { name: /^next$/i })).toBeVisible();
  // Back is present but disabled on the first step
  await expect(page.getByRole('button', { name: /^back$/i })).toBeDisabled();
});

test('wizard can advance through steps (Next is always enabled)', async ({ page }) => {
  await page.goto('/#/?setup=notready');
  await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();

  const next = page.getByRole('button', { name: /^next$/i });
  await next.click(); // step 1 → step 2

  // After advancing, Back becomes enabled
  await expect(page.getByRole('button', { name: /^back$/i })).toBeEnabled();
  // Progress indicator advances
  await expect(page.getByText(/step 2 of 5/i)).toBeVisible();
  // Next is still available (not on the last step yet)
  await expect(next).toBeVisible();
});

test('wizard reaches the last step and shows Finish setup', async ({ page }) => {
  await page.goto('/#/?setup=notready');
  await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();

  const next = page.getByRole('button', { name: /^next$/i });

  // Advance through steps 1 → 2 → 3 → 4 (Next disappears on step 5)
  for (let i = 0; i < 4; i++) {
    await expect(next).toBeVisible();
    await next.click();
  }

  // On step 5 the wizard's Next is gone; StepFinish owns "Finish setup"
  await expect(page.getByText(/step 5 of 5/i)).toBeVisible();
  await expect(next).not.toBeVisible();
  await expect(page.getByRole('button', { name: /finish setup/i })).toBeVisible();
});

test('Tier-1 smoke test runs and renders audio (mock)', async ({ page }) => {
  await page.goto('/#/?setup=notready');
  await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();

  // Advance through steps 1 → 2 → 3 → 4 → 5 (Finish) via Next ×4.
  // On step 5 the wizard's Next is gone; StepFinish owns "Finish setup".
  const next = page.getByRole('button', { name: /^next$/i });
  for (let i = 0; i < 4; i++) {
    await next.click();
  }
  await expect(page.getByText(/step 5 of 5/i)).toBeVisible();

  // On the Finish step: run the smoke test.
  const smoke = page.getByTestId('smoke-test-placeholder');
  await expect(smoke).toBeVisible();
  await smoke.click();

  // Mock api.runSmokeTest returns stub-a.mp3 → audio element appears.
  await expect(page.getByTestId('smoke-audio')).toBeVisible();

  // Finish setup button is also present.
  await expect(page.getByRole('button', { name: /finish setup/i })).toBeVisible();
});

test('boot gate stays out of the way when ready', async ({ page }) => {
  await page.goto('/#/');
  await expect(page).not.toHaveURL(/#\/setup/);
});
