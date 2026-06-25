import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

test('fs-56 — author edits a per-line instruct; it shows + round-trips in-session', async ({ page }) => {
  // Nav preamble copied verbatim from manuscript-emotion-preview.spec.ts (proven).
  await goToConfirm(page);
  await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

  // The instruct chip renders on every line (ungated). The empty chip is
  // opacity-0/hover-reveal but is in the DOM and clickable (Playwright's
  // actionability check ignores opacity).
  const chip = page.getByTestId('instruct-chip').first();
  await chip.click();
  // Use aria-label to disambiguate from the "Filter chapters" search box.
  const ta = page.getByRole('textbox', { name: 'Enter delivery direction' });
  await ta.fill('a slow, dramatic pause');
  await page.getByRole('button', { name: /save/i }).click();

  // Chip now shows the truncated preview (redux→view seam works).
  await expect(page.getByTestId('instruct-chip').first()).toContainText('a slow, dramatic');

  // Re-open: the saved value round-trips into the textarea (store→control).
  await page.getByTestId('instruct-chip').first().click();
  await expect(page.getByRole('textbox', { name: 'Enter delivery direction' })).toHaveValue('a slow, dramatic pause');
});
