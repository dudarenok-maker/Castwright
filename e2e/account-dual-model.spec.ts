/* Account → dual-model TTS flag + Qwen install card e2e.
 *
 * Pins two in-browser surfaces in the Account view:
 *   - the "Keep both TTS engines loaded (dual-model mode)" checkbox in
 *     the TTS-sidecar card (off by default, toggleable, Save-persisted)
 *   - the Qwen3-TTS install-command card inside the Models card
 *
 * Mock-mode persistence: the dev server runs with VITE_USE_MOCKS=true, so
 * PUT /api/user/settings is fulfilled in-memory by the mock api layer
 * (`mockPutUserSettings`, which echoes dualModelEnabled back) and the
 * slice rehydrates from the response within the same JS context. The
 * real-backend round-trip is locked by the server unit tests + the slice
 * unit tests independently. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady, stubAccountModelProbes } from './helpers';

/* Run this file's tests sequentially (not across parallel workers): the
   Account view is heavy and its mount-time probes flake under contention.
   Matches account-models.spec.ts. */
test.describe.configure({ mode: 'serial' });

/* Stub the raw-fetch install probes so the Account view renders a
   deterministic not-installed state regardless of whether a real backend is
   live on :8080 (the proxy target) — see stubAccountModelProbes. */
test.beforeEach(async ({ page }) => {
  await stubAccountModelProbes(page);
});

async function readAccountSlice(page: import('@playwright/test').Page) {
  return await page.evaluate(() => {
    const w = window as unknown as { __store__: { getState: () => unknown } };
    const state = w.__store__.getState() as { account: Record<string, unknown> };
    return state.account;
  });
}

test.describe('Account — dual-model TTS flag', () => {
  test('renders the dual-model checkbox unchecked by default', async ({ page }) => {
    await page.goto('/#/account');
    await waitForRouteReady(page);

    const checkbox = page.getByTestId('account-dual-model-enabled');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();
  });

  test('toggling the checkbox + Save round-trips through the slice', async ({ page }) => {
    await page.goto('/#/account');
    await waitForRouteReady(page);

    const checkbox = page.getByTestId('account-dual-model-enabled');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked();

    await checkbox.check();
    await expect(checkbox).toBeChecked();

    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText(/^saved\.$/i)).toBeVisible({ timeout: 5_000 });

    /* The mock putUserSettings echoes dualModelEnabled back and the slice
       rehydrates from the response — the saved flag lands without a reload. */
    await expect
      .poll(async () => {
        const s = await readAccountSlice(page);
        return s.dualModelEnabled;
      })
      .toBe(true);

    await expect(checkbox).toBeChecked();
  });
});

test.describe('Account — Qwen install card', () => {
  test('renders the in-app Qwen3-TTS installer card', async ({ page }) => {
    await page.goto('/#/account');
    await waitForRouteReady(page);

    /* The display-only snippet was replaced by the one-click QwenInstall
       component. With no reachable /api/qwen/detect in mock mode the probe
       stays unresolved, so the default "not installed" card renders with the
       Install action. */
    await expect(page.getByTestId('qwen-install-not-detected')).toBeVisible();
    await expect(page.getByRole('button', { name: /Install Qwen3-TTS/i })).toBeVisible();
  });
});
