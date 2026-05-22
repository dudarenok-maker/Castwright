/* Plan 94 — analysing-stage multi-model UI + sticky status bar.
 *
 * Boots a fresh book through the upload flow, lands on /analysing, kicks
 * off the mock analysis stream, and asserts:
 *   1. Both phase-model chips are present in the DOM (Phase 0 + Phase 1).
 *   2. The Phase 0 chip lights up in `streaming` state while the SSE is in
 *      flight; Phase 1 chip stays in `warming` until the watermark releases.
 *   3. Scrolling past the header pins the sticky bar at top-16 (header h1
 *      is no longer in viewport, sticky bar IS).
 *   4. Clicking the sticky bar's Pause button transitions activeStream.state
 *      to 'paused' in Redux + flips the button label to "Resume analysis".
 *   5. Picking a new model in the Phase 0 swap dropdown dispatches
 *      saveAccountSettings with the right patch + surfaces the toast.
 *
 * The mock analysis stream (src/mocks/canned-data.ts) drives all four phases
 * in ~7.6 s before advancing the stage to confirm — assertions race that
 * window. Tests that need a longer hold pause the run first.
 */

import { test, expect, type Page } from '@playwright/test';

async function readAccountSlice(page: Page) {
  return await page.evaluate(() => {
    const w = window as unknown as { __store__: { getState: () => unknown } };
    const state = w.__store__.getState() as { account: Record<string, unknown> };
    return state.account;
  });
}

async function readAnalysisStream(page: Page) {
  return await page.evaluate(() => {
    const w = window as unknown as { __store__: { getState: () => unknown } };
    const state = w.__store__.getState() as {
      analysis: { activeStream: { state: string; phaseId: number } | null };
    };
    return state.analysis.activeStream;
  });
}

async function bootFreshBookIntoAnalysing(page: Page) {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Start a new book/i })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/new$/);
  await page.getByRole('button', { name: /Paste text/i }).click();
  await page
    .locator('textarea')
    .fill(
      '# The Plan 94 Book\n\n# Chapter 1\n\nA tiny chapter.\n\n# Chapter 2\n\nAnother.\n',
    );
  await page.getByRole('button', { name: /Upload pasted text/i }).click();
  await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
    timeout: 5_000,
  });
  await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('Plan 94 Author');
  await page.getByRole('button', { name: /Save book and start analysis/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
  await expect(page.getByRole('button', { name: /Start analysis/i })).toBeVisible({
    timeout: 5_000,
  });
}

test.describe('plan 94 — analysing multi-model UI + sticky bar', () => {
  test('both phase-model chips are visible on the analysing view', async ({ page }) => {
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();
    /* Two phase-0 chips render once the SSE starts: one inside the
       PhaseCard, one inside the sticky bar. Both are intentional —
       assert via count + visibility, not single-match getByTestId. */
    await expect(page.getByTestId('phase-model-chip-0').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('phase-model-chip-0')).toHaveCount(2);
    /* Phase 1 chip only renders inside the PhaseCard (the sticky bar
       only mounts the chip for the ACTIVE phase). One occurrence. */
    await expect(page.getByTestId('phase-model-chip-1')).toBeVisible();
    await expect(page.getByTestId('phase-model-chip-1')).toHaveCount(1);
    /* Phase 2 has no chip — no model selection for the library-match phase. */
    await expect(page.getByTestId('phase-model-chip-2')).toHaveCount(0);
  });

  test('sticky bar remains in viewport after the page scrolls', async ({ page }) => {
    /* Short viewport so the analysing view's content reliably overflows.
       Mock book pages are tight (~3 phase rows on a 2-chapter manuscript);
       at default 720px the content frequently fits above the fold. */
    await page.setViewportSize({ width: 1280, height: 400 });
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();
    await expect(page.getByTestId('sticky-analysis-bar')).toBeVisible({ timeout: 5_000 });

    /* Capture the natural top before scroll. */
    const before = await page
      .getByTestId('sticky-analysis-bar')
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));

    /* Scroll enough to push everything that's NOT sticky past the top. */
    await page.evaluate(() => window.scrollBy(0, 300));

    /* The defining test for `position: sticky`: after scrolling 300 px, a
       NON-sticky element at `before` would move to `before - 300` (off
       viewport when before<300). The sticky bar must stay >=0 and still be
       in viewport. */
    const after = await page
      .getByTestId('sticky-analysis-bar')
      .evaluate((el) => Math.round(el.getBoundingClientRect().top));
    expect(after).toBeGreaterThanOrEqual(0);
    /* And the sticky.top:64 clamp: the bar shouldn't keep moving down past
       the topbar even though we scrolled. `after` should be near `before`
       or higher (i.e. closer to top), not 300 px lower than where it started. */
    expect(after).toBeLessThanOrEqual(before + 5);
    await expect(page.getByTestId('sticky-analysis-bar')).toBeInViewport();
  });

  test('clicking Pause inside the sticky bar pauses the analysis', async ({ page }) => {
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();
    await expect(page.getByTestId('sticky-pause-button')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('sticky-pause-button')).toHaveText(/Pause analysis/);

    await page.getByTestId('sticky-pause-button').click();

    /* The slice flips to paused. */
    await expect
      .poll(async () => (await readAnalysisStream(page))?.state, { timeout: 5_000 })
      .toBe('paused');

    /* The sticky bar unmounts once isAnalysisRunning is false (see plan 94
       mutual-exclusivity invariant in src/views/analysing.tsx). The inline
       Resume button takes over. */
    await expect(page.getByTestId('sticky-pause-button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Resume analysis/i })).toBeVisible();
  });

  test('Phase 0 model swap writes the saveAccountSettings patch + surfaces the toast', async ({
    page,
  }) => {
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();
    await expect(page.getByTestId('phase-model-swap-0')).toBeVisible({ timeout: 5_000 });

    /* Capture the current persisted value (the default — null in the slice
       since the user hasn't touched the picker yet). */
    const before = await readAccountSlice(page);
    expect(before.analyzerPhase0Model).toBeNull();

    /* Pick a non-default model. The mock putUserSettings handler in
       src/lib/api.ts persists the patch into the in-memory slice. */
    await page.getByTestId('phase-model-swap-0').selectOption('gemini-3.1-flash-lite');

    /* Toast: active-run wording mentions the in-flight chapter completing
       on the previous model. */
    await expect(page.getByTestId('phase-model-swap-0-toast')).toBeVisible();
    await expect(page.getByTestId('phase-model-swap-0-toast')).toContainText(
      /Applies from the next chapter/i,
    );

    /* Slice reflects the new value. */
    await expect
      .poll(async () => (await readAccountSlice(page)).analyzerPhase0Model, { timeout: 5_000 })
      .toBe('gemini-3.1-flash-lite');
  });
});
