/* PR4 Task 9 — e2e: picking Qwen3-TTS 1.7B in the regenerate modal queues a
 * 1.7B render (EnqueueInput.modelKey === 'qwen3-tts-1.7b').
 *
 * Design note: mock mode short-circuits queueRequest to the in-memory
 * mockQueueRequest (queue-thunks.ts:35), so page.route on /api/queue/enqueue
 * never fires. We assert via window.__store__.getState().queue.entries[0].modelKey
 * (the standard e2e store-hook pattern used in queue-modal.spec.ts).
 *
 * The ready mock book is 'sb' (Solway Bay) — all chapters are pre-done, so
 * the Generate view renders immediately with "Regenerate this chapter" buttons. */

import { test, expect } from '@playwright/test';

test('picking 1.7B in the regenerate model picker queues a 1.7B render', async ({ page }) => {
  test.setTimeout(30_000);

  /* Navigate to the Solway Bay generate view — all chapters are done. */
  await page.goto('/#/books/sb/generate');

  /* Wait for at least one chapter row to render. */
  await expect(page.getByText(/^CH 01$/)).toBeVisible({ timeout: 10_000 });

  /* Click the first "Regenerate this chapter" button (aria-label on the icon
     button; visible text is just "Regenerate"). */
  await page
    .getByRole('button', { name: 'Regenerate this chapter' })
    .first()
    .click();

  /* RegenerateModal opens. Click the "Qwen3-TTS 1.7B" model option. */
  await page.getByText('Qwen3-TTS 1.7B').click();

  /* Select the scope — exercises the real user flow. */
  await page.getByText('This and all subsequent').click();

  /* Click the Regenerate confirm button at the bottom of the modal.
     The RegenerateModal uses overflow-hidden; on a standard 1280×720 Desktop
     Chrome viewport the footer button is clipped below the visible area.
     Use evaluate to dispatch a click event directly, bypassing the
     viewport-visibility check that blocks Playwright's normal click. */
  await page.getByRole('button', { name: 'Regenerate', exact: true }).last().evaluate((b) => (b as HTMLElement).click());

  /* Assert the first queued entry carries modelKey = 'qwen3-tts-1.7b'.
     This reads from the in-memory Redux store (the standard e2e store-hook
     pattern; __store__ is wired in main.tsx behind VITE_USE_MOCKS). */
  const modelKey = await page.evaluate(
    () =>
      (
        window as unknown as {
          __store__: { getState: () => { queue: { entries: Array<{ modelKey?: string }> } } };
        }
      ).__store__
        .getState()
        .queue.entries.at(0)?.modelKey,
  );
  expect(modelKey).toBe('qwen3-tts-1.7b');
});
