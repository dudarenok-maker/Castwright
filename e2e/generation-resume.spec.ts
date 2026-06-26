/* Browser-level proof of the fe-17 "Resume generation" button.
 *
 * Plan 137 made opening a book never auto-enqueue — a plain nav to the
 * Generate view leaves the fixture's queued chapters queued with no active
 * run. fe-17 adds an explicit, header-level "Resume generation" button that
 * dispatches the same plan-137 `requestStartGeneration` intent the
 * "Approve cast & start generating" CTA uses, so a user can continue an
 * interrupted run in one click. It's shown ONLY when there's queued work and
 * nothing in flight.
 *
 * This spec drives mock mode through analysing → confirm → manuscript, then
 * navigates to Generate WITHOUT clicking the approve CTA (so nothing
 * enqueues). It asserts the resume button is visible, clicks it, and confirms
 * a queued chapter leaves the queued state — proving the intent → middleware
 * → dispatcher → stream wiring end-to-end through the browser seam (which
 * jsdom can lie about for the hashchange / middleware timing). */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm, confirmTierPromptIfPresent } from './helpers';

/* Serial mode: the cold-boot analysis walk is long; keep it in one worker so
   the mock SSE phase transitions don't miss their window under contention
   (same rationale as generation-stuck-queued.spec.ts). */
test.describe.configure({ mode: 'serial' });

async function queuedChapterIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __store__?: {
          getState: () => { chapters: { chapters: Array<{ id: number; state: string }> } };
        };
      }
    ).__store__;
    if (!s) throw new Error('window.__store__ is not exposed (main.tsx DEV/e2e gate regressed)');
    return s
      .getState()
      .chapters.chapters.filter((c) => c.state === 'queued')
      .map((c) => c.id);
  });
}

async function anyQueuedLeft(page: Page, ids: number[]): Promise<boolean> {
  return page.evaluate((cids) => {
    const s = (
      window as unknown as {
        __store__?: {
          getState: () => { chapters: { chapters: Array<{ id: number; state: string }> } };
        };
      }
    ).__store__;
    const chapters = s?.getState().chapters.chapters ?? [];
    return cids.every((cid) => chapters.find((c) => c.id === cid)?.state === 'queued');
  }, ids);
}

test.describe('Resume generation button (fe-17)', () => {
  test('an idle book with queued chapters shows Resume generation; clicking it kicks the queue off', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });

    /* Plain nav to Generate — does NOT enqueue (plan 137), so the fixture's
       queued chapters stay queued with no active run: exactly the shape that
       should surface the Resume button. */
    await page.getByRole('button', { name: /^Generate$/ }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/generate/, { timeout: 5_000 });

    /* The analysis fixture seeds a stale `in_progress` chapter (a previously
       interrupted run). In the real app the server reconciles an orphaned
       in_progress → queued on boot (workspace/queue-boot.ts), leaving an idle
       book with only queued/done/failed rows — exactly the state the Resume
       button targets. Reproduce that reconciliation here so the button gate
       (`inProgressCnt === 0`) holds, then exercise the real button + wiring. */
    await page.evaluate(() => {
      const store = (window as any).__store__;
      const chapters = store.getState().chapters.chapters as Array<{ state: string }>;
      const reconciled = chapters.map((c) =>
        c.state === 'in_progress' ? { ...c, state: 'queued', progress: 0 } : c,
      );
      store.dispatch({ type: 'chapters/setChapters', payload: reconciled });
    });

    const queuedBefore = await queuedChapterIds(page);
    expect(queuedBefore.length).toBeGreaterThan(0);

    const resumeBtn = page.getByTestId('generation-view-resume');
    await expect(resumeBtn).toBeVisible({ timeout: 5_000 });
    await expect(resumeBtn).toHaveText(/Resume generation/i);

    /* Click it → requestStartGeneration → middleware enqueues the queued
       chapters → dispatcher claims them → at least one leaves 'queued'. */
    await resumeBtn.click();
    /* #1160 — a Qwen book prompts for the voice-model tier before starting;
       confirm it (keep the default) so the run actually kicks off. */
    await confirmTierPromptIfPresent(page);
    await expect
      .poll(() => anyQueuedLeft(page, queuedBefore), {
        timeout: 15_000,
        message: 'expected at least one queued chapter to leave "queued" after Resume generation',
      })
      .toBe(false);
  });
});
