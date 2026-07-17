import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * Plan 95 — editable cast aliases.
 *
 * Drives a fresh book through the analyse pipeline (via the shared
 * goToConfirm helper) and exercises the Profile Drawer's "Also known
 * as" affordances: the + Add alias inline input round-trip, then chip
 * removal via the per-chip X — which opens the Reassign Lines modal
 * seeded by the unlink-alias endpoint (`kind: 'unlink'` source).
 *
 * Why browser-level: the X-on-chip → unlink-alias → modal-open seam
 * crosses redux, the layout's modal state, and React focus management.
 * Vitest+jsdom covers the slice + component contracts in isolation
 * (src/store/cast-slice.test.ts, src/modals/profile-drawer.test.tsx,
 * src/modals/reassign-lines.test.tsx); this spec pins the end-to-end
 * click chain in a real DOM.
 *
 * #1676 part (c) generalized the modal that used to open here
 * (`ReattributeLinesModal`) into the reusable `ReassignLinesModal`
 * (src/modals/reassign-lines.tsx) — same unlink-alias trigger and
 * intent (split off the alias, then move its lines), new aria-label
 * ("Reassign lines" instead of "Reattribute lines for {alias}") and
 * empty-state copy. This spec's assertions were updated to match; the
 * click chain it pins is otherwise unchanged.
 *
 * Captain Halloran is the target (the mock cast's most evidence-rich
 * character) — no aliases on the design fixture, so the spec adds one
 * via the +Add input and then immediately removes it via the chip X.
 */
test.describe('cast view → profile drawer → alias chip editing', () => {
  test('user can add an alias and then unlink it, which opens the Reassign Lines modal', async ({
    page,
  }) => {
    await goToConfirm(page);
    await waitForRouteReady(page);

    /* Open the Halloran drawer — same affordance the cast-drawer spec
       uses, picked because it's the most reliable character to find on
       the confirm-cast view. */
    const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    /* Drawer mounted. Scroll the alias-row into view (the section sits
       below the long Voice profile + Identity blocks). */
    await expect(page.getByText('Also known as')).toBeVisible({ timeout: 10_000 });
    await page.getByText('Also known as').scrollIntoViewIfNeeded();

    /* + Add alias round-trip: button opens the inline input, typing +
       Enter dispatches addAlias which the cast-slice reducer dedups
       case-insensitively and stores on the character. */
    const addButton = page.getByRole('button', { name: 'Add alias' });
    await expect(addButton).toBeVisible();
    await addButton.click();
    const input = page.getByRole('textbox', { name: 'New alias name' });
    await input.fill('Cap');
    await input.press('Enter');

    /* New chip appears with an Unlink X. */
    const unlinkCap = page.getByRole('button', { name: 'Unlink Cap' });
    await expect(unlinkCap).toBeVisible({ timeout: 5_000 });

    /* Click the X — the layout's onUnlinkAlias handler fires
       api.unlinkAlias (mock returns empty impactedChapters) and opens
       the Reassign Lines modal with an `{ kind: 'unlink' }` source. */
    await unlinkCap.click();

    /* Modal mounted. #1676(c): the generalized modal's aria-label is the
       fixed "Reassign lines" (no longer alias-specific — the source
       union carries the alias identity instead of the title). */
    const modal = page.getByRole('dialog', { name: 'Reassign lines' });
    await expect(modal).toBeVisible({ timeout: 5_000 });

    /* Mock returns no impactedChapters, so the empty-state copy is what
       renders. #1676(c): the copy changed to the generalized form's
       wording, and the dedicated "Done" button was replaced by the
       modal's header "Close" icon button (shared by every source). */
    await expect(
      modal.getByText(/Nothing to reassign here — 0 lines to move for this selection\./i),
    ).toBeVisible();
    await modal.getByRole('button', { name: 'Close' }).click();
    await expect(modal).not.toBeVisible();

    /* Back on the drawer — the Cap chip is gone (it was just split into
       its own character), the +Add button is reachable again. */
    await expect(page.getByRole('button', { name: 'Unlink Cap' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add alias' })).toBeVisible();
  });
});
