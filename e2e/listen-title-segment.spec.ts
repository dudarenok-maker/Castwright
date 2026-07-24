/* fs-10 (#412) — browser-level coverage for the chapter-title band on the
 * Listen view's mini-player scrubber.
 *
 * Scope: the band's presence and labelling only. The segment-index fix that
 * shipped alongside it (spec §5) lives at a wire→disk seam that mock mode has
 * no way to reach, so it is covered by the server + resolver unit tests. */

import { test, expect, type Page } from '@playwright/test';

/* Serial for the same reason as mini-player-features.spec.ts: audio-element
   tests race each other under parallel-worker contention on Windows. */
test.describe.configure({ mode: 'serial' });

async function openSolwayBay(page: Page): Promise<void> {
  await page.goto('/#/books/sb/listen');
  await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
    timeout: 10_000,
  });
}

async function startPlaybackFromStart(page: Page): Promise<void> {
  const playButton = page.getByRole('button', { name: /Play from the start/i });
  await expect(playButton).toBeVisible({ timeout: 5_000 });
  await expect(playButton).toBeEnabled({ timeout: 5_000 });
  await playButton.click();
  await expect(page.locator('audio')).toHaveCount(1, { timeout: 3_000 });
}

test.describe('fs-10 — chapter-title band', () => {
  test('renders at the head of the mini-player scrubber, labelled', async ({ page }) => {
    await openSolwayBay(page);
    await startPlaybackFromStart(page);

    const band = page.getByTestId('mini-player-title-segment');
    await expect(band).toBeVisible({ timeout: 5_000 });
    await expect(band).toHaveAttribute('title', /^Chapter title · /);
  });

  test('is not a control — it adds no control to the player', async ({ page }) => {
    await openSolwayBay(page);
    await startPlaybackFromStart(page);

    const band = page.getByTestId('mini-player-title-segment');
    await expect(band).toBeVisible({ timeout: 5_000 });

    /* The band must not become a tab stop or a named control — the whole point
       of §6.1 is that it is a cue, not a competing affordance over the
       scrubber. Asserting the click-through behaviour itself belongs in the
       Vitest spec, where the scrubber's rect can be stubbed; in a real browser
       the band is ~4 px wide and distinguishing "scrubbed to 2 px" from
       "hard-seeked to 0" would be a flake, not a test. */
    await expect(band).not.toHaveAttribute('tabindex');
    expect(await band.evaluate((el) => el.tagName)).toBe('SPAN');
  });
});
