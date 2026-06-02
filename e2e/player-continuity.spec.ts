/* Browser-level coverage for the player-continuity feature pack:
 *   fe-23 — auto-advance / continuous playback (chapter N ends → N+1 plays;
 *           with auto-advance off → stops).
 *   fe-24 — skip forward / back (±N s) buttons advance / floor currentTime.
 *
 * Pairs with the unit specs in src/components/mini-player.test.tsx (onEnded
 * matrix + seekBy clamps) and src/store/settings-slice.test.ts (defaults +
 * clamps). Here we drive the same flow through the real <audio> element since
 * only the live element emits `ended` and honours currentTime writes against a
 * real decoded duration.
 *
 * Mock seed: 'sb' (Solway Bay) — same fixture listen-playback.spec.ts uses. */

import { test, expect, type Page } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

/* Serial so the audio-element tests don't race each other under parallel-worker
   contention on Windows (mirrors listen-playback + mini-player-features). */
test.describe.configure({ mode: 'serial' });

async function openSolwayBayAndPlay(page: Page): Promise<void> {
  await page.goto('/#/books/sb/listen');
  await waitForListenViewReady(page, /Solway Bay/i);
  await page.getByRole('button', { name: /Play from the start/i }).click();
  await expect(page.locator('audio')).toHaveCount(1, { timeout: 3_000 });
}

/* Flip the device-local auto-advance preference via the injected store
   (window.__store__, exposed in main.tsx under the DEV/e2e gate). */
async function setAutoAdvance(page: Page, value: boolean): Promise<void> {
  await page.evaluate((v) => {
    const store = (
      window as unknown as { __store__: { dispatch: (a: unknown) => void } }
    ).__store__;
    store.dispatch({ type: 'settings/setAutoAdvance', payload: v });
  }, value);
}

test.describe('fe-23 — auto-advance', () => {
  test('chapter end advances to the next chapter when auto-advance is on (default)', async ({
    page,
  }) => {
    await openSolwayBayAndPlay(page);
    const audio = page.locator('audio');
    await expect(audio).toHaveJSProperty('paused', false, { timeout: 3_000 });

    /* Fire the chapter-end event on the live element. onEnded sees
       autoAdvance=true + nextAvailable=true + no sleep timer → calls onNext,
       which moves currentTrack to chapter 2. */
    await audio.evaluate((el: HTMLAudioElement) => el.dispatchEvent(new Event('ended')));

    /* Chapter 2's row flips to its "Pause chapter 2" affordance (it became the
       playing track) and the audio element stays alive + unpaused. */
    const chapter2Row = page.getByTestId('chapter-row-2');
    await expect(chapter2Row.getByRole('button', { name: /Pause chapter 2/i })).toBeVisible({
      timeout: 5_000,
    });
    await expect(audio).toHaveJSProperty('paused', false, { timeout: 3_000 });
  });

  test('chapter end stops (no advance) when auto-advance is off', async ({ page }) => {
    await openSolwayBayAndPlay(page);
    const audio = page.locator('audio');
    await setAutoAdvance(page, false);

    await audio.evaluate((el: HTMLAudioElement) => el.dispatchEvent(new Event('ended')));

    /* Player pauses; chapter 2 never becomes the playing track. */
    await expect(audio).toHaveJSProperty('paused', true, { timeout: 3_000 });
    await expect(
      page.getByTestId('chapter-row-2').getByRole('button', { name: /Pause chapter 2/i }),
    ).toHaveCount(0);
  });
});

test.describe('fe-24 — skip forward / back', () => {
  test('skip-forward advances currentTime by the configured delta', async ({ page }) => {
    await openSolwayBayAndPlay(page);
    const audio = page.locator('audio');

    /* Wait for the element to know its (real) duration so the clamp has a
       valid upper bound, then park the playhead at a deterministic spot. */
    await expect
      .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.duration), { timeout: 5_000 })
      .toBeGreaterThan(0);
    await audio.evaluate((el: HTMLAudioElement) => {
      el.pause();
      el.currentTime = 0;
    });

    const before = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    await page.getByTestId('mini-player-skip-forward').click();
    const after = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    /* The stub MP3 is short (~0.65 s), so the +30 s skip clamps at duration —
       the only invariant we can assert across the tiny fixture is that the
       playhead moved forward (and never past the end). */
    expect(after).toBeGreaterThan(before);
    const dur = await audio.evaluate((el: HTMLAudioElement) => el.duration);
    expect(after).toBeLessThanOrEqual(dur + 0.001);
  });

  test('skip-back floors currentTime at 0', async ({ page }) => {
    await openSolwayBayAndPlay(page);
    const audio = page.locator('audio');

    await expect
      .poll(async () => audio.evaluate((el: HTMLAudioElement) => el.duration), { timeout: 5_000 })
      .toBeGreaterThan(0);
    /* Park near the start, then skip back 15 s — must floor at 0. */
    await audio.evaluate((el: HTMLAudioElement) => {
      el.pause();
      el.currentTime = Math.min(0.3, el.duration / 2);
    });
    await page.getByTestId('mini-player-skip-back').click();
    const after = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    expect(after).toBe(0);
  });
});
