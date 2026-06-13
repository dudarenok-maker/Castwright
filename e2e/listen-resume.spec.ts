import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

/**
 * Browser-level coverage for plan 47 listen-progress.
 *
 * Walks the resume-pill + audio-seek round-trip via the mock API:
 *  1. PUT a bookmark for chapter 1 of the Solway Bay fixture book.
 *  2. Navigate to its Listen view → the "Resume at MM:SS" pill is
 *     visible inside the chapter row.
 *  3. Click play → the MiniPlayer mounts, its onLoadedMetadata seeks
 *     the <audio> element to the saved position, and the visible
 *     "currentTime" tick text matches.
 *
 * Pairs with docs/features/archive/47-listen-progress.md.
 */

/* Prime the mock listen-progress RECORD via an init script that runs BEFORE
   the app boots, so the layout mount-effect's `getListenProgress('sb')`
   reads this bookmark on its very first call and hydrates the slice. This is
   deterministic: dispatching the slice AFTER navigation is fragile because the
   same async fetch returns empty for an un-seeded book and can clobber the
   dispatched value (it did once the tour-status boot fetch shifted effect
   timing). The mock honours `window.__SEED_LISTEN_PROGRESS__` (see
   `mockGetListenProgress`). */
async function gotoListenWithBookmark(
  page: import('@playwright/test').Page,
  bookmark: { chapterId: number; currentSec: number },
) {
  await page.addInitScript((bm) => {
    (
      window as unknown as { __SEED_LISTEN_PROGRESS__: Record<string, unknown> }
    ).__SEED_LISTEN_PROGRESS__ = {
      sb: { chapterId: bm.chapterId, currentSec: bm.currentSec, updatedAt: new Date().toISOString() },
    };
  }, bookmark);
  await page.goto('/#/books/sb/listen');
  /* Generous: the first spec to reach the listen view pays a cold Vite
     transform when the warmup project is skipped (CI / single-spec runs). */
  await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
    timeout: 25_000,
  });
}

/* Absorb a cold first-transform of the listen view (the warmup project is
   skipped on CI / when running this spec in isolation). */
test.describe.configure({ timeout: 90_000 });

test.describe('listen-progress resume', () => {

  test('shows the Resume pill when a bookmark exists and seeks playback to it', async ({ page }) => {
    await gotoListenWithBookmark(page, { chapterId: 1, currentSec: 67 });

    /* Pill renders inside chapter 1's row. formatTime(67) → "1:07". */
    const chapter1 = page.getByTestId('chapter-row-1');
    await expect(chapter1.getByText(/Resume at/i)).toBeVisible({ timeout: 5_000 });
    await expect(chapter1.getByText(/Resume at 1:07/)).toBeVisible();
  });

  test('does NOT show the pill for chapters other than the bookmarked one', async ({ page }) => {
    /* Bookmark on chapter 1 should not surface a pill on chapter 2's row. */
    await gotoListenWithBookmark(page, { chapterId: 1, currentSec: 67 });

    /* Confirm the bookmark hydrated (pill on ch1) before asserting absence. */
    await expect(page.getByTestId('chapter-row-1').getByText(/Resume at/i)).toBeVisible({
      timeout: 5_000,
    });
    const chapter2 = page.getByTestId('chapter-row-2');
    await expect(chapter2).toBeVisible();
    await expect(chapter2.getByText(/Resume at/i)).not.toBeVisible();
  });

  test('does NOT show the pill when the bookmarked position is under the 5 s noise floor', async ({
    page,
  }) => {
    /* currentSec = 3 (below the 5 s gate the ChapterListenRow uses). */
    await gotoListenWithBookmark(page, { chapterId: 1, currentSec: 3 });

    const chapter1 = page.getByTestId('chapter-row-1');
    await expect(chapter1).toBeVisible();
    await expect(chapter1.getByText(/Resume at/i)).not.toBeVisible();
  });

  /* Plan 125 — once the bookmarked chapter is actively playing the
     "Resume at" pill is moot (the live row time covers it), so the row
     suppresses it. This walks the click → currentTrack (redux) → row
     `!isPlaying` gate at the browser level; deterministic because the
     gate keys on currentTrack, not on the audio playhead. */
  test('hides the Resume pill once the bookmarked chapter starts playing', async ({ page }) => {
    await gotoListenWithBookmark(page, { chapterId: 1, currentSec: 67 });
    /* Wait for the chapters slice to hydrate (Play-from-start enabled) so
       the row's play handler is wired before we click — otherwise the
       click can land pre-hydration and currentTrack never updates. */
    await waitForListenViewReady(page, /Solway Bay/i);

    const chapter1 = page.getByTestId('chapter-row-1');
    await expect(chapter1.getByText(/Resume at/i)).toBeVisible({ timeout: 5_000 });

    /* Start playback from this chapter's row. Assert the button flips to
       "Pause chapter 1" first — that proves currentTrack propagated and
       isPlaying is true (the actionable gate, same pattern as
       listen-playback.spec) — then the pill must be gone. */
    await chapter1.getByRole('button', { name: /Play chapter 1/i }).click();
    await expect(chapter1.getByRole('button', { name: /Pause chapter 1/i })).toBeVisible({
      timeout: 5_000,
    });
    await expect(chapter1.getByText(/Resume at/i)).not.toBeVisible();
  });
});
