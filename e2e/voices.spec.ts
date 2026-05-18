import { test, expect } from '@playwright/test';

/**
 * Voice library pin/unpin round-trip — plan 37 follow-on.
 *
 * The selection + Compare gating story is covered by voices-compare.spec.ts.
 * This spec pins the *other* user action on the Voice library: pin/unpin.
 * Browser-level rather than Vitest+jsdom because the affordance is a tiny
 * round button rendered in a Tailwind grid — easy to dislodge with a class
 * rename, easy to miss in unit tests, and the optimistic-UI revert path
 * (api.setVoicePin failure → slice flips back) wants real-network framing.
 *
 * Asserts: aria-pressed reflects pin state, the accessible name swaps
 * between "Pin voice" and "Unpin voice", and the "Pinned" StatTile in the
 * page header tracks the count.
 */

test.describe('voice library pin/unpin', () => {
  test('global #/voices: pin button toggles aria-pressed and the Pinned StatTile', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    await page.goto('/#/voices');

    /* Voice cards from across the workspace render under the global tab.
       Captain Halloran is the deterministic target — same one
       voices-compare.spec.ts uses, present in the seeded `sb` mock. */
    await expect(page.getByText('Captain Halloran').first()).toBeVisible({ timeout: 10_000 });

    /* Pinned StatTile in the page header starts at 0 — no mock voices ship
       with `pinned: true` (see src/lib/api.ts MOCK_VOICE_LIBRARY). */
    const pinnedStat = page.locator('div', { hasText: /^Pinned/ }).getByText(/^\d+$/).first();
    await expect(pinnedStat).toHaveText('0');

    /* Locate Captain Halloran's voice card and the pin button on it. The
       button's accessible name is "Pin voice" before press, "Unpin voice"
       after — voice-library-panel.tsx:199. aria-pressed mirrors the state. */
    const card = page.locator('div.group', { hasText: 'Captain Halloran' }).first();
    const pinBtn = card.getByLabel('Pin voice');
    await expect(pinBtn).toBeVisible();
    await expect(pinBtn).toHaveAttribute('aria-pressed', 'false');

    await pinBtn.click();

    /* After pin: same DOM node, new accessible name + aria-pressed flipped.
       StatTile increments. */
    const unpinBtn = card.getByLabel('Unpin voice');
    await expect(unpinBtn).toBeVisible();
    await expect(unpinBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(pinnedStat).toHaveText('1');

    /* Round-trip: unpin returns to the initial state. */
    await unpinBtn.click();
    await expect(card.getByLabel('Pin voice')).toHaveAttribute('aria-pressed', 'false');
    await expect(pinnedStat).toHaveText('0');
  });
});
