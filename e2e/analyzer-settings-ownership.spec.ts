/* #3141 step 6 — e2e for the analyzer-settings ownership split (steps 1-5):
 * Advanced Settings owns the Ollama URL + per-phase analyzer models, Account
 * (the Model Manager's "Two-model analyzer split" card, `/#/models`) shows
 * them read-only with a link out, and the analysing view's phase-model swap
 * is a per-run PICK (ui-slice) that never writes UserSettings.
 *
 * Scenario 2 needs the account slice already holding a per-phase split so
 * the swap control and chip have something to show/override. The mock
 * PUT /api/user/settings route rejects the four migrated fields outright
 * (mockPutUserSettings's RETIRED_ANALYZER_FIELDS — src/lib/api.ts), and the
 * mock Advanced Settings PUT (mockPutConfig) doesn't feed back into
 * MOCK_USER_SETTINGS, so there's no UI path to seed a split in mock mode.
 * Dispatch the account slice's own `fetch/fulfilled` action directly instead
 * — the same `window.__store__.dispatch` seam several sibling specs already
 * use (e.g. script-review-instruct.spec.ts) — mirroring what a real
 * GET /api/user/settings response with a configured split would hydrate. */

import { test, expect, type Page } from '@playwright/test';
import { waitForRouteReady, stubAccountModelProbes, bootFreshBookIntoAnalysing } from './helpers';

/* Cold `goto`s into /#/models and the new-book upload flow both trigger
   route-level React.lazy chunk loads; run this file's tests on a single
   worker to avoid the contention flake several sibling specs already guard
   against (advanced-settings.spec.ts). */
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await stubAccountModelProbes(page);
});

interface StoreHandle {
  getState: () => { account: Record<string, unknown> };
  dispatch: (action: { type: string; payload: unknown }) => void;
}

function getStore(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __store__?: StoreHandle };
    if (!w.__store__) {
      throw new Error('window.__store__ is not exposed — main.tsx DEV/e2e gate may have regressed');
    }
    return true;
  });
}

/* Seed a two-model analyzer split into the account slice, as if the user had
   configured it in Advanced Settings. Merges onto whatever the slice already
   holds via the same `account/fetch/fulfilled` action the real fetch thunk
   dispatches on success, so every other account field survives untouched. */
async function seedAnalyzerSplit(page: Page): Promise<void> {
  await getStore(page);
  await page.evaluate(() => {
    const w = window as unknown as { __store__: StoreHandle };
    const account = w.__store__.getState().account;
    w.__store__.dispatch({
      type: 'account/fetch/fulfilled',
      payload: {
        ...account,
        analyzerPhase0Model: 'gemma-4-31b-it',
        analyzerPhase1Model: 'gemini-3.1-flash-lite',
        analyzerPhase1MinLagChapters: 10,
      },
    });
  });
}

test.describe('#3141 step 6 — analyzer settings ownership', () => {
  test('Account is read-only for the four fields, with a link to Advanced Settings', async ({
    page,
  }) => {
    await page.goto('/#/models');
    await waitForRouteReady(page);

    const fields = [
      'account-analyzer-phase0-model',
      'account-analyzer-phase1-model',
      'account-analyzer-phase1-min-lag',
      'account-ollama-url',
    ];

    for (const testId of fields) {
      const value = page.getByTestId(testId);
      await expect(value).toBeVisible({ timeout: 10_000 });
      /* No editable input/select carries this testid any more — it's a
         read-only <span>. Before step 3 these WERE <select>/<input>
         elements with these exact testids. */
      const tag = await value.evaluate((el) => el.tagName);
      expect(tag).not.toBe('SELECT');
      expect(tag).not.toBe('INPUT');

      const link = value.locator('xpath=following-sibling::a[1]');
      await expect(link).toHaveText(/Edit in Advanced Settings/i);
    }

    /* Following one row's link lands on #/advanced with the view rendered. */
    await page
      .getByTestId('account-analyzer-phase0-model')
      .locator('xpath=following-sibling::a[1]')
      .click();
    await expect(page).toHaveURL(/#\/advanced$/);
    await waitForRouteReady(page);
    await expect(page.locator('h1').filter({ hasText: /Advanced/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('a per-run phase pick does not change settings', async ({ page }) => {
    await bootFreshBookIntoAnalysing(page);
    await seedAnalyzerSplit(page);

    const swap0 = page.getByTestId('phase-model-swap-0');
    const chip0 = page.getByTestId('phase-model-chip-0').first();
    await expect(swap0).toBeVisible({ timeout: 10_000 });
    /* Before any pick, the chip shows the saved per-phase model. */
    await expect(chip0).toContainText('Gemma 4 31B');

    /* Pick a different model for the NEXT run started from this view.
       Gemini options are always present (the curated static catalog);
       the local-Ollama group is INSTALLED-ONLY (buildLocalModelOptions)
       and stubAccountModelProbes reports no installed tags, so a Gemini
       id is the only pick guaranteed to be a selectable option here. */
    await swap0.selectOption('gemini-3.5-flash-lite');
    await expect(chip0).toContainText('Gemini 3.5 Flash Lite');

    /* Navigate to the Model Manager (same JS context — a hash-only
       navigation, so the mock store and the seeded split survive; the mock
       store resets on a full `page.reload()` but not on an in-context hash
       navigation) and confirm the saved settings are unchanged: still the
       original split, not the per-run pick. */
    await page.goto('/#/models');
    await waitForRouteReady(page);
    await expect(page.getByTestId('account-analyzer-phase0-model')).toContainText('Gemma 4 31B');
    await expect(page.getByTestId('account-analyzer-phase1-model')).toContainText(
      'Gemini 3.1 Flash Lite',
    );
  });
});
