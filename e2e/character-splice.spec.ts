import { test, expect } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * fs-26 — per-character "Fix audio" (loudness / re-record splice).
 *
 * Pins the layout ↔ profile-drawer ↔ modal seam: the cast profile drawer
 * carries the new "Fix … audio" affordance, and clicking it opens the
 * FixCharacterAudioModal with its mode toggles + chapter-selection UI.
 *
 * Why browser-level: the button lives on the shared <Layout/> ProfileDrawer
 * (src/components/layout.tsx) and opens a modal keyed by the open character —
 * a layout + redux + modal-state seam jsdom can lie about. The full
 * run-to-completion (one splice per chapter, pending revisions) is unit-tested
 * with a mocked api.streamSplice in src/modals/fix-character-audio.test.tsx;
 * here we just prove the seam mounts. On the confirm-cast view no chapters are
 * rendered yet, so the modal shows its empty-state — which still exercises the
 * mode toggles and the candidate filter.
 */
test.describe('cast profile drawer → Fix audio modal', () => {
  test('opens the Fix audio modal with loudness/re-record controls', async ({ page }) => {
    await goToConfirm(page);
    await waitForRouteReady(page);

    const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    /* The drawer mounted (evidence section proves hydration). */
    await expect(page.getByText(/Evidence from the manuscript/i)).toBeVisible({ timeout: 10_000 });

    /* The fs-26 affordance. */
    const fixBtn = page.getByRole('button', { name: /Fix .*audio \(loudness \/ re-record\)/i });
    await expect(fixBtn).toBeVisible();
    await fixBtn.click();

    /* Modal opens with both modes + the loudness slider (remix is default).
       Assert on modal-unique copy so we don't collide with the drawer behind. */
    await expect(page.getByText(/Boost a too-quiet voice/i)).toBeVisible();
    await expect(page.getByText(/Re-synthesise the lines/i)).toBeVisible();
    await expect(page.getByLabel(/Loudness boost in decibels/i)).toBeVisible();
  });
});
