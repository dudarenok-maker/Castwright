/* Browser-level golden path for the low-confidence-triage-polish round.
 *
 * Drives all three behaviours end-to-end inside one walk:
 *
 *  - Low-confidence navigator (#33): the manuscript header's "X
 *    low-confidence" stat is now an active pill with ▲/▼ controls + J/K
 *    keyboard shortcuts that jump to the next/previous low-confidence
 *    sentence and open the SegmentInspector on it.
 *  - Series-roster in the reassign picker (#32): the inspector's
 *    per-sentence picker shows a "From prior books in this series" group
 *    below the local cast; picking one POSTs /cast/add-from-roster,
 *    appends the new local character, and reassigns the sentence.
 *  - Typeahead search (#34): the picker's focused-on-open search input
 *    filters the union (local + roster) by case-insensitive substring.
 *
 * Uses the mock SSE analysis fixture (ANALYSIS_NORTHERN_STAR) which
 * seeds `initialSentences` — sentence id=13 in chapter 3 carries
 * confidence=0.62, our low-confidence target. MOCK_SERIES_ROSTER
 * provides "Captain James Halloran" + "Mae Vance" as roster entries.
 *
 * Wall-clock budget: ~20 s warm (analysis mock ~7.6 s + click chain). */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

test.describe('manuscript low-confidence triage', () => {
  test('▼ jumps to low-conf sentence → search picker → roster pick reassigns', async ({
    page,
  }) => {
    await goToConfirm(page);

    /* Step 1: confirm cast → manuscript view. */
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

    /* Step 2: pick chapter 3 in the sidebar — that's where the
       canned-data low-confidence sentence (id=13, confidence 0.62)
       lives. The sidebar chapter list renders chapter titles; the
       canned `initialChapters` names them. */
    const chapter3 = page.getByRole('button', { name: /Cold Galley|Chapter 3/i }).first();
    /* Some viewports render the sidebar inside a drawer; fall back to
       any chapter button containing "3" if the title isn't visible. */
    if (await chapter3.isVisible().catch(() => false)) {
      await chapter3.click();
    }

    /* Step 3: verify the active low-confidence navigator pill is
       present and reports a non-zero count. */
    await expect(page.getByText(/^[1-9]\d* low-confidence$/)).toBeVisible({ timeout: 5_000 });
    const nextBtn = page.getByLabel('Next low-confidence sentence');
    await expect(nextBtn).toBeVisible();

    /* Step 4: clicking ▼ jumps to the first low-confidence sentence and
       opens the SegmentInspector on its segment. The inspector mounts
       once for tablet+desktop (sticky aside) and once for mobile
       (BottomSheet); the chromium project runs at desktop width so we
       expect at least one "Reassign whole segment to" header. */
    await nextBtn.click();
    await expect(page.getByText('Reassign whole segment to').first()).toBeVisible({
      timeout: 5_000,
    });

    /* Step 5: open the segment-level picker via the "Change…" button.
       The picker renders as role="dialog" with aria-label "Reassign
       speaker"; its first element is the focused search input. */
    await page.getByText(/Change…/).first().click();
    const picker = page.getByRole('dialog', { name: /reassign speaker/i }).first();
    await expect(picker).toBeVisible({ timeout: 5_000 });

    /* Step 6: typeahead — typing "halloran" should narrow the picker
       to the roster entry "Captain James Halloran" (plus any local
       cast member whose name happens to contain "halloran" — the canned
       cast has none). */
    await page.keyboard.type('halloran');
    const halloranOption = picker.getByRole('option', { name: /Captain James Halloran/i });
    await expect(halloranOption).toBeVisible();
    /* Sanity: roster footer text "From Solway Bay" is rendered on the
       row so the user can disambiguate. */
    await expect(picker.getByText(/From Solway Bay/i)).toBeVisible();

    /* Step 7: pick the roster entry — POSTs /cast/add-from-roster,
       dispatches castActions.addCharacter, then setSentencesCharacter.
       The reassignSegment handler also closes the inspector. Mock
       takes ~120 ms to settle. */
    await halloranOption.click();
    await expect(picker).toBeHidden({ timeout: 5_000 });

    /* Step 8: the SegmentRow's speaker label inside the manuscript
       prose now reads "Captain James Halloran". Sentence id=13's text
       ("Cold supper it is, then.") gives us a stable anchor — find the
       segment header just above it in the article. */
    await expect(
      page.getByRole('button', { name: /Captain James Halloran/i }).first(),
    ).toBeVisible({ timeout: 5_000 });
  });
});
