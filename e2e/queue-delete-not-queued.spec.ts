/* Bug 1 — deleting a chapter from the generation queue flips its row to the
 * neutral "Not queued" state instead of leaving a stale "Queued" badge that the
 * auto-work resume would silently re-enqueue.
 *
 * Mock mode has a real in-memory queue (src/mocks/mock-queue.ts); we seed it
 * PAUSED (so the dispatcher doesn't drain the entry before we cancel it) with a
 * chapter-scope entry for Carrick's Compass ('cc'), whose chapters hydrate as
 * `queued` (completedSlugs empty). Navigating to its Generate view loads those
 * rows; cancelling the entry in the queue modal must record the hold.
 */

import { test, expect, type Page } from '@playwright/test';

interface QueueEntryShape {
  id: string;
  bookId: string;
  chapterId: number;
  scope: 'this' | 'character';
  addedAt: string;
  status: 'queued' | 'in_progress' | 'paused' | 'done' | 'failed';
  order: number;
}

async function seedQueue(page: Page, entries: QueueEntryShape[]): Promise<void> {
  await page.addInitScript(
    ([e, p]) => {
      (window as unknown as { __mockQueueInitial: unknown }).__mockQueueInitial = e;
      (window as unknown as { __mockQueueInitialPaused: unknown }).__mockQueueInitialPaused = p;
    },
    [entries, true] as const,
  );
}

const entry = (over: Partial<QueueEntryShape> & Pick<QueueEntryShape, 'id' | 'bookId' | 'chapterId'>): QueueEntryShape => ({
  scope: 'this',
  addedAt: new Date().toISOString(),
  status: 'queued',
  order: 0,
  ...over,
});

function chapterHeld(page: Page, id: number): Promise<boolean | undefined> {
  return page.evaluate((cid) => {
    const s = (
      window as unknown as {
        __store__?: {
          getState: () => { chapters: { chapters: Array<{ id: number; held?: boolean }> } };
        };
      }
    ).__store__;
    return s?.getState().chapters.chapters.find((c) => c.id === cid)?.held;
  }, id);
}

test.describe('queue delete → "Not queued" (Bug 1)', () => {
  test('cancelling a queued chapter in the modal flips its row to "Not queued" and does not re-add it', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await seedQueue(page, [entry({ id: 'cc-c1', bookId: 'cc', chapterId: 1 })]);
    await page.goto('/#/books/cc/generate');

    /* The chapter starts life as a plain "Queued" row. (Generous wait — the
       first spec in a run pays the Vite cold-compile cost.) */
    const row = page.locator('#chapter-1');
    await row.waitFor({ state: 'visible', timeout: 20_000 });
    await expect(row.getByText('Queued')).toBeVisible();

    /* Open the queue modal and cancel chapter 1's entry. */
    await page.getByTestId('generation-view-queue').click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByTestId('queue-entry-cc-c1-cancel').click();
    await expect(page.getByText(/Empty/i).first()).toBeVisible({ timeout: 5_000 });

    /* The cancel recorded the user's intent: chapter 1 is now held. */
    await expect.poll(() => chapterHeld(page, 1), { timeout: 5_000 }).toBe(true);

    /* Close the modal and confirm the row reads "Not queued", not "Queued". */
    await page.getByRole('button', { name: 'Close queue' }).click();
    await expect(page.getByRole('dialog', { name: /Generation queue/i })).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(row.getByText('Not queued')).toBeVisible();
    /* exact:true — getByText is case-insensitive substring by default, so a bare
       'Queued' would match the "Not queued" pill itself. */
    await expect(row.getByText('Queued', { exact: true })).toHaveCount(0);

    /* Re-add via the row's "Generate this chapter" → the hold clears (the row
       leaves "Not queued"), proving the per-chapter re-queue path. */
    await row.locator('button').first().click(); // expand the row
    await page.getByTestId('chapter-row-1-generate').click();
    await expect.poll(() => chapterHeld(page, 1), { timeout: 5_000 }).toBeFalsy();
  });
});
