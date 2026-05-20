/* Plan 81 wave 1 — responsive baseline.
 *
 * Runs under all three Playwright projects (chromium / mobile-chrome /
 * tablet-chrome) via the testMatch glob in playwright.config.ts. Each
 * project's viewport is set by its `devices[...]` preset:
 *
 *   chromium       Desktop Chrome  1280x720
 *   mobile-chrome  Pixel 7         412x915  (browserName overridden to chromium)
 *   tablet-chrome  iPad Pro 11     834x1194 (browserName overridden to chromium)
 *
 * Wave 1 scope: prove the e2e plumbing works for mobile + tablet projects
 * (the smoke half of the spec runs everywhere) AND lock no-horizontal-
 * scroll on the desktop chromium project (the only project where the
 * desktop layout is intended to render correctly today). Per-view layout
 * fixes for cast / manuscript / etc. land in waves 2-3, then wave 5
 * upgrades the smoke assertion on mobile/tablet to the same strict
 * no-overflow check we run on desktop today.
 *
 * Concretely: mobile + tablet projects currently have N hundred px of
 * horizontal overflow on most views (that's the whole point of plan 81).
 * Asserting "no overflow" on mobile in wave 1 would be a false-failure
 * gate. Smoke-only here, strict in wave 5. */

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
  test('library renders', async ({ page }, testInfo) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    /* Let staggered card-mount transitions settle; matches the same
       300 ms used by visual.spec.ts before screenshot capture. */
    await page.waitForTimeout(300);
    if (testInfo.project.name === 'chromium') {
      await expectNoHorizontalScroll(page);
    }
  });

  test('listen renders', async ({ page }, testInfo) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByRole('button', { name: /Play from the start/i })).toBeEnabled({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    if (testInfo.project.name === 'chromium') {
      await expectNoHorizontalScroll(page);
    }
  });
});
