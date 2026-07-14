/* fs-58 heartbeat follow-up — Task 13.
 *
 * The status-popover's SubstageRow (Task 10) renders the review engine +
 * model name (`substage-engine-model`) and a ticking timer while a script
 * review streams — not just a bare percent, so a stalled Ollama/Gemini call
 * reads differently from real progress. mockReviewScript (Task 12) now
 * emits a "Loading model" tick, then a "waiting" tick carrying
 * `model: 'qwen3.5:9b'` / `engine: 'local'` (persisted last-known-value —
 * later ticks that omit model/engine don't clear it), then a streaming
 * heartbeat, before the run completes (~1.46 s total).
 *
 * This spec proves the global top-bar pill's popover surfaces that engine
 * + model line, and that the inline chapter-review progress pill is still
 * visibly counting, while the review streams.
 */

import { test, expect } from '@playwright/test';

test('script review shows engine·model and a live progress indicator on the global pill', async ({
  page,
}) => {
  await page.goto('/#/books/sb/manuscript');

  /* Wait for the manuscript view to hydrate. */
  await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
    timeout: 10_000,
  });

  /* Trigger a single-chapter review (same trigger used by the existing
     analysis-pill Cancel spec — e2e/script-review-pill-progress.spec.ts). */
  const reviewBtn = page.getByTestId('review-script-chapter');
  await expect(reviewBtn).toBeVisible({ timeout: 5_000 });
  await expect(reviewBtn).toBeEnabled();
  await reviewBtn.click();

  /* The inline review pill shows immediately — scriptReviewActions.setActive
     is dispatched before the mock's first await. */
  const progressPill = page.getByTestId('review-script-progress');
  await expect(progressPill).toBeVisible({ timeout: 5_000 });

  /* Open the global status pill's popover (top bar, always mounted). */
  await page.getByTestId('status-pill').click();
  const popover = page.getByTestId('status-popover');
  await expect(popover).toBeVisible({ timeout: 5_000 });

  /* Once the mock's "waiting" phase tick lands (~560 ms in), the substage
     row shows "Ollama · <friendly model name>" and keeps showing it
     (last-known-value semantics) through the rest of the ~1.46 s run. */
  await expect(page.getByTestId('substage-engine-model')).toContainText(/Ollama|Gemini/, {
    timeout: 5_000,
  });

  /* The moving progress indicator: the inline pill is still visible
     alongside the popover's substage row. */
  await expect(progressPill).toBeVisible();
  await expect(page.getByTestId('substage-row')).toBeVisible();
});
