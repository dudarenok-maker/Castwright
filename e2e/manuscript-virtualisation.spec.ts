/* Plan 92 — manuscript view virtualisation.

   Vitest pins the threshold-based code path (flat below 60 segments,
   virtualised above). This spec is the browser-side counterpart: under
   real layout measurement, the virtualizer ACTUALLY keeps only the
   visible window in the DOM. The threshold mode test (vitest) cannot
   verify that because jsdom doesn't measure layout.

   The Solway Bay fixture ships 14 sentences in chapter 3 — far below
   the threshold — so we dispatch a synthetic 200-sentence payload via
   the dev-only `window.__store__` hook (src/main.tsx:56-58) to trip
   virtualisation. Same hook the revision-diff e2e uses for redux
   inspection. */

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test.describe('manuscript view — windowed render at scale (plan 92)', () => {
  test('14-sentence Solway Bay chapter renders flat (below the threshold)', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');
    /* Chapters sidebar h2 is the canonical hydration signal. */
    await expect(page.getByRole('heading', { name: /^Chapters$/, level: 2 })).toBeVisible({
      timeout: 5_000,
    });
    /* Below the 60-segment threshold the flat-render path is active —
       no virtual container in the DOM. */
    await expect(page.getByTestId('manuscript-virtual-container')).toHaveCount(0);
  });

  test('200 alternating-character sentences engage the virtualizer and keep only a windowed subset in the DOM', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapters$/, level: 2 })).toBeVisible({
      timeout: 5_000,
    });

    /* Inject 200 alternating-character sentences into chapter 3.
       Alternating characters guarantees one segment per sentence (the
       segmenter only folds *consecutive* same-speaker runs), so 200
       sentences → 200 segments → well above the 60-segment threshold. */
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: { getState: () => unknown; dispatch: (a: unknown) => unknown } }).__store__;
      const manuscript = (store.getState() as { manuscript: { bookId: string | null; manuscriptId: string | null; title: string | null } }).manuscript;
      const sentences = Array.from({ length: 200 }, (_, i) => ({
        id: i + 1,
        chapterId: 3,
        characterId: i % 2 === 0 ? 'narrator' : 'halloran',
        text: `Synthetic sentence ${i + 1} for virtualisation perf coverage. Padding to give the row some real height: lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
      }));
      store.dispatch({
        type: 'manuscript/hydrateFromBookState',
        payload: {
          state: {
            bookId: manuscript.bookId,
            manuscriptId: manuscript.manuscriptId,
            title: manuscript.title,
          },
          sentences,
        },
      });
    });

    /* The virtualized container's testid only renders when the
       segments.length >= 60 threshold engages. */
    await expect(page.getByTestId('manuscript-virtual-container')).toBeVisible({
      timeout: 2_000,
    });

    /* Perf invariant — only a small windowed subset of segments lives
       in the DOM. The virtualizer's default overscan is 5 above + 5
       below the visible viewport, plus whatever fits within the
       viewport. On a desktop chromium viewport (1280×720) that's
       roughly 20-40 segments, never the full 200. The exact count
       depends on rendered row height, so the test uses a generous
       upper bound (60) but still catches a regression to "render all". */
    const rendered = await page
      .locator('[data-testid="manuscript-virtual-container"] > [data-index]')
      .count();
    expect(rendered, 'virtualised row count').toBeGreaterThan(0);
    expect(rendered, 'virtualised row count').toBeLessThan(60);
  });
});
