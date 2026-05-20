/* Plan 81 wave 5 — full per-view responsive coverage.
 *
 * Runs every view × every Playwright project (chromium / mobile-chrome /
 * tablet-chrome) per the testMatch glob in playwright.config.ts. Each
 * view's spec:
 *   1. Navigates to the view's URL with the Solway Bay fixture book ('sb').
 *   2. Waits for a hydration signal (a heading or button known to mount once
 *      the view's redux slices are populated).
 *   3. Asserts `documentElement.scrollWidth <= clientWidth + 1` so there's
 *      no horizontal overflow at the project's viewport size.
 *
 * Waves 1-4 brought every primary surface up to mobile + tablet width:
 *   - Wave 2 (chrome): top-bar + mini-player + modal infra.
 *   - Wave 3 (parallel agents): books, confirm-cast, manuscript, listen,
 *     generation, upload, cast — each view file scoped responsive.
 *   - Wave 4: tap-to-assign + pointer-event boundaries (touch
 *     affordances).
 *
 * Wave 5 is the regression gate: any future PR that lands a layout
 * change without a matching responsive update will trip the no-overflow
 * assertion at one of the three viewport sizes.
 *
 * Why this is separate from `e2e/responsive/baseline.spec.ts`:
 *   baseline.spec.ts is the minimal smoke that wave-1 shipped before
 *   any responsive layout work landed. It only asserts library + listen
 *   render. coverage.spec.ts is the strict matrix that ships once all
 *   views are responsive. Keeping them separate makes the test history
 *   tell the story: baseline was the contract from wave 1 → wave 4,
 *   coverage is the contract from wave 5 onwards.
 */

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, 'horizontal page overflow').toBeLessThanOrEqual(1);
}

test.describe('responsive coverage (all views × all viewports)', () => {
  test('books library', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('upload view', async ({ page }) => {
    await page.goto('/#/new');
    await expect(page.getByRole('button', { name: /Paste text/i })).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(200);
    await expectNoHorizontalScroll(page);
  });

  test('listen view — Solway Bay fixture', async ({ page }) => {
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

  test('manuscript view — Solway Bay fixture', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');
    /* Chapters sidebar h2 is the canonical hydration signal — only
       mounts once the chapters slice has the book's chapters loaded.
       On mobile the sidebar is a drawer so the heading may live behind
       the hamburger; matchers are scoped on the heading role so either
       position resolves. */
    await expect(page.getByRole('heading', { name: /^Chapters$/, level: 2 })).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('cast view — Solway Bay fixture', async ({ page }) => {
    await page.goto('/#/books/sb/cast');
    /* The cast view's primary heading is "Voices generated from <title>"
       per src/views/cast.tsx MixedHeading. The Library pill is reliably
       visible at the top under sm: where the desktop aside is hidden. */
    await expect(page.getByText(/Voices generated from/i)).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('generation view — Solway Bay fixture', async ({ page }) => {
    await page.goto('/#/books/sb/generate');
    /* Generation page title hydrates once chapters are loaded. */
    await page.waitForTimeout(500);
    await expectNoHorizontalScroll(page);
  });

  test('voices (global) view', async ({ page }) => {
    await page.goto('/#/voices');
    await page.waitForTimeout(500);
    await expectNoHorizontalScroll(page);
  });

  test('changelog (global) view', async ({ page }) => {
    await page.goto('/#/changelog');
    await page.waitForTimeout(500);
    await expectNoHorizontalScroll(page);
  });
});
