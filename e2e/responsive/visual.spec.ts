/* Visual-regression baselines for the seven core surfaces.
 *
 * Per-platform AND per-project: each test captures one screenshot under
 * `e2e/{platform}/responsive/visual.spec.ts/{projectName}/<name>.png`
 * (snapshotPathTemplate in playwright.config.ts). First run blesses;
 * subsequent runs diff against the committed baseline and fail if the
 * page drifts beyond `maxDiffPixelRatio: 0.01` (~1% of pixels).
 *
 * Stages captured (light + dark theme each):
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
 *   7. generate — `#/books/sb/generate`
 *
 * Animations are disabled via the global `expect.toHaveScreenshot`
 * config so CSS transitions / animated SVGs settle to their final
 * frame before capture.
 *
 * Plan 37 (visual baselines) — relocated from `e2e/visual.spec.ts` to
 * `e2e/responsive/visual.spec.ts` 2026-05-22 so all three Playwright
 * projects (chromium / mobile-chrome / tablet-chrome) pick it up via
 * the existing responsive/* testMatch glob. The `mode: 'serial'`
 * directive below pins one worker for the whole describe block so the
 * 14 baselines don't race the other 80+ specs locally.
 *
 * Visuals run ONLY in the new `verify:visual` step (see package.json),
 * not in the parallel `test:e2e` battery — see archive/37-e2e-playwright.md.
 *
 * To regenerate after an intentional visual change:
 *   npm run verify:visual -- --update-snapshots
 *   # or for a specific project:
 *   npx playwright test --project=mobile-chrome --update-snapshots e2e/responsive/visual.spec.ts
 *
 * Pairs with docs/features/archive/37-e2e-playwright.md "Visual baselines". */

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { goToAnalysing, goToConfirm, waitForConfirmViewReady, waitForListenViewReady } from '../helpers';

/* Per-platform AND per-project baselines (snapshotPathTemplate in
   playwright.config.ts) only exist for the OS that blessed them.
   PR CI runs on Ubuntu but only Windows baselines are committed today,
   so the bare specs would fail every PR with "snapshot doesn't exist,
   writing actual". Skip the whole describe when no baseline directory
   exists for the running platform — auto-enables the moment someone
   commits baselines for that platform (e.g.
   `e2e/linux/responsive/visual.spec.ts/`). Linux baselines are produced
   by the `regen-visual-baselines.yml` workflow (below). */
const BASELINE_DIR = resolve(process.cwd(), 'e2e', process.platform, 'responsive', 'visual.spec.ts');
/* The regen workflow at `.github/workflows/regen-visual-baselines.yml`
   pre-creates this directory before invoking playwright, so the skip
   doesn't fire on the initial Linux regen run. For local regen on an
   un-blessed platform: `mkdir -p e2e/<platform>/responsive/visual.spec.ts`
   first, then `npm run verify:visual -- --update-snapshots`.
   (Playwright's worker `process.argv` does NOT include the CLI's
   `--update-snapshots` flag — checking it here was tried in PR #178
   and silently no-op'd; the mkdir bootstrap is the supported pathway.) */
const SKIP_REASON =
  `No visual baselines committed for ${process.platform}. ` +
  `Run \`npm run verify:visual -- --update-snapshots\` to bless on this platform.`;

/* Plan 37 (visual baselines) — pin all visual specs to one worker. The 14
   captures share a Vite dev server with the other 80+ specs locally;
   parallel-worker contention caused sub-pixel font drift past the
   1% maxDiffPixelRatio threshold. Serial mode eliminates the race.
   The new `verify:visual` step in package.json also runs --workers=1,
   so this directive is belt-and-suspenders for direct invocations. */
test.describe.configure({ mode: 'serial' });

/* Plan 37 (visual baselines, additional layer) — chromium font hinting on
   Windows is non-deterministic at the sub-pixel level even with
   animations disabled and serial workers; consecutive captures of
   the SAME page can drift by ~1-2% of pixels (typically along font
   anti-aliased edges). The global 1% threshold is too tight for
   this seam — widen to 5% for visual specs ONLY so the harness
   stops flagging anti-aliasing drift as regression. Real layout
   regressions (button repositioned, colour swapped, etc.) trip
   much higher pixel counts and still fail. Per-test overrides
   like `toHaveScreenshot('foo.png', { maxDiffPixelRatio: 0.05 })`
   would be more granular but require 14× duplication; the file-
   level override below is cleaner. */
const VISUAL_DIFF_OPTS = { maxDiffPixelRatio: 0.05 } as const;

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
    await expect(page).toHaveScreenshot('library.png', VISUAL_DIFF_OPTS);
  });

  test('upload', async ({ page }) => {
    await page.goto('/#/new');
    /* Wait for the upload view's primary CTA to confirm hydration. */
    await expect(page.getByRole('button', { name: /Paste text/i })).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('upload.png', VISUAL_DIFF_OPTS);
  });

  test('analysing (pre-start)', async ({ page }) => {
    await goToAnalysing(page);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('analysing.png', VISUAL_DIFF_OPTS);
  });

  test('confirm', async ({ page }) => {
    await goToConfirm(page);
    await waitForConfirmViewReady(page);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('confirm.png', VISUAL_DIFF_OPTS);
  });

  test('ready (manuscript)', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');
    /* Per-chapter h1 ("Chapter N — Title") is the hydration signal that
       works at ALL viewports (the desktop-only h2 "Chapters" sidebar
       lives inside a closed <Drawer> at <lg width). */
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('ready.png', VISUAL_DIFF_OPTS);
  });

  test('listen', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('listen.png', VISUAL_DIFF_OPTS);
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
    await expect(page).toHaveScreenshot('generate.png', VISUAL_DIFF_OPTS);
  });
});

/* fs-16 — stats dashboard visual baseline.
 *
 * Seeds a FIXED payload (same dates, same values every run) AND freezes the
 * page clock to 2026-06-13T12:00:00 so StatsView's `today` default
 * (`new Date().toLocaleDateString('en-CA')`) is deterministic. Without the
 * clock freeze the streak sentence ("On a N-day streak") and the 7-day
 * sparkbar window shift day-to-day, breaking the baseline within 1–2 days. */
test.describe('visual baselines (stats)', () => {
  test.skip(!existsSync(BASELINE_DIR), SKIP_REASON);

  test('stats dashboard', async ({ page }) => {
    /* Freeze the page clock BEFORE navigation so the app sees a fixed
       `new Date()` from the first render. 2026-06-13 is the seed's latest
       active day, giving a deterministic 3-day consecutive streak
       (Jun 11 / 12 / 13) and a fully stable sparkbar window. */
    await page.clock.install({ time: new Date('2026-06-13T12:00:00') });
    await page.addInitScript(() => {
      (window as unknown as { __SEED_LIBRARY_STATS__: unknown }).__SEED_LIBRARY_STATS__ = {
        totalListenedSec: 47 * 3600 + 12 * 60, // 47h 12m — stable figure in lede
        booksFinished: 6,
        perBook: [
          { bookId: 'b-coalfall', title: 'The Coalfall Commission', completionPct: 1, finished: true },
          { bookId: 'b-hollow', title: 'Hollow Tide', completionPct: 0.78, finished: false },
          { bookId: 'b-never2', title: 'Neverseen · Book 2', completionPct: 0.54, finished: false },
        ],
        perSeries: [
          { series: 'Neverseen', finishedCount: 1, importedCount: 3 },
          { series: 'Coalfall', finishedCount: 1, importedCount: 2 },
        ],
        /* byDay uses fixed dates. The clock is frozen to 2026-06-13, so the
           last-7-days window is always Jun 7–13. Jun 11/12/13 have activity,
           yielding a stable 3-day streak; Jun 13 is the peak (3 600 s) and
           always renders the single magenta bar. Earlier dates fall outside
           the window and are intentionally absent. */
        byDay: [
          { date: '2026-06-01', seconds: 600 },
          { date: '2026-06-02', seconds: 600 },
          { date: '2026-06-03', seconds: 600 },
          { date: '2026-06-04', seconds: 600 },
          { date: '2026-06-11', seconds: 1200 },
          { date: '2026-06-12', seconds: 1800 },
          { date: '2026-06-13', seconds: 3600 },
        ],
      };
    });
    await page.goto('/#/stats');
    /* Wait for the lede to confirm the fetch resolved and the real content is painted.
       25 s budget: the warmup project is skipped in serial-mode runs so this test
       pays a cold Vite transform on first run. */
    await expect(page.getByTestId('stats-lede')).toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('stats.png', VISUAL_DIFF_OPTS);
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
 *   npm run test:e2e:visual -- --update-snapshots
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
    await expect(page).toHaveScreenshot('library-dark.png', VISUAL_DIFF_OPTS);
  });

  test('upload (dark)', async ({ page }) => {
    await page.goto('/#/new');
    await expect(page.getByRole('button', { name: /Paste text/i })).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot('upload-dark.png', VISUAL_DIFF_OPTS);
  });

  test('analysing (pre-start, dark)', async ({ page }) => {
    await goToAnalysing(page);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('analysing-dark.png', VISUAL_DIFF_OPTS);
  });

  test('confirm (dark)', async ({ page }) => {
    await goToConfirm(page);
    await waitForConfirmViewReady(page);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('confirm-dark.png', VISUAL_DIFF_OPTS);
  });

  test('ready (manuscript, dark)', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('ready-dark.png', VISUAL_DIFF_OPTS);
  });

  test('listen (dark)', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot('listen-dark.png', VISUAL_DIFF_OPTS);
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
    await expect(page).toHaveScreenshot('generate-dark.png', VISUAL_DIFF_OPTS);
  });
});
