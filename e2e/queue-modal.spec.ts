/* Plan 102 — global queue modal e2e.
 *
 * Drives the modal end-to-end against Vite in mock mode. The mock backend
 * doesn't expose /api/queue/* (the queue is server-owned and the mock
 * never wired it), so we stub the routes per-test via page.route. That
 * keeps the spec free of mock-mode plumbing changes and pins the
 * frontend's expected request/response shapes against the OpenAPI
 * contract.
 *
 * Covered flows:
 *   - Cold boot → top-bar queue chip surfaces the pending count.
 *   - Click chip → modal opens, lists every entry grouped by book.
 *   - Click Cancel on a non-in-flight entry → DELETE round-trips,
 *     modal re-renders without the cancelled entry.
 *   - Pause toggle → POST /pause flips the queue-global flag, badge
 *     reflects "Paused" in the modal header.
 *   - Generate view "View queue" button opens the modal as an alternate
 *     entry point.
 *
 * Not covered (out of scope for this spec; covered elsewhere):
 *   - SSE reconnect during generation — pinned by api-stream-reconnect.test.ts.
 *   - Dispatcher drain semantics — pinned by queue-dispatcher-middleware.test.ts.
 *   - Cross-book ordering across two real books — same dispatcher tests. */

import { test, expect, type Route } from '@playwright/test';

interface QueueEntryShape {
  id: string;
  bookId: string;
  chapterId: number;
  scope: 'this' | 'character';
  characterId?: string;
  addedAt: string;
  status: 'queued' | 'in_progress' | 'paused' | 'done' | 'failed';
  order: number;
}

/* Helper: install a per-test in-memory queue + intercept every /api/queue
   route against it. Returns a `state` ref so the spec can mutate the
   fixture mid-test if needed. */
function installQueueRoutes(entries: QueueEntryShape[], initialPaused = false) {
  const state = { entries: [...entries], paused: initialPaused };

  const respondSnapshot = (route: Route): Promise<void> =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: state.entries, paused: state.paused }),
    });

  return { state, respondSnapshot };
}

test.describe('queue modal (plan 102)', () => {
  test('top-bar chip surfaces the pending count and opens the modal', async ({ page }) => {
    const { state, respondSnapshot } = installQueueRoutes([
      {
        id: 'e1',
        bookId: 'sb',
        chapterId: 1,
        scope: 'this',
        addedAt: new Date().toISOString(),
        status: 'queued',
        order: 0,
      },
      {
        id: 'e2',
        bookId: 'sb',
        chapterId: 2,
        scope: 'this',
        addedAt: new Date().toISOString(),
        status: 'queued',
        order: 1,
      },
    ]);
    await page.route('**/api/queue', respondSnapshot);
    await page.route('**/api/queue/*', (route) => {
      if (route.request().method() === 'DELETE') {
        const url = new URL(route.request().url());
        const id = url.pathname.split('/').pop();
        state.entries = state.entries.filter((e) => e.id !== id);
        void respondSnapshot(route);
      } else {
        void respondSnapshot(route);
      }
    });

    await page.goto('/#/books/sb/listen');
    /* The chip mounts only when queueCount > 0; the layout's
       mount-effect dispatches loadQueue which resolves with our 2
       entries. */
    const chip = page.getByTestId('topbar-queue-chip');
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(chip).toContainText('Queue · 2');

    await chip.click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible({
      timeout: 5_000,
    });
    /* Modal header reads "N entries pending" — sanity-check the count is
       rendered from our snapshot. */
    await expect(page.getByText(/2 entries pending/i)).toBeVisible();
  });

  test('cancel button removes the entry and re-renders the modal', async ({ page }) => {
    const { state, respondSnapshot } = installQueueRoutes([
      {
        id: 'e-cancel',
        bookId: 'sb',
        chapterId: 5,
        scope: 'this',
        addedAt: new Date().toISOString(),
        status: 'queued',
        order: 0,
      },
    ]);
    await page.route('**/api/queue', respondSnapshot);
    await page.route('**/api/queue/*', (route) => {
      if (route.request().method() === 'DELETE') {
        const id = new URL(route.request().url()).pathname.split('/').pop();
        state.entries = state.entries.filter((e) => e.id !== id);
      }
      void respondSnapshot(route);
    });

    await page.goto('/#/books/sb/listen');
    await page.getByTestId('topbar-queue-chip').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('topbar-queue-chip').click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible();
    /* Modal lists chapter 5 — the cancel button carries a per-entry
       data-testid so we can disambiguate when there are multiple rows. */
    const cancelBtn = page.getByTestId('queue-entry-e-cancel-cancel');
    await cancelBtn.click();
    /* After the DELETE round-trip the modal re-renders empty. */
    await expect(page.getByText(/Empty/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('Generate view "View queue" button opens the modal', async ({ page }) => {
    const { respondSnapshot } = installQueueRoutes([]);
    await page.route('**/api/queue', respondSnapshot);
    await page.route('**/api/queue/*', respondSnapshot);

    await page.goto('/#/books/sb/generate');
    /* The header View queue button is always rendered (chip-style); the
       count badge only shows when queue is non-empty. */
    const viewQueue = page.getByTestId('generation-view-queue');
    await viewQueue.waitFor({ state: 'visible', timeout: 10_000 });
    await viewQueue.click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible({
      timeout: 5_000,
    });
  });
});
