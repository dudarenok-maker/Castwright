/* fs-15 / fs-16 — browser-level coverage for the continue-listening rail
 * (fs-15) and the #/stats Reading-column dashboard (fs-16).
 *
 * Both features seed data via `page.addInitScript` before `page.goto` so
 * the mock API's __SEED_CONTINUE__ and __SEED_LIBRARY_STATS__ globals are
 * in place before the app boots — the same pattern used by listen-resume.spec.ts
 * for __SEED_LISTEN_PROGRESS__. */

import { test, expect } from '@playwright/test';

/* Generous timeout: the warmup project is skipped in isolated runs so the
   first spec pays a cold Vite transform. */
test.describe.configure({ timeout: 90_000 });

/* ── Shared seed payloads ─────────────────────────────────────────────── */

/** One in-progress book that exists in the mock library ('sb' = Solway Bay). */
const CONTINUE_SEED = [
  {
    bookId: 'sb',
    title: 'Solway Bay',
    chapterId: 3,
    currentSec: 240,
    remainingSec: 4200,
    completionPct: 0.22,
    updatedAt: '2026-06-13T10:00:00Z',
  },
];

/** Stable library-stats payload — same values as the Vitest unit fixture so the
 *  semantics are already proven; using fixed dates here means the sparkbar
 *  count (7) is always 7 regardless of when the test runs. */
const STATS_SEED = {
  totalListenedSec: 47 * 3600 + 12 * 60, // 47h 12m
  booksFinished: 6,
  perBook: [
    { bookId: 'b-coalfall', title: 'The Coalfall Commission', completionPct: 1, finished: true },
    { bookId: 'b-hollow', title: 'Hollow Tide', completionPct: 0.78, finished: false },
    { bookId: 'b-never2', title: 'Neverseen · Book 2', completionPct: 0.54, finished: false },
    { bookId: 'b-unstarted', title: 'Unstarted Book', completionPct: 0, finished: false },
  ],
  perSeries: [
    { series: 'Neverseen', finishedCount: 1, importedCount: 3 },
    { series: 'Coalfall', finishedCount: 1, importedCount: 2 },
  ],
  byDay: [
    { date: '2026-06-01', seconds: 600 },
    { date: '2026-06-02', seconds: 600 },
    { date: '2026-06-03', seconds: 600 },
    { date: '2026-06-04', seconds: 600 },
    { date: '2026-06-11', seconds: 1200 },
    { date: '2026-06-12', seconds: 1800 },
    { date: '2026-06-13', seconds: 3600 }, // peak day
  ],
};

/* ── fs-15 continue-listening rail ───────────────────────────────────── */

test.describe('fs-15 continue-listening rail', () => {
  test('renders the rail + card when __SEED_CONTINUE__ is set', async ({ page }) => {
    await page.addInitScript((seed) => {
      (window as unknown as { __SEED_CONTINUE__: unknown }).__SEED_CONTINUE__ = seed;
    }, CONTINUE_SEED);
    await page.goto('/');

    /* Wait for the library to hydrate (the "Start a new book" CTA is
       the canonical hydration signal used across coverage.spec.ts). */
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 25_000,
    });

    /* The rail section heading and the seeded card must be visible. */
    await expect(page.getByRole('heading', { name: /Continue listening/i })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole('button', { name: /Continue listening to Solway Bay/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('clicking a continue card navigates to the book listen view', async ({ page }) => {
    await page.addInitScript((seed) => {
      (window as unknown as { __SEED_CONTINUE__: unknown }).__SEED_CONTINUE__ = seed;
    }, CONTINUE_SEED);
    await page.goto('/');

    /* Wait for the card to render. */
    const card = page.getByRole('button', { name: /Continue listening to Solway Bay/i });
    await card.waitFor({ state: 'visible', timeout: 25_000 });

    await card.click();

    /* handleOpenContinue dispatches hydrateFromUrl({ kind: 'ready', bookId: 'sb',
       view: 'listen', ... }) which updates the hash to #/books/sb/listen. */
    await expect(page).toHaveURL(/#\/books\/sb\/listen/, { timeout: 10_000 });
  });

  test('does NOT render the rail when __SEED_CONTINUE__ is empty', async ({ page }) => {
    /* No seed script — the mock returns [] by default. */
    await page.goto('/');

    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 25_000,
    });

    /* The rail section must be absent. */
    await expect(page.getByRole('heading', { name: /Continue listening/i })).not.toBeVisible();
  });
});

/* ── fs-16 #/stats Reading-column dashboard ─────────────────────────── */

test.describe('fs-16 #/stats dashboard', () => {
  test('renders the headline lede and figures', async ({ page }) => {
    await page.addInitScript((seed) => {
      (window as unknown as { __SEED_LIBRARY_STATS__: unknown }).__SEED_LIBRARY_STATS__ = seed;
    }, STATS_SEED);

    await page.goto('/#/stats');

    /* Lede resolves once the async getLibraryStats() fetch completes.
       We wait on this first — it's both the hydration signal AND the
       content assertion. The heading ("Your listening") is stable once
       the page mounts, but the lede requires the async fetch to settle. */
    await expect(page.getByTestId('stats-lede')).toBeVisible({ timeout: 20_000 });

    /* The page h1 "Your listening" is a MixedHeading — text split across
       two nodes, so we match on the role+accessible-name which Playwright
       folds from the full text content. */
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 5_000 });

    /* 47h 12m total — the leading text inside the Lora sentence. */
    await expect(page.getByTestId('stats-lede')).toContainText('47h 12m');
  });

  test('renders 7 sparkbars', async ({ page }) => {
    await page.addInitScript((seed) => {
      (window as unknown as { __SEED_LIBRARY_STATS__: unknown }).__SEED_LIBRARY_STATS__ = seed;
    }, STATS_SEED);

    await page.goto('/#/stats');

    /* Wait for the lede so we know the fetch resolved. */
    await expect(page.getByTestId('stats-lede')).toBeVisible({ timeout: 15_000 });

    /* Exactly 7 sparkbar elements (one per day in the last-7-days window). */
    await expect(page.getByTestId('stats-sparkbar')).toHaveCount(7, { timeout: 5_000 });
  });

  test('renders completion rows for in-progress books', async ({ page }) => {
    await page.addInitScript((seed) => {
      (window as unknown as { __SEED_LIBRARY_STATS__: unknown }).__SEED_LIBRARY_STATS__ = seed;
    }, STATS_SEED);

    await page.goto('/#/stats');

    await expect(page.getByTestId('stats-lede')).toBeVisible({ timeout: 15_000 });

    /* "Hollow Tide" is in progress (78%) — must appear in the progress list. */
    await expect(page.getByTestId('stats-progress-row').filter({ hasText: 'Hollow Tide' })).toBeVisible({
      timeout: 5_000,
    });

    /* "Unstarted Book" has 0% completion — must NOT appear. */
    await expect(page.getByTestId('stats-progress-row').filter({ hasText: 'Unstarted Book' })).not.toBeVisible();
  });

  test('renders a per-series line', async ({ page }) => {
    await page.addInitScript((seed) => {
      (window as unknown as { __SEED_LIBRARY_STATS__: unknown }).__SEED_LIBRARY_STATS__ = seed;
    }, STATS_SEED);

    await page.goto('/#/stats');

    await expect(page.getByTestId('stats-lede')).toBeVisible({ timeout: 15_000 });

    /* "Neverseen" series row with "1 of 3 finished". */
    await expect(page.getByTestId('stats-series-row').filter({ hasText: 'Neverseen' })).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId('stats-series-row').filter({ hasText: 'Neverseen' })).toContainText(
      '1 of 3',
    );
  });
});
