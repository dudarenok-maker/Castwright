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

/* Plan 58 — un-quarantined 2026-05-19. The earlier quarantine was a
   parallel-worker contention problem: the audio.currentTime poll
   raced other workers' SSE traffic on Windows. file-level serial mode
   keeps this spec's tests in one worker while other spec files still
   parallelise, recovering most throughput without the flake. */
test.describe.configure({ mode: 'serial' });

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
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 5_000,
    });

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

    /* Duration-tick assertion: with a real bundled MP3 driving the
       element (stub-b.mp3, ~88 KB, 880 Hz tone) the browser will
       advance `currentTime` once playback starts. Chromium needs
       time to fetch the bundled MP3, parse headers, decode, and emit
       the first onTimeUpdate — empirically ~500 ms warm but up to
       several seconds when the pre-push verify shares a busy box
       with concurrent specs and stale chrome instances. 8 s budget
       keeps the spec well under its overall wall-clock without
       false-failing under load. Deleting
       `setCurrentSec(e.currentTarget.currentTime)` in
       src/components/mini-player.tsx would not break this assertion
       (we read `currentTime` directly on the <audio>), but deleting
       the imperative `el.src = audio.url` or the play() call would —
       this case pins the play seam, not the React state update. */
    await expect
      .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.currentTime), {
        timeout: 8_000,
        message: 'audio currentTime should advance past zero after play()',
      })
      .toBeGreaterThan(0);

    /* Chapter-switch: clicking a different chapter row's play button
       reloads the MiniPlayer's <audio> with that chapter's URL. In
       mock mode both chapters resolve to stubAudioB so the src is
       identical, but loading a fresh metadata cycle resets
       currentTime — assert the row's "playing" affordance flips to
       chapter 2 and the audio stays unpaused. Locator: stable
       data-testid added to ChapterListenRow for this case. */
    const chapter2Row = page.getByTestId('chapter-row-2');
    await expect(chapter2Row).toBeVisible({ timeout: 3_000 });
    await chapter2Row.getByRole('button', { name: /Play chapter 2/i }).click();
    /* The newly-clicked row's button label flips to "Pause chapter 2"
       once `currentTrack` updates and isPlaying becomes true. */
    await expect(chapter2Row.getByRole('button', { name: /Pause chapter 2/i })).toBeVisible({
      timeout: 3_000,
    });
    /* Audio element stays alive and unpaused through the switch (the
       URL-landing effect kicks off a new load + play). */
    await expect(audio).toHaveJSProperty('paused', false, { timeout: 3_000 });
  });
});
