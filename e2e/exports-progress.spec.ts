import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

/**
 * Listen-section finalize — export queue bar completes after modal close.
 *
 * Locks the key behavioural fix: the export progress driven by the
 * store-level `exportPollMiddleware` (src/store/exports-middleware.ts)
 * advances a queued job to completion REGARDLESS of whether the export
 * modal is open. Previously the modal's own useEffect was the only
 * poller, so closing it froze the queue-rail bar mid-flight.
 *
 * Flow:
 *  - Open the export modal from the M4B download tile (download tab,
 *    M4B preselected via the `prefill` prop).
 *  - Submit the export (POST createBookExport → exportStarted; the
 *    middleware begins polling getBookExport every 800 ms).
 *  - CLOSE the modal immediately, without waiting for completion.
 *  - Assert the Listen-view queue-rail row for that export reaches the
 *    terminal "Done" state on its own.
 *
 * In mock mode (VITE_USE_MOCKS=true) the job ticks
 * 0 → 0.25 (~700ms) → 0.6 (~1500ms) → done (~2400ms); the 800 ms poll
 * picks up the terminal state shortly after. A 10 s completion budget is
 * generous against that ~2.4 s mock finish.
 */
test.describe('listen finalize — export bar completes after modal close', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);
  });

  test('queue-rail row reaches Done while the export modal is closed', async ({ page }) => {
    // Open the modal from the M4B download tile.
    const tile = page.getByTestId('download-tile-m4b');
    await expect(tile).toBeVisible();
    await tile.getByRole('button', { name: /Download/i }).click();

    const modal = page.getByTestId('export-audiobook-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    // Modal opens on the download tab with M4B preselected.
    await expect(page.getByTestId('export-format-m4b')).toBeVisible();

    // Submit the export — the active-job preview row mounting confirms
    // the POST was accepted (no 409 in mock mode) and the slice has the job.
    await page.getByTestId('export-submit').click();
    await expect(page.getByTestId('export-active-job')).toBeVisible({ timeout: 10_000 });

    // Close the modal WITHOUT waiting for completion. From here only the
    // store-level poll middleware can drive the job to done.
    await modal.getByRole('button', { name: 'Close' }).first().click();
    await expect(modal).toBeHidden({ timeout: 5_000 });

    // The queue-rail row for the export (mock filename "Mock audiobook.m4b")
    // must reach the terminal "Done" status on its own. The rail is a pure
    // view of the exports slice, advanced only by exportPollMiddleware now
    // that the modal is gone. Submitting a live export replaces the demo
    // fixture rows, so the rail holds exactly this one row — its filename
    // and "Done" status pin completion.
    // Scoped to the queue-rail section (data-testid="export-queue-rail") so
    // a "Done" inside the now-hidden modal's export-active-job row cannot
    // satisfy this assertion.
    const rail = page.getByTestId('export-queue-rail');
    await expect(rail.getByText('Mock audiobook.m4b')).toBeVisible({ timeout: 10_000 });
    await expect(rail.getByText('Done', { exact: true })).toBeVisible({ timeout: 10_000 });
  });
});
