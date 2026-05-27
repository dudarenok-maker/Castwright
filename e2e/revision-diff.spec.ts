import { test, expect } from '@playwright/test';

/* Plan 58 — file-level serial mode. The revisions poll cycle's SSE-
   like timing intermittently raced under parallel-worker contention. */
test.describe.configure({ mode: 'serial' });

/**
 * Revision-diff a/b audition pill — plan 20 follow-on (a/b audio for revisions).
 *
 * Asserts the integration bit Vitest can't cover: the revisions poll
 * resolves under VITE_USE_MOCKS and the pending-revisions action renders.
 * The affordance lives in the Status popover (not an inline top-bar pill), so
 * the test opens the popover (via the compact Status pill) and asserts the
 * "N revisions pending" action inside it. The full diff-player open + a/b
 * mutual exclusion logic is covered by `src/views/revision-diff.test.tsx`
 * (jsdom + spied <audio>), which doesn't need a populated chapters slice —
 * the e2e here just proves the polling effect → slice → Status-popover seam
 * is wired.
 *
 * Why not also click through to the player here: mock mode doesn't
 * hydrate chapters from the library payload (state.json hydration
 * throws in mocks), so RevisionDiffPlayer returns null when the
 * fixture's chapterId doesn't resolve. That's a separate gap to close
 * (would need either a mock chapters seed or a graceful fallback in
 * the player) — out of scope for this PR.
 */

test.describe('revision diff a/b audition pill', () => {
  test('pending-revisions action appears in the Status popover after opening a complete book under mocks', async ({
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
    await expect(
      page.getByTestId('status-popover-revisions').getByRole('button', { name: /\d+ revisions?/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
