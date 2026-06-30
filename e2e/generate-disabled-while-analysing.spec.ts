/* analysis-pill Task 10 — Spec D
 *
 * Verifies that the Generate controls are blocked while an analysis
 * sub-stage is in flight:
 *
 *   (a) The allComplete "Regenerate" button on the Generate view is
 *       `disabled` while analysisBusy is true.
 *
 *   (b) The "Review Script" button (review-script-chapter) on the
 *       Manuscript view is `disabled` while analysisBusy is true.
 *
 *   (c) Clicking a per-chapter "Generate this chapter" row button
 *       (chapter-row-${id}-generate) while analysisBusy fires a warn
 *       toast with the "Wait — emotions are still being detected" copy.
 *
 * Sequence:
 *   1. Navigate to sb/manuscript, start detect-emotions → mock runs ~2.5 s.
 *   2. (b) Assert review-script-chapter is disabled on the manuscript view.
 *   3. Navigate to sb/generate.
 *   4. (a) Assert the allComplete "Regenerate" button is disabled.
 *   5. Inject chapter 1 as 'queued' via store (to surface the per-chapter
 *      generate button — it only appears when the row state is 'queued').
 *   6. Expand chapter 1 row → click chapter-row-1-generate.
 *   7. (c) Assert the warn toast fires.
 *
 * The slowed mock gives ~2.5 s of analysisBusy window — enough for all
 * navigation + assertions before the stream auto-clears. */

import { test, expect } from '@playwright/test';

type Store = {
  getState: () => {
    chapters: {
      chapters: Array<Record<string, unknown>>;
    };
  };
  dispatch: (action: unknown) => void;
};

test.describe.configure({ mode: 'serial' });
test.describe('generate gate while analysing (analysis-pill Task 10)', () => {
  test('(a) Regenerate disabled + (b) Review Script disabled + (c) warn toast on chapter-row generate', async ({
    page,
  }) => {
    /* ── Navigate to manuscript, start detect-emotions ────────────────── */
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const detectBtn = page.getByTestId('detect-emotions-button');
    await expect(detectBtn).toBeVisible({ timeout: 5_000 });
    await expect(detectBtn).toBeEnabled();
    await detectBtn.click();

    const confirmBtn = page.getByTestId('detect-emotions-confirm');
    await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
    await confirmBtn.click();
    /* prosodyActions.setActive dispatched synchronously — analysisBusy = true. */

    /* ── (b) Review Script button disabled on manuscript view ─────────── */
    const reviewScriptBtn = page.getByTestId('review-script-chapter');
    await expect(reviewScriptBtn).toBeVisible({ timeout: 5_000 });
    await expect(reviewScriptBtn).toBeDisabled({ timeout: 3_000 });

    /* ── Navigate to Generate view ────────────────────────────────────── */
    await page.goto('/#/books/sb/generate');

    /* The sb fixture has all 18 chapters in 'done' state → allComplete = true
       → the "Regenerate" button is visible (and disabled while analysisBusy). */
    const regenerateBtn = page.getByRole('button', { name: /^Regenerate$/ });
    await expect(regenerateBtn).toBeVisible({ timeout: 10_000 });

    /* ── (a) Regenerate button disabled ───────────────────────────────── */
    await expect(regenerateBtn).toBeDisabled({ timeout: 3_000 });

    /* ── Inject chapter 1 as 'queued' to expose the per-chapter button ── */
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      const chapters = store.getState().chapters.chapters;
      /* Flip only chapter id:1 to 'queued'; all others stay 'done'.
         chapters/setChapters replaces s.chapters wholesale. */
      const patched = chapters.map((c, i) => (i === 0 ? { ...c, state: 'queued' } : c));
      store.dispatch({ type: 'chapters/setChapters', payload: patched });
    });

    /* Chapter 1 is now 'queued' → allComplete is false.  The "Regenerate"
       button disappears; chapter 1 row flips to the queued appearance. */

    /* ── Expand chapter 1 row ─────────────────────────────────────────── */
    /* The toggle button is the direct child <button> of #chapter-1.
       After clicking, the expanded panel renders the "Generate this chapter" button. */
    await page.locator('#chapter-1 > button').click();

    /* ── (c) Click chapter-row-1-generate → warn toast ───────────────── */
    const chGenBtn = page.getByTestId('chapter-row-1-generate');
    await expect(chGenBtn).toBeVisible({ timeout: 3_000 });
    await chGenBtn.click();

    /* handleGenerateChapter checks analysisBusy first; since the mock is
       still running it fires a warn toast with the prosody-running copy. */
    await expect(
      page.getByRole('status').getByText(/Wait — emotions are still being detected/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});
