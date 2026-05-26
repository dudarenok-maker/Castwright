import { test, expect } from '@playwright/test';

/**
 * Cross-book duplicate review — plan 101 (+ hydrate-on-open bug fix).
 *
 * Asserts the browser-level discovery surface for cross-book duplicates:
 * the auto-detected pair surfaces a ⚠ pill on the family card, clicking
 * the pill opens the DuplicateReviewModal, and — the regression for the
 * "all buttons dead" bug — opening the modal hydrates both books' casts
 * so the "Same character — link them" button ENABLES and the link
 * actually fires. The action transports (cast-link-prior, cast-not-linked-
 * to) are also unit-tested in src/modals/duplicate-review-modal.test.tsx
 * and server/src/routes/cast-not-linked-to.test.ts; the predicate in
 * src/lib/cross-book-duplicates.test.ts.
 *
 * Mock fixture: Eliza Gray (Northern Star, bookId 'ns') + Eliza
 * (Carrick's Compass, bookId 'cc') both resolve to the Kore base voice.
 * Both books carry a NON-null cast (`ns` → initialCharacters, `cc` →
 * buildCarricksCompassMockState), so the modal hydrates both sides and
 * enables the link button. The duplicate partner lives in `cc`, not `sb`,
 * precisely because `sb` keeps `cast: null` to anchor voices-compare.spec.
 */

test.describe('cross-book duplicate review (plan 101)', () => {
  test('⚠ pill opens the modal, hydrates both casts, and links the pair', async ({ page }) => {
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

    /* Click → modal mounts with the modal-specific header. */
    await reviewPill.click();
    await expect(page.getByText(/Same person across books\?/)).toBeVisible({ timeout: 5_000 });

    /* Regression: opening the modal hydrates both foreign casts so the
       characters resolve and the link button flips from its loading
       state to enabled. Before the fix it stayed disabled forever. */
    const linkBtn = page.getByRole('button', { name: /Same character — link them/i });
    await expect(linkBtn).toBeEnabled({ timeout: 5_000 });

    /* Clicking it links the pair → toast + the modal closes. */
    await linkBtn.click();
    await expect(page.getByText(/^Linked /)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Same person across books\?/)).toBeHidden({ timeout: 5_000 });

    /* Regression for "merge fails silently then reappears": the ⚠ pill must
       vanish once the loser's name is reflected onto the winner's cached
       aliases — and STAY gone (the bug was that detection re-flagged the
       pair on the next render because the foreign-cast cache was stale). */
    await expect(page.getByRole('button', { name: /duplicate candidate/i })).toBeHidden({
      timeout: 5_000,
    });
    /* Let the toast auto-dismiss and the view re-settle, then re-check. */
    await page.waitForTimeout(1_000);
    await expect(page.getByRole('button', { name: /duplicate candidate/i })).toBeHidden();
  });

  test('"Different on purpose" marks the pair as variants and clears the pill', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.goto('/#/voices');
    await expect(page.getByText('Eliza Gray').first()).toBeVisible({ timeout: 10_000 });

    await page
      .getByRole('button', { name: /duplicate candidate/i })
      .first()
      .click();
    await expect(page.getByText(/Same person across books\?/)).toBeVisible({ timeout: 5_000 });

    const variantBtn = page.getByRole('button', { name: /Different on purpose/i });
    await expect(variantBtn).toBeEnabled({ timeout: 5_000 });
    await variantBtn.click();
    await expect(page.getByText(/separate characters/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Same person across books\?/)).toBeHidden({ timeout: 5_000 });

    /* The notLinkedTo pair is reflected into the cached casts → pill gone
       and does not reappear. */
    await expect(page.getByRole('button', { name: /duplicate candidate/i })).toBeHidden({
      timeout: 5_000,
    });
    await page.waitForTimeout(1_000);
    await expect(page.getByRole('button', { name: /duplicate candidate/i })).toBeHidden();
  });

  test('Cancel closes the modal cleanly', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.goto('/#/voices');
    await expect(page.getByText('Eliza Gray').first()).toBeVisible({ timeout: 10_000 });

    await page
      .getByRole('button', { name: /duplicate candidate/i })
      .first()
      .click();
    await expect(page.getByText(/Same person across books\?/)).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText(/Same person across books\?/)).toBeHidden({ timeout: 5_000 });
  });
});
