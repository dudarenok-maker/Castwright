import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

/**
 * fs-52 — Captions tile e2e. Mirrors e2e/download-tiles.spec.ts's pattern
 * for the M4B/MP3 ZIP tiles: open the tile, confirm the modal opens
 * pre-set to format='captions', pick a granularity/scope/file-format,
 * submit, and confirm the mock export job reaches 'done' with a download
 * link. Word-mode ASR is mocked (mockCreateBookExport) — no real Whisper
 * model needed to exercise the UI flow.
 *
 * Pairs with docs/features/2026-07-10-fs52-caption-srt-export.md.
 */
test.describe.configure({ mode: 'serial' });

test.describe('fs-52 — captions export tile', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await waitForRouteReady(page);
  });

  test('Captions tile opens the export modal with captions pre-selected', async ({ page }) => {
    const tile = page.getByTestId('download-tile-captions');
    await expect(tile).toBeVisible();
    const button = tile.getByRole('button', { name: /Download/i });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(page.getByTestId('export-audiobook-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('export-format-captions')).toBeVisible();
    await expect(page.getByTestId('captions-options')).toBeVisible();
  });

  test('picking word/vtt/per-chapter and submitting reaches a done job with a download link', async ({
    page,
  }) => {
    await page.getByTestId('download-tile-captions').getByRole('button', { name: /Download/i }).click();
    await expect(page.getByTestId('export-audiobook-modal')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('captions-file-format-vtt').click();
    await page.getByTestId('captions-granularity-word').click();
    await page.getByTestId('captions-scope-per-chapter').click();
    await page.getByTestId('export-submit').click();

    await expect(page.getByTestId('export-active-job')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('export-active-job')).toContainText(/Done/, { timeout: 10_000 });
  });
});
