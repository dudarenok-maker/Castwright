import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * Plan 95 — editable cast aliases.
 *
 * Drives a fresh book through the analyse pipeline (via the shared
 * goToConfirm helper) and exercises the Profile Drawer's "Also known
 * as" affordances: the + Add alias inline input round-trip, then chip
 * removal via the per-chip X — which opens the Reattribute Lines
 * modal seeded by the unlink-alias endpoint.
 *
 * Why browser-level: the X-on-chip → unlink-alias → modal-open seam
 * crosses redux, the layout's modal state, and React focus management.
 * Vitest+jsdom covers the slice + component contracts in isolation
 * (src/store/cast-slice.test.ts, src/modals/profile-drawer.test.tsx,
 * src/modals/reattribute-lines.test.tsx); this spec pins the
 * end-to-end click chain in a real DOM.
 *
 * Captain Halloran is the target (the mock cast's most evidence-rich
 * character) — no aliases on the design fixture, so the spec adds one
 * via the +Add input and then immediately removes it via the chip X.
 */
test.describe('cast view → profile drawer → alias chip editing', () => {
  test('user can add an alias and then unlink it, which opens the Reattribute modal', async ({
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
       the Reattribute Lines modal. */
    await unlinkCap.click();

    /* Modal mounted. Title carries the alias name + the source. */
    const modal = page.getByRole('dialog', { name: /Reattribute lines for Cap/i });
    await expect(modal).toBeVisible({ timeout: 5_000 });

    /* Mock returns no impactedChapters, so the empty-state copy is
       what renders. The Done button is reachable either way. */
    await expect(modal.getByText(/Nothing to reattribute here\./i)).toBeVisible();
    await modal.getByRole('button', { name: 'Done' }).click();
    await expect(modal).not.toBeVisible();

    /* Back on the drawer — the Cap chip is gone (it was just split into
       its own character), the +Add button is reachable again. */
    await expect(page.getByRole('button', { name: 'Unlink Cap' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add alias' })).toBeVisible();
  });
});
