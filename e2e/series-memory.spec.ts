/* Golden-path e2e for the series-memory feature (fe-40).
 *
 * Exercises: library → series-memory chip → reveal dialog →
 * "Share this cast" → share card.
 *
 * Mock mode (port 5174) — the "Northern Coast Trilogy" series in
 * MOCK_LIBRARY carries a `seriesMemory` summary, and
 * MOCK_SERIES_MEMORY["Marin Vale::Northern Coast Trilogy"] supplies the
 * detail payload that the reveal dialog fetches via api.getSeriesMemory.
 */

import { test, expect } from '@playwright/test';

test.describe('series-memory: chip → reveal → share card', () => {
  test('library shows chip, chip opens reveal, reveal shows headline, share card contains castwright.ai', async ({
    page,
  }) => {
    await page.goto('/');

    /* Wait for the library to hydrate — "Start a new book" CTA is the
       standard hydration signal (matches waitForLibraryViewReady). */
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    /* The series-memory chip renders in the Northern Coast Trilogy series
       row. Playwright auto-scrolls to visible elements, so no manual
       scrollIntoView is needed — but give the chip a 10 s budget to
       account for cold-load contention. */
    const chip = page.getByTestId('series-memory-chip').first();
    await expect(chip).toBeVisible({ timeout: 10_000 });

    /* Chip copy: "Your cast · N voices, N books" */
    await expect(chip).toContainText('Your cast ·');

    /* Click the chip — opens the series-memory reveal dialog. */
    await chip.click();

    /* The reveal renders as a role="dialog". */
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    /* Headline: "{spell(bookCount)} books in, and not a voice has changed."
       bookCount = 3 → "Three books in, and not a voice has changed." */
    await expect(dialog.getByText(/not a voice has changed/i)).toBeVisible({ timeout: 5_000 });

    /* "Share this cast" button is inside the reveal. */
    await dialog.getByText('Share this cast').click();

    /* Share card appears (series-share-card.tsx). */
    const shareCard = page.getByTestId('series-share-card');
    await expect(shareCard).toBeVisible({ timeout: 5_000 });

    /* Footer of the share card carries the branding. */
    await expect(shareCard.getByText('castwright.ai')).toBeVisible();
  });

  test('share card exports a PNG download', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('series-memory-chip').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByText('Share this cast').click();
    await expect(page.getByTestId('series-share-card')).toBeVisible({ timeout: 5_000 });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /download image \(\.png\)/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
  });
});
