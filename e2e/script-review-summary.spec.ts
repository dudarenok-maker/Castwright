/* fs-58 — browser-level proof of the whole-book script-review SUMMARY:
 *
 *  1. Open the Solway Bay fixture book to the manuscript view.
 *  2. Run a per-chapter "Review Script" — the mock emits ops across TWO
 *     chapters (ch3 + ch1), so the modal opens as a collapsed per-chapter
 *     summary rather than a flat wall of cards.
 *  3. Assert it opens collapsed: chapter rows are visible, op cards are not.
 *  4. Chapter-level "Approve" ticks that chapter's mechanical ops; Apply lands
 *     them and the modal closes.
 *
 * This is the golden path for the summary redesign — the flat op-class body is
 * gone, replaced by chapter → type → op accordion with group-approve. The mock
 * review bucket already spans two chapters (see mockReviewScript / the sibling
 * script-review.spec.ts contract), so no new fixture is needed. */

import { test, expect } from '@playwright/test';

/* Serial: the mock review state is shared in-memory on the Vite dev server;
   run sequentially so parallel workers can't collide on it. */
test.describe.configure({ mode: 'serial' });

test.describe('fs-58 — script-review whole-book summary', () => {
  test('opens collapsed → expand → chapter-approve → apply closes the modal', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');

    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* Run the per-chapter review — the mock returns ops across ch3 + ch1. */
    const reviewBtn = page.getByTestId('review-script-chapter');
    await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewBtn).toBeEnabled();
    await reviewBtn.click();

    await expect(page.getByRole('heading', { name: /Script review suggestions/i })).toBeVisible({
      timeout: 10_000,
    });

    /* Collapsed by default: chapter rows visible, op cards NOT rendered. */
    await expect(page.getByTestId('chapter-row-3')).toBeVisible();
    await expect(page.getByTestId('chapter-row-1')).toBeVisible();
    await expect(page.getByTestId('op-toggle-3:1:strip_tag')).toHaveCount(0);

    /* Expanding a chapter reveals its type rows; a mechanical type carries a
       bulk "Approve" control (chapter-approve), an expand-only type does not. */
    await page.getByTestId('chapter-row-3').click();
    await expect(page.getByTestId('type-row-3-strip_tag')).toBeVisible();
    await expect(page.getByTestId('chapter-approve-3')).toBeVisible();

    /* Apply the default mechanical selection (both chapters' strip_tags). */
    const applyBtn = page.getByTestId('apply-button');
    await expect(applyBtn).toContainText(/Apply 2 selected/i);
    await applyBtn.click();

    /* The modal closes after Apply. */
    await expect(
      page.getByRole('heading', { name: /Script review suggestions/i }),
    ).toBeHidden({ timeout: 5_000 });
  });
});
