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
    /* 10 s budget rather than 5 s — the upload view's mount runs through
       re-upload-mode detection, library lookup, and the local-analyzer
       guard before the Paste-text button mounts. Under tablet-chrome
       parallel contention the 5 s budget was undersized. */
    await expect(page.getByRole('button', { name: /Paste text/i })).toBeVisible({
      timeout: 10_000,
    });
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
    /* Per-chapter h1 ("Chapter N — Title") is the hydration signal that
       works at ALL viewports — it mounts when the chapters slice has
       loaded the current chapter. The original h2 "Chapters" lives
       inside the SidebarPanels which on `<lg:` only renders inside a
       closed <Drawer>, so it's not in the DOM at mobile/tablet width. */
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
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

  test('admin (global) view', async ({ page }) => {
    await page.goto('/#/admin');
    await expect(page.getByRole('heading', { name: 'Admin', level: 2 })).toBeVisible({
      timeout: 5_000,
    });
    /* Health board hydrates from the mocked GET /api/diagnostics. */
    await expect(page.getByTestId('health-board')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('model-manager (global) view', async ({ page }) => {
    await page.goto('/#/models');
    /* Inventory hydrates from the mocked GET /api/models/inventory. */
    await expect(page.getByTestId('model-inventory')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('about (global) view', async ({ page }) => {
    await page.goto('/#/about');
    /* "What it is" is a stable h2 in the rebuilt 7-block page (fe-37). */
    await expect(page.getByRole('heading', { name: /What it is/i })).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('help (global) view', async ({ page }) => {
    await page.goto('/#/help');
    await expect(page.getByRole('heading', { name: 'Troubleshooting' })).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('release-notes (global) view', async ({ page }) => {
    await page.goto('/#/release-notes');
    /* The mock /api/info releaseNotes carries one bullet — its presence is the
       hydration signal that useAppInfo resolved and the history rendered. */
    await expect(page.getByText(/In-app upgrades/i)).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('queue modal (plan 102)', async ({ page }) => {
    /* Intercept /api/queue so the layout's mount-effect loadQueue
       resolves and the modal can render — mock-mode otherwise has no
       server-side queue endpoint and the slice stays in unloaded
       state, which would render an empty modal with no horizontal-
       overflow risk to assert against. */
    await page.route('**/api/queue', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            {
              id: 'demo-1',
              bookId: 'sb',
              chapterId: 1,
              scope: 'this',
              addedAt: new Date().toISOString(),
              status: 'queued',
              order: 0,
            },
            {
              id: 'demo-2',
              bookId: 'sb',
              chapterId: 2,
              scope: 'this',
              addedAt: new Date().toISOString(),
              status: 'queued',
              order: 1,
            },
          ],
          paused: false,
        }),
      }),
    );
    await page.goto('/#/books/sb/generate');
    /* The View queue button mounts inside Generate header; data-testid
       is the stable hook. */
    const viewQueue = page.getByTestId('generation-view-queue');
    await viewQueue.waitFor({ state: 'visible', timeout: 10_000 });
    await viewQueue.click();
    /* Modal renders with aria-label="Generation queue" on every
       viewport (dialog on >= sm, full-screen sheet on phone). */
    await page.getByRole('dialog', { name: /Generation queue/i }).waitFor({
      state: 'visible',
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('setup view (boot gate not-ready)', async ({ page }) => {
    await page.goto('/#/?setup=notready');
    await expect(page.getByRole('heading', { name: /Set up Castwright/i })).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('advanced configuration view', async ({ page }) => {
    await page.goto('/#/advanced');
    await expect(page.getByRole('heading', { name: /Advanced configuration/i })).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('status popover', async ({ page }) => {
    /* The Status pill is always present in a book context; clicking it pins
       the popover open (TTS controls + analysis/generation/revisions). The
       portaled, width-clamped panel must not introduce horizontal overflow. */
    await page.goto('/#/books/sb/generate');
    const statusPill = page.getByTestId('status-pill');
    await statusPill.waitFor({ state: 'visible', timeout: 10_000 });
    await statusPill.click();
    await page.getByTestId('status-popover').waitFor({
      state: 'visible',
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });

  test('guided-tour overlay (tour bubble visible across viewports)', async ({ page }) => {
    /* Start the linear tour via the ? menu. loadSample resolves in ~150 ms
       (mock); the bubble portals to document.body so it is never clipped by
       the top-bar's overflow-x-clip. Asserting the bubble is visible (not
       overflowed off-screen) is sufficient — horizontal-scroll is the main
       risk at narrow viewports. */
    await page.goto('/#/');
    await page.getByTestId('topbar-help').click();
    await page.getByRole('menuitem', { name: /take the tour/i }).click();
    await page.getByTestId('tour-bubble').waitFor({ state: 'visible', timeout: 12_000 });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
  });
});
