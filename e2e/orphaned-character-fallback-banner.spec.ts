/* #2023 Piece 1 — the orphaned-characterId advisory banner on the Cast view.
 *
 * When a rendered sentence group carries a characterId with no entry in the
 * book's cast at all (a cast/analysis id drift — e.g. a romanisation
 * mismatch), the server falls back to the narrator's voice for that line and
 * now records the substitution (server/src/tts/synthesise-chapter.ts's
 * `renderedFallbackCharacterId`, aggregated by
 * `collectOrphanedCharacterFallbacks` into the book-state GET's
 * `orphanedCharacterFallbacks` map). Before this fix nothing on the wire ever
 * named the substitution — the render only logged it once per orphan id.
 *
 * Mirrors `e2e/generation/coqui-fallback-non-english.spec.ts`'s established
 * pattern for this exact class of render-time fact: mock-mode generation has
 * no per-character/per-line engine or attribution model, so it can never
 * produce `orphanedCharacterFallbacks` by actually walking a mock render
 * (server-side render contract is pinned by
 * `server/src/tts/synthesise-chapter.test.ts` and
 * `server/src/routes/book-state.test.ts` instead). What e2e CAN and does
 * assert directly is the resulting UI: dispatching the real
 * `cast/setOrphanedCharacterFallbacks` reducer (src/store/cast-slice.ts) —
 * the exact action the book-state GET's hydration path fires
 * (src/components/layout.tsx) — and checking the advisory banner
 * (src/views/cast.tsx) actually renders. This crosses the redux/component
 * seam (store.dispatch through to rendered DOM) at real browser layout/focus
 * timing, going beyond a jsdom unit test — but NOT the layout.tsx hydration
 * seam itself: the spec dispatches the reducer directly rather than driving
 * it through Layout's own getBookState hydrate effect, so it cannot catch a
 * regression in THAT wiring (see `src/components/layout.test.tsx`'s
 * "orphaned-characterId fallback banner (#2023)" describe block for the test
 * that pins layout.tsx's dispatch itself). */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/* Confirm the cast (fe-46: confirm lands on Cast first) without continuing
   on to the manuscript route, so the spec stays on `#/books/:id/cast` where
   the advisory banner lives. */
async function reachCastView(page: Page): Promise<void> {
  await goToConfirm(page);
  await page.getByRole('button', { name: /Confirm cast and design voices/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/cast/, { timeout: 5_000 });
  await waitForRouteReady(page);
}

/* Directly dispatches the real `cast/setOrphanedCharacterFallbacks` reducer —
   the same render-time fact the server's `collectOrphanedCharacterFallbacks`
   (server/src/audio/segments-io.ts) aggregates for real, which mock-mode
   generation has no way to reproduce (see header). Mirrors
   coqui-fallback-non-english.spec.ts's `seedRenderedCoquiFallback`. */
async function seedOrphanedFallback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __store__: { dispatch(a: unknown): void } }).__store__;
    store.dispatch({
      type: 'cast/setOrphanedCharacterFallbacks',
      payload: { mayrin: { characterId: 'narrator', voiceName: 'qwen-oduvan' } },
    });
  });
}

test.describe('cast view — orphaned-characterId advisory banner (#2023)', () => {
  test('shows the banner once the book-state hydrate carries an orphaned-id substitution', async ({
    page,
  }) => {
    await reachCastView(page);

    /* No substitution yet — the banner is absent. */
    await expect(page.getByTestId('orphaned-character-fallback-banner')).toHaveCount(0);

    await seedOrphanedFallback(page);

    /* The advisory banner renders, naming the orphaned id. */
    const banner = page.getByTestId('orphaned-character-fallback-banner');
    await expect(banner).toBeVisible({ timeout: 5_000 });
    await expect(banner).toContainText('mayrin');
  });
});
