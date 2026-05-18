/* Visual-regression baselines for the six core surfaces.
 *
 * Each test captures one screenshot under
 * `e2e/visual.spec.ts-snapshots/{platform}/visual.spec.ts/<name>.png`
 * (snapshotPathTemplate in playwright.config.ts). First run blesses;
 * subsequent runs diff against the committed baseline and fail if the
 * page drifts beyond `maxDiffPixelRatio: 0.01` (~1% of pixels).
 *
 * Stages captured:
 *   1. library — cold boot, mock fixture library
 *   2. upload — `#/new` with the paste affordance pristine
 *   3. analysing — `#/books/:id/analysing` BEFORE the Start click (the
 *      streaming UI is too dynamic to baseline safely; the pre-start
 *      "ready to fire" state is deterministic and still exercises the
 *      analysing-view shell layout — model picker, Start button, etc.)
 *   4. confirm — `#/books/:id/confirm` after the mock SSE completes
 *   5. ready   — `#/books/sb/manuscript` (Solway Bay, the stable
 *      'complete' fixture seeded for the listen + revision-diff specs)
 *   6. listen  — `#/books/sb/listen`
 *
 * Animations are disabled via the global `expect.toHaveScreenshot`
 * config so CSS transitions / animated SVGs settle to their final
 * frame before capture.
 *
 * To regenerate after an intentional visual change:
 *   npm run test:e2e -- --update-snapshots visual.spec.ts
 *
 * Pairs with docs/features/37-e2e-playwright.md "Visual baselines". */

import { test, expect } from '@playwright/test';
import { goToAnalysing, goToConfirm } from './helpers';

test.describe('visual baselines', () => {
  test('library', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    /* Wait one rAF for the staggered card-mount transitions to settle.
       Without this, cards animate in over ~200 ms after first paint and
       the screenshot lands mid-transition. animations:'disabled' freezes
       CSS transitions at their final state but not the initial-mount
       opacity 0 → 1 if React hasn't queued the second frame yet. */
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('library.png');
  });

  test('upload', async ({ page }) => {
    await page.goto('/#/new');
    /* Wait for the upload view's primary CTA to confirm hydration. */
    await expect(page.getByRole('button', { name: /Paste text/i })).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('upload.png');
  });

  test('analysing (pre-start)', async ({ page }) => {
    await goToAnalysing(page);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('analysing.png');
  });

  test('confirm', async ({ page }) => {
    await goToConfirm(page);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('confirm.png');
  });

  test('ready (manuscript)', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');
    /* The manuscript view's h1 is the current-chapter title ("Chapter N
       — …"), not the book title. Wait for the Chapters sidebar to
       hydrate as the readiness signal — it's only rendered once the
       chapters slice has the book's chapters loaded. */
    await expect(page.getByRole('heading', { name: /^Chapters$/, level: 2 })).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('ready.png');
  });

  test('listen', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 5_000,
    });
    /* "Play from the start" enabling is the hydration signal for the
       chapter list — once it flips enabled the chapter rows are present. */
    await expect(page.getByRole('button', { name: /Play from the start/i })).toBeEnabled({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('listen.png');
  });
});

/* Plan 41 — dark-theme baselines.
 *
 * Mirrors the six light-mode captures above with a pre-mount
 * `localStorage` seed that flips the ui-slice themeOverride to 'dark'
 * before React mounts. The pre-mount paint guard in src/main.tsx
 * picks up the seeded value and sets <html data-theme="dark"> before
 * the first frame, so the captures show the dark surface without a
 * one-frame light flash.
 *
 * Same regenerate command as the light pass:
 *   npm run test:e2e -- --update-snapshots visual.spec.ts
 */
test.describe('visual baselines (dark theme)', () => {
  test.beforeEach(async ({ context }) => {
    /* Seed the redux-persist 'persist:ui' blob before any page in this
       context loads. Each key inside the wrapper is JSON-encoded
       individually, mirroring redux-persist's own serialisation. */
    await context.addInitScript(() => {
      const wrapper = { themeOverride: JSON.stringify('dark') };
      window.localStorage.setItem('persist:ui', JSON.stringify(wrapper));
    });
  });

  test('library (dark)', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('library-dark.png');
  });

  test('upload (dark)', async ({ page }) => {
    await page.goto('/#/new');
    await expect(page.getByRole('button', { name: /Paste text/i })).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('upload-dark.png');
  });

  test('analysing (pre-start, dark)', async ({ page }) => {
    await goToAnalysing(page);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('analysing-dark.png');
  });

  test('confirm (dark)', async ({ page }) => {
    await goToConfirm(page);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('confirm-dark.png');
  });

  test('ready (manuscript, dark)', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapters$/, level: 2 })).toBeVisible({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('ready-dark.png');
  });

  test('listen (dark)', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByRole('button', { name: /Play from the start/i })).toBeEnabled({
      timeout: 5_000,
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('listen-dark.png');
  });
});
