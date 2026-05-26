import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * Cast drawer — rename a character + promote an alias to the primary name.
 *
 * Drives a fresh book through the analyse pipeline (shared goToConfirm
 * helper) and exercises the Profile Drawer header rename affordance and
 * the per-alias-chip "Make primary" promote. Both dispatch the
 * cast/renameCharacter reducer, which always demotes the old name into the
 * "Also known as" list so no name is lost.
 *
 * Why browser-level: the header inline-edit → redux rename → re-render with
 * the new name + demoted alias chip seam crosses the layout's profile
 * selector, React focus management, and the persistence middleware. The
 * slice + component contracts are covered in isolation
 * (src/store/cast-slice.test.ts, src/modals/profile-drawer.test.tsx); this
 * spec pins the end-to-end click chain in a real DOM.
 *
 * Captain Halloran is the target — the mock cast's most evidence-rich
 * character, with no aliases on the fixture, so a rename produces a clean
 * single demoted-alias chip.
 */
test.describe('cast view → profile drawer → rename + promote alias', () => {
  test('free-text rename updates the header and demotes the old name to an alias', async ({
    page,
  }) => {
    await goToConfirm(page);
    await waitForRouteReady(page);

    const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    /* Scope assertions to the drawer (an <aside>, role=complementary) — the
       cast card behind it carries the same name heading once the rename
       propagates through redux. */
    const drawer = page.getByRole('complementary');

    /* Header rename: the affordance sits next to the name in the sticky
       header. Clicking reveals the inline input seeded with the current
       name; typing + Enter dispatches renameCharacter. */
    await drawer.getByRole('button', { name: 'Rename character' }).click();
    const input = drawer.getByRole('textbox', { name: 'Character name' });
    await expect(input).toHaveValue('Captain Halloran');
    await input.fill('Admiral Halloran');
    await input.press('Enter');

    /* Header now shows the new name. */
    await expect(drawer.getByRole('heading', { name: 'Admiral Halloran' })).toBeVisible({
      timeout: 5_000,
    });

    /* Old name preserved as an alias chip (never lose a name). */
    await drawer.getByText('Also known as').scrollIntoViewIfNeeded();
    await expect(drawer.getByRole('button', { name: 'Unlink Captain Halloran' })).toBeVisible();
  });

  test('promoting an alias via the chip star swaps it up to the primary name', async ({ page }) => {
    await goToConfirm(page);
    await waitForRouteReady(page);

    const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    const drawer = page.getByRole('complementary');

    /* Seed an alias to promote. */
    await expect(drawer.getByText('Also known as')).toBeVisible({ timeout: 10_000 });
    await drawer.getByText('Also known as').scrollIntoViewIfNeeded();
    await drawer.getByRole('button', { name: 'Add alias' }).click();
    const aliasInput = drawer.getByRole('textbox', { name: 'New alias name' });
    await aliasInput.fill('Cap');
    await aliasInput.press('Enter');

    /* Promote it — the star next to the chip's Unlink X. */
    await drawer.getByRole('button', { name: 'Make Cap the primary name' }).click();

    /* "Cap" is now the header name; the previous primary demotes to a chip. */
    await expect(drawer.getByRole('heading', { name: 'Cap' })).toBeVisible({ timeout: 5_000 });
    await expect(drawer.getByRole('button', { name: 'Unlink Captain Halloran' })).toBeVisible();
    /* The promoted alias no longer appears as a chip (it became the name).
       exact:true so "Unlink Cap" doesn't substring-match the demoted
       "Unlink Captain Halloran" chip. */
    await expect(drawer.getByRole('button', { name: 'Unlink Cap', exact: true })).toHaveCount(0);
  });
});
