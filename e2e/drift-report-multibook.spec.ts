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

    /* Solway Bay seeds six drift events under bookId 'sb' in the
       VOICE_DRIFT_EVENTS fixture (4 Eliza events sharing one snapshot
       plus singleton events for Halloran and Marcus). Open the book,
       then navigate to its cast view where the drift banner lives.
       Direct URL avoids clicking through a tab that might not exist on
       the listen view under mocks. */
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

  /* Plan 91 — consolidated cards. The Solway Bay drift fixture
     (`src/data/drift.ts`) carries 4 Eliza events sharing one snapshot
     plus singleton events for Halloran and Marcus, so the modal should
     render 3 cards for `sb` (not 6). The Eliza card carries an expand
     toggle + bulk Regen-all + Dismiss-all, none of which existed in the
     pre-91 per-event card. */
  test('clicking the drift banner opens the modal with a consolidated Eliza card', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });
    await page
      .getByText(/Solway Bay/i)
      .first()
      .click({ timeout: 10_000 });
    await page.goto('/#/books/sb/cast');

    /* Wait for the banner, then click it to open the modal. */
    const banner = page.getByText(/Voice drift detected in \d+ chapters?/i);
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await banner.click();

    /* Modal header preserves the per-chapter count (not per-card). */
    await expect(page.getByText(/6 chapters flagged/i)).toBeVisible({ timeout: 5_000 });

    /* Eliza's 4 same-snapshot events collapse to ONE card with a
       "4 chapters" badge and an expand toggle. */
    const elizaToggle = page.getByTestId(/^drift-group-toggle-/);
    await expect(elizaToggle).toBeVisible();
    await expect(page.getByText(/Show 4 chapters/i)).toBeVisible();

    /* Bulk Regen-all surfaces on the consolidated card. */
    await expect(page.getByTestId(/^drift-group-regen-all-/).first()).toBeVisible();

    /* Halloran's single-chapter group renders its action row inline —
       no group-level toggle for that card. The DOM contains exactly one
       group-toggle button (Eliza's) since the other two `sb` groups are
       single-chapter. */
    await expect(page.getByTestId(/^drift-group-toggle-/)).toHaveCount(1);
  });
});
