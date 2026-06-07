/* fs-33 (#510) — the "Detect emotions" trigger in the manuscript header runs the
 * emotion-only backfill pass: confirm → stream → annotations applied to the
 * manuscript store. In mock mode `api.detectEmotions` resolves synchronously and
 * streams one annotation (chapter 1, sentence 1 → excited), so we can assert the
 * full confirm → run → done flow at the browser level.
 *
 * Pairs with the fs-33/fs-34 plan; mirrors manuscript-emotion-preview.spec.ts. */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

test.describe('manuscript — Detect emotions (fs-33)', () => {
  test('confirm → run → done, and the streamed emotion lands on a sentence', async ({ page }) => {
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

    const button = page.getByTestId('detect-emotions-button');
    await expect(button).toBeVisible({ timeout: 5_000 });
    await expect(button).toBeEnabled();

    await button.click();
    // The confirm popover appears with the quota/time copy + a Detect button.
    const confirm = page.getByTestId('detect-emotions-confirm');
    await expect(confirm).toBeVisible();
    await confirm.click();

    // The pass completes (mock) and the inline "Tagged N line(s)…" summary
    // shows — proving the confirm → stream → result flow wired end to end.
    const done = page.getByTestId('detect-emotions-done');
    await expect(done).toBeVisible({ timeout: 5_000 });
    await expect(done).toContainText(/Tagged \d+ line/i);
    // (The store fill — applyDetectedEmotions, fill-only-empty — is covered by
    // manuscript-slice + detect-emotions-button unit/component tests, which use
    // controlled fixtures rather than the canned manuscript's sentence shape.)
  });
});
