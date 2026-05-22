import { test, expect } from '@playwright/test';

/**
 * Cross-book duplicate review — plan 101.
 *
 * Asserts the browser-level discovery surface for cross-book duplicates:
 * the auto-detected pair surfaces a ⚠ pill on the family card, and
 * clicking the pill opens the DuplicateReviewModal with both sides
 * rendered. The action transports (cast-link-prior, cast-not-linked-to)
 * are unit-tested in src/modals/duplicate-review-modal.test.tsx and
 * server/src/routes/cast-not-linked-to.test.ts; the predicate is unit-
 * tested in src/lib/cross-book-duplicates.test.ts.
 *
 * Mock fixture: Eliza Gray (Northern Star, bookId 'ns') + Eliza (Solway
 * Bay, bookId 'sb') both resolve to the Kore base voice. The frontend
 * detector flags them because 'eliza' is a strict substring of
 * 'elizagray' under the series-prior-dedup normalisation rule.
 */

test.describe('cross-book duplicate review (plan 101)', () => {
  test('⚠ pill on the Kore family opens the review modal with both sides', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.goto('/#/voices');

    /* The Kore family card carries the Eliza Gray + Eliza cross-book pair. */
    await expect(page.getByText('Eliza Gray').first()).toBeVisible({ timeout: 10_000 });

    /* The ⚠ pill renders in the family header. Text shape:
       "⚠ 1 duplicate candidate". */
    const reviewPill = page.getByRole('button', { name: /duplicate candidate/i }).first();
    await expect(reviewPill).toBeVisible();
    await expect(reviewPill).toContainText('⚠');

    /* Click → modal mounts with the modal-specific header. The mock
       fixture's `sb` cast is intentionally null (anchored by
       voices-compare.spec.ts), so the Link button is rendered but
       disabled (`canLink` requires both Characters resolved). We assert
       the modal opens; the action wiring is unit-tested separately. */
    await reviewPill.click();
    await expect(page.getByText(/Same person across books\?/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('button', { name: /Same character — link them/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Different on purpose/i })).toBeVisible();
    /* Cancel closes cleanly. */
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText(/Same person across books\?/)).toBeHidden({ timeout: 5_000 });
  });
});
