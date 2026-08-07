/* #2209 — a rejected config save must surface the server's own message,
 * inline next to the control that caused it, rather than silently
 * discarding it (the control just snapped back to its previous value with
 * no explanation).
 *
 * Drives a REAL rejected save through mockPutConfig's qa.asr.device
 * pattern check (src/lib/api.ts) — the exact "cuda1 typo" example #2180's
 * own writeup and this issue both name, on the exact knob the real server
 * validates the same way (server/src/config/registry.ts's `qa.asr.device`
 * pattern). All assertions run in mock mode (VITE_USE_MOCKS=true), same
 * convention as e2e/advanced-settings.spec.ts — no route stub, no new
 * fixture pattern.
 */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

/* Same rationale as advanced-settings.spec.ts: serialize this file's tests
 * so a cold #/advanced route-chunk load never piles onto a sibling spec's
 * under peak parallel-worker contention. */
test.describe.configure({ mode: 'serial' });

test.describe('Advanced Settings — save-error surfacing (#2209)', () => {
  test('a rejected save renders the server message inline, next to the control, and reverts the field', async ({
    page,
  }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);

    /* "Content-QA (Whisper) device" (qa.asr.device) — group qa-gates,
       collapsedByDefault:false, risk:medium — open on load. */
    const input = page.getByLabel('Content-QA (Whisper) device');
    await expect(input).toBeVisible({ timeout: 10_000 });
    await expect(input).toHaveValue('cpu');

    await input.click({ clickCount: 3 });
    await input.fill('cuda1');
    await input.press('Tab');

    /* The server's own message — naming the field and the required shape —
       must reach the DOM verbatim, not a generic "failed to save". */
    await expect(
      page.getByText(/qa\.asr\.device: does not match the required shape/i),
    ).toBeVisible({ timeout: 5_000 });

    /* A rejected save leaves the redux value untouched, so the field falls
       back to the last known-good value rather than staying frozen on the
       unsaved "cuda1" with no visible sign the save never landed. */
    await expect(input).toHaveValue('cpu');
  });

  test('a subsequent successful save on the same row clears the error', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);

    const input = page.getByLabel('Content-QA (Whisper) device');
    await expect(input).toBeVisible({ timeout: 10_000 });

    await input.click({ clickCount: 3 });
    await input.fill('cuda1');
    await input.press('Tab');
    await expect(
      page.getByText(/qa\.asr\.device: does not match the required shape/i),
    ).toBeVisible({ timeout: 5_000 });

    await input.click({ clickCount: 3 });
    await input.fill('cuda:1');
    await input.press('Tab');

    await expect(
      page.getByText(/qa\.asr\.device: does not match the required shape/i),
    ).not.toBeVisible({ timeout: 5_000 });
    await expect(input).toHaveValue('cuda:1');
  });
});
