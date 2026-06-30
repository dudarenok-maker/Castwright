/* analysis-pill Task 10 — Spec C
 *
 * Verifies the double-fire guard for the prosody sub-stage:
 *   shouldAutoTriggerProsody / selectAnalysisBusyForBook gate the
 *   detect-emotions-button (disabled while any prosody stream is active)
 *   and prevent a second concurrent run.
 *
 * The spec uses two phases:
 *
 *   Phase 1 — store-injection (simulates the auto-trigger or a cross-tab
 *   broadcast seeding an active stream without driving the UI).  Asserts:
 *   • pill shows "Analysing"
 *   • detect-emotions-button is disabled (busy gate)
 *   • pill reflects a progress update (prosody/updateProgress works)
 *   • clearing the stream re-enables the button
 *
 *   Phase 2 — real click-through (drives the slowed mock via the button).
 *   Asserts:
 *   • button is disabled while the manual stream is active (no double-fire)
 *   • pill clears after the mock completes (~2.5 s)
 *   • button is re-enabled (no zombie second stream)
 *
 * Uses the Solway Bay (sb) fixture book. */

import { test, expect } from '@playwright/test';

type Store = {
  dispatch: (action: unknown) => void;
};

test.describe.configure({ mode: 'serial' });
test.describe('prosody auto-trigger guard (analysis-pill Task 10)', () => {
  test('active stream disables detect-emotions button; cleared stream re-enables it', async ({
    page,
  }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });

    const pill = page.getByTestId('status-pill');
    const detectBtn = page.getByTestId('detect-emotions-button');

    /* Pre-condition: button is enabled when no stream is active. */
    await expect(detectBtn).toBeEnabled({ timeout: 3_000 });

    /* ── Phase 1: store-injection ─────────────────────────────────────── */

    /* Seed an active prosody stream directly (simulating the auto-trigger
       or a cross-tab broadcast — both ultimately dispatch prosody/setActive). */
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      store.dispatch({
        type: 'prosody/setActive',
        payload: { bookId: 'sb', progress: 0.25, label: 'Detecting emotions' },
      });
    });

    /* selectAnalysisSubstage now returns a non-null substage → pill shows
       "Analysing · 25%" and the busy selector returns true. */
    await expect(pill).toContainText('Analysing', { timeout: 3_000 });
    await expect(pill).toContainText('25%', { timeout: 3_000 });

    /* The double-fire guard: detect-emotions-button is DISABLED while
       selectAnalysisBusyForBook(state, 'sb') is true. */
    await expect(detectBtn).toBeDisabled({ timeout: 3_000 });

    /* Advance the stream progress. */
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      store.dispatch({
        type: 'prosody/updateProgress',
        payload: { bookId: 'sb', progress: 0.75 },
      });
    });

    /* Pill reflects the new progress value. */
    await expect(pill).toContainText('75%', { timeout: 3_000 });

    /* Clear the stream (simulating the finally block of run()). */
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      store.dispatch({ type: 'prosody/clear', payload: { bookId: 'sb' } });
    });

    /* Guard cleared → pill returns to idle, button re-enabled. */
    await expect(pill).not.toContainText('Analysing', { timeout: 3_000 });
    await expect(detectBtn).toBeEnabled({ timeout: 3_000 });

    /* ── Phase 2: real click-through ─────────────────────────────────── */

    /* Drive the button → confirm → slowed mock path to prove no double-run. */
    await detectBtn.click();
    const confirmBtn = page.getByTestId('detect-emotions-confirm');
    await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
    await confirmBtn.click();

    /* While the run is active, the component renders detect-emotions-progress
       (the spinner bar) IN PLACE OF the button — the button is unmounted.
       This is the double-fire guard in action: the trigger surface is gone. */
    await expect(pill).toContainText('Analysing', { timeout: 5_000 });
    await expect(page.getByTestId('detect-emotions-progress')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId('detect-emotions-button')).not.toBeAttached({ timeout: 3_000 });

    /* Wait for the mock to complete (~2.5 s).  Button reappears enabled and
       pill clears — proving no zombie second stream is running. */
    await expect(pill).not.toContainText('Analysing', { timeout: 8_000 });
    await expect(detectBtn).toBeVisible({ timeout: 3_000 });
    await expect(detectBtn).toBeEnabled();
  });
});
