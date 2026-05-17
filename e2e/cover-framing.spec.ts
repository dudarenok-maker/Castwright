/* Plan 40 — cover framing + local-disk upload golden path.

   Walks the library → CoverPicker → Upload tab → file upload → auto-
   switch to Frame tab → zoom interaction. Under VITE_USE_MOCKS=true the
   mock api.uploadCover returns a session-only blob URL (no server
   round-trip); mock api.patchCoverFraming is a no-op. We verify
   user-visible artifacts: tabs render, upload succeeds, Frame tab
   becomes active and shows the zoom control. */

import { test, expect } from '@playwright/test';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test.describe('cover framing + local-disk upload (plan 40)', () => {
  test('upload tab uploads a PNG and auto-switches to Frame tab', async ({ page }) => {
    /* Library landing — pick the canonical 'complete' fixture (Solway Bay)
       so a BookCard is guaranteed to be in the grid under mocks. */
    await page.goto('/');
    const newBookButton = page.getByRole('button', { name: /Start a new book/i });
    await expect(newBookButton).toBeVisible({ timeout: 10_000 });

    /* Reveal the per-card "..." menu — opacity:0 on the card by default,
       triggered by hover (or focus). Just clicking it works in headless
       chromium since the button is in the DOM regardless. */
    const optionsButton = page.getByRole('button', { name: /Book options/i }).first();
    await optionsButton.click();

    /* "Find cover image" opens the CoverPicker modal. */
    await page.getByRole('button', { name: /Find cover image/i }).click();
    await expect(page.getByTestId('cover-picker')).toBeVisible({ timeout: 5_000 });

    /* Default tab is Search — the account default is 'search' on a fresh
       fixture. Switch to Upload. */
    await page.getByTestId('tab-upload').click();
    await expect(page.getByTestId('upload-dropzone')).toBeVisible();

    /* Set the file directly on the hidden <input type="file"> — this is
       the standard Playwright pattern for tests that don't need to
       exercise the drag-drop event handlers. */
    await page.getByTestId('upload-input').setInputFiles({
      name: 'test-cover.png',
      mimeType: 'image/png',
      buffer: Buffer.from(TINY_PNG_BASE64, 'base64'),
    });

    /* On successful upload the picker switches to the Frame tab and
       reveals the zoom range input. The aria-selected attribute on the
       Frame tab flips to "true". */
    await expect(page.getByTestId('frame-preview')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('frame-zoom')).toBeVisible();
    await expect(page.getByTestId('tab-frame')).toHaveAttribute('aria-selected', 'true');

    /* Frame zoom slider is interactive. Move to 1.5×; we don't assert
       framing persists here (mocks make that a no-op) — that lives in
       the unit tests. The interaction proves the slider is wired. */
    await page.getByTestId('frame-zoom').fill('1.5');
    await expect(page.getByTestId('frame-zoom')).toHaveValue('1.5');

    /* "Reset framing" button is present and clickable. */
    await page.getByTestId('frame-reset').click();
    await expect(page.getByTestId('frame-zoom')).toHaveValue('1');
  });
});
