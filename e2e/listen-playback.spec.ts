/* Browser-level coverage for the second-highest-blast-radius surface:
 * opening a 'complete' book → Listen view → clicking play → the
 * MiniPlayer's <audio> element gets a real src and starts playing.
 *
 * Depends on the mock seed for 'sb' (Solway Bay) shipped in this same
 * change — without populated chapters under mocks, the Listen view's
 * "Play from the start" button stays disabled and there's nothing to
 * test. Mock audio URLs (stubAudioA/B) shipped 2026-05-17 with plan 20.
 *
 * Pairs with docs/features/37-e2e-playwright.md. */

import { test, expect } from '@playwright/test';

test.describe('listen view + mini-player', () => {
  test('opens Solway Bay listen view, clicks play, audio src + paused flip', async ({ page }) => {
    /* Direct navigation rather than clicking through the library so this
       spec stays orthogonal to the library-card click path covered by
       revision-diff.spec.ts. The mock seed populates state for 'sb'
       (the 'complete' fixture in src/data/books.ts) at module init. */
    await page.goto('/#/books/sb/listen');
    await expect(page).toHaveURL(/#\/books\/sb\/listen/);

    /* Header is "Loading…" until book-meta hydrates. Wait for the real
       title so the playlist below is also hydrated. */
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 }))
      .toBeVisible({ timeout: 5_000 });

    /* "Play from the start" enables once `listenable.length > 0` —
       i.e. once mockGetBookState's seeded chapters have hydrated into
       the chapters slice and the cross-book guard sees them. */
    const playButton = page.getByRole('button', { name: /Play from the start/i });
    await expect(playButton).toBeVisible({ timeout: 5_000 });
    await expect(playButton).toBeEnabled({ timeout: 5_000 });
    await playButton.click();

    /* Clicking play mounts the MiniPlayer in the Layout (see
       layout.tsx + mini-player.tsx). The <audio> element renders with
       className="hidden" but is still in the DOM and queryable. */
    const audio = page.locator('audio');
    await expect(audio).toHaveCount(1, { timeout: 3_000 });

    /* The src is set imperatively via el.src = audio.url inside the
       URL-landing effect (mini-player.tsx:52). mockGetChapterAudio
       returns the stub-b.mp3 URL bundled at src/mocks/audio/. */
    await expect(audio).toHaveJSProperty('paused', false, { timeout: 3_000 });
    const srcValue = await audio.evaluate((el: HTMLAudioElement) => el.src);
    expect(srcValue).toMatch(/stub-b\.mp3/);
  });
});
