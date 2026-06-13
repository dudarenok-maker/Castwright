/* Browser-level golden path for the Kokoro Load/Stop control.
 *
 * Runs against Vite in mock mode (`.env.e2e`) where the mock api keeps
 * Kokoro pre-loaded at startup (mirroring the real sidecar's eager-preload
 * behaviour per plan 14a). With the default Kokoro engine selected, the
 * Kokoro control should read "Kokoro ready / Stop"; clicking Stop flips it
 * to "Kokoro idle / Load"; clicking Load brings it back.
 *
 * The TTS model-control pills live in the Status popover — so each test first
 * opens the popover via the compact Status pill (clicking the pill pins it
 * open; clicking Load/Stop inside does NOT close it).
 *
 * Pairs with the amended plan 14a invariant 3 and exercises the
 * useTtsLifecycle hook's per-engine Load/Stop side-effects through the
 * mock /api/sidecar/load + /unload round-trip in src/lib/api.ts. */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

/* Open the Status popover — the TTS controls live inside it. Clicking the
   Status pill pins the popover open (sticky). The pill renders from the first
   book-context stage (Layout's `showGlobalTtsPill` gate covers analysing /
   confirm / ready). */
async function openStatusPopover(page: import('@playwright/test').Page) {
  await page.getByTestId('status-pill').click();
  await expect(page.getByTestId('status-popover')).toBeVisible({ timeout: 5_000 });
}

test.describe('Kokoro Stop pill — bidirectional Load/Stop in the Status popover', () => {
  test('starts ready, flips to idle on Stop, returns to ready on Load', async ({ page }) => {
    /* Walk the cold-boot path to the Confirm-cast view — the first stage
       where the global Status pill renders. The mock account default is
       `kokoro-v1` (per FRONTEND_ACCOUNT_DEFAULTS) so the engines-in-use
       selector resolves to {kokoro} and the Kokoro control mounts. */
    await goToConfirm(page);
    await openStatusPopover(page);

    /* Wait for the first /health probe to resolve and the control to render
       its real state. The button has aria-label "Stop (voice engine)" when the
       engine is ready. The displayed text reads "Kokoro ready" via the
       engineLabel override. */
    const stopButton = page.getByRole('button', { name: /^stop \(voice engine\)$/i }).first();
    await expect(stopButton).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Kokoro ready/i).first()).toBeVisible();

    /* Click Stop — pill should optimistically flip to "idle" before the
       /health repoll comes back, and the Load button replaces Stop. */
    await stopButton.click();
    const loadButton = page.getByRole('button', { name: /^load model \(voice engine\)$/i }).first();
    await expect(loadButton).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Kokoro idle/i).first()).toBeVisible();

    /* Click Load — pill should flip back through "loading" then to "ready"
       again. The mock loadSidecar resolves after a short wait and the
       hook re-probes /health, picking up kokoroLoaded:true. */
    await loadButton.click();
    await expect(page.getByRole('button', { name: /^stop \(voice engine\)$/i }).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText(/Kokoro ready/i).first()).toBeVisible();
  });

  test('Coqui control is NOT rendered when the book default is Kokoro', async ({ page }) => {
    /* Controls only render for engines in use. The Coqui control would
       mislead a user on a Kokoro-default book — verify it's absent (inside
       the Status popover, where the TTS controls now live). */
    await goToConfirm(page);
    await openStatusPopover(page);
    await expect(page.getByText(/Kokoro ready/i).first()).toBeVisible({ timeout: 5_000 });
    /* No element should read "Coqui XTTS ready / idle / unavailable". */
    await expect(page.getByText(/Coqui XTTS/i)).toHaveCount(0);
  });
});
