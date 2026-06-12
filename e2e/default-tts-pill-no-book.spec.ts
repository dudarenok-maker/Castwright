/* Browser-level golden path for the default-engine TTS control being
 * reachable WITHOUT an open book.
 *
 * Runs against Vite in mock mode (`.env.e2e`) where the mock api keeps
 * Kokoro (the account default per FRONTEND_ACCOUNT_DEFAULTS) pre-loaded at
 * startup. The user lands on the Books/library view (no book open) — the
 * Status pill must now render there (because a default TTS control is
 * available), and opening its popover must surface the Kokoro Load/Stop
 * control instead of the old "TTS controls appear once a manuscript is open"
 * dead-end text. This lets the user pre-load the model right after launch.
 *
 * Pairs with docs/features/archive/30-global-model-control.md (default-engine pill
 * reachable on book-less views) and crosses the redux/layout/popover seam
 * Vitest+jsdom can't fully exercise (the Status pill's render gate +
 * popover open + per-engine pill render). */

import { test, expect } from '@playwright/test';
import { waitForLibraryViewReady } from './helpers';

test.describe('Default-engine TTS pill — reachable on the Books view (no book open)', () => {
  test('surfaces the Kokoro control in the Status popover before any book is opened', async ({
    page,
  }) => {
    /* Cold boot lands on the library view — no book in scope. */
    await page.goto('/');
    await waitForLibraryViewReady(page);

    /* The Status pill now renders even with no book open, because the default
       engine's control is available. Open its popover (clicking pins it). */
    await page.getByTestId('status-pill').click();
    await expect(page.getByTestId('status-popover')).toBeVisible({ timeout: 5_000 });

    /* The Kokoro control is reachable — mock keeps it pre-loaded, so it reads
       "Kokoro ready" with a Stop button. */
    await expect(page.getByText(/Kokoro ready/i).first()).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole('button', { name: /^stop \(voice engine\)$/i }).first(),
    ).toBeVisible();

    /* The dead-end fallback must be gone. */
    await expect(
      page.getByText(/TTS controls appear once a manuscript is open/i),
    ).toHaveCount(0);
  });
});
