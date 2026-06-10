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

  test('Castwright Companion banner sits above the grid, which no longer lists Plex', async ({
    page,
  }) => {
    const banner = page.getByTestId('companion-app-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('heading', { name: /Castwright Companion/i })).toBeVisible();
    // Mocked store buttons render but stay disabled while unpublished.
    await expect(page.getByTestId('companion-store-google-play')).toBeDisabled();
    await expect(page.getByTestId('companion-store-app-store')).toBeDisabled();
    // Plex was retired in favour of the first-party companion app.
    await expect(page.getByTestId('listener-app-plex')).toHaveCount(0);
    await expect(page.getByTestId('listener-app-apple_books')).toBeVisible();
  });

  test('Pair a device opens a scannable pairing QR with manual-entry fallback', async ({ page }) => {
    const pair = page.getByTestId('companion-pair-device');
    await expect(pair).toBeVisible();
    await pair.click();

    const modal = page.getByTestId('pair-device-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // The QR renders as a data: image from the mocked pairing session payload.
    const qr = page.getByTestId('pair-qr-image');
    await expect(qr).toBeVisible();
    await expect(qr).toHaveAttribute('src', /^data:image\/png/);

    // Manual-entry fallback (collapsed <details>) carries the compact CWP1
    // values: host:port, the pairing code, and the fingerprint tag.
    await modal.getByText(/enter these manually/i).click();
    await expect(modal.getByText('192.168.1.42:8443')).toBeVisible();
    await expect(modal.getByText('K7QF3M2P')).toBeVisible();
  });
});
