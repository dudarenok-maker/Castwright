/* #4199 — the Generate view scrolls only when the URL names a chapter.
 *
 * ReadyRoute defaults a chapterless URL to chapter 3 and stageToHash omits
 * `?chapter=3`, so the plan-102 scroll effect used to smooth-scroll
 * `#chapter-3` into view on every plain load (settling at scrollY ~500-740).
 * A plain load must stay at the top; a `?chapter=<id>` in the URL (id other
 * than 3, e.g. from `stageToHash` or a shared link) must still scroll.
 *
 * #4212 — a cold `?chapter=3` link must scroll too. The stage now carries
 * `chapterExplicit`, `stageToHash` keeps `?chapter=3` for it, and Layout's
 * Redux->URL sync no longer drops the param before the view mounts. */

import { test, expect } from '@playwright/test';

/* The old scroll started ~0.9 s after navigation and ran ~20 frames; wait
   comfortably past it before asserting the page never moved. */
const PAST_OLD_SCROLL_WINDOW_MS = 2000;
const RELOAD_SETTLE_MS = 3000;

test.describe('Generate view chapter scroll (#4199)', () => {
  test('a plain load stays at the top', async ({ page }) => {
    await page.goto('/#/books/sb/generate');
    await expect(page.locator('#chapter-1')).toBeVisible();
    await page.waitForTimeout(PAST_OLD_SCROLL_WINDOW_MS);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(new URL(page.url()).hash).not.toContain('chapter=');
  });

  test('a cold ?chapter=3 link scrolls, keeps the param, and keeps scrolling on reload', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/generate?chapter=3');
    await expect(page.locator('#chapter-3')).toBeInViewport({ timeout: 10_000 });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    expect(new URL(page.url()).hash).toContain('chapter=3');

    /* Let the smooth scroll finish first: reloading mid-scroll lets the
       browser's scroll restoration fight the view's own scroll. */
    await expect
      .poll(async () => {
        const before = await page.evaluate(() => window.scrollY);
        await page.waitForTimeout(300);
        return before === (await page.evaluate(() => window.scrollY));
      })
      .toBe(true);

    await page.reload();
    /* No polling assertion here: polling changes the load timing and let a
       reload that never scrolled pass. Wait a fixed settle period, then read
       the page once. */
    await page.waitForTimeout(RELOAD_SETTLE_MS);
    const { scrollY, top, height, viewport } = await page.evaluate(() => {
      const r = document.getElementById('chapter-3')!.getBoundingClientRect();
      return { scrollY: window.scrollY, top: r.top, height: r.height, viewport: window.innerHeight };
    });
    expect(scrollY).toBeGreaterThan(0);
    /* The row (taller than a line) overlaps the viewport. */
    expect(top).toBeLessThan(viewport);
    expect(top + height).toBeGreaterThan(0);
    expect(new URL(page.url()).hash).toContain('chapter=3');
  });

  test('an explicit ?chapter=<later chapter> scrolls to it', async ({ page }) => {
    await page.goto('/#/books/sb/generate?chapter=8');
    await expect(page.locator('#chapter-8')).toBeAttached();
    await expect(page.locator('#chapter-8')).toBeInViewport({ timeout: 10_000 });
  });
});
