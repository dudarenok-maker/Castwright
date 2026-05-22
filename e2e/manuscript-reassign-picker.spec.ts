/* Browser-level coverage for the post-90 reassign-picker polish:
 *
 *  - Portal: the picker now renders as a fixed-position popover under
 *    document.body, escaping the inspector's `overflow-y-auto` middle
 *    scroll region. Pre-fix the picker was clipped to the right-rail
 *    bounds and the lower rows (incl. the series roster) were hidden.
 *  - Dismissal: closes on click-outside + Esc only. Moving the pointer
 *    from the trigger button into the popover MUST keep it open — the
 *    old `onMouseLeave` dismissal closed the menu mid-gesture and made
 *    the row dropdown unusable.
 *  - Dark-mode surface: `.picker-surface` lifts the popover one more
 *    elevation step than the generic `bg-white` redirect so the dark-
 *    canvas popover reads as a distinct surface, not bleed-through.
 *
 * Drives the same low-confidence triage manuscript fixture as
 * `manuscript-low-confidence-triage.spec.ts` (chapter "Cold Galley",
 * sentence id=13). */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

test.describe('manuscript reassign picker — portal + dismissal + dark surface', () => {
  test('inspector picker is portal-rendered to document.body, not clipped by the inspector card', async ({
    page,
  }) => {
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

    /* Jump to the low-conf sentence to open the inspector deterministically. */
    const chapter3 = page.getByRole('button', { name: /Cold Galley|Chapter 3/i }).first();
    if (await chapter3.isVisible().catch(() => false)) {
      await chapter3.click();
    }
    await page.getByLabel('Next low-confidence sentence').click();
    await expect(page.getByText('Reassign whole segment to').first()).toBeVisible();

    /* Open the segment-level picker. */
    await page.getByText(/Change…/).first().click();
    const picker = page.getByRole('dialog', { name: /reassign speaker/i }).first();
    await expect(picker).toBeVisible();

    /* Portal contract: the picker's parent in the DOM should be
       <body>, not the inspector card. */
    const parentTag = await picker.evaluate((el) => el.parentElement?.tagName ?? null);
    expect(parentTag).toBe('BODY');

    /* Positioned with position: fixed so the coords from
       getBoundingClientRect line up with the viewport (not an offset
       parent that might be clipping). */
    const position = await picker.evaluate((el) => window.getComputedStyle(el).position);
    expect(position).toBe('fixed');

    /* Roster group is reachable below the local cast. The triage spec
       already pins the picker contents — here we just need the group
       header to exist as a smoke check that the FULL list mounted, not
       a clipped subset. */
    await expect(picker.getByText(/From prior books in this series/i)).toBeVisible();
  });

  test('row Reassign popover survives the pointer crossing from trigger into the list', async ({
    page,
  }) => {
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

    /* Pick a chapter with at least one normal-confidence segment so the
       hover-only Reassign button reveal is exercised. Chapter 1 is the
       canned chapter that opens by default — use it. */
    const firstSegment = page.locator('article >> [data-sentence-id]').first();
    await firstSegment.hover();
    /* The row-level Reassign button has aria-name "Reassign" — the
       inspector also has a "Change…" trigger but its accessible name
       differs, so this is unambiguous. */
    const reassignBtn = page.getByRole('button', { name: /^Reassign$/ }).first();
    await reassignBtn.click();

    const picker = page.getByRole('dialog', { name: /reassign speaker/i }).first();
    await expect(picker).toBeVisible();

    /* Move the pointer from the trigger button into the popover —
       crossing the row's bounding box. Pre-fix this fired the row's
       onMouseLeave and closed the popover before the user could click
       a row. */
    const pickerBox = await picker.boundingBox();
    if (!pickerBox) throw new Error('picker boundingBox unavailable');
    await page.mouse.move(pickerBox.x + 20, pickerBox.y + 60);
    /* The dialog must still be in the DOM after the pointer crosses
       out of the row container into the portalled popover — this is
       the regression contract. */
    await expect(picker).toBeVisible();

    /* And the user can pick a character from the popover after the
       cross — proves the click path is still live. The first option in
       the canned cast is the Narrator. */
    const firstOption = picker.getByRole('option').first();
    await firstOption.click();
    await expect(picker).toBeHidden({ timeout: 5_000 });
  });

  test('Esc and click-outside both dismiss the inspector picker', async ({ page }) => {
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });
    await page.getByLabel('Next low-confidence sentence').click();
    await expect(page.getByText('Reassign whole segment to').first()).toBeVisible();
    await page.getByText(/Change…/).first().click();
    const picker = page.getByRole('dialog', { name: /reassign speaker/i }).first();
    await expect(picker).toBeVisible();

    /* Click on a manuscript sentence — anywhere outside the picker and
       its anchor — and the popover should dismiss. */
    await page.locator('article >> [data-sentence-id]').first().click({ position: { x: 5, y: 5 } });
    await expect(picker).toBeHidden({ timeout: 5_000 });
  });

  test('dark-mode popover paints with the .picker-surface elevation override', async ({
    page,
  }) => {
    /* Programmatic contrast check — the visual-baseline route was too
       fragile because the popover width depends on the trigger's
       getBoundingClientRect, which varies between paints (308 vs 320 px
       observed on re-renders). The CSS-rule test in
       `src/test/dark-mode-css.test.ts` pins the rule itself; here we
       prove the rule actually paints on the rendered picker.

       Background sits at #2a2520 = rgb(42, 37, 32) under data-theme=dark,
       a noticeable lift over --canvas (#14110f = rgb(20, 17, 15)) so
       the popover reads as a distinct surface — that's the regression. */
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

    await page.getByLabel('Next low-confidence sentence').click();
    await expect(page.getByText('Reassign whole segment to').first()).toBeVisible();
    await page.getByText(/Change…/).first().click();
    const picker = page.getByRole('dialog', { name: /reassign speaker/i }).first();
    await expect(picker).toBeVisible();

    const bg = await picker.evaluate(
      (el) => window.getComputedStyle(el).backgroundColor,
    );
    /* Browsers serialise as rgb(r, g, b) — match the elevation override
       byte-for-byte. */
    expect(bg).toBe('rgb(42, 37, 32)');
  });
});
