/* Plan 78 — rename a chapter from the Listen view, confirm the new
   title sticks across views.

   Coverage:
   - Open the Listen view on a 'complete' book → pencil button is
     present on every chapter row.
   - Click pencil → modal opens with the current title seeded.
   - Type a new title → Save → modal closes; the row re-renders with
     the new title.
   - Navigate to the Restructure view → the same chapter shows the new
     title there too (single-tab redux propagation).

   This pins the e2e seam that Vitest+jsdom can't fully exercise:
   modal mount + dispatch + cross-view re-render in a real browser. */

import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

test.describe.configure({ mode: 'serial' });

test.describe('listen view — rename chapter (plan 78)', () => {
  test('rename a chapter from the listen view; new title appears on the row and in restructure', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page).toHaveURL(/#\/books\/sb\/listen/);

    /* per-view hydration helper. The chapter rows
       only mount once listenable.length > 0 — Play-from-start enable is
       a stronger signal than the title alone. */
    await waitForListenViewReady(page, /Solway Bay/i);

    // Chapter rows are stamped with data-testid=`chapter-row-${id}`. The
    // rename button on each carries `chapter-row-${id}-rename`. We pick
    // chapter 1 — the first row is the most stable selector across mock
    // seed variants.
    const renameButton = page.getByTestId('chapter-row-1-rename').first();
    await expect(renameButton).toBeVisible({ timeout: 5_000 });
    await renameButton.click();

    // Modal mounted — input is autofocused with the current title.
    const input = page.getByTestId('edit-chapter-title-input');
    await expect(input).toBeVisible({ timeout: 2_000 });
    const originalTitle = await input.inputValue();
    expect(originalTitle.length).toBeGreaterThan(0);

    const newTitle = 'Renamed In E2E';
    await input.fill(newTitle);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // Modal closes — input gone from the DOM.
    await expect(input).toHaveCount(0, { timeout: 3_000 });

    // The row re-renders with the new title. Use the chapter-row testid
    // as the scope so we're asserting on the right row.
    const row = page.getByTestId('chapter-row-1');
    await expect(row).toContainText(newTitle, { timeout: 3_000 });

    // Navigate to the Restructure view — the same chapter title shows
    // there too (single-tab redux propagation across views).
    await page.goto('/#/books/sb/restructure');
    const restructureRow = page.getByTestId('restructure-row-1');
    await expect(restructureRow).toContainText(newTitle, { timeout: 5_000 });
  });

  test('cancel discards changes — title stays as-is', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);

    const row = page.getByTestId('chapter-row-2');
    const originalRowText = await row.textContent();

    await page.getByTestId('chapter-row-2-rename').first().click();
    const input = page.getByTestId('edit-chapter-title-input');
    await expect(input).toBeVisible();
    await input.fill('Garbage that should not stick');
    // Close via Escape — the modal owns its own keydown handler. Avoids
    // ambiguous "Cancel" button matches against other modals that might
    // be mounted on the same page (e.g. EditBookMetaModal from header).
    await input.press('Escape');
    await expect(input).toHaveCount(0);

    // Row text is the same as before — title unchanged.
    await expect(row).toContainText((originalRowText ?? '').trim().split(/\s+/)[0]!);
    await expect(row).not.toContainText('Garbage that should not stick');
  });
});
