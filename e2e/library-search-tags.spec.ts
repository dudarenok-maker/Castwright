import { test, expect } from '@playwright/test';

/**
 * Browser-level coverage for plan 73 — library search input + per-book
 * tag-chip filter row.
 *
 * Mock mode pre-seeds the library with four books and these tags:
 *   - sb (Solway Bay)         → ['favourite', 'series-1']
 *   - ns (The Northern Star)  → ['series-1']
 *   - cc (Carrick's Compass)  → []
 *   - ts (Twilight Stations)  → ['favourite']
 *
 * Pairs with docs/features/archive/73-library-search-tags.md.
 *
 * Each card carries `data-testid="book-meta-strip-<bookId>"` (plan 9
 * always-visible metadata strip), which we use as the per-card visibility
 * probe rather than text search — the title appears in two DOM nodes per
 * card (cover overlay + metadata strip) so a bare `getByText` is
 * non-unique. */
test.describe('library search + tag filter (plan 73)', () => {
  test('search input filters books by title substring', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('book-meta-strip-sb')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('book-meta-strip-ns')).toBeVisible();
    await expect(page.getByTestId('book-meta-strip-cc')).toBeVisible();

    /* Type a query that matches only "The Northern Star". */
    await page.getByTestId('library-search-input').fill('north');

    /* The debounce is 150ms — the filtered grid should settle quickly. */
    await expect(page.getByTestId('book-meta-strip-ns')).toBeVisible({ timeout: 2000 });
    await expect(page.getByTestId('book-meta-strip-sb')).not.toBeVisible();
    await expect(page.getByTestId('book-meta-strip-cc')).not.toBeVisible();
  });

  test('typing a non-matching query renders the no-results pane', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('library-search-input')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('library-search-input').fill('zzzzzz-no-match');
    await expect(page.getByTestId('library-no-results')).toBeVisible({ timeout: 2000 });

    /* Clear-filters button surfaces and restores the full library. */
    await page
      .getByTestId('library-no-results')
      .getByRole('button', { name: /Clear filters/i })
      .click();
    await expect(page.getByTestId('book-meta-strip-sb')).toBeVisible();
  });

  test('clicking a tag chip narrows the library to books carrying that tag', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('library-tag-chip-row')).toBeVisible({ timeout: 10_000 });

    /* Mock seed: `series-1` is on Solway Bay + Northern Star only. */
    await page.getByTestId('tag-filter-chip-series-1').click();

    await expect(page.getByTestId('book-meta-strip-sb')).toBeVisible();
    await expect(page.getByTestId('book-meta-strip-ns')).toBeVisible();
    await expect(page.getByTestId('book-meta-strip-cc')).not.toBeVisible();
    await expect(page.getByTestId('book-meta-strip-ts')).not.toBeVisible();
  });

  test('multi-select chips intersect (book must carry every active tag)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('library-tag-chip-row')).toBeVisible({ timeout: 10_000 });

    /* favourite + series-1 → only Solway Bay carries BOTH tags. */
    await page.getByTestId('tag-filter-chip-favourite').click();
    await page.getByTestId('tag-filter-chip-series-1').click();

    await expect(page.getByTestId('book-meta-strip-sb')).toBeVisible();
    await expect(page.getByTestId('book-meta-strip-ns')).not.toBeVisible();
    await expect(page.getByTestId('book-meta-strip-ts')).not.toBeVisible();
  });

  test('clear-filters affordance resets search + active chips', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('library-tag-chip-row')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('library-search-input').fill('bay');
    await page.getByTestId('tag-filter-chip-favourite').click();

    /* Top-of-chrome clear-filters chip appears once anything is active. */
    await page.getByTestId('library-clear-filters').click();

    /* Every book is back. */
    await expect(page.getByTestId('book-meta-strip-sb')).toBeVisible();
    await expect(page.getByTestId('book-meta-strip-cc')).toBeVisible();
    await expect(page.getByTestId('book-meta-strip-ts')).toBeVisible();
    /* Search input is cleared. */
    await expect(page.getByTestId('library-search-input')).toHaveValue('');
  });
});
