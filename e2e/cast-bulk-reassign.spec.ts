import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * Cast bulk line-reassignment — #1676 part (c).
 *
 * Golden path for the roster entry point into the new, reusable
 * `ReassignLinesModal` (src/modals/reassign-lines.tsx): open a character's
 * profile drawer from the ready-stage Cast roster, "Reassign lines…",
 * select every candidate line, pick a target, confirm, and land on the
 * layout-level Undo banner (src/components/bulk-reassign-undo-banner.tsx).
 * The banner is book-session-scoped (not view-scoped), so this spec's load-
 * bearing assertion is that it SURVIVES navigating Cast -> Manuscript ->
 * Cast before finally exercising Undo.
 *
 * Why browser-level: the roster row click -> profile drawer -> modal ->
 * layout banner chain crosses redux (manuscript.lastBulkReassign), the
 * layout's local `reassignSource` state, and real top-bar tab navigation —
 * exactly the router/redux/layout seam Vitest+jsdom can lie about. The
 * component contracts themselves (selection Set, drift re-validation,
 * Narrator confirm, empty state) are pinned in
 * src/modals/reassign-lines.test.tsx; this spec only proves the click
 * chain + cross-view banner survival in a real DOM.
 *
 * Fixture: goToConfirm's mock analysis stream always returns the same
 * canned ANALYSIS_NORTHERN_STAR fixture (src/mocks/canned-data.ts)
 * regardless of the pasted manuscript, so Captain Halloran (id 'halloran')
 * and his attributed sentences (src/data/sentences.ts) are deterministic —
 * the same fixture e2e/cast-alias-edit.spec.ts and e2e/cast.spec.ts key
 * off for the same reason. Eliza Gray (id 'eliza') is the reassignment
 * target.
 *
 * Viewport pinned >=1280 (xl) so the top-bar's inline Cast/Manuscript tab
 * strip renders instead of collapsing into the hamburger drawer (design
 * spec §8 / CLAUDE.md "Top-bar nav exception") — bumped to 1366 rather
 * than sitting exactly on the 1280 boundary, matching
 * e2e/script-review-persistence.spec.ts's same precaution.
 */
test.use({ viewport: { width: 1366, height: 900 } });

test.describe('cast bulk line reassignment — golden path (#1676c)', () => {
  test('bulk-reassign lines from the roster, then undo; banner survives cast<->script nav', async ({
    page,
  }) => {
    await goToConfirm(page);
    await waitForRouteReady(page);

    /* Confirm the cast -> lands on the ready-stage Cast view (the roster),
       where stage === 'ready' so the top-bar tab strip renders. */
    await page.getByRole('button', { name: /Confirm cast and design voices/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/cast/, { timeout: 5_000 });
    await waitForRouteReady(page);

    /* Open Captain Halloran's profile drawer via his roster row. The row
       itself has no accessible name (unlike the confirm-cast view's "Open
       profile for X" cards), so target it by its `data-testid` — the desktop
       table row and the responsive mobile-card row both render "Captain
       Halloran" text (one hidden by CSS per breakpoint), so a plain
       `getByText(..., { exact: true })` is ambiguous; the desktop row's
       `onClick` fires `onOpenProfile(c.id)` directly. */
    const hallRow = page.getByTestId('cast-row-halloran');
    await expect(hallRow).toBeVisible({ timeout: 10_000 });
    await hallRow.click();

    const reassignBtn = page.getByRole('button', { name: /^Reassign lines/i });
    await expect(reassignBtn).toBeVisible({ timeout: 10_000 });
    await reassignBtn.click();

    const dialog = page.getByRole('dialog', { name: 'Reassign lines' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
    await dialog.getByLabel(/reassign to/i).selectOption({ label: 'Eliza Gray' });
    await dialog.getByRole('button', { name: /^Reassign \d+ lines?$/i }).click();

    const confirmDialog = page.getByRole('alertdialog', { name: /Confirm reassignment/i });
    await expect(confirmDialog).toBeVisible({ timeout: 5_000 });
    await confirmDialog.getByRole('button', { name: 'Confirm', exact: true }).click();

    /* Layout-level, non-dismissing Undo banner. */
    const banner = page.getByText(/Reassigned \d+ lines? to Eliza Gray/i);
    await expect(banner).toBeVisible({ timeout: 5_000 });
    await expect(dialog).not.toBeVisible();

    /* Closing the reassign modal returns to the profile drawer (it stays
       open behind the modal by design). The drawer's own <aside> (z-50,
       right-anchored) overlaps the right edge of the centered Undo banner
       below it, so close the drawer the same way a user would before
       moving on — via its full-width backdrop (`fixed inset-x-0 top-16
       bottom-0`, `onClick={onClose}`), clicking a point on the LEFT side
       that's outside the drawer's own right-anchored bounds. The drawer's
       close (X) button has no accessible name to target directly. */
    await page.mouse.click(80, 200);
    await expect(page.getByRole('button', { name: /^Reassign lines/i })).toHaveCount(0);

    /* §6 book-session scope: the banner must SURVIVE cast<->script
       navigation — it lives in the manuscript slice, rendered once at the
       layout level, not owned by either view. */
    await page.getByRole('button', { name: 'Manuscript', exact: true }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
    await waitForRouteReady(page);
    await expect(banner).toBeVisible();

    await page.getByRole('button', { name: 'Cast', exact: true }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/cast/, { timeout: 5_000 });
    await expect(banner).toBeVisible();

    /* Undo restores prior attribution and dismisses the banner. */
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(banner).not.toBeVisible();
  });
});
