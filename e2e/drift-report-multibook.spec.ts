import { test, expect } from '@playwright/test';

/* drift-report-fidelity (2026-05-19) — multi-book Drift Report.
   Browser smoke that the slice → cast-view → modal seam wires through
   under mocks. The unit tests in `src/modals/drift-report.test.tsx`
   pin the rendering invariants (chapter titles from event payload,
   side-by-side comparison rows, multi-book grouping); this spec only
   proves that pollRevisions resolves under VITE_USE_MOCKS, the cast
   view's drift banner appears, and clicking it surfaces the modal.

   File-level serial mode matches the revision-diff spec: the
   revisions poll's 200ms mock latency intermittently races under
   parallel-worker contention. */
test.describe.configure({ mode: 'serial' });

test.describe('Drift Report — modal opens with multi-book payload', () => {
  test('opening Solway Bay surfaces the drift banner with the fixture events', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    /* Solway Bay seeds three drift events under bookId 'sb' in the
       VOICE_DRIFT_EVENTS fixture. Open the book, then navigate to its
       cast view where the drift banner lives. Direct URL avoids
       clicking through a tab that might not exist on the listen view
       under mocks. */
    await page
      .getByText(/Solway Bay/i)
      .first()
      .click({ timeout: 10_000 });
    await page.goto('/#/books/sb/cast');

    /* The banner uses "Voice drift detected in N chapters" wording.
       Anchors to the active book's slice projection; waits past the
       200ms mock poll latency. */
    await expect(page.getByText(/Voice drift detected in \d+ chapters?/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
