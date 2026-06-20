import { test, expect } from '@playwright/test';
import { goToConfirm, waitForConfirmViewReady, waitForRouteReady } from './helpers';

/**
 * Tier-2b diminutive merge-suggestion cards in the cast-review view.
 *
 * The mock API (src/lib/api.ts) seeds two suggestions:
 *   - "eliza" + "halloran" (Eliza Gray / Captain Halloran)
 *   - "marcus" + "halloran" (Marcus the Cook / Captain Halloran)
 * Both pairs exist in the mock cast roster so display names resolve.
 *
 * Within one test we exercise both Merge (removes one card) and Dismiss
 * (removes the other), so both button paths are covered without depending
 * on module-level state ordering between tests.
 *
 * Why browser-level: the card fetch is a useEffect keyed to bookId (crosses
 * router + redux stage), the accept/dismiss calls mutate module-level state,
 * and the card list drives conditional rendering — exactly the seam
 * Vitest+jsdom can misread (async effect timing, real DOM removal).
 */

test.describe('cast view → diminutive merge-suggestion cards', () => {
  test('shows suggestion cards; Merge and Dismiss each remove a card', async ({ page }) => {
    await goToConfirm(page);
    await waitForConfirmViewReady(page);

    /* Confirm the cast → navigate to the cast view. */
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/(manuscript|cast|generate|listen)$/, {
      timeout: 10_000,
    });
    const bookId = page.url().match(/#\/books\/([^/]+)\//)?.[1];
    expect(bookId).toBeTruthy();

    await page.goto(`/#/books/${bookId}/cast`);
    await waitForRouteReady(page);

    /* Wait for the cast roster to hydrate — the narrator row is always
       present in the mock cast and proves the CastView is mounted + the
       characters slice has populated. */
    await expect(page.getByTestId('cast-row-narrator')).toBeVisible({
      timeout: 10_000,
    });

    /* Both seeded suggestion cards should appear after listMergeSuggestions
       resolves (~40 ms mock delay). */
    const cards = page.getByTestId('merge-suggestion-card');
    await expect(cards.first()).toBeVisible({ timeout: 5_000 });

    /* The first card must show recognisable character names. */
    const firstCard = cards.first();
    await expect(firstCard).toContainText(/Eliza Gray|Marcus the Cook/);

    /* Record current count before acting. */
    const totalBefore = await cards.count();
    expect(totalBefore).toBeGreaterThanOrEqual(1);

    /* ── Merge: click the Merge button on the first card ── */
    await firstCard.getByTestId('merge-suggestion-merge').click();
    /* Card is removed from local state — count drops by one. */
    await expect(cards).toHaveCount(totalBefore - 1, { timeout: 5_000 });

    /* ── Dismiss: click the Dismiss button on the remaining card (if any) ── */
    if (totalBefore > 1) {
      const remaining = cards.first();
      await expect(remaining).toBeVisible({ timeout: 5_000 });
      await remaining.getByTestId('merge-suggestion-dismiss').click();
      await expect(cards).toHaveCount(totalBefore - 2, { timeout: 5_000 });
    }
  });
});
