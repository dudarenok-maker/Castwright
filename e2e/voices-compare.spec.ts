import { test, expect } from '@playwright/test';

/**
 * Voice library compare entry point — plan 22a + plan 60.
 *
 * Asserts the browser-level seam that Vitest+jsdom can lie about: the
 * per-book Voices tab renders multi-select checkboxes on `VoiceCard`s,
 * clicking two checkboxes surfaces the floating "Selected · N" pill with
 * the same-/different-base-voice badge, and the Compare button gates on
 * 2-selected within-book + cast hydration.
 *
 * Per-book tab scope note: under mocks, `sb`'s mock state explicitly
 * keeps `cast: null` so the per-book Compare button stays disabled with
 * the "Selected voice is no longer linked to a character" tooltip.
 *
 * Global tab (plan 60): when both selected voices share a non-null
 * `bookId`, the view fetches that book's cast via `api.getBookState`
 * on demand and mounts `CompareCastModal` with the resolved
 * characters. Cross-book pairs remain disabled (BACKLOG #17).
 */

test.describe('voice library compare entry point', () => {
  test('per-book Voices tab surfaces checkboxes + selection pill + badge', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    /* Solway Bay is the mock 'complete' book; its bookId is `sb`. */
    await page.goto('/#/books/sb/library');

    /* The voice cards render — Narrator and The Lighthouse Keeper are both
       in `sb` per src/mocks/voices.ts. The card text is the character name. */
    await expect(page.getByText('Narrator', { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
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

  test('global #/voices tab fetches foreign cast and opens Compare modal (plan 60)', async ({
    page,
  }) => {
    await page.goto('/');
    /* Two buttons match: the top-bar CTA and the empty-state dropzone card. .first() picks the deterministic one. */
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.goto('/#/voices');
    /* Voice cards from across the workspace render under the global tab. */
    await expect(page.getByText('Captain Halloran').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Eliza Gray').first()).toBeVisible();

    const hallCard = page.locator('div.group', { hasText: 'Captain Halloran' }).first();
    await hallCard.getByLabel('Select voice for compare').click();
    const elizaCard = page.locator('div.group', { hasText: 'Eliza Gray' }).first();
    await elizaCard.getByLabel('Select voice for compare').click();

    /* Pill renders with the amber "different base voices" badge (Halloran
       resolves to Charon, Eliza to Kore) — both still belong to bookId
       'ns', so the Compare button is enabled (plan 60 same-book global
       compare). */
    await expect(page.getByText('Selected', { exact: true })).toBeVisible();
    await expect(page.getByText('different base voices')).toBeVisible();
    const compareBtn = page.getByRole('button', { name: 'Compare', exact: true });
    await expect(compareBtn).toBeEnabled();

    /* Click Compare → on-demand `api.getBookState('ns')` resolves the
       Northern Star cast → `CompareCastModal` mounts with both
       characters as A/B sides. */
    await compareBtn.click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
  });

  test('global #/voices tab still disables Compare on cross-book pairs (plan 60)', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.goto('/#/voices');
    await expect(page.getByText('Captain Halloran').first()).toBeVisible({ timeout: 10_000 });
    /* Narrator lives in book `sb`; Halloran lives in book `ns`. The
       cross-book guard fires for this pair — BACKLOG #17 owns lifting
       it. */
    await expect(page.getByText('Narrator').first()).toBeVisible();

    const hallCard = page.locator('div.group', { hasText: 'Captain Halloran' }).first();
    await hallCard.getByLabel('Select voice for compare').click();
    const narratorCard = page.locator('div.group', { hasText: 'Narrator' }).first();
    await narratorCard.getByLabel('Select voice for compare').click();

    await expect(page.getByText('Selected', { exact: true })).toBeVisible();
    const compareBtn = page.getByRole('button', { name: 'Compare', exact: true });
    await expect(compareBtn).toBeDisabled();
    await expect(compareBtn).toHaveAttribute('title', 'Cross-book compare not supported yet');
  });
});
