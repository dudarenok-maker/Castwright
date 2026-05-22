/* Browser-level golden path for the in-book merge flow via the
 * Profile Drawer's searchable picker.
 *
 * Companion spec to manual-continuity-link.spec.ts (which covers the
 * cross-book prior-roster path). This spec drives the in-book branch
 * — typeahead → click the survivor row → click "Merge".
 *
 * Same cold-boot → upload → analysing → confirm walk as the sibling
 * spec so the test is self-contained. Wall-clock budget: ~16 s warm.
 * Pairs with docs/features/10-profile-drawer.md "Merge / downgrade
 * controls" + the searchable-picker bullet added with this change.
 */

import { test, expect } from '@playwright/test';

test.describe('profile drawer in-book merge via searchable picker', () => {
  test('confirm → drawer → picker typeahead → in-book merge', async ({ page }) => {
    /* Step 1: cold boot to library. */
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    /* Step 2: Start a new book. */
    await page
      .getByRole('button', { name: /Start a new book/i })
      .first()
      .click();
    await expect(page).toHaveURL(/#\/new$/);

    /* Step 3: paste a tiny manuscript so the analyser mock has something
       to consume. The H1 becomes the title. */
    await page.getByRole('button', { name: /Paste text/i }).click();
    await page
      .locator('textarea')
      .fill(
        '# In-Book Merge Test\n\n# Chapter 1\n\nA tiny test paragraph.\n\n' +
          '# Chapter 2\n\nA second paragraph.\n',
      );
    await page.getByRole('button', { name: /Upload pasted text/i }).click();

    /* Step 4: confirm metadata. */
    await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('E2E Author');
    await page.getByRole('button', { name: /Save book and start analysis/i }).click();

    /* Step 5: analysing view → start. */
    await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
    await page.getByRole('button', { name: /Start analysis/i }).click();

    /* Step 6: confirm-cast view loads. ANALYSIS_NORTHERN_STAR fixture
       seeds Halloran / Eliza / Marcus / Narrator. */
    await expect(page).toHaveURL(/#\/books\/.+\/confirm$/, { timeout: 15_000 });
    await expect(page.getByText('Captain Halloran').first()).toBeVisible({ timeout: 5_000 });

    /* Step 7: open Eliza's drawer. She has in-book siblings we can
       merge her into (Halloran / Marcus / Narrator). */
    await page.getByText('Eliza Gray').first().click();
    await expect(page).toHaveURL(/profile=eliza/, { timeout: 5_000 });

    /* Step 8: expand the merge picker card. */
    const mergeBtn = page.getByRole('button', { name: /Merge Eliza into another character/i });
    await expect(mergeBtn).toBeVisible({ timeout: 5_000 });
    await mergeBtn.click();

    /* Step 9: open the SearchablePicker popover off the merge-target
       trigger. The popover portals to document.body. */
    await page.getByRole('button', { name: /Merge target/i }).click();
    const dialog = page.getByRole('dialog', { name: /Reassign speaker/i });
    await expect(dialog).toBeVisible();

    /* Step 10: confirm the search input is focused (autofocus on open). */
    await expect(dialog.getByPlaceholder('Search character…')).toBeFocused();

    /* Step 11: typeahead narrows the list. "Marc" should leave only
       Marcus visible inside the dialog. */
    await dialog.getByPlaceholder('Search character…').fill('Marc');
    const visibleOptions = dialog.getByRole('option');
    await expect(visibleOptions).toHaveCount(1);
    await expect(visibleOptions.first()).toHaveText(/Marcus/);

    /* Step 12: click Marcus. The picker fires onPick(id), the merge
       card surfaces the in-book confirmation copy ("folded into …"). */
    await visibleOptions.first().click();
    await expect(page.getByText(/folded into/i)).toBeVisible();

    /* Step 13: click "Merge" — submit goes through onMerge in mock
       mode and the drawer closes on success. */
    await page.getByRole('button', { name: /^Merge$/i }).click();
    await expect(page).not.toHaveURL(/profile=eliza/, { timeout: 5_000 });

    /* Step 14: Eliza no longer appears as a top-level cast card on the
       confirm view — she's been folded into Marcus. */
    await expect(page.getByText('Eliza Gray').first()).toBeHidden({ timeout: 5_000 });
  });
});
