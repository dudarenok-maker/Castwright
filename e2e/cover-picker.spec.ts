/* Multi-source cover search — source-badge smoke (2026-06-10).

   Guards the multi-source cover picker UI against router/redux/layout
   regressions. The Search tab aggregates covers from OpenLibrary +
   Apple Books + Google Books, interleaved, each tagged with a small
   source badge. Under VITE_USE_MOCKS=true (the e2e harness mode)
   api.findCoverCandidates returns MOCK_COVER_CANDIDATES — a mix of
   source: 'openlibrary' | 'apple' | 'google'. This spec opens the
   picker via the real library card "..." → "Find cover image" control
   and asserts the grid renders with at least two DIFFERENT source
   badges, locking the badged-grid contract at the browser level. */

import { test, expect } from '@playwright/test';

/* File-level serial mode — mirrors cover-framing.spec.ts: the
   CoverPicker flow flaked under parallel-worker contention on Windows
   (modal open + async candidate fetch race other workers' asset
   traffic). */
test.describe.configure({ mode: 'serial' });

test.describe('multi-source cover picker (2026-06-10)', () => {
  test('search grid shows badges from at least two different sources', async ({ page }) => {
    /* Library landing — a BookCard is guaranteed under mocks. */
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    /* Open the per-card "..." menu, then "Find cover image" → CoverPicker. */
    await page.getByRole('button', { name: /Book options/i }).first().click();
    await page.getByRole('button', { name: /Find cover image/i }).click();
    await expect(page.getByTestId('cover-picker')).toBeVisible({ timeout: 5_000 });

    /* Search is the default tab on a fresh fixture. The grid renders
       once the (mock) candidates resolve. */
    const grid = page.getByTestId('cover-grid');
    await expect(grid).toBeVisible({ timeout: 5_000 });

    /* Assert at least two DIFFERENT source labels are present. The mock
       data spans openlibrary + apple + google; we read the rendered
       badge text and require ≥2 distinct labels rather than pinning to
       specific candidate ids. */
    const badges = grid.locator('[data-testid^="cover-source-"]');
    await expect(badges.first()).toBeVisible();
    const labels = await badges.allInnerTexts();
    const distinct = new Set(labels.map((t) => t.trim().toLowerCase()));
    expect(distinct.size).toBeGreaterThanOrEqual(2);

    /* Spot-check the two headline sources are both on screen. */
    await expect(grid.getByText('OpenLibrary', { exact: true }).first()).toBeVisible();
    await expect(grid.getByText('Apple', { exact: true }).first()).toBeVisible();
  });
});
