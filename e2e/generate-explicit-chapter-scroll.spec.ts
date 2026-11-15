/* #4199 — the Generate view scrolls only when the URL names a chapter.
 *
 * ReadyRoute defaults a chapterless URL to chapter 3 and stageToHash omits
 * `?chapter=3`, so the plan-102 scroll effect used to smooth-scroll
 * `#chapter-3` into view on every plain load (settling at scrollY ~500-740).
 * A plain load must stay at the top; an explicit `?chapter=<id>` (the queue
 * modal's "Jump to chapter") must still scroll. */

import { test, expect } from '@playwright/test';

/* The old scroll started ~0.9 s after navigation and ran ~20 frames; wait
   comfortably past it before asserting the page never moved. */
const PAST_OLD_SCROLL_WINDOW_MS = 2000;

test.describe('Generate view chapter scroll (#4199)', () => {
  test('a plain load stays at the top', async ({ page }) => {
    await page.goto('/#/books/sb/generate');
    await expect(page.locator('#chapter-1')).toBeVisible();
    await page.waitForTimeout(PAST_OLD_SCROLL_WINDOW_MS);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('an explicit ?chapter=<later chapter> scrolls to it', async ({ page }) => {
    await page.goto('/#/books/sb/generate?chapter=8');
    await expect(page.locator('#chapter-8')).toBeAttached();
    await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 }).toBeGreaterThan(0);
  });
});
