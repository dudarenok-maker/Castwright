/* #3435 decision A — while a book's main analysis run is live, the Generate
 * view disables Re-analyse (and Include) with "Pause the analysis first";
 * once the run is paused, the control is enabled again.
 *
 * This crosses the redux → component seam (the shared `analysis.activeStream`
 * snapshot drives a row control through `selectMainAnalysisLive`), which jsdom
 * can misreport. `window.__store__` exposes only the store (src/main.tsx), so
 * the spec dispatches RAW actions.
 *
 * What this cannot show: mock mode has no server, so no 409, no drain, no
 * abort and no second device. Those are the route and unit tests
 * (server/src/routes/analysis.refuse-while-main.test.ts and the view tests). */

import { test, expect } from '@playwright/test';

type Store = {
  getState: () => {
    manuscript: {
      manuscriptId: string | null;
      title: string;
      format: string;
      wordCount: number;
      sourceText: string;
    };
  };
  dispatch: (action: unknown) => void;
};

type GapStore = {
  getState: () => { chapters: { chapters: Array<Record<string, unknown>> } };
  dispatch: (action: unknown) => void;
};

test('Re-analyse is disabled with "Pause the analysis first" while the main analysis runs, enabled once paused', async ({
  page,
}) => {
  await page.goto('/#/books/sb/generate');
  const reanalyse = page.getByTestId('chapter-row-1-reanalyse');
  await expect(reanalyse).toBeVisible({ timeout: 10_000 });
  await expect(reanalyse).toBeEnabled();

  /* Mock fixtures carry no manuscript id; seed one so the selector has a
     manuscript to match. */
  const manuscriptId = await page.evaluate(() => {
    const store = (window as unknown as { __store__: Store }).__store__;
    const m = store.getState().manuscript;
    if (m.manuscriptId) return m.manuscriptId;
    store.dispatch({
      type: 'manuscript/uploadComplete',
      payload: {
        manuscriptId: 'mns_e2e_3435',
        title: m.title,
        format: m.format,
        wordCount: m.wordCount,
        sourceText: m.sourceText,
      },
    });
    return 'mns_e2e_3435';
  });

  await page.evaluate((id) => {
    const store = (window as unknown as { __store__: Store }).__store__;
    store.dispatch({
      type: 'analysis/setActiveStream',
      payload: {
        bookId: 'sb',
        manuscriptId: id,
        phaseId: 1,
        phaseLabel: 'Parsing and attribution',
        phaseProgress: 0.4,
        remainingMs: null,
        lastTickAt: Date.now(),
        state: 'running',
        kind: 'main',
      },
    });
  }, manuscriptId);

  await page.locator('#chapter-1 > button').click();
  await expect(reanalyse).toBeDisabled();
  await expect(page.getByText('Pause the analysis first').first()).toBeVisible();

  await page.evaluate((id) => {
    const store = (window as unknown as { __store__: Store }).__store__;
    store.dispatch({ type: 'analysis/setPaused', payload: { manuscriptId: id } });
  }, manuscriptId);

  await expect(reanalyse).toBeEnabled();
  await expect(page.getByText('Pause the analysis first')).toHaveCount(0);
});

/* #3435 decision F / O2 — a chapter whose analysis did not finish (the
 * book-state's analysis gaps, carried by the layout's hydrate into
 * `chapters.analysisGapById`) shows an analysis note and an enabled Re-analyse
 * control on its Generate row, even on a queued row, which has no Re-analyse
 * otherwise. Crosses the chapters slice → Generate row seam. */
test('a queued chapter with an analysis gap shows the note and an enabled Re-analyse', async ({ page }) => {
  await page.goto('/#/books/sb/generate');
  await expect(page.getByTestId('chapter-row-1-reanalyse')).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => {
    const store = (window as unknown as { __store__: GapStore }).__store__;
    const chapters = store.getState().chapters.chapters;
    /* Flip only chapter 1 to 'queued' (as generate-disabled-while-analysing does). */
    store.dispatch({
      type: 'chapters/setChapters',
      payload: chapters.map((c, i) => (i === 0 ? { ...c, state: 'queued' } : c)),
    });
    store.dispatch({
      type: 'chapters/setAnalysisGap',
      payload: { chapterId: 1, message: "Analysis didn't finish for this chapter." },
    });
  });

  await page.locator('#chapter-1 > button').click();
  await expect(page.getByTestId('chapter-row-1-analysis-gap')).toContainText(
    "Analysis didn't finish for this chapter.",
  );
  await expect(page.getByTestId('chapter-row-1-reanalyse')).toBeEnabled();
});
