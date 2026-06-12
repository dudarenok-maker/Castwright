import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * The cast-drawer must-pass regression.
 *
 * The Status pill's hover/tap popover replaced the click-modal specifically so
 * that managing the TTS model from WITHIN the cast (profile) drawer no longer
 * dismisses the drawer. Two things this spec locks, in a real browser (jsdom
 * can't model paint order / portal stacking):
 *
 *   1. Opening the Status popover while the cast drawer is open does NOT close
 *      the drawer. (The drawer now tucks under the top bar — `top-16` — so the
 *      Status pill is no longer hidden behind the drawer's backdrop, and the
 *      pill click reaches the pill instead of the backdrop's onClose.)
 *   2. Clicking a button INSIDE the popover (Load/Stop) does NOT close the
 *      drawer OR the popover. (The popover is a portaled subtree painted above
 *      the drawer's backdrop, and its root stops event propagation, so the
 *      backdrop's onClose never fires.)
 *
 * If either regresses we are "back where we started" — the explicit user ask.
 */

test.describe('Status popover ↔ cast drawer coexistence', () => {
  test('opening the popover and clicking Load/Stop inside it keeps the cast drawer open', async ({
    page,
  }) => {
    await goToConfirm(page);
    await waitForRouteReady(page);

    /* Open the cast (profile) drawer for Captain Halloran. The "Evidence from
       the manuscript" heading is the load-bearing "drawer is open" signal. */
    await page.getByRole('button', { name: /Open profile for Captain Halloran/i }).click();
    const drawerOpen = page.getByText(/Evidence from the manuscript/i);
    await expect(drawerOpen).toBeVisible({ timeout: 10_000 });

    /* Open the Status popover via the pill (the pill sits in the top bar,
       which the drawer no longer covers). The drawer must stay open. */
    await page.getByTestId('status-pill').click();
    const popover = page.getByTestId('status-popover');
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await expect(drawerOpen, 'drawer must stay open when the popover opens').toBeVisible();

    /* Click Stop on the Kokoro control INSIDE the popover (mock Kokoro is
       preloaded → "Stop (voice engine)" is present). This is the exact action
       that used to dismiss the drawer. */
    const stopButton = page.getByRole('button', { name: /^stop \(voice engine\)$/i }).first();
    await expect(stopButton).toBeVisible({ timeout: 5_000 });
    await stopButton.click();

    /* The must-pass: after clicking inside the popover, BOTH stay open. */
    await expect(drawerOpen, 'drawer must stay open after clicking Stop in the popover').toBeVisible();
    await expect(popover, 'popover must stay open after clicking Stop').toBeVisible();

    /* And the control actually acted — it flipped to Load. */
    await expect(page.getByRole('button', { name: /^load model \(voice engine\)$/i }).first()).toBeVisible(
      { timeout: 5_000 },
    );
    await expect(drawerOpen, 'drawer still open after the engine flipped').toBeVisible();
  });
});
