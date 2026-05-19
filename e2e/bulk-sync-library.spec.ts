/* Browser-level golden path for plan 41 + Bug C — bulk-apply library
 * matches on confirm-cast. Walks the same cold-boot → paste → analysing
 * → confirm sequence the manual-continuity-link spec uses, then asserts:
 *
 *   1. the "Apply all N matches" pill renders above the cast-card grid
 *      with N matching the number of cards eligible for sync;
 *   2. clicking the pill flips Reuse decision AND ticks every matched
 *      character's "Sync profile" checkbox in one click (Bug C — the
 *      original plan-41 behaviour was overrides-only);
 *   3. the label flips to "Clear all syncs" after the bulk apply;
 *   4. confirming the cast advances the stage to ready (the per-card
 *      override POSTs fire through the existing handleConfirm batch).
 *
 * Mock-mode only — the bulk-sync flow is a UI compression over the
 * existing POST /api/library-cast/override path. Wall-clock budget:
 * ~16 s warm (analyser mock ~7.6 s + UI).
 *
 * Pairs with docs/features/archive/41-bulk-library-sync.md (Bug C amend). */

import { test, expect } from '@playwright/test';

test.describe('bulk-sync library on confirm-cast', () => {
  test('pill renders, click ticks all matched checkboxes, Confirm advances stage', async ({
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

    /* Step 7: the bulk-apply pill is present with N=3 matching the three
       fixture characters carrying the full library handle. The
       voice-match effect in src/components/layout.tsx:469 fires once
       characters hydrate; give it a beat to land. */
    const bulkPill = page.getByRole('button', { name: /Apply all 3 matches/ });
    await expect(bulkPill).toBeVisible({ timeout: 5_000 });

    /* Step 8: click the pill — every matched character's Reuse decision
       stays selected AND "Sync profile" checkbox ticks in one click. The
       label flips to "Clear all syncs" once all eligible are applied. */
    await bulkPill.click();
    await expect(page.getByRole('button', { name: 'Clear all syncs' })).toBeVisible();
    const checkboxes = page.getByRole('checkbox', { name: /Sync profile/i });
    await expect(checkboxes).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await expect(checkboxes.nth(i)).toBeChecked();
    }

    /* Step 9: confirm cast advances to the ready stage. The handleConfirm
       batch (confirm-cast.tsx:94-121) fans out the per-character
       library-cast-override POSTs before navigating; awaiting the URL
       change implicitly waits for those promises to settle. */
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 10_000 });
  });
});
