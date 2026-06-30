/* analysis-pill Task 10 — Spec B
 *
 * Verifies that the status-pill in the top bar shows "Analysing · N%" while
 * the script-review sub-stage is in flight, persists across view navigation,
 * and that the ScriptReviewDiff modal appears after the mock completes.
 *
 * mockReviewScript now emits three phase ticks (0.25 / 0.5 / 0.85) with
 * fixed 500 ms gaps before the existing onOps calls (~1.46 s total), giving
 * the test time to navigate to the Cast view and back.
 *
 * Uses the Solway Bay (sb) fixture book — the sb manuscript seeds initialSentences
 * including chapterId:3 ops which the whole-book review exercised here. */

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.describe('script-review pill progress (analysis-pill Task 10)', () => {
  test('status-pill shows Analysing while review runs, persists on cast, diff modal on return', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');

    /* Wait for the manuscript view to hydrate. */
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const pill = page.getByTestId('status-pill');

    /* Open the whole-book review via the dropdown. */
    const menuToggle = page.getByTestId('review-script-menu-toggle');
    await expect(menuToggle).toBeVisible({ timeout: 5_000 });
    await expect(menuToggle).toBeEnabled();
    await menuToggle.click();

    const wholeBook = page.getByTestId('review-script-wholebook');
    await expect(wholeBook).toBeVisible({ timeout: 3_000 });
    await wholeBook.click();

    /* scriptReviewActions.setActive is dispatched before the first mock await,
       so the pill shows "Analysing" immediately. */
    await expect(pill).toContainText('Analysing', { timeout: 5_000 });

    /* Navigate to the Cast view while the review stream is running
       (mock takes ~1.46 s — navigation should land well inside the window). */
    await page.goto('/#/books/sb/cast');
    await expect(page).toHaveURL(/#\/books\/sb\/cast/, { timeout: 5_000 });

    /* Pill persists across the navigation (top bar is always mounted). */
    await expect(pill).toContainText('Analysing', { timeout: 3_000 });

    /* Navigate back to manuscript. */
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* runReviewScript dispatches scriptReviewActions.setReview when the mock
       resolves — this populates scriptReview.byBook['sb'] and renders the
       ScriptReviewDiff modal (hasActiveReview = true). Allow up to 6 s for
       the mock to finish and the modal to render. */
    await expect(
      page.getByRole('heading', { name: /Script review suggestions/i }),
    ).toBeVisible({ timeout: 6_000 });

    /* Pill returns to idle once scriptReviewActions.clear fires in finally. */
    await expect(pill).not.toContainText('Analysing', { timeout: 3_000 });
  });
});
