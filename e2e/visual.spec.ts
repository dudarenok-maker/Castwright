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
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { goToAnalysing, goToConfirm } from './helpers';

/* Per-platform baselines (snapshotPathTemplate in playwright.config.ts)
   only exist for the OS that blessed them. PR CI runs on Ubuntu but
   only Windows baselines are committed today, so the bare specs would
   fail every PR with "snapshot doesn't exist, writing actual". Skip
   the whole describe when no baseline directory exists for the
   running platform — auto-enables the moment someone commits
   baselines for that platform (e.g. `e2e/linux/visual.spec.ts/`).
   Linux baselines are tracked as a BACKLOG follow-up. */
const BASELINE_DIR = resolve(process.cwd(), 'e2e', process.platform, 'visual.spec.ts');
const SKIP_REASON =
  `No visual baselines committed for ${process.platform}. ` +
  `Run \`npm run test:e2e -- --update-snapshots visual.spec.ts\` to bless on this platform.`;

test.describe('visual baselines', () => {
  test.skip(!existsSync(BASELINE_DIR), SKIP_REASON);
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

  test('generate', async ({ page }) => {
    /* Solway Bay hydrates with all 18 chapters in `done` state
       (`src/lib/api.ts` buildSolwayBayMockState + hydrateFromBookState),
       so `#/books/sb/generate` paints every chapter row with the
       `bg-emerald-50/50` "Done" tint and no live SSE motion. Anchors the
       Generate-view baseline that the suite was previously missing, and
       the dark-mode companion below pins the emerald-50/50 override. */
    await page.goto('/#/books/sb/generate');
    /* "CH 01" only renders once the chapters slice has hydrated. */
    await expect(page.getByText(/^CH 01$/)).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('generate.png');
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
  test.skip(!existsSync(BASELINE_DIR), SKIP_REASON);

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

  test('generate (dark)', async ({ page }) => {
    /* Pins the dark-mode "Done" chapter tint. Without the
       `.bg-emerald-50\/50` dark override in src/styles.css the chapter
       cards would paint a muddy cream wash over the dark canvas; the
       override drops to a low-alpha emerald so the green hue stays
       recognisable. This baseline catches any future regression that
       removes / weakens the override. */
    await page.goto('/#/books/sb/generate');
    await expect(page.getByText(/^CH 01$/)).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('generate-dark.png');
  });
});
