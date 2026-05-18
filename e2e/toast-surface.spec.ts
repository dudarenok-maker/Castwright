import { test, expect } from '@playwright/test';

/* Plan 58 — file-level serial mode. The auto-dismiss 6s window
   timing intermittently raced under parallel-worker contention. */
test.describe.configure({ mode: 'serial' });

/**
 * Browser-level coverage for the global toast surface (plan 48).
 *
 * Mock-mode createBookExport always succeeds, so we exercise the
 * notifications slice directly from the page context via the dev/e2e
 * `window.__store__` hook installed in src/main.tsx. The branches
 * under test (slice dedupe, ToastStack render, auto-dismiss timer)
 * don't care whether the push came from a real export 5xx or from a
 * direct dispatch — both routes hit the same reducer + render path.
 *
 * Pairs with docs/features/archive/48-toast-surface.md.
 */
test.describe('toast surface', () => {
  test('pushed toast renders and auto-dismisses after the 6 s window', async ({ page }) => {
    await page.goto('/');

    /* Wait for the app shell so ToastStack is mounted. */
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    /* Push a single error toast through the slice. The ToastStack is
       mounted in layout.tsx after the outlet, so it should pick up
       the new state and render. */
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: { dispatch: (a: unknown) => void } })
        .__store__;
      store.dispatch({
        type: 'notifications/pushToast',
        payload: {
          id: 'e2e-toast-1',
          kind: 'error',
          message: 'Synthetic e2e error toast',
          createdAt: Date.now(),
        },
      });
    });

    const toast = page.getByRole('status').getByText(/Synthetic e2e error toast/i);
    await expect(toast).toBeVisible({ timeout: 2_000 });
    await expect(page.getByRole('button', { name: /Dismiss notification/i })).toBeVisible();

    /* Auto-dismiss fires at 6 s. 12 s margin so a contended Windows
       host with multiple parallel workers doesn't flake when the
       setTimeout slips a couple seconds past the 6 s mark. */
    await expect(toast).not.toBeVisible({ timeout: 12_000 });
  });

  test('dedupe-by-key collapses repeated pushes into a single toast', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    /* Three pushes with the same dedupeKey should collapse into one. */
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: { dispatch: (a: unknown) => void } })
        .__store__;
      const fire = (msg: string) =>
        store.dispatch({
          type: 'notifications/pushToast',
          payload: {
            id: `dedupe-${Math.random().toString(36).slice(2)}`,
            kind: 'error',
            message: msg,
            dedupeKey: 'e2e-dedupe',
            createdAt: Date.now(),
          },
        });
      fire('first push');
      fire('second push');
      fire('third push');
    });

    /* The last push wins — first / second messages should not be on
       screen. */
    await expect(page.getByText(/third push/i)).toBeVisible({ timeout: 2_000 });
    await expect(page.getByText(/first push/i)).not.toBeVisible();
    await expect(page.getByText(/second push/i)).not.toBeVisible();

    /* The role="status" stack contains exactly one toast region.
       (Match the close button as a more stable proxy than counting
       text nodes — kind icons + message would also be in the tree.) */
    const dismissButtons = page.getByRole('button', { name: /Dismiss notification/i });
    await expect(dismissButtons).toHaveCount(1);
  });
});
