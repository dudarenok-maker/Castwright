import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * Per-character engine + bespoke Qwen voice — plan 108, Wave 4.
 *
 * Drives a fresh book to the confirm-cast view, opens a character's
 * profile drawer, switches the per-character TTS engine to Qwen, and
 * exercises the bespoke voice-design sub-flow: the persona auto-fills
 * (mock returns a canned persona). The FIRST design has nothing to compare
 * against, so "Design & preview" auditions in place (no compare modal) and
 * the designed confirmation surfaces. A second design — now that a voice
 * exists — reads "Design & compare", stages a preview, and opens the A/B
 * "current vs proposed" modal (plan 161); "Use proposed voice" promotes +
 * stages it. Save then closes the drawer.
 *
 * Why browser-level: the engine selector → Qwen panel reveal crosses
 * redux (Character.ttsEngine state), the design fetch returns a binary
 * blob the drawer wraps in an <audio> src, and the series-scoped override
 * write fires on Save — the kind of layout + async-fetch + redux seam
 * Vitest+jsdom can lie about. Vitest covers the contracts in isolation
 * (src/modals/profile-drawer.test.tsx Qwen cases); this pins the click
 * chain in a real DOM.
 *
 * The mock backend (src/lib/api.ts) returns a canned persona for
 * generateVoiceStyle and a silent-WAV blob for designQwenVoice, so this
 * spec doesn't need a live Gemini key or TTS sidecar.
 */
test.describe('cast view → profile drawer → per-character Qwen voice', () => {
  test('switch a character to Qwen, design a bespoke voice, and save', async ({ page }) => {
    await goToConfirm(page);
    await waitForRouteReady(page);

    /* Open Captain Halloran's drawer — the most reliable character to
       find on the confirm-cast view (most evidence-rich in the mock). */
    const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    /* Drawer mounted — the preset "Model voice" picker proves hydration. */
    await expect(page.getByText(/Model voice/i).first()).toBeVisible({ timeout: 5_000 });

    /* Switch the per-character engine to Qwen. */
    const engineSelect = page.getByLabel('Voice engine for this character');
    await expect(engineSelect).toBeVisible();
    await engineSelect.selectOption('qwen');

    /* Qwen design panel appears; the persona auto-fills from the mock
       generator (the character had no voiceStyle in the fixture). */
    const panel = page.getByTestId('qwen-design-panel');
    await expect(panel).toBeVisible();
    const persona = page.getByTestId('qwen-persona-text');
    await expect(persona).not.toHaveValue('', { timeout: 5_000 });

    /* The preset Model-voice picker is hidden while Qwen is selected. */
    await expect(page.getByText(/Model voice/i)).toHaveCount(0);

    /* First design — nothing to compare against yet, so this is the one-shot
       "Design & preview": no compare modal, the designed confirmation surfaces
       directly. */
    const designBtn = page.getByTestId('qwen-design-voice');
    await expect(designBtn).toHaveText(/Design & preview/i);
    await expect(designBtn).toBeEnabled();
    await designBtn.click();
    await expect(page.getByTestId('qwen-designed-confirm')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('voice-compare-overlay')).toHaveCount(0);

    /* Re-design — now a voice exists, so the button reads "Design & compare"
       and opens the A/B "current vs proposed" modal (plan 161). */
    await expect(designBtn).toHaveText(/Design & compare/i);
    await designBtn.click();
    await expect(page.getByTestId('voice-compare-overlay')).toBeVisible({ timeout: 5_000 });
    /* Both audition sides + the editable proposed persona render. */
    await expect(page.getByTestId('voice-compare-current-play')).toBeVisible();
    await expect(page.getByTestId('voice-compare-proposed-play')).toBeVisible();
    await expect(page.getByTestId('voice-compare-persona')).not.toHaveValue('');

    /* Keep the proposed voice → promotes (mock) + stages it; the modal closes
       and the designed confirmation surfaces back in the drawer. */
    await page.getByTestId('voice-compare-approve').click();
    await expect(page.getByTestId('voice-compare-overlay')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId('qwen-designed-confirm')).toBeVisible({ timeout: 5_000 });

    /* Save — the drawer closes (the engine picker detaches). */
    await page.getByRole('button', { name: /Save changes/i }).click();
    await expect(engineSelect).toHaveCount(0, { timeout: 5_000 });
  });
});
