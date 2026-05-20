/* Library card↔table view toggle — browser-level coverage for plan 76.
 *
 * Asserts the round-trip the Vitest+jsdom suite can't reliably model:
 * localStorage actually persists across a `page.reload()` and the
 * view-mode pill seeds from it on the next mount. Also locks the
 * table-row click → listen-route transition since the table reuses
 * the same `onOpenBook` callback as the grid. */

import { test, expect } from '@playwright/test';

/* Plan 58 — file-level serial mode. localStorage round-trips across a
   page.reload() within one spec; running parallel workers against the
   same key would race on the seed. */
test.describe.configure({ mode: 'serial' });

test.describe('library card↔table toggle', () => {
  test('defaults to cards, toggles to table, opens a book, persists across reload', async ({
    page,
  }) => {
    await page.goto('/');
    /* Wipe any leftover persisted view-mode from a sibling spec on the
       same storage state — runs INSIDE the page so it's a one-shot
       clear, not the per-navigation reset that `addInitScript` would
       impose (which would also wipe the value we're about to write
       BEFORE the reload). */
    await page.evaluate(() => {
      try {
        window.localStorage.removeItem('library.viewMode');
      } catch {
        /* swallow */
      }
    });
    await page.reload();

    /* Library skeleton resolves into the populated layout — wait for
       the toggle to materialise. */
    const toggle = page.getByTestId('library-view-mode-toggle');
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    /* Default is Cards — table row testids absent. */
    await expect(page.getByTestId('library-view-mode-card')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('library-table-row-sb')).not.toBeVisible();

    /* Toggle into Table. */
    await page.getByTestId('library-view-mode-table').click();
    await expect(page.getByTestId('library-view-mode-table')).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    /* Mock library seeds 'sb' (Solway Bay) — its row + series header
       should be visible. */
    await expect(page.getByTestId('library-table-row-sb')).toBeVisible();
    /* Series header text. */
    await expect(page.getByText(/Northern Coast Trilogy/i).first()).toBeVisible();

    /* Click the row → routes to that book's listen view (the same
       onOpenBook handler the cards use). */
    await page.getByTestId('library-table-row-sb').click();
    await expect(page).toHaveURL(/#\/books\/sb\/listen/, { timeout: 5_000 });

    /* Reload, navigate back to library — view-mode should still be
       'table'. */
    await page.goto('/');
    await expect(page.getByTestId('library-view-mode-toggle')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('library-view-mode-table')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('library-table-row-sb')).toBeVisible();

    /* Toggle back to Cards. The card view's "Start a new book" CTA
       reappears in the chrome (it's always visible across both
       modes, so anchor on the BookCard cover testid instead). */
    await page.getByTestId('library-view-mode-card').click();
    await expect(page.getByTestId('library-view-mode-card')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('library-table-row-sb')).not.toBeVisible();
  });
});
