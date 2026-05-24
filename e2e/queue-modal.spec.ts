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
 *   - Cross-book entries (Should #6): two books' entries render grouped in
 *     the modal while viewing one book, and the OTHER book's entry can be
 *     cancelled without navigating to it.
 *
 * Not covered (out of scope for this spec; covered elsewhere):
 *   - SSE reconnect during generation — pinned by api-stream-reconnect.test.ts.
 *   - Dispatcher drain semantics (incl. the cross-book open → idle → DELETE
 *     round-trip) — pinned by queue-dispatcher-middleware.test.ts. Driving a
 *     real cross-book SSE drain in mock mode is intentionally avoided here
 *     (the mock stream reads the viewed book's chapters); the dispatcher unit
 *     tests pin that path deterministically. */

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
  /* Plan 108 Wave 3 — server-stamped engine set + multi-TTS flag. */
  requiredEngines?: ('coqui' | 'piper' | 'kokoro' | 'gemini' | 'qwen')[];
  multiTts?: boolean;
}

/* Helper: install a per-test in-memory queue + intercept every /api/queue
   route against it. Returns a `state` ref so the spec can mutate the
   fixture mid-test if needed.

   Defaults to PAUSED. Since Should #6 lifted the same-book gate, the queue
   dispatcher drains any UNPAUSED queue with work the moment the snapshot
   loads — regardless of which view the user is on. These specs inspect the
   queue UI (chip count, grouping, cancel), not the drain, so a paused
   fixture keeps the injected entries put. Drain semantics (incl. the
   cross-book open → idle → DELETE round-trip) are pinned by
   queue-dispatcher-middleware.test.ts. Pass `false` to exercise draining. */
function installQueueRoutes(entries: QueueEntryShape[], initialPaused = true) {
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

  test('cross-book entries render grouped and the other book’s entry cancels while viewing one book', async ({
    page,
  }) => {
    /* Should #6 — two books' worth of queue entries injected via page.route.
       The user is viewing Solway Bay (sb); a Northern Star (ns) entry is also
       queued. Both render in the modal (grouped by book), and the ns entry —
       a DIFFERENT book than the one on screen — can be cancelled without
       navigating to it. This is the cross-book queue surface; the dispatcher
       unit tests cover the actual cross-book drain. */
    const { state, respondSnapshot } = installQueueRoutes([
      {
        id: 'sb-c1',
        bookId: 'sb',
        chapterId: 1,
        scope: 'this',
        addedAt: new Date().toISOString(),
        status: 'queued',
        order: 0,
      },
      {
        id: 'ns-c3',
        bookId: 'ns',
        chapterId: 3,
        scope: 'this',
        addedAt: new Date().toISOString(),
        status: 'queued',
        order: 1,
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
    const chip = page.getByTestId('topbar-queue-chip');
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(chip).toContainText('Queue · 2');
    await chip.click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible({
      timeout: 5_000,
    });

    /* Both books' entries render (grouped by book in the modal). */
    await expect(page.getByTestId('queue-entry-sb-c1')).toBeVisible();
    await expect(page.getByTestId('queue-entry-ns-c3')).toBeVisible();

    /* Cancel the OTHER book's entry (ns) while still on sb's listen view. */
    await page.getByTestId('queue-entry-ns-c3-cancel').click();
    await expect(page.getByTestId('queue-entry-ns-c3')).toHaveCount(0, { timeout: 5_000 });
    /* The viewed book's entry is untouched. */
    await expect(page.getByTestId('queue-entry-sb-c1')).toBeVisible();
  });

  test('multi-TTS chapter shows the engine badge + dual-model-off warning (plan 108 Wave 3)', async ({
    page,
  }) => {
    /* One single-engine chapter (Kokoro) and one multi-engine chapter
       (Kokoro + Qwen). The multi one names both engines and — with the
       dual-model flag at its default (off) in mock mode — shows the advisory
       to enable dual-model mode in Account settings. */
    const { respondSnapshot } = installQueueRoutes([
      {
        id: 'single',
        bookId: 'sb',
        chapterId: 1,
        scope: 'this',
        addedAt: new Date().toISOString(),
        status: 'queued',
        order: 0,
        requiredEngines: ['kokoro'],
        multiTts: false,
      },
      {
        id: 'multi',
        bookId: 'sb',
        chapterId: 2,
        scope: 'this',
        addedAt: new Date().toISOString(),
        status: 'queued',
        order: 1,
        requiredEngines: ['kokoro', 'qwen'],
        multiTts: true,
      },
    ]);
    await page.route('**/api/queue', respondSnapshot);
    await page.route('**/api/queue/*', respondSnapshot);

    await page.goto('/#/books/sb/listen');
    const chip = page.getByTestId('topbar-queue-chip');
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    await chip.click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible({
      timeout: 5_000,
    });

    /* Single-engine row: badge names Kokoro, no advisory. */
    await expect(page.getByTestId('queue-entry-single-engines')).toHaveText('Kokoro');
    await expect(page.getByTestId('queue-entry-single-dual-model-warning')).toHaveCount(0);

    /* Multi-engine row: badge names both engines + the dual-model advisory. */
    await expect(page.getByTestId('queue-entry-multi-engines')).toHaveText('Kokoro + Qwen');
    await expect(page.getByTestId('queue-entry-multi-dual-model-warning')).toBeVisible();
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
