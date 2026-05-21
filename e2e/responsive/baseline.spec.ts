/* Plan 81 wave 5 — responsive baseline (promoted from wave 1).
 *
 * Runs under all three Playwright projects (chromium / mobile-chrome /
 * tablet-chrome) via the testMatch glob in playwright.config.ts. Each
 * project's viewport is set by its `devices[...]` preset:
 *
 *   chromium       Desktop Chrome  1280x720
 *   mobile-chrome  Pixel 7         412x915  (browserName overridden to chromium)
 *   tablet-chrome  iPad Pro 11     834x1194 (browserName overridden to chromium)
 *
 * History: shipped in wave 1 as smoke-only on mobile/tablet (no-overflow
 * assertion was gated to chromium because waves 2-4 hadn't made views
 * responsive yet). Wave 5 promotes the assertion to all projects — every
 * Wave 3 view-responsive PR and Wave 4 touch-affordance PR has shipped,
 * so the views ARE responsive on phone + tablet.
 *
 * Companion: `e2e/responsive/coverage.spec.ts` is the comprehensive
 * matrix (every view × every project). This file is the fast smoke
 * subset (just library + listen) that can run in <30 s and confirms
 * the project plumbing is alive. */

import { test, expect } from '@playwright/test';

async function expectNoHorizontalScroll(page: import('@playwright/test').Page) {
  /* `documentElement.scrollWidth` exceeds `clientWidth` when content
     overflows horizontally. Tolerate a 1-px difference for sub-pixel
     rounding under non-integer device-pixel ratios (e.g. Pixel 7 is 2.625x). */
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, 'horizontal page overflow').toBeLessThanOrEqual(1);
}

test.describe('responsive baseline', () => {
  test('library renders + no horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('listen renders + no horizontal overflow', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByRole('button', { name: /Play from the start/i })).toBeEnabled({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });
});
