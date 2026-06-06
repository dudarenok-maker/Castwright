/* Plan 88 phase-2 — Account → Analyzer card e2e.
 *
 * Pins the in-browser surface for the three per-phase analyzer knobs:
 *   - Phase 0 model picker
 *   - Phase 1 model picker
 *   - Phase 1 minimum chapter lag
 *
 * The card lives between "Defaults for new books" and "Cast analysis"
 * on the Account view. Each field accepts a "(use server default)"
 * sentinel value that maps to `null` in the persisted payload — the
 * server-side selector falls through to env / hardcoded default when
 * the field is null.
 *
 * Mock-mode persistence: the dev server runs with VITE_USE_MOCKS=true,
 * so PUT /api/user/settings is fulfilled in-memory by the mock api
 * layer (`mockPutUserSettings`) and the slice rehydrates from the
 * response. The mock store survives a hash navigation within the
 * same JS context (e.g. away to /#/books and back to /#/account) but
 * resets on `page.reload()` — that's a mock-mode quirk. We assert
 * persistence via the in-context round-trip path; the real-backend
 * round-trip is locked by the server unit tests + the slice unit
 * tests independently. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady, stubAccountModelProbes } from './helpers';

/* Run this file's tests sequentially (not across parallel workers): the
   Account view is heavy and its mount-time probes flake under contention.
   Matches account-models.spec.ts. */
test.describe.configure({ mode: 'serial' });

/* The analyzer knobs come from the client mock layer, but the Account view
   still mounts the Qwen/Ollama install cards, which probe the real backend
   via raw fetch through the Vite /api proxy. Stub those probes so the mount
   is fast + deterministic (no real-backend round-trip) — the latency behind
   the goto/visibility timeouts under parallel load. See stubAccountModelProbes. */
test.beforeEach(async ({ page }) => {
  await stubAccountModelProbes(page);
});

/* The mock layer keeps user-settings in a module-scope object; the
   slice's saveAccountSettings thunk reaches it via the same window-
   accessible store the persist layer uses. Read the latest slice
   snapshot to confirm the save round-trip landed. */
async function readAccountSlice(page: import('@playwright/test').Page) {
  return await page.evaluate(() => {
    const w = window as unknown as { __store__: { getState: () => unknown } };
    const state = w.__store__.getState() as { account: Record<string, unknown> };
    return state.account;
  });
}

test.describe('plan 88 phase-2 — Account Analyzer card', () => {
  test('renders all three knobs with the "(use server default)" sentinel', async ({ page }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);

    const phase0 = page.getByTestId('account-analyzer-phase0-model');
    const phase1 = page.getByTestId('account-analyzer-phase1-model');
    const minLag = page.getByTestId('account-analyzer-phase1-min-lag');

    await expect(phase0).toBeVisible();
    await expect(phase1).toBeVisible();
    await expect(minLag).toBeVisible();

    /* Fresh-account default is `null` for all three; the pickers
       render the "(use server default)" sentinel (value="") and the
       min-lag input renders blank. */
    await expect(phase0).toHaveValue('');
    await expect(phase1).toHaveValue('');
    await expect(minLag).toHaveValue('');

    /* The sentinel option text is "(use server default)" — visible to
       the user as the default state of each picker. */
    const sentinelOptions = page.getByRole('option', { name: '(use server default)' });
    /* Two pickers × one sentinel option each = 2. */
    await expect(sentinelOptions).toHaveCount(2);

    /* Plan 118 — the live status line reads OFF when both pickers sit at the
       sentinel (single-model), so the user can see at a glance the split is
       not engaged. */
    await expect(page.getByTestId('analyzer-split-status')).toContainText(/Currently OFF/i);
  });

  test('changing the three knobs + Save round-trips through the slice', async ({ page }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);

    const phase0 = page.getByTestId('account-analyzer-phase0-model');
    const phase1 = page.getByTestId('account-analyzer-phase1-model');
    const minLag = page.getByTestId('account-analyzer-phase1-min-lag');

    await expect(phase0).toBeVisible();

    await phase0.selectOption('gemma-4-31b-it');
    await phase1.selectOption('gemini-3.1-flash-lite');
    await minLag.fill('15');

    /* Plan 118 — the status line flips to ON the moment both phases have a
       model, naming each phase's model + the lag (driven by the live form
       state, before Save). */
    const status = page.getByTestId('analyzer-split-status');
    await expect(status).toContainText(/Currently ON/i);
    await expect(status).toContainText('Gemma 4 31B');
    await expect(status).toContainText('Gemini 3.1 Flash Lite');
    await expect(status).toContainText('lag 15');

    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText(/^saved\.$/i)).toBeVisible({ timeout: 5_000 });

    /* Slice rehydrates from the mock putUserSettings response — the
       saved values land in the account slice and the form mirrors
       them without needing a reload. */
    const slice = await readAccountSlice(page);
    expect(slice.analyzerPhase0Model).toBe('gemma-4-31b-it');
    expect(slice.analyzerPhase1Model).toBe('gemini-3.1-flash-lite');
    expect(slice.analyzerPhase1MinLagChapters).toBe(15);

    await expect(phase0).toHaveValue('gemma-4-31b-it');
    await expect(phase1).toHaveValue('gemini-3.1-flash-lite');
    await expect(minLag).toHaveValue('15');
  });

  test('values survive an away-and-back hash navigation in the same JS context', async ({
    page,
  }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);
    const phase0 = page.getByTestId('account-analyzer-phase0-model');
    await expect(phase0).toBeVisible();

    await phase0.selectOption('gemma-4-31b-it');
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText(/^saved\.$/i)).toBeVisible({ timeout: 5_000 });

    /* Wait for the slice to hold the saved value before navigating
       away — without this, the in-flight Save thunk may still be
       resolving when /#/books fires its own renders. */
    await expect
      .poll(async () => {
        const s = await readAccountSlice(page);
        return s.analyzerPhase0Model;
      })
      .toBe('gemma-4-31b-it');

    /* Navigate away then back — same JS context, so the mock store
       still holds the saved value AND the fetch-on-mount thunk re-
       hydrates from it. */
    await page.goto('/#/books');
    await waitForRouteReady(page);
    /* Let the library view settle (its own fetch hops fire on mount). */
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.goto('/#/models');
    await waitForRouteReady(page);

    const phase0AfterNav = page.getByTestId('account-analyzer-phase0-model');
    await expect(phase0AfterNav).toBeVisible();
    await expect(phase0AfterNav).toHaveValue('gemma-4-31b-it');
  });

  test('switching a picker back to "(use server default)" lands null in the slice', async ({
    page,
  }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);

    const phase0 = page.getByTestId('account-analyzer-phase0-model');
    await expect(phase0).toBeVisible();

    /* Seed a non-null value, save, then flip back to the sentinel
       option (value=""). */
    await phase0.selectOption('gemma-4-31b-it');
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText(/^saved\.$/i)).toBeVisible({ timeout: 5_000 });
    /* Wait for the first save's flash to fade so the second save's
       flash is observably distinct. The flash setTimeout is 2.4 s in
       the view; poll until it's gone. */
    await expect(page.getByText(/^saved\.$/i)).toBeHidden({ timeout: 10_000 });

    /* Confirm the slice picked up the first save before we issue the
       second. Without this wait, the user-events here race the
       Object.assign in the mock putUserSettings. */
    await expect
      .poll(async () => {
        const s = await readAccountSlice(page);
        return s.analyzerPhase0Model;
      })
      .toBe('gemma-4-31b-it');

    await phase0.selectOption('');
    await page.getByRole('button', { name: /save changes/i }).click();
    await expect(page.getByText(/^saved\.$/i)).toBeVisible({ timeout: 5_000 });

    /* Poll the slice instead of one-shot reading — the mock
       putUserSettings resolves asynchronously and the extraReducers
       hop is a microtask after that. */
    await expect
      .poll(async () => {
        const s = await readAccountSlice(page);
        return s.analyzerPhase0Model;
      })
      .toBeNull();
    await expect(phase0).toHaveValue('');
  });

  test('min-lag input clamps an out-of-range entry to [0, 50]', async ({ page }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);

    const minLag = page.getByTestId('account-analyzer-phase1-min-lag');
    await expect(minLag).toBeVisible();

    /* The Account view clamps the onChange to [0, 50] so a fat-finger
       Save can't fire a value the server would 400 on. */
    await minLag.fill('999');
    await expect(minLag).toHaveValue('50');

    await minLag.fill('-7');
    await expect(minLag).toHaveValue('0');
  });
});
