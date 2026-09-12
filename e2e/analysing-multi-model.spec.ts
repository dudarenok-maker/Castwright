/* Plan 95 — analysing-stage multi-model UI + sticky status bar.
 *
 * Boots a fresh book through the upload flow, lands on /analysing, kicks
 * off the mock analysis stream, and asserts:
 *   1. Both phase-model chips are present in the DOM (Phase 0 + Phase 1).
 *   2. With no per-phase split configured (the default), both chips show the
 *      single effective model and Phase 1 shows NO "warms up after ch." hint
 *      (plan 118 — that handoff only happens when a split is engaged).
 *   3. Scrolling past the header pins the sticky bar at top-16 (header h1
 *      is no longer in viewport, sticky bar IS).
 *   4. Clicking the sticky bar's Pause button transitions activeStream.state
 *      to 'paused' in Redux + flips the button label to "Resume analysis".
 *   5. The Phase 0 swap dropdown renders read-only while a run is live
 *      (#3141 step 5 — it's a per-run pick for the NEXT run, not a
 *      settings write, so it has nothing to do mid-run).
 *
 * The mock analysis stream (src/mocks/canned-data.ts) drives all four phases
 * in ~7.6 s before advancing the stage to confirm — assertions race that
 * window. Tests that need a longer hold pause the run first.
 */

import { test, expect, type Page } from '@playwright/test';
import { bootFreshBookIntoAnalysing } from './helpers';

async function readAnalysisStream(page: Page) {
  return await page.evaluate(() => {
    const w = window as unknown as { __store__: { getState: () => unknown } };
    const state = w.__store__.getState() as {
      analysis: { activeStream: { state: string; phaseId: number } | null };
    };
    return state.analysis.activeStream;
  });
}

/* Run this file's tests sequentially on a single worker. Each test does a cold
 * `bootFreshBookIntoAnalysing` (goto('/') + upload flow) that triggers a route-level
 * React.lazy chunk load; with fullyParallel + local workers these cold-loads pile
 * onto the single Vite dev server and the visibility timeouts flake under peak
 * battery contention (passes on retry in isolation, exhausts retries under full
 * load). Serial mode caps this file at one concurrent cold-load — the same
 * mitigation 10+ sibling specs use. */
test.describe.configure({ mode: 'serial' });

test.describe('plan 95 — analysing multi-model UI + sticky bar', () => {
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

  test('single-model (no split): both chips name the server-reported model and Phase 1 shows no warm-up hint', async ({
    page,
  }) => {
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();
    const phase1 = page.getByTestId('phase-model-chip-1');
    await expect(phase1).toBeVisible({ timeout: 5_000 });
    /* The mock analysis stream emits `model: 'qwen3.5:9b'` on every phase
       event (Task 2 — the mock exercises the "server ran a different model
       than the UI default" path). With Task 2 wired, the chip now prefers
       the server-reported id over the Redux selection (Gemini 3.1 Flash Lite),
       so both chips must show the 9B label once the SSE arrives. */
    await expect(page.getByTestId('phase-model-chip-0').first()).toContainText(
      'Qwen3.5 9B (local)',
    );
    await expect(phase1.first()).toContainText('Qwen3.5 9B (local)');
    /* And no false promise of a handoff that won't happen with the split off. */
    await expect(phase1).not.toContainText(/warms up/i);
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

    /* The sticky bar unmounts once isAnalysisRunning is false (see plan 95
       mutual-exclusivity invariant in src/views/analysing.tsx). The inline
       Resume button takes over. */
    await expect(page.getByTestId('sticky-pause-button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Resume analysis/i })).toBeVisible();
  });

  test('chip shows the server-reported model label, not the Redux default', async ({ page }) => {
    /* The mock analysis stream (mockAnalyseManuscript in src/lib/api.ts)
       emits `model: 'qwen3.5:9b'` on every phase event.  The Redux default
       for a fresh account is Gemini 3.1 Flash Lite.  Task 2 wires the chip
       to prefer the server-reported model id over the Redux selection, so
       once the first phase event arrives the chip must flip to the 9B label
       rather than the UI's default. */
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();
    const chip0 = page.getByTestId('phase-model-chip-0').first();
    await expect(chip0).toBeVisible({ timeout: 5_000 });
    /* Server emitted qwen3.5:9b — chip must reflect that, not the Redux default. */
    await expect(chip0).toContainText('Qwen3.5 9B (local)');
    await expect(chip0).not.toContainText('Gemini');
  });

  test('Phase 0 model swap is read-only while a run is live (#3141 step 5 — per-run pick, not a settings write)', async ({
    page,
  }) => {
    /* #3141 step 5 superseded this control's old behavior (dispatching
       saveAccountSettings + a toast while the run kept streaming): the
       swap now only ever applies to the NEXT run started from this view,
       so it renders disabled — still showing the current pick — for the
       duration of any live run. See analyzer-settings-ownership.spec.ts's
       "a per-run phase pick does not change settings" for the idle-view
       per-run-pick path this control actually drives. */
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();
    const swap0 = page.getByTestId('phase-model-swap-0');
    await expect(swap0).toBeVisible({ timeout: 5_000 });

    await expect(swap0).toBeDisabled();
    await expect(swap0).toHaveAttribute(
      'title',
      'A run is in progress — pick a model for the next run started from this view.',
    );
  });

  test('live ticker shows "section M/N" sub-bar when mock emits sectionsDone/sectionsTotal', async ({
    page,
  }) => {
    /* The mock analysis stream (mockAnalyseManuscript in src/lib/api.ts)
       emits a live payload with sectionsDone:2 / sectionsTotal:5 on Phase 0
       between 40–70% progress. Assert the section text renders in the ticker
       before the phase completes. */
    await bootFreshBookIntoAnalysing(page);
    await page.getByRole('button', { name: /Start analysis/i }).click();
    /* Wait for the live ticker to appear with section info. The mock emits
       the live payload during Phase 0 progress 40–70%, so it will appear
       while Phase 0 is streaming. */
    await expect(page.getByText(/section 2\/5/i)).toBeVisible({ timeout: 8_000 });
  });
});
