/* Plan 77 — browser-level coverage for the per-chapter loudness report
   card + the per-row drift badge. The mock seed for Solway Bay (in
   `src/lib/api.ts`) ships a deterministic chapterLufs payload that
   mixes on-target / slight / off-target / no-data / single-pass rows,
   so the report card has real content to render under mocks.

   This pins the public test hooks (testids + bucket attributes) that
   the unit tests also assert on; the end-to-end pass verifies the
   redux hydration + view layout actually surface them in a real
   browser. */

import { test, expect } from '@playwright/test';

/* Same parallel-worker contention story as listen-playback.spec.ts:
   chapter-row hydration races other workers' SSE traffic on Windows.
   Serial mode within this file keeps the spec stable while other files
   parallelise. */
test.describe.configure({ mode: 'serial' });

test.describe('listen loudness report card', () => {
  test('renders the report card + summary + sparkline on the Listen view', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page).toHaveURL(/#\/books\/sb\/listen/);

    /* Wait for hydration: the loudness card only renders once the
       chapters slice has the mock chapterLufs map. The empty book-meta
       header would race past us otherwise. */
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const card = page.getByTestId('loudness-report');
    await expect(card).toBeVisible({ timeout: 10_000 });
    /* Summary line names a per-book on-target count + the formatted
       target. Mock seed is centred at -16 LUFS. */
    const summary = page.getByTestId('loudness-report-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(/of \d+ chapters within ±2 LU/);
    /* Sparkline renders one column per chapter — the mock seed has 18
       chapters, all listenable. */
    await expect(page.getByTestId('loudness-report-sparkline')).toBeVisible();
  });

  test('expandable per-chapter table toggles open and surfaces row buckets', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    /* Wait for header → confirms book-meta hydrated → chapters slice
       is also populated by then (same hydration effect). */
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('loudness-report')).toBeVisible({ timeout: 10_000 });

    const toggle = page.getByTestId('loudness-report-toggle');
    await expect(toggle).toBeVisible();
    /* Table is collapsed by default. */
    await expect(page.getByTestId('loudness-report-table')).not.toBeVisible();
    await toggle.click();
    await expect(page.getByTestId('loudness-report-table')).toBeVisible();
    /* The mock seed puts a 4.4 LU off-target on chapter 9 — check that
       the row carries the right data-bucket attribute. */
    const row9 = page.getByTestId('loudness-report-row-9');
    await expect(row9).toBeVisible();
    await expect(row9).toHaveAttribute('data-bucket', 'off-target');
    /* Chapter 1 (delta 0.1) is on-target. */
    const row1 = page.getByTestId('loudness-report-row-1');
    await expect(row1).toHaveAttribute('data-bucket', 'on-target');
  });

  test('per-row drift badge appears on the chapter list for measured chapters', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/listen');
    /* Wait for header → chapters slice is hydrated. */
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByTestId('chapter-row-1')).toBeVisible({ timeout: 10_000 });
    /* Chapter 1 has two-pass data at +0.1 LU drift — badge present,
       bucket on-target. */
    const badge1 = page.getByTestId('chapter-row-1-lufs-badge');
    await expect(badge1).toBeVisible({ timeout: 5_000 });
    await expect(badge1).toHaveAttribute('data-bucket', 'on-target');
    /* Chapter 11 is single-pass-only in the mock seed — badge must
       NOT render (the critical gate from plan 71). */
    await expect(page.getByTestId('chapter-row-11')).toBeVisible();
    await expect(page.getByTestId('chapter-row-11-lufs-badge')).toHaveCount(0);
    /* Chapter 14 has null lufs in the seed — badge must NOT render. */
    await expect(page.getByTestId('chapter-row-14')).toBeVisible();
    await expect(page.getByTestId('chapter-row-14-lufs-badge')).toHaveCount(0);
  });
});
