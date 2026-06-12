import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * Single voice design — background-survivable with live progress (plan 196).
 *
 * Drives a fresh book to the confirm-cast view, opens a character's Profile
 * Drawer, switches the engine to Qwen, and clicks "Design & preview". The
 * single-design job runs as a detached background job via the Redux stream
 * middleware (using mock `mockStartSingleDesign` which emits phases then
 * completes in ~200 ms). The test asserts the feature's core promise:
 *
 *   1. The design runs to completion via the Redux middleware (not local
 *      await), dispatching `setQwenOverrideName` on the cast slice.
 *   2. The drawer reflects the designed state via the cast slice update.
 *   3. A completion toast announces "<name> is ready.".
 *   4. Closing the drawer (Save changes) and reopening shows the designed
 *      state — proving the work survived the close + reopen round-trip.
 *
 * Why browser-level: the "survives close" property crosses the profile-drawer
 * component lifecycle, the Redux `castDesign` slice, the stream middleware
 * (which owns the SSE loop and fires the toast), the `cast` slice
 * (setQwenOverrideName), and the Layout ProfileDrawer's re-open logic — all of
 * which Vitest+jsdom covers in isolation but can only be proven end-to-end in a
 * real browser.
 *
 * NOTE on the waveform assertion: `mockStartSingleDesign` resolves in ~200 ms
 * (120 ms + 80 ms). The `[data-testid="design-waveform"]` element is only
 * present while `state === 'running'` in the castDesign slice — a window too
 * narrow for a reliable Playwright assertion. The waveform check is therefore
 * DROPPED. The load-bearing assertions are the toast and the reopened designed
 * state, which are the actual acceptance bar for this feature.
 */

test.describe('single voice design → background-survivable', () => {
  test('single design completes via middleware, announces via toast, survives drawer close', async ({
    page,
  }) => {
    /* The goToConfirm helper takes ~7.6 s (analysis mock), plus drawer
       interaction + toast wait + reopen. Bump the budget so the test
       passes on a contended local box. */
    test.setTimeout(60_000);

    await goToConfirm(page);
    await waitForRouteReady(page);

    /* Open Captain Halloran's drawer (the most fixture-rich character; has
       evidence + voiceStyle, so the Qwen panel auto-fills a persona). */
    const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    /* Drawer mounted — evidence section proves hydration. */
    await expect(page.getByText(/Evidence from the manuscript/i)).toBeVisible({ timeout: 10_000 });

    /* Switch the per-character engine to Qwen. */
    const engineSelect = page.getByLabel('Voice engine for this character');
    await expect(engineSelect).toBeVisible();
    await engineSelect.selectOption('qwen');

    /* Qwen design panel appears; persona auto-fills from the mock persona
       generator (the drawer auto-generates a persona if none exists). */
    await expect(page.getByTestId('qwen-design-panel')).toBeVisible();
    const personaField = page.getByTestId('qwen-persona-text');
    await expect(personaField).not.toHaveValue('', { timeout: 5_000 });

    /* Ensure the design button is ready (persona must be non-empty). */
    const designBtn = page.getByTestId('qwen-design-voice');
    await expect(designBtn).toBeEnabled({ timeout: 5_000 });

    /* Click the design button — dispatches designSingleRequested which
       the stream middleware picks up and starts the mock SSE job.
       The mock resolves in ~200 ms (designing 120 ms + rendering 80 ms). */
    await designBtn.click();

    /* The completion toast announces the character's name — this is the
       primary "background job completed" signal. Fires via the middleware's
       onCharacterDesigned callback → notificationsActions.pushToast.
       Playwright auto-waits up to 8 s. */
    await expect(page.getByText(/is ready/i)).toBeVisible({ timeout: 8_000 });

    /* The drawer must reflect the designed state: the cast slice's
       setQwenOverrideName updated character.overrideTtsVoices.qwen.name, the
       drawer's useEffect for qwenOverrideName fired and set designedVoiceId,
       and the qwen-designed-confirm element renders once the Design pill
       finishes its 5 s linger (SUMMARY_LINGER_MS) and clears the snapshot —
       `designBusy` only drops to false when the slice clears back to null
       after the linger period. Budget: toast fires at ~200 ms; linger = 5 s;
       total wait from this point ≈ 5 s. Allow 10 s to absorb box jitter. */
    await expect(page.getByTestId('qwen-designed-confirm')).toBeVisible({ timeout: 10_000 });

    /* Close the drawer via Save changes. This saves ttsEngine:'qwen' and the
       designed voiceId to the character, then calls onClose. */
    await page.getByRole('button', { name: /Save changes/i }).click();

    /* The drawer is now closed (engine picker detaches). */
    await expect(engineSelect).toHaveCount(0, { timeout: 5_000 });

    /* SURVIVE CLOSE: Reopen the same character's drawer. The character in the
       cast slice now has ttsEngine:'qwen' + overrideTtsVoices.qwen.name set.
       The drawer initialises engineChoice='qwen' from character.ttsEngine and
       designedVoiceId from character.overrideTtsVoices.qwen.name. */
    await card.click();

    /* Drawer re-opens. */
    await expect(page.getByText(/Evidence from the manuscript/i)).toBeVisible({
      timeout: 10_000,
    });

    /* The Qwen panel is visible (engine is still Qwen). */
    await expect(page.getByTestId('qwen-design-panel')).toBeVisible({ timeout: 5_000 });

    /* The designed-confirmation badge is visible — the work survived the
       drawer close + reopen round-trip. */
    await expect(page.getByTestId('qwen-designed-confirm')).toBeVisible({ timeout: 5_000 });
  });
});
