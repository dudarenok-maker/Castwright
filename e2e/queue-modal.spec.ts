/* Plan 102 + plan 111 — global queue modal e2e.
 *
 * Plan 111 made the persisted queue drive generation, and mock mode now has a
 * real in-memory queue (src/mocks/mock-queue.ts) that the frontend's
 * queue-thunks talk to. So these specs SEED that in-memory queue via the
 * `window.__mockQueueInitial` hook (set by addInitScript before load) instead
 * of stubbing /api/queue with page.route — there is no network call to
 * intercept in mock mode any more.
 *
 * Static-inspection specs (chip count, grouping, cancel, badges) seed the
 * queue PAUSED so the dispatcher doesn't drain it out from under the
 * assertions. The last spec seeds nothing and drives a real generation to
 * prove the queue is authoritative (chapters show up as real entries). */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

interface QueueEntryShape {
  id: string;
  bookId: string;
  chapterId: number;
  scope: 'this' | 'character';
  characterId?: string;
  addedAt: string;
  status: 'queued' | 'in_progress' | 'paused' | 'done' | 'failed';
  order: number;
  requiredEngines?: ('coqui' | 'piper' | 'kokoro' | 'gemini' | 'qwen')[];
  multiTts?: boolean;
  errorReason?: string | null;
}

/* Seed the in-memory mock queue before the app loads. Defaults to PAUSED so
   the static-inspection specs keep their injected entries put. */
async function seedQueue(
  page: import('@playwright/test').Page,
  entries: QueueEntryShape[],
  paused = true,
): Promise<void> {
  await page.addInitScript(
    ([e, p]) => {
      (window as unknown as { __mockQueueInitial: unknown }).__mockQueueInitial = e;
      (window as unknown as { __mockQueueInitialPaused: unknown }).__mockQueueInitialPaused = p;
    },
    [entries, paused] as const,
  );
}

const e = (over: Partial<QueueEntryShape> & Pick<QueueEntryShape, 'id' | 'bookId' | 'chapterId'>): QueueEntryShape => ({
  scope: 'this',
  addedAt: new Date().toISOString(),
  status: 'queued',
  order: 0,
  ...over,
});

test.describe('queue modal (plan 102 / 111)', () => {
  test('top-bar chip surfaces the pending count and opens the modal', async ({ page }) => {
    await seedQueue(page, [
      e({ id: 'e1', bookId: 'sb', chapterId: 1 }),
      e({ id: 'e2', bookId: 'sb', chapterId: 2 }),
    ]);
    await page.goto('/#/books/sb/listen');
    const chip = page.getByTestId('topbar-queue-chip');
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(chip).toContainText('Queue · 2');

    await chip.click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByText(/2 entries pending/i)).toBeVisible();
  });

  test('cancel button removes the entry and re-renders the modal', async ({ page }) => {
    await seedQueue(page, [e({ id: 'e-cancel', bookId: 'sb', chapterId: 5 })]);
    await page.goto('/#/books/sb/listen');
    await page.getByTestId('topbar-queue-chip').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('topbar-queue-chip').click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible();
    await page.getByTestId('queue-entry-e-cancel-cancel').click();
    /* After the DELETE the modal re-renders empty. */
    await expect(page.getByText(/Empty/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('force-remove clears a stuck in_progress entry that normal cancel can’t reach', async ({
    page,
  }) => {
    /* A seeded in_progress entry with the dispatcher's in-memory inFlight map
       empty (fresh load) is the stuck/orphaned case: it's never reconciled or
       re-claimed, and the normal cancel button is hidden + the route 409s. The
       force-remove control is the only way out. */
    await seedQueue(page, [e({ id: 'e-stuck', bookId: 'sb', chapterId: 7, status: 'in_progress' })]);
    await page.goto('/#/books/sb/listen');
    await page.getByTestId('topbar-queue-chip').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('topbar-queue-chip').click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible();
    /* In-flight row: no normal cancel, but a force-remove control. */
    await expect(page.getByTestId('queue-entry-e-stuck-cancel')).toHaveCount(0);
    await page.getByTestId('queue-entry-e-stuck-force-remove').click();
    await expect(page.getByText(/Empty/i).first()).toBeVisible({ timeout: 5_000 });
  });

  test('a failed entry persists as "Failed" with a Retry control that re-queues it', async ({
    page,
  }) => {
    /* Seeded PAUSED so retrying doesn't immediately drain the re-queued entry. */
    await seedQueue(page, [
      e({ id: 'e-failed', bookId: 'sb', chapterId: 9, status: 'failed', errorReason: 'sidecar 500' }),
    ]);
    await page.goto('/#/books/sb/listen');
    await page.getByTestId('topbar-queue-chip').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('topbar-queue-chip').click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible();
    await expect(page.getByText(/Failed · sidecar 500/)).toBeVisible();
    await page.getByTestId('queue-entry-e-failed-retry').click();
    /* Re-queued → the Failed line is gone and the row reads Queued. Assert via
       the entry's own status testid rather than a bare getByText('Queued'),
       which also matches the dev build-stamp footer (plan 124) on any branch
       whose name contains "queued" — a strict-mode violation. */
    await expect(page.getByText(/Failed · sidecar 500/)).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId('queue-entry-e-failed-status')).toHaveText('Queued');
  });

  test('cross-book entries render grouped and the other book’s entry cancels while viewing one book', async ({
    page,
  }) => {
    await seedQueue(page, [
      e({ id: 'sb-c1', bookId: 'sb', chapterId: 1 }),
      e({ id: 'ns-c3', bookId: 'ns', chapterId: 3, order: 1 }),
    ]);
    await page.goto('/#/books/sb/listen');
    const chip = page.getByTestId('topbar-queue-chip');
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(chip).toContainText('Queue · 2');
    await chip.click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible({
      timeout: 5_000,
    });

    await expect(page.getByTestId('queue-entry-sb-c1')).toBeVisible();
    await expect(page.getByTestId('queue-entry-ns-c3')).toBeVisible();

    await page.getByTestId('queue-entry-ns-c3-cancel').click();
    await expect(page.getByTestId('queue-entry-ns-c3')).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId('queue-entry-sb-c1')).toBeVisible();
  });

  test('multi-TTS chapter shows the engine badge + dual-model-off warning (plan 108 Wave 3)', async ({
    page,
  }) => {
    await seedQueue(page, [
      e({ id: 'single', bookId: 'sb', chapterId: 1, requiredEngines: ['kokoro'], multiTts: false }),
      e({
        id: 'multi',
        bookId: 'sb',
        chapterId: 2,
        order: 1,
        requiredEngines: ['kokoro', 'qwen'],
        multiTts: true,
      }),
    ]);
    await page.goto('/#/books/sb/listen');
    const chip = page.getByTestId('topbar-queue-chip');
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    await chip.click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible({
      timeout: 5_000,
    });

    await expect(page.getByTestId('queue-entry-single-engines')).toHaveText('Kokoro');
    await expect(page.getByTestId('queue-entry-single-dual-model-warning')).toHaveCount(0);
    await expect(page.getByTestId('queue-entry-multi-engines')).toHaveText('Kokoro + Qwen');
    await expect(page.getByTestId('queue-entry-multi-dual-model-warning')).toBeVisible();
  });

  test('Generate view "View queue" button opens the modal', async ({ page }) => {
    await seedQueue(page, []);
    await page.goto('/#/books/sb/generate');
    const viewQueue = page.getByTestId('generation-view-queue');
    await viewQueue.waitFor({ state: 'visible', timeout: 10_000 });
    await viewQueue.click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('the queue is authoritative — generating chapters appear as real queue entries (plan 111)', async ({
    page,
  }) => {
    /* The explicit "Approve cast & start generating" click enqueues (plan 137)
       → the dispatcher drains it. So while a book generates, the queue modal
       shows REAL entries (not the old synthetic overlay). Drives a real mock
       generation and asserts the modal reports pending entries. */
    test.setTimeout(60_000);

    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
    await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });

    /* Generation is live once a chapter-row "Generating" pill shows. */
    await expect(page.locator('span', { hasText: /^Generating$/ }).first()).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId('generation-view-queue').click();
    const dialog = page.getByRole('dialog', { name: /Generation queue/i });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    /* Authoritative queue → real pending entries, never "No chapters queued". */
    await expect(dialog.getByText(/entr(y|ies) pending/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/No chapters queued/)).toHaveCount(0);
  });

  test('queue stays empty until the user explicitly starts generating (plan 137)', async ({
    page,
  }) => {
    /* Regression for "opening a book auto-starts generation" (plan 137): a
       freshly-analysed book must NOT enter the queue at confirm/manuscript, NOR
       on merely reaching the Generate view via the top-nav tab (passive
       changeView) — only the explicit "Approve cast & start generating" click
       enqueues. Reads the persisted queue length off the e2e __store__ hook. */
    test.setTimeout(60_000);
    const queueLen = (): Promise<number> =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __store__: { getState: () => { queue: { entries: unknown[] } } };
            }
          ).__store__.getState().queue.entries.length,
      );

    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
    /* Poll until stable (passes instantly if 0, catches a delayed enqueue within 2 s). */
    await expect.poll(queueLen, { timeout: 2_000 }).toBe(0);

    /* Passive navigation to the Generate view (top-nav tab → changeView) must
       NOT enqueue — this is the exact path that used to auto-start on open. */
    await page.getByRole('button', { name: /^Generate$/ }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });
    await expect.poll(queueLen, { timeout: 2_000 }).toBe(0);

    /* Go back and use the explicit CTA → the queue now fills. */
    await page.getByRole('button', { name: /^Manuscript$/ }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
    await page.getByRole('button', { name: /Approve cast.*start generating/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });
    await expect.poll(queueLen, { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test('Clear queue empties the queue via the confirm dialog', async ({ page }) => {
    /* Seeded PAUSED so the dispatcher doesn't drain before we clear. */
    await seedQueue(page, [
      e({ id: 'c1', bookId: 'sb', chapterId: 1 }),
      e({ id: 'c2', bookId: 'sb', chapterId: 2, order: 1 }),
    ]);
    await page.goto('/#/books/sb/listen');
    await page.getByTestId('topbar-queue-chip').waitFor({ state: 'visible', timeout: 10_000 });
    await page.getByTestId('topbar-queue-chip').click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible();
    await page.getByTestId('queue-modal-clear').click();
    /* The dialog's confirm button shares the "Clear queue" name with the header
       trigger; the dialog's is the later one in the DOM. */
    await page.getByRole('button', { name: 'Clear queue' }).last().click();
    await expect(page.getByText(/Empty/i).first()).toBeVisible({ timeout: 5_000 });
  });
});
