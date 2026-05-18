import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

/**
 * Cast → profile drawer flow — plan 37 follow-on.
 *
 * Drives a fresh book through the upload/analyse pipeline (via the shared
 * goToConfirm helper) and asserts the profile-drawer's evidence
 * affordance: the drawer opens when a character card is clicked, the
 * "Evidence from the manuscript" section renders the first three quotes,
 * and the "+ Show N more" toggle reveals/hides the rest.
 *
 * Why browser-level: the drawer renders alongside the cast view via the
 * shared <Layout/> (src/components/layout.tsx:894), gated by
 * `stage.openProfileId`. The click-to-open seam is a small piece of
 * URL+redux state coordination that Vitest+jsdom is fine on, but the
 * drawer's "+ Show N more" affordance only renders when the character has
 * >3 evidence quotes — the kind of CSS-driven visibility that benefits
 * from a real browser. Captain Halloran has 4 evidence quotes in the
 * design fixture (src/data/characters.ts:51-67) so the toggle renders.
 */

test.describe('cast view → profile drawer', () => {
  test('clicking a character opens the drawer with evidence + toggleable "Show more"', async ({
    page,
  }) => {
    await goToConfirm(page);

    /* Confirm-cast view renders character cards. Each card has
       aria-label="Open profile for <name>" (src/views/confirm-cast.tsx:241).
       Captain Halloran is the target because his evidence count (4) exceeds
       EVIDENCE_PREVIEW_LIMIT (3), so the "+ Show 1 more" toggle renders. */
    const hallCard = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(hallCard).toBeVisible({ timeout: 10_000 });
    await hallCard.click();

    /* Drawer opens. The "Evidence from the manuscript" section is the
       load-bearing assertion — proves the drawer mounted with the right
       character hydrated. */
    await expect(page.getByText(/Evidence from the manuscript/i)).toBeVisible({ timeout: 5_000 });

    /* Initial state: 3 quotes shown, "+ Show 1 more" toggle visible. */
    const showMore = page.getByRole('button', { name: /Show 1 more/i });
    await expect(showMore).toBeVisible();

    /* Click the toggle → 4th quote appears, button text flips to "Show fewer". */
    await showMore.click();
    await expect(page.getByRole('button', { name: /Show fewer/i })).toBeVisible();

    /* Round-trip back to collapsed. */
    await page.getByRole('button', { name: /Show fewer/i }).click();
    await expect(page.getByRole('button', { name: /Show 1 more/i })).toBeVisible();
  });
});
