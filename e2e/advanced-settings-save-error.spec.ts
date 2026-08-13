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

  /* #2209 review B1/B2/B3/B4 — the Revert half of this fix, end to end:
   * real click, real dispatch(resetKnob(...)).unwrap() (advanced.tsx),
   * real mockResetConfig cross-field pair-rule rejection (lib/api.ts,
   * mirrors server/src/config/pair-rules.ts), real per-row error region.
   * This is #2180's own regression shape ON THE RESET PATH: a valid pair
   * set via two saves, then Revert on just ONE half re-creates the exact
   * bad pair PUT would have refused outright — the Revert button could
   * silently produce it before this fix (Refs #2180 on-box register:
   * "the UI can no longer produce this state" — it still could, through
   * Revert).
   */
  test('Revert re-creating an invalid pair renders the pair-rule message inline, not an env-lock message', async ({
    page,
  }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);

    // Order matters: qa.asr.device must move to 'cuda' FIRST. Setting
    // computeType='float16' while device is still its default ('cpu')
    // would itself be an invalid pair and get refused immediately —
    // this exact ordering mistake was caught authoring this spec (the
    // save silently failed, leaving computeType exactly where it
    // started, which is a good demonstration of why req 1's message
    // needs to be visible in the first place).
    const deviceInput = page.getByLabel('Content-QA (Whisper) device');
    await expect(deviceInput).toBeVisible({ timeout: 10_000 });
    await deviceInput.click({ clickCount: 3 });
    await deviceInput.fill('cuda');
    await deviceInput.press('Tab');
    await expect(deviceInput).toHaveValue('cuda');

    const computeTypeSelect = page.getByLabel('Content-QA (Whisper) compute type');
    await computeTypeSelect.selectOption('float16');
    // cuda + float16 is a SUPPORTED pair — this save succeeds, no error.
    await expect(computeTypeSelect).not.toHaveAttribute('aria-invalid', 'true');

    // Revert qa.asr.device back to its default (cpu) while
    // qa.asr.computeType stays pinned at float16 — cpu+float16 is exactly
    // the bad pair PUT would have refused; the reset must refuse it too.
    // Scoped to THIS row's own outer container (class "py-3", the whole
    // OverrideRow — not the tighter control-row div) — qa.asr.computeType
    // is ALSO overridden at this point (its own save above), so it has
    // its OWN "Revert" button on the page too; an unscoped getByRole
    // would be ambiguous between the two.
    const deviceRow = page.locator('div.py-3').filter({ has: deviceInput });
    await deviceRow.getByRole('button', { name: /^revert$/i }).click();

    const error = page.getByTestId('knob-save-error-qa.asr.device');
    await expect(error).toBeVisible({ timeout: 5_000 });
    await expect(error).toContainText(/qa\.asr\.device=cpu \+ qa\.asr\.computeType=float16/i);
    await expect(error).toContainText(/couldn't save/i);
    // The wrong half of the original bug: reset can only ever 400 (no
    // locked check exists on the reset route), never 409.
    await expect(error).not.toContainText(/pinned in your environment/i);

    // A rejected reset leaves the redux value untouched — still 'cuda',
    // not silently reverted to the default it failed to reach.
    await expect(deviceInput).toHaveValue('cuda');
  });
});
