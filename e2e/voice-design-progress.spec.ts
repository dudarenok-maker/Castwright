import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * Voice-design progress indicator — honest clock + ETA line while running.
 *
 * Drives a fresh book to the confirm-cast view, opens Captain Halloran's
 * Profile Drawer, switches the engine to Qwen, then FREEZES the Playwright
 * fake clock so the mock's internal `wait()` calls (which use `setTimeout`)
 * never resolve — leaving `DesignProgress` mounted indefinitely. The test
 * then asserts the two load-bearing invariants from plan 196 / A1:
 *
 *   1. The elapsed clock element (`data-testid="design-elapsed"`) is visible
 *      while the design is in flight.
 *   2. The honest ETA line (`data-testid="design-eta"`) is visible.
 *
 * Why fake clock? The mock `mockStartSingleDesign` resolves in ~200 ms
 * (120 ms + 80 ms via `setTimeout`). That window is too narrow for reliable
 * Playwright assertions (acknowledged in `single-voice-design-background.spec.ts`
 * which already dropped the waveform check for the same reason). By calling
 * `page.clock.install()` AFTER the persona auto-populates (so the 80 ms
 * persona-generation `wait` runs normally) but BEFORE clicking "Design &
 * preview", all subsequent `setTimeout` calls use the frozen fake clock —
 * the mock never advances past its first `await wait(120)`, and
 * `DesignProgress` stays mounted long enough for deterministic assertions.
 *
 * The clock-advance assertion ("elapsed text changes after 2.5 s") is
 * intentionally dropped: the fake clock also freezes DesignProgress's
 * `setInterval`, so the counter stays at "0:00". The component's tick
 * behaviour is already proven in unit tests (`design-progress.test.tsx`).
 * This spec guards the RENDER PATH — that the component actually mounts
 * through the real drawer / Redux / layout seams when a design is in flight.
 *
 * Why browser-level: `designBusy` crosses the profile-drawer component
 * lifecycle, the Redux `castDesign` slice, the stream middleware's
 * `beginSingle` dispatch, and the VoiceEnginePicker presentation layer —
 * seams that Vitest+jsdom covers only in isolation.
 */

test.describe('voice-design progress indicator', () => {
  test('shows elapsed clock and honest ETA line while a design is in flight', async ({ page }) => {
    /* goToConfirm takes ~7.6 s (analysis mock). Add budget for drawer
       interaction + clock setup. */
    test.setTimeout(60_000);

    await goToConfirm(page);
    await waitForRouteReady(page);

    /* Open Captain Halloran's drawer — the most fixture-rich character;
       has evidence + voiceStyle so the Qwen panel auto-fills a persona.
       Matches the selector used in single-voice-design-background.spec.ts. */
    const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    /* Drawer mounted — evidence section proves hydration. */
    await expect(page.getByText(/Evidence from the manuscript/i)).toBeVisible({ timeout: 10_000 });

    /* Switch the per-character engine to Qwen. This triggers auto-persona
       generation via `api.generateVoiceStyle` (mock: `wait(80)` then returns
       MOCK_PERSONA). We must let this 80 ms timer resolve BEFORE installing
       the fake clock — otherwise the textarea stays empty and the design
       button stays disabled. */
    const engineSelect = page.getByLabel('Voice engine for this character');
    await expect(engineSelect).toBeVisible();
    await engineSelect.selectOption('qwen');

    /* Wait for the Qwen panel to mount and the persona to auto-populate.
       The mock generateVoiceStyle resolves in ~80 ms; the timeout absorbs
       any local contention. */
    await expect(page.getByTestId('qwen-design-panel')).toBeVisible();
    const personaField = page.getByTestId('qwen-persona-text');
    await expect(personaField).not.toHaveValue('', { timeout: 5_000 });

    /* FREEZE THE CLOCK. Now that the persona is ready, install Playwright's
       fake clock. From this point on, every new `setTimeout` / `setInterval`
       in the browser context (including the mock's `wait()` calls) uses the
       frozen fake clock — they will not fire until we explicitly call
       `page.clock.runFor()` or `page.clock.resume()`. This keeps
       `DesignProgress` mounted indefinitely so we can assert on it. */
    await page.clock.install();

    /* Ensure the design button is enabled (persona non-empty). */
    const designBtn = page.getByTestId('qwen-design-voice');
    await expect(designBtn).toBeEnabled({ timeout: 5_000 });

    /* Click the design button. This dispatches `designSingleRequested`
       synchronously. The middleware intercepts it and dispatches `beginSingle`
       synchronously — setting `castDesign.active` to `{ kind:'single',
       state:'running' }` before the async `mockStartSingleDesign` even starts.
       React re-renders with `designBusy=true`, mounting `<DesignProgress>`.
       The mock's first `await wait(120)` then schedules a frozen timer —
       it never fires, so `settle()` is never called, and `DesignProgress`
       stays mounted. */
    await designBtn.click();

    /* THE LOAD-BEARING ASSERTIONS: both data-testid elements from
       DesignProgress must be visible while the design is in flight. */
    await expect(page.getByTestId('design-elapsed')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId('design-eta')).toBeVisible({ timeout: 3_000 });

    /* Restore real timers so the browser can clean up without hanging.
       The test is already passing at this point. */
    await page.clock.resume();
  });
});
