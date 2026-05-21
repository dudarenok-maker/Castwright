/* Browser-level golden path for the Kokoro Load/Stop pill in the top bar.
 *
 * Runs against Vite in mock mode (`.env.e2e`) where the mock api keeps
 * Kokoro pre-loaded at startup (mirroring the real sidecar's eager-preload
 * behaviour per plan 14a). With the default Kokoro engine selected, the
 * top-bar Kokoro pill should read "Kokoro ready / Stop"; clicking Stop
 * flips it to "Kokoro idle / Load"; clicking Load brings it back.
 *
 * Pairs with the amended plan 14a invariant 3 and exercises the
 * useTtsLifecycle hook's per-engine Load/Stop side-effects through the
 * mock /api/sidecar/load + /unload round-trip in src/lib/api.ts. */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

test.describe('Kokoro Stop pill — bidirectional Load/Stop in the top bar', () => {
  test('starts ready, flips to idle on Stop, returns to ready on Load', async ({ page }) => {
    /* Walk the cold-boot path to the Confirm-cast view — that's the first
       stage where the global TTS pill renders (Layout's `showGlobalTtsPill`
       gate covers analysing / confirm / ready). The mock account default
       is `kokoro-v1` (per FRONTEND_ACCOUNT_DEFAULTS) so the engines-in-use
       selector resolves to {kokoro} and the Kokoro pill mounts. */
    await goToConfirm(page);

    /* Wait for the first /health probe to resolve and the pill to render
       its real state. The pill's button has aria-label
       "Stop (tts model)" when the engine is ready. The displayed text
       reads "Kokoro ready" via the engineLabel override. */
    const stopButton = page.getByRole('button', { name: /^stop \(tts model\)$/i }).first();
    await expect(stopButton).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Kokoro ready/i).first()).toBeVisible();

    /* Click Stop — pill should optimistically flip to "idle" before the
       /health repoll comes back, and the Load button replaces Stop. */
    await stopButton.click();
    const loadButton = page.getByRole('button', { name: /^load model \(tts model\)$/i }).first();
    await expect(loadButton).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Kokoro idle/i).first()).toBeVisible();

    /* Click Load — pill should flip back through "loading" then to "ready"
       again. The mock loadSidecar resolves after a short wait and the
       hook re-probes /health, picking up kokoroLoaded:true. */
    await loadButton.click();
    await expect(page.getByRole('button', { name: /^stop \(tts model\)$/i }).first()).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText(/Kokoro ready/i).first()).toBeVisible();
  });

  test('Coqui pill is NOT rendered when the book default is Kokoro', async ({ page }) => {
    /* Pills only render for engines in use. The Coqui pill would mislead
       a user on a Kokoro-default book — verify it's absent. */
    await goToConfirm(page);
    await expect(page.getByText(/Kokoro ready/i).first()).toBeVisible({ timeout: 5_000 });
    /* No element should read "Coqui XTTS ready / idle / unavailable". */
    await expect(page.getByText(/Coqui XTTS/i)).toHaveCount(0);
  });
});
