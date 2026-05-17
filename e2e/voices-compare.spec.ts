import { test, expect } from '@playwright/test';

/**
 * Voice library compare entry point — plan 22a.
 *
 * Asserts the browser-level seam that Vitest+jsdom can lie about: the
 * per-book Voices tab renders multi-select checkboxes on `VoiceCard`s,
 * clicking two checkboxes surfaces the floating "Selected · N" pill with
 * the same-/different-base-voice badge, and the Compare button gates on
 * 2-selected within-book + cast hydration.
 *
 * Scope note: under mocks, `getBookState` throws (Must #3 on the backlog),
 * so the cast slice stays empty when navigating to `/books/sb/library`.
 * The Compare button therefore stays disabled even at exactly 2 selections
 * — the gating logic surfaces the "Selected voice is no longer linked to
 * a character" tooltip. That's the correct behaviour under the current
 * mock state; the dialog-open assertion will become reachable once Must #3
 * lands and the mock seeds the cast slice. Until then this spec covers
 * the selection + pill + badge + tooltip path.
 */

test.describe('voice library compare entry point', () => {
  test('per-book Voices tab surfaces checkboxes + selection pill + badge', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });

    /* Solway Bay is the mock 'complete' book; its bookId is `sb`. */
    await page.goto('/#/books/sb/library');

    /* The voice cards render — Narrator and The Lighthouse Keeper are both
       in `sb` per src/mocks/voices.ts. The card text is the character name. */
    await expect(page.getByText('Narrator', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('The Lighthouse Keeper').first()).toBeVisible();

    /* No pill yet at 0 selections. */
    await expect(page.getByText(/^Selected$/)).toHaveCount(0);

    /* Click the checkbox on two cards. The accessible name is
       "Select voice for compare" when unselected; "Deselect voice" once
       selected. Scope to the card containing each character name so we
       click the right one. */
    const narratorCard = page.locator('div.group', { hasText: 'Narrator' }).first();
    await narratorCard.getByLabel('Select voice for compare').click();

    const keeperCard = page.locator('div.group', { hasText: 'The Lighthouse Keeper' }).first();
    await keeperCard.getByLabel('Select voice for compare').click();

    /* Pill renders with count 2 and a badge. Narrator (Sulafat) + Keeper
       (Algieba) are different families in the mock catalog, so the amber
       "different base voices" badge appears. The badge text is the
       load-bearing assertion — proves the (provider, name) comparison ran. */
    await expect(page.getByText('Selected', { exact: true })).toBeVisible();
    await expect(page.getByText('different base voices')).toBeVisible();

    /* Compare button exists but stays disabled under mocks (cast slice
       isn't hydrated because mockGetBookState throws). The tooltip surfaces
       the reason. */
    const compareBtn = page.getByRole('button', { name: 'Compare', exact: true });
    await expect(compareBtn).toBeVisible();
    await expect(compareBtn).toBeDisabled();

    /* Clear resets the pill. */
    await page.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(page.getByText(/^Selected$/)).toHaveCount(0);
  });

  test('global #/voices tab disables Compare with the documented tooltip', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });

    await page.goto('/#/voices');
    /* Voice cards from across the workspace render under the global tab. */
    await expect(page.getByText('Captain Halloran').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Eliza Gray').first()).toBeVisible();

    const hallCard = page.locator('div.group', { hasText: 'Captain Halloran' }).first();
    await hallCard.getByLabel('Select voice for compare').click();
    const elizaCard = page.locator('div.group', { hasText: 'Eliza Gray' }).first();
    await elizaCard.getByLabel('Select voice for compare').click();

    /* Pill renders, Compare disabled with the "Open a book" tooltip. */
    await expect(page.getByText('Selected', { exact: true })).toBeVisible();
    const compareBtn = page.getByRole('button', { name: 'Compare', exact: true });
    await expect(compareBtn).toBeDisabled();
    await expect(compareBtn).toHaveAttribute('title', 'Open a book to compare its voices');
  });
});
