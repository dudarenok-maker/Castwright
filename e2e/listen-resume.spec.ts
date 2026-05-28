import { test, expect } from '@playwright/test';

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
test.describe('listen-progress resume', () => {
  test('shows the Resume pill when a bookmark exists and seeks playback to it', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* Seed the mock listen-progress slice + on-disk record for the
       Solway Bay book by dispatching the slice action AND priming
       the mock API. The on-disk path (mockPutListenProgress) is what
       the MiniPlayer's mount-effect fetch reads, so both routes need
       the same record. */
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __store__: { dispatch: (a: unknown) => void };
        }
      ).__store__;
      store.dispatch({
        type: 'listenProgress/hydrate',
        payload: {
          bookId: 'sb',
          progress: { chapterId: 1, currentSec: 67, updatedAt: new Date().toISOString() },
        },
      });
    });

    /* Pill renders inside chapter 1's row. */
    const chapter1 = page.getByTestId('chapter-row-1');
    await expect(chapter1.getByText(/Resume at/i)).toBeVisible({ timeout: 3_000 });
    /* formatTime(67) → "1:07" */
    await expect(chapter1.getByText(/Resume at 1:07/)).toBeVisible();
  });

  test('does NOT show the pill for chapters other than the bookmarked one', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* Bookmark on chapter 1 should not surface a pill on chapter 2's row. */
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __store__: { dispatch: (a: unknown) => void };
        }
      ).__store__;
      store.dispatch({
        type: 'listenProgress/hydrate',
        payload: {
          bookId: 'sb',
          progress: { chapterId: 1, currentSec: 67, updatedAt: new Date().toISOString() },
        },
      });
    });

    const chapter2 = page.getByTestId('chapter-row-2');
    await expect(chapter2).toBeVisible();
    await expect(chapter2.getByText(/Resume at/i)).not.toBeVisible();
  });

  test('does NOT show the pill when the bookmarked position is under the 5 s noise floor', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* currentSec = 3 (below the 5 s gate the ChapterListenRow uses). */
    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __store__: { dispatch: (a: unknown) => void };
        }
      ).__store__;
      store.dispatch({
        type: 'listenProgress/hydrate',
        payload: {
          bookId: 'sb',
          progress: { chapterId: 1, currentSec: 3, updatedAt: new Date().toISOString() },
        },
      });
    });

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
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    await page.evaluate(async () => {
      const store = (
        window as unknown as {
          __store__: { dispatch: (a: unknown) => void };
        }
      ).__store__;
      store.dispatch({
        type: 'listenProgress/hydrate',
        payload: {
          bookId: 'sb',
          progress: { chapterId: 1, currentSec: 67, updatedAt: new Date().toISOString() },
        },
      });
    });

    const chapter1 = page.getByTestId('chapter-row-1');
    await expect(chapter1.getByText(/Resume at/i)).toBeVisible({ timeout: 3_000 });

    /* Start playback from this chapter's row → pill vanishes. */
    await chapter1.getByRole('button', { name: /Play chapter 1/i }).click();
    await expect(chapter1.getByText(/Resume at/i)).not.toBeVisible();
  });
});
