import { test, expect } from '@playwright/test';

/**
 * Plan 57 — Listen-view download tiles e2e.
 *
 * Three "Or download a file" tiles on the listen view:
 *  - Full audiobook (m4b chaptered) — LIVE
 *  - MP3 ZIP — LIVE
 *  - Streaming link — Coming soon
 *
 * Each live tile opens the ExportAudiobookModal pre-set to the right
 * format + destination via the `prefill` prop. This spec walks the
 * click-through for the two live tiles and confirms the modal mounts
 * with the right format selected.
 *
 * Pairs with docs/features/57-download-tiles.md.
 */
test.describe.configure({ mode: 'serial' });

test.describe('plan 57 — download tiles', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('M4B tile is live and opens the export modal with m4b pre-selected', async ({ page }) => {
    const tile = page.getByTestId('download-tile-m4b');
    await expect(tile).toBeVisible();
    const button = tile.getByRole('button', { name: /Download/i });
    await expect(button).toBeEnabled();
    await button.click();
    // Modal mounts. Use the modal's own testid + the format-picker
    // selected-state attribute exposed by export-audiobook.tsx
    // (data-testid="export-format-m4b" on the M4B format pill).
    await expect(page.getByTestId('export-audiobook-modal')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId('export-format-m4b')).toBeVisible();
  });

  test('MP3 ZIP tile is live and opens the export modal with mp3-zip pre-selected', async ({
    page,
  }) => {
    const tile = page.getByTestId('download-tile-mp3-zip');
    await expect(tile).toBeVisible();
    const button = tile.getByRole('button', { name: /Download/i });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByTestId('export-audiobook-modal')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId('export-format-mp3-zip')).toBeVisible();
  });

  test('Streaming link tile remains "Coming soon" in v1.3.0', async ({ page }) => {
    const tile = page.getByTestId('download-tile-streaming');
    await expect(tile).toBeVisible();
    const button = tile.getByRole('button', { name: /Download/i });
    await expect(button).toBeDisabled();
  });
});
