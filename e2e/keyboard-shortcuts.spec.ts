/* fe-2 — power-user keyboard shortcut, end-to-end through the
 * account → redux(settings) → mini-player seam.
 *
 * The unit tests pin the slice, the keybinding hook, and the Account card in
 * isolation; this spec proves the whole chain in a real browser: rebinding
 * play/pause in Account → Advanced changes the live (redux-persist) binding,
 * and pressing that key on the Listen view toggles the mini-player's <audio>.
 * Crosses router + redux + layout + keyboard seams that jsdom can't fully
 * model — exactly the bar CLAUDE.md sets for an e2e.
 *
 * Pairs with the fe-2 regression plan. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady, waitForListenViewReady, stubAccountModelProbes } from './helpers';

/* Serial: the listen view's audio + the account view's mount-time probes both
   flake under parallel-worker contention (mirrors listen-playback.spec.ts). */
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await stubAccountModelProbes(page);
});

test.describe('fe-2 — rebindable play/pause shortcut', () => {
  test('rebinding to K in Account toggles the mini-player on the Listen view', async ({ page }) => {
    /* 1. Rebind play/pause → K in Account → Advanced. */
    await page.goto('/#/account');
    await waitForRouteReady(page);
    const binding = page.getByTestId('account-play-pause-binding');
    await expect(binding).toHaveText('Space'); // default

    await page.getByTestId('account-rebind-play-pause').click();
    await page.keyboard.press('k');
    await expect(binding).toHaveText('K'); // override took, persisted to the settings slice

    /* 2. Open the Listen view and start playback (mini-player mounts). */
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);
    await page.getByRole('button', { name: /Play from the start/i }).click();

    const audio = page.locator('audio');
    await expect(audio).toHaveCount(1, { timeout: 3_000 });
    await expect(audio).toHaveJSProperty('paused', false, { timeout: 3_000 });

    /* 3. Press the rebound key → playback pauses; press again → resumes.
       Blur any focused control first so Space/Enter activation can't confound
       the key press (we drive the binding, not a focused button). */
    await page.locator('body').press('k');
    await expect(audio).toHaveJSProperty('paused', true, { timeout: 3_000 });

    await page.locator('body').press('k');
    await expect(audio).toHaveJSProperty('paused', false, { timeout: 3_000 });
  });
});
