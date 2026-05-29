import { test, expect } from '@playwright/test';

/**
 * Plan 75 — Portable book bundle e2e.
 *
 * Click the "Portable bundle" tile on the Listen view → downloads a zip.
 * Then navigate to the Library view → click "Import portable bundle" →
 * select that zip → the toast surfaces and the library refresh fires.
 *
 * Runs against Vite in mock mode (VITE_USE_MOCKS=true). The mock
 * exportPortable returns a minimal empty-zip blob, and the mock
 * importPortable echoes a synthesised bookId so the library can refresh
 * without disturbing the canned data.
 *
 * Pairs with docs/features/archive/75-portable-book-export.md.
 */
test.describe('plan 75 — portable book bundle round-trip', () => {
  test('Listen view: Portable bundle tile is live and triggers a download', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const tile = page.getByTestId('download-tile-portable');
    await expect(tile).toBeVisible();
    const button = tile.getByRole('button', { name: /Download/i });
    await expect(button).toBeEnabled();

    /* In mock mode the click fabricates a Blob and dispatches an
       anchor click. We attach a download listener BEFORE the click
       so Playwright's intercept catches it. */
    const downloadPromise = page.waitForEvent('download', { timeout: 5_000 });
    await button.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.portable\.zip$/);
  });

  test('Library view: Import portable bundle button surfaces and fires on file pick', async ({
    page,
  }) => {
    await page.goto('/#/');
    /* Library view loads via the layout hydrate. Wait for the library
       skeleton to clear so the chrome (with the Import button) is
       rendered. */
    await expect(page.getByTestId('library-import-portable-button')).toBeVisible({
      timeout: 10_000,
    });

    /* Wire a fake file pick: set the hidden input's files via
       Playwright's setInputFiles helper. The hidden input has the
       library-import-portable-input testid; setInputFiles unwraps
       the hidden state. */
    const fileInput = page.getByTestId('library-import-portable-input');
    await fileInput.setInputFiles({
      name: 'demo.portable.zip',
      mimeType: 'application/zip',
      /* Minimal valid empty-zip (EOCD only). */
      buffer: Buffer.from([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]),
    });

    /* The orchestrator calls api.importPortable → in mock mode resolves
       to a synthesised bookId that doesn't exist in the mock library.
       The orchestrator falls back to the "Bundle imported" toast. Assert
       on either branch — both prove the round-trip plumbing fired. */
    await expect(page.getByText(/Imported:|Bundle imported/i).first()).toBeVisible({
      timeout: 5_000,
    });
  });
});
