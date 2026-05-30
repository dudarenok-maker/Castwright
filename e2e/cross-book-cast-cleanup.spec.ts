import { test, expect } from '@playwright/test';

/**
 * Cross-book cast cleanup — fe-8 (profile-drawer duplicate chip) + fe-16
 * (Fallback (Kokoro) Status pill). Both cross redux/layout seams that
 * Vitest+jsdom can't fully exercise (the chip's candidate is computed in
 * layout.tsx off the voices slice + library series metadata; the fallback
 * pill rides the book-state hydrate into the cast slice).
 *
 * Mock fixture: opening "Eliza Gray" (Northern Star, bookId 'ns') — whose
 * cross-book partner "Eliza" (Carrick's Compass, 'cc') resolves to the same
 * Kore base voice — should surface the "Possible duplicate of …" chip in the
 * drawer (src/mocks/voices.ts carries both v_eliza + v_eliza_cc).
 *
 * The bulk-review (fe-9) + undo (fs-11) flows are covered in
 * e2e/voices-duplicate-review.spec.ts.
 */

test.describe('cross-book cast cleanup', () => {
  test('fe-8 — profile drawer surfaces the "Possible duplicate of …" chip', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    /* Visit #/voices first so the voice library + library-books series
       metadata hydrate (the chip's candidate is computed in layout off both).
       Then open Eliza Gray's profile drawer via the per-book cast URL — the
       same URL the #/voices onOpenCharacter navigation builds. */
    await page.goto('/#/voices');
    await expect(page.getByText('Eliza Gray').first()).toBeVisible({ timeout: 10_000 });
    /* The cast view's `?profile=` param is a CHARACTER id; Eliza Gray's id is
       'eliza' (her voiceId is 'v_eliza'). */
    await page.goto('/#/books/ns/cast?profile=eliza');

    /* The drawer opens for Eliza Gray. The chip names the cross-book partner
       + its book title. */
    const chip = page.getByRole('button', { name: /Possible duplicate of/i });
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toContainText('Eliza');

    /* Click → the duplicate-review modal opens pre-populated. */
    await chip.click();
    await expect(page.getByText(/Same person across books\?/)).toBeVisible({ timeout: 5_000 });
  });
});
