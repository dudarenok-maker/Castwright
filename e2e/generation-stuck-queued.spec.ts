/* Browser-level proof of the stuck-queued escape hatch (side: stuck-queued).
 *
 * A chapter that failed writes no audio, so it's absent from completedSlugs
 * and re-hydrates as the neutral "Queued". Once its (clearable) queue entry is
 * gone, the row's only expanded actions were Rename/Exclude — leaving it
 * unactionable. We added a per-row "Generate this chapter" control to queued
 * rows that enqueues just that chapter so the dispatcher renders it.
 *
 * This spec drives mock mode through analysing → confirm → manuscript, then
 * navigates to the Generate view WITHOUT clicking "Approve cast & start
 * generating" (plan 137: a plain nav doesn't enqueue). The analysis fixture
 * (ANALYSIS_NORTHERN_STAR) seeds several queued chapters with no active run —
 * exactly the stuck-but-idle shape. We expand one, assert the escape-hatch
 * button renders, click it, and confirm the chapter leaves the queued state
 * (the enqueue → dispatcher → stream wiring end-to-end). */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm } from './helpers';

/* Serial mode: the cold-boot analysis walk is long; keep it in one worker so
   the mock SSE phase transitions don't miss their window under contention
   (same rationale as generation-parallel.spec.ts). */
test.describe.configure({ mode: 'serial' });

async function firstQueuedChapterId(page: Page): Promise<number> {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __store__?: {
          getState: () => { chapters: { chapters: Array<{ id: number; state: string }> } };
        };
      }
    ).__store__;
    if (!s) throw new Error('window.__store__ is not exposed (main.tsx DEV/e2e gate regressed)');
    const queued = s.getState().chapters.chapters.find((c) => c.state === 'queued');
    if (!queued) throw new Error('expected at least one queued chapter from the analysis fixture');
    return queued.id;
  });
}

async function chapterState(page: Page, id: number): Promise<string | undefined> {
  return page.evaluate((cid) => {
    const s = (
      window as unknown as {
        __store__?: {
          getState: () => { chapters: { chapters: Array<{ id: number; state: string }> } };
        };
      }
    ).__store__;
    return s?.getState().chapters.chapters.find((c) => c.id === cid)?.state;
  }, id);
}

test.describe('stuck-queued escape hatch (side: stuck-queued)', () => {
  test('a queued chapter exposes "Generate this chapter" and clicking it kicks off that chapter', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });

    /* Plain nav to Generate — does NOT enqueue (plan 137), so the fixture's
       queued chapters stay queued with no active run. */
    await page.getByRole('button', { name: /^Generate$/ }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });

    const queuedId = await firstQueuedChapterId(page);

    /* Expand the queued row (the escape-hatch action lives in the expanded
       panel). The row is wrapped in `#chapter-<id>`; its first button is the
       collapse/expand toggle. */
    await page.locator(`#chapter-${queuedId} button`).first().click();

    const generateBtn = page.getByTestId(`chapter-row-${queuedId}-generate`);
    await expect(generateBtn).toBeVisible({ timeout: 5_000 });
    await expect(generateBtn).toHaveText(/Generate this chapter/i);

    /* Click it → enqueue → dispatcher claims it → the row leaves 'queued'
       (flips to in_progress as its stream opens). Proves the full wiring. */
    await generateBtn.click();
    await expect
      .poll(() => chapterState(page, queuedId), {
        timeout: 15_000,
        message: 'expected the chapter to leave "queued" after Generate this chapter',
      })
      .not.toBe('queued');
  });
});
