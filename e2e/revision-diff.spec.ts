import { test, expect } from '@playwright/test';

/* Plan 58 — file-level serial mode. The revisions poll cycle's SSE-
   like timing intermittently raced under parallel-worker contention. */
test.describe.configure({ mode: 'serial' });

/**
 * Revision-diff a/b audition pill — plan 20 follow-on (a/b audio for revisions).
 *
 * Asserts the integration bit Vitest can't cover: the revisions poll
 * resolves under VITE_USE_MOCKS, the pending-revisions action renders in the
 * Status popover, AND clicking it opens the review-mode A/B player against a
 * hydrated chapter. `sb` (Solway Bay) hydrates 18 chapters under mocks
 * (api.ts SB_CHAPTERS) and the mock pending revision targets chapterId 3, so
 * `RevisionDiffPlayer` resolves its chapter and mounts. The full per-segment
 * a/b mutual-exclusion logic stays covered by `src/views/revision-diff.test.tsx`
 * (jsdom + spied <audio>); this e2e pins the polling → slice → popover → player
 * open seam in a real browser.
 */

test.describe('revision diff a/b audition pill', () => {
  test('opens the review-mode A/B player from the Status popover after opening a complete book under mocks', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    /* Solway Bay is the 'complete' book in the mock library. */
    await page
      .getByText(/Solway Bay/i)
      .first()
      .click({ timeout: 10_000 });

    /* The revisions affordance lives in the Status popover. The Status pill
       is always present in a book context; clicking it pins the popover open.
       Wait for the revisions action to appear once the mock pollRevisions call
       resolves (≈200ms) and the slice flips loaded. */
    await page.getByTestId('status-pill').click();
    const openRevisions = page
      .getByTestId('status-popover-revisions')
      .getByRole('button', { name: /\d+ revisions?/i });
    await expect(openRevisions).toBeVisible({ timeout: 10_000 });

    /* Clicking through opens the review-mode player. The chapters slice is
       hydrated by now (Layout's getBookState effect ran on book open), so the
       revision's chapterId resolves and the player mounts in 'review' mode. */
    await openRevisions.click();
    const player = page.getByTestId('revision-diff-player');
    await expect(player).toBeVisible({ timeout: 10_000 });
    await expect(player).toHaveAttribute('data-mode', 'review');
  });
});
