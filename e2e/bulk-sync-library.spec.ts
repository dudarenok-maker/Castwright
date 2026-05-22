/* Browser-level golden path for plan 41 + Bug C + Bug D — bulk-apply
 * library matches on confirm-cast. Walks the same cold-boot → paste →
 * analysing → confirm sequence the manual-continuity-link spec uses,
 * then asserts:
 *
 *   1. the "Apply all N matches" pill renders above the cast-card grid
 *      — N counts rows where SOMETHING is still un-applied. With the
 *      Bug-D confidence gate, the high-confidence Narrator row (0.94)
 *      is "applied" from first render (decision='match' is set by the
 *      useState initialiser and the auto-tick is skipped at high-conf),
 *      so N=2 on initial load (Eliza 0.89 + Marcus 0.86 — both low);
 *   2. clicking the pill auto-ticks the "Sync profile" checkbox ONLY
 *      for low-confidence (< 0.9) matches (Bug D — the original
 *      plan-41 + Bug-C behaviour ticked every eligible sync regardless
 *      of score). Reuse decision flip still fires for every eligible
 *      card (Bug C);
 *   3. the label flips to "Clear all syncs" after the bulk apply
 *      because all three rows are now "applied" by the new count
 *      semantics (high-conf counts as applied via decision alone);
 *   4. confirming the cast advances the stage to ready (the per-card
 *      override POSTs fire through the existing handleConfirm batch).
 *
 * Mock-mode only — the bulk-sync flow is a UI compression over the
 * existing POST /api/library-cast/override path. Wall-clock budget:
 * ~16 s warm (analyser mock ~7.6 s + UI).
 *
 * Pairs with docs/features/archive/41-bulk-library-sync.md
 * (Bug C + Bug D amends). */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test.describe('bulk-sync library on confirm-cast', () => {
  test('pill renders, click ticks all matched checkboxes, Confirm advances stage', async ({
    page,
  }) => {
    /* Step 1: cold boot to library. */
    await page.goto('/');
    await waitForRouteReady(page);
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible();

    /* Step 2: Start a new book. */
    await page
      .getByRole('button', { name: /Start a new book/i })
      .first()
      .click();
    await expect(page).toHaveURL(/#\/new$/);

    /* Step 3: paste a tiny manuscript. The H1 becomes the title. */
    await page.getByRole('button', { name: /Paste text/i }).click();
    await page
      .locator('textarea')
      .fill(
        '# Bulk Sync Test Book\n\n# Chapter 1\n\nA tiny test paragraph.\n\n' +
          '# Chapter 2\n\nA second paragraph.\n',
      );
    await page.getByRole('button', { name: /Upload pasted text/i }).click();

    /* Step 4: confirm metadata. */
    await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('E2E Author');
    await page.getByRole('button', { name: /Save book and start analysis/i }).click();

    /* Step 5: analysing → click Start → wait for the canned fixture
       to stream. ANALYSIS_NORTHERN_STAR seeds Halloran / Eliza / Marcus /
       Narrator. Plan 41 seeded matchedFrom + match-factors on three of
       those (Narrator + Eliza + Marcus) so the bulk-sync pill renders
       with N=3 once voice-matching completes. */
    await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
    await page.getByRole('button', { name: /Start analysis/i }).click();

    /* Step 6: confirm-cast view loads after the four mock phases. */
    await expect(page).toHaveURL(/#\/books\/.+\/confirm$/, { timeout: 15_000 });
    await expect(page.getByText('Captain Halloran').first()).toBeVisible({ timeout: 5_000 });

    /* Step 7: the bulk-apply pill renders. N counts unapplied eligible
       rows. With the Bug-D confidence gate, Narrator (0.94, high-conf)
       starts as already-applied via the useState initialiser (decision
       defaults to 'match'); only Eliza (0.89) and Marcus (0.86) are
       unapplied at first render. N=2. The voice-match effect in
       src/components/layout.tsx fires once characters hydrate; give it
       a beat to land. */
    const bulkPill = page.getByRole('button', { name: /Apply all 2 matches/ });
    await expect(bulkPill).toBeVisible({ timeout: 5_000 });

    /* Step 8: click the pill — Eliza + Marcus get their "Sync profile"
       checkbox auto-ticked (both < 0.9). Narrator (0.94) stays unticked
       because the Bug-D gate keeps high-confidence syncs as a per-card
       opt-in. The label flips to "Clear all syncs" — all three rows are
       now applied (Narrator via decision alone; Eliza + Marcus via
       decision + override). Look up each character's sync checkbox by
       its accessible name (which includes the source-book title via
       `aria-label="Sync profile with <bookTitle>"`) rather than by
       index, so the assertion doesn't drift if cast render order
       changes. */
    await bulkPill.click();
    await expect(page.getByRole('button', { name: 'Clear all syncs' })).toBeVisible();

    /* All three "Sync profile" checkboxes carry the same `Sync profile
       with Solway Bay` accessible label (fixture: all three matched
       characters share bookTitle = 'Solway Bay'). Disambiguate via the
       enclosing card's aria-label — each card is a `<article role="button"
       aria-label="Open profile for <name>">` in confirm-cast.tsx, so the
       per-character card is addressable by the character name. */
    const narratorCard = page.locator('article', { hasText: 'Narrator' }).first();
    const elizaCard = page.locator('article', { hasText: 'Eliza Gray' }).first();
    const marcusCard = page.locator('article', { hasText: 'Marcus the Cook' }).first();

    await expect(narratorCard.getByRole('checkbox', { name: /Sync profile/i })).not.toBeChecked();
    await expect(elizaCard.getByRole('checkbox', { name: /Sync profile/i })).toBeChecked();
    await expect(marcusCard.getByRole('checkbox', { name: /Sync profile/i })).toBeChecked();

    /* Step 9: confirm cast advances to the ready stage. The handleConfirm
       batch (confirm-cast.tsx:94-121) fans out the per-character
       library-cast-override POSTs before navigating; awaiting the URL
       change implicitly waits for those promises to settle. */
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 10_000 });
  });
});
