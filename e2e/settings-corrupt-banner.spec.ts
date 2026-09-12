/* #3175 layer 3 / PR #3195 M4 — the settings-corruption banner at the
 * redux → layout seam, in a real browser.
 *
 * The banner (src/components/settings-corrupt-banner.tsx, mounted in
 * src/components/layout.tsx beside WhatsNewBanner) renders iff
 * `account.corruptSettingsFile` is true. Mock mode cannot produce a corrupt
 * settings file — `mockGetUserSettings` (src/lib/api.ts) clones a static
 * object with the flag `false` and there is no disk — so, mirroring
 * `e2e/orphaned-character-fallback-banner.spec.ts`'s established pattern
 * for server-only facts, this spec seeds the flag through the real
 * `account/setCorruptSettingsFile` reducer via `window.__store__` (the same
 * reducer the three non-thunk writers' callers dispatch in production) and
 * asserts what the layout paints.
 *
 * What it does NOT reach: the server-side latch (`isUserSettingsFileCorrupt`,
 * pinned by server/src/workspace/user-settings.test.ts) and the GET → boot
 * hydration path (`fetchAccountSettings.fulfilled`, pinned by
 * src/store/account-slice.test.ts). The clearing half IS driven end to end
 * through a real code path: saving from the Account view dispatches the real
 * `saveAccountSettings` thunk, whose mock-mode response carries
 * `corruptSettingsFile: false`, and the slice re-hydrates from it — the exact
 * "the banner goes away on its own the first time you save anything" promise
 * the release note makes. */

import { test, expect, type Page } from '@playwright/test';

async function setCorruptFlag(page: Page, value: boolean): Promise<void> {
  await page.evaluate((v) => {
    const store = (window as unknown as { __store__?: { dispatch(a: unknown): void } }).__store__;
    if (!store) throw new Error('window.__store__ is not exposed (main.tsx DEV/e2e gate regressed)');
    store.dispatch({ type: 'account/setCorruptSettingsFile', payload: v });
  }, value);
}

test.describe('settings-corruption banner (#3175)', () => {
  test('renders in the shell while the flag is set, names the real recovery artifacts, and has no dismiss control', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('alert')).toHaveCount(0);

    await setCorruptFlag(page, true);

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/unreadable and has been reset to defaults/i);
    await expect(alert).toContainText(/user-settings\.json\.corrupt-/);
    await expect(alert).not.toContainText(/\.bak\.\d/);
    await expect(alert.getByRole('button')).toHaveCount(0);

    /* Global, not view-local: still up after navigating to another route. */
    await page.goto('/#/account');
    await expect(page.getByRole('alert')).toContainText(/unreadable and has been reset to defaults/i);

    await setCorruptFlag(page, false);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a successful settings save from the Account view clears it on its own', async ({ page }) => {
    await page.goto('/#/account');
    await expect(page.getByRole('button', { name: /Save changes/i })).toBeVisible({ timeout: 10_000 });

    await setCorruptFlag(page, true);
    await expect(page.getByRole('alert')).toContainText(/unreadable and has been reset to defaults/i);

    /* The real save thunk: the mock PUT answers with the settings echo
       (corruptSettingsFile: false), and saveAccountSettings.fulfilled
       re-hydrates the slice from that response. No dispatch of the flag
       reducer here — the banner must leave because the save did. */
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(page.getByText('Saved.')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
