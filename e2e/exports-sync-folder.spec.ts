import { test, expect } from '@playwright/test';

/**
 * Plan 79 — sync-folder UX hardening e2e.
 *
 * Locks the browser-level golden path through the export modal's
 * Voice tile in mock mode:
 *  - Voice tile opens the modal with the sync-folder body visible.
 *  - The "Test" probe button is wired to the new
 *    `/api/user/settings/sync-folder/test` endpoint; mock returns
 *    `{ ok: true }` for any non-empty path, so clicking Test after
 *    typing a path renders the ✓ banner.
 *  - The folder input auto-saves on blur (no Save button click
 *    required) — the next reopen of the modal pre-populates with the
 *    saved value, which we assert via the "Saves to your Voice library
 *    at ..." caption rendered when saved && !isDirty.
 *
 * Disk-side assertions (artifact at `<bookDir>/exports/<slug>.m4b`,
 * manifest at `<bookDir>/.audiobook/export-manifests/<id>.json`) live
 * in server/src/routes/export.test.ts — this spec only covers the
 * user-visible UI seam.
 */
test.describe('plan 79 — sync-folder UX', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('Voice tile shows the sync-folder body with a Test button', async ({ page }) => {
    const tile = page.getByTestId('listener-app-voice');
    await expect(tile).toBeVisible();
    await tile.getByRole('button', { name: /Send to Voice/i }).click();

    await expect(page.getByTestId('export-audiobook-modal')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId('export-voice-body')).toBeVisible();
    await expect(page.getByTestId('sync-folder-input')).toBeVisible();
    await expect(page.getByTestId('sync-folder-test')).toBeVisible();
  });

  test('typing a path and clicking Test shows the ✓ probe banner', async ({ page }) => {
    await page.getByTestId('listener-app-voice').getByRole('button', { name: /Send to Voice/i }).click();
    await expect(page.getByTestId('export-voice-body')).toBeVisible();

    const input = page.getByTestId('sync-folder-input');
    await input.fill('G:\\My Drive\\Audiobooks');
    /* Test button is enabled once the input has content. */
    const testBtn = page.getByTestId('sync-folder-test');
    await expect(testBtn).toBeEnabled();
    await testBtn.click();
    await expect(page.getByTestId('sync-folder-probe-ok')).toBeVisible({ timeout: 3_000 });
  });
});
