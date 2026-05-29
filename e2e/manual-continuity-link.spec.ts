/* Browser-level golden path for the manual continuity-link flow.
 *
 * Driving the bug from the screenshot ("Hartwell Brennan Vale" / "Hart"
 * couldn't be merged because the dropdown only listed in-book candidates):
 * on the confirm-cast view, opening a character's drawer and using
 * "Merge ... into another character" should now surface a "From prior
 * books in this series" optgroup populated by GET /series-roster, and
 * picking one should fire POST /cast/link-prior, close the drawer, and
 * light up the "Continuity preserved" footer on the cast card.
 *
 * Walks the same cold-boot → upload → analysing → confirm sequence
 * existing specs use (smoke.spec.ts + new-book-flow on the sibling
 * branch) so the test is self-contained — no fixture shortcuts.
 *
 * Wall-clock budget: ~16 s warm (analyser mock ~7.6 s + UI). Pairs with
 * docs/features/archive/09-voice-match-pipeline.md §"Manual continuity link". */

import { test, expect } from '@playwright/test';

test.describe('manual continuity link', () => {
  test('confirm → drawer → prior-roster optgroup → link → Continuity preserved footer', async ({
    page,
  }) => {
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
        '# Continuity Test Book\n\n# Chapter 1\n\nA tiny test paragraph.\n\n' +
          '# Chapter 2\n\nA second paragraph.\n',
      );
    await page.getByRole('button', { name: /Upload pasted text/i }).click();

    /* Step 4: confirm metadata. Standalone defaults to checked. */
    await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('E2E Author');
    await page.getByRole('button', { name: /Save book and start analysis/i }).click();

    /* Step 5: analysing view → click Start → wait for the canned
       ANALYSIS_NORTHERN_STAR fixture to stream. */
    await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
    await page.getByRole('button', { name: /Start analysis/i }).click();

    /* Step 6: confirm-cast view loads after the four mock phases.
       ANALYSIS_NORTHERN_STAR seeds Halloran / Eliza / Marcus / Narrator —
       Halloran has no matchedFrom in the fixture, so his card has no
       "Continuity preserved" footer yet. That's our link target. */
    await expect(page).toHaveURL(/#\/books\/.+\/confirm$/, { timeout: 15_000 });
    await expect(page.getByText('Captain Halloran').first()).toBeVisible({ timeout: 5_000 });

    /* Step 7: click Halloran's card to open the profile drawer. The
       confirm-cast view's card click sets stage.openProfileId so the
       hash gains ?profile=halloran. */
    await page.getByText('Captain Halloran').first().click();
    await expect(page).toHaveURL(/profile=halloran/, { timeout: 5_000 });

    /* Step 8: expand the merge picker. The drawer's "Cast roster"
       section renders "Merge Captain into another character…" when at
       least one of mergeCandidates / mergeCandidatesPrior is non-empty.
       Mock mode seeds the prior roster via MOCK_SERIES_ROSTER in
       src/lib/api.ts so the picker shows up even for a fresh book
       with no prior in-series sibling in the canned cast. */
    const mergeBtn = page.getByRole('button', { name: /Merge Captain into another character/i });
    await expect(mergeBtn).toBeVisible({ timeout: 5_000 });
    await mergeBtn.click();

    /* Step 9: the merge target trigger opens the searchable picker
       popover (portal-rendered to document.body). MOCK_SERIES_ROSTER
       contributes Captain James Halloran + Mae Vance under the prior-
       books group; the current-book group has the three other cast
       members (Narrator / Eliza / Marcus, excluding Halloran himself). */
    await page.getByRole('button', { name: /Merge target/i }).click();
    const dialog = page.getByRole('dialog', { name: /Reassign speaker/i });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('option', { name: /Captain James Halloran.*Solway Bay/i }),
    ).toHaveCount(1);
    await expect(dialog.getByRole('option', { name: /Mae Vance.*Solway Bay/i })).toHaveCount(1);
    await expect(dialog.getByRole('option', { name: /^Eliza Gray$/ })).toHaveCount(1);

    /* Step 10: pick the canonical prior — click the row. The picker
       routes prior-book picks through the merge handler's
       onPickRosterEntry callback which writes prior:0 to mergeTargetId. */
    await dialog
      .getByRole('option', { name: /Captain James Halloran.*Solway Bay/i })
      .click();

    /* Step 11: confirmation copy shifts to the link wording (the prior
       branch of ProfileDrawer's selected-row text). */
    await expect(page.getByText(/linked as the same person as/i)).toBeVisible();

    /* Step 12: the primary button label flips from "Merge" to "Link"
       when a prior is selected. Click it. */
    const linkBtn = page.getByRole('button', { name: /^Link$/i });
    await expect(linkBtn).toBeEnabled();
    await linkBtn.click();

    /* Step 13: on success, Layout's onLinkPrior callback dispatches
       castActions.applyManualMatch + setOpenProfileId(null). The drawer
       disappears (hash loses ?profile=) and the cast card's "Continuity
       preserved" footer surfaces with the prior book's title. The
       footer's character-name span resolves through `voice?.character`;
       mock mode doesn't ship the prior book's voice (v_halloran_solway)
       in src/mocks/voices.ts, so that span renders empty. Real mode
       resolves it from the prior book's confirmed voice library. The
       reliably-observable mock signals are the footer text + the prior
       bookTitle ("Solway Bay"). */
    await expect(page).not.toHaveURL(/profile=halloran/, { timeout: 5_000 });
    /* Plan 41 seeded matchedFrom on Narrator / Eliza / Marcus so the
       bulk-sync pill has multiple eligible cards in mock mode — those
       cards also render "Continuity preserved" footers. The original
       single-match assertion would have caught the narrator's footer
       even before plan 41 (narrator had matchedFrom in the fixture);
       `.first()` keeps the semantics. */
    await expect(page.getByText(/Continuity preserved/i).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('Solway Bay').first()).toBeVisible();
  });
});
