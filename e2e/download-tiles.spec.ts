import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

/**
 * Plan 57 + plan 67 — Listen-view download tiles e2e.
 *
 * Three "Or download a file" tiles on the listen view:
 *  - Full audiobook (m4b chaptered) — LIVE (plan 57)
 *  - MP3 ZIP — LIVE (plan 57)
 *  - Streaming link — LIVE (plan 67)
 *
 * The M4B + MP3 ZIP tiles open the ExportAudiobookModal pre-set to the
 * right format + destination via the `prefill` prop. The Streaming link
 * tile mints a slugged share URL (POST /api/books/:bookId/share) and
 * opens the ShareLinkModal with a copyable URL.
 *
 * Pairs with docs/features/archive/57-download-tiles.md (M4B + MP3 ZIP)
 * and docs/features/archive/68-streaming-link-tile.md (Streaming link).
 */
test.describe.configure({ mode: 'serial' });

test.describe('plan 57 — download tiles', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await waitForRouteReady(page);
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
    await expect(page.getByTestId('export-audiobook-modal')).toBeVisible({ timeout: 10_000 });
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
    await expect(page.getByTestId('export-audiobook-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('export-format-mp3-zip')).toBeVisible();
  });

  test('Streaming link tile mints a share URL and opens a copyable modal (plan 67)', async ({
    page,
  }) => {
    const tile = page.getByTestId('download-tile-streaming');
    await expect(tile).toBeVisible();
    const button = tile.getByRole('button', { name: /Download/i });
    await expect(button).toBeEnabled();
    await button.click();

    // Share-link modal mounts with the slugged URL in a copyable input.
    await expect(page.getByTestId('share-link-modal')).toBeVisible({ timeout: 10_000 });
    const urlInput = page.getByTestId('share-link-url');
    // Mock createBookShareLink resolves to `${origin}/share/<12-char slug>`.
    await expect(urlInput).toHaveValue(/\/share\/[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/, {
      timeout: 10_000,
    });
    const copyButton = page.getByTestId('share-link-copy');
    await expect(copyButton).toBeEnabled();
  });
});
