/* analysis-pill Task 10 — Spec A
 *
 * Verifies that the status-pill in the top bar shows "Analysing · N%" while
 * the prosody sub-stage (detectEmotions + detectInstruct) is in flight,
 * persists across view navigation, and clears once both passes complete.
 *
 * The mockDetectEmotions + mockDetectInstruct mocks emit three ticks each
 * with fixed delays (~1.56 s + ~0.96 s = ~2.52 s total), giving the test
 * enough time to navigate away and back before the stream clears.
 *
 * Uses the Solway Bay (sb) fixture book — 18 chapters all in 'done' state,
 * already cast + analysed, so detect-emotions-button is immediately clickable
 * without the full goToConfirm → confirm → manuscript ceremony. */

import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

test.describe.configure({ mode: 'serial' });
test.describe('detect-emotions pill progress (analysis-pill Task 10)', () => {
  test('status-pill shows Analysing while prosody runs, persists on listen, clears on completion', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');

    /* Wait for the manuscript view to hydrate — chapter heading is our signal. */
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const pill = page.getByTestId('status-pill');
    const detectBtn = page.getByTestId('detect-emotions-button');

    await expect(detectBtn).toBeVisible({ timeout: 5_000 });
    await expect(detectBtn).toBeEnabled();
    await detectBtn.click();

    /* Confirm dialog must appear and be acknowledged. */
    const confirmBtn = page.getByTestId('detect-emotions-confirm');
    await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
    await confirmBtn.click();

    /* prosodyActions.setActive is dispatched synchronously before the first
       await inside run(), so the pill flips to "Analysing" immediately. */
    await expect(pill).toContainText('Analysing', { timeout: 5_000 });

    /* Navigate to the Listen view while the stream is still running. */
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page);

    /* The status pill lives in the top bar (always mounted) — it should still
       report "Analysing" since the mock takes ~2.5 s total. */
    await expect(pill).toBeVisible();
    await expect(pill).toContainText('Analysing', { timeout: 3_000 });

    /* Navigate back to the manuscript view. */
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    /* prosodyActions.clear fires in the finally block of run() when the mock
       finishes (~2.5 s after the confirm click).  Allow up to 8 s for it to
       clear; the pill must stop containing "Analysing". */
    await expect(pill).not.toContainText('Analysing', { timeout: 8_000 });
  });
});
