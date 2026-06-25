/* Plan 199 — Advanced Settings golden path.
 *
 * Asserts the #/advanced view loads, knob rows render, a LIVE knob
 * round-trips edit → overridden → revert → default, and a
 * restart-sidecar knob shows the amber banner after edit.
 *
 * All assertions run in mock mode (VITE_USE_MOCKS=true) against the
 * canned descriptors in src/lib/api.ts:
 *   group "tts"      collapsedByDefault:false  (open on load)
 *     KOKORO_SAMPLE_RATE   integer  apply:restart-sidecar  default:24000
 *     SEG_QA_MAX_RERECORDS integer  apply:live             default:2
 *     SEG_ASR_ENABLED      boolean  apply:live             default:false
 *   group "analyzer" collapsedByDefault:true   (closed on load)
 *     ANALYZER_STAGE1_PROMPT  string  isPrompt:true
 *
 * The spec does NOT need a route stub — the mock api.getConfig() +
 * mockPutConfig() + mockResetConfig() all run in-process. */

import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

/* Run this file's tests sequentially on a single worker. Each test does a cold
 * `goto('/#/advanced')` that triggers a route-level React.lazy chunk load; with
 * fullyParallel + 4 local workers these cold-loads pile onto the single Vite dev
 * server and the visibility timeouts flake under peak battery contention (passes
 * on retry in isolation, exhausts retries under full load). Serial mode caps this
 * file at one concurrent cold-load — the same mitigation 10+ sibling specs use. */
test.describe.configure({ mode: 'serial' });

test.describe('Advanced Settings — plan 199 golden path', () => {
  test('navigates to #/advanced and shows the heading', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);

    /* The heading is a MixedHeading <h1> — "Advanced" in the regular node,
       "configuration" in a child <span>. Use the h1 element locator so we
       don't depend on the exact text-node layout the role name matcher sees. */
    await expect(page.locator('h1').filter({ hasText: /Advanced/i })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('TTS section is open and renders the knob rows on load', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);

    /* The "Text-to-speech" accordion section starts open
       (collapsedByDefault: false on the mock tts group). Target the SECTION
       HEADER button specifically (it carries aria-label + aria-expanded) — the
       label also appears as a jump-link in the nav rail, so a plain
       getByRole('button', { name }) is now ambiguous. */
    const ttsButton = page.locator('button[aria-label="Text-to-speech"]');
    await expect(ttsButton).toBeVisible({ timeout: 10_000 });
    await expect(ttsButton).toHaveAttribute('aria-expanded', 'true');

    /* At least one knob label is rendered inside the open section. */
    await expect(page.getByText('Max re-records per segment')).toBeVisible();
  });

  test('can reach the view via the Admin entry card', async ({ page }) => {
    await page.goto('/#/admin');
    const card = page.getByTestId('admin-open-advanced');
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();
    await expect(page).toHaveURL(/#\/advanced$/);
    await expect(page.locator('h1').filter({ hasText: /Advanced/i })).toBeVisible({
      timeout: 5_000,
    });
  });

  test('editing a LIVE knob shows the overridden state and a Revert button', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);

    /* SEG_QA_MAX_RERECORDS is a live integer knob (default 2, range 0-10).
       In the mock descriptor list order, KOKORO_SAMPLE_RATE is first
       (restart-sidecar) and SEG_QA_MAX_RERECORDS is second (live). */
    await expect(page.getByText('Max re-records per segment')).toBeVisible({ timeout: 10_000 });

    /* Use the second number input — SEG_QA_MAX_RERECORDS. */
    const input = page.locator('input[type="number"]').nth(1);
    await expect(input).toBeVisible();
    /* Triple-click to select all, then type new value. */
    await input.click({ clickCount: 3 });
    await input.fill('5');
    /* Blur to commit the value. */
    await input.press('Tab');

    /* After a PUT the mock store marks this knob overridden=true.
       A "Revert" button should appear alongside the "default: 2" label. */
    await expect(page.getByRole('button', { name: /^Revert$/i })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/default:\s*2/)).toBeVisible();
  });

  test('clicking Revert restores the default value and hides the Revert button', async ({
    page,
  }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);

    await expect(page.getByText('Max re-records per segment')).toBeVisible({ timeout: 10_000 });

    /* Override the second knob (SEG_QA_MAX_RERECORDS, live). */
    const input = page.locator('input[type="number"]').nth(1);
    await input.click({ clickCount: 3 });
    await input.fill('7');
    await input.press('Tab');
    await expect(page.getByRole('button', { name: /^Revert$/i })).toBeVisible({ timeout: 5_000 });

    /* Click Revert — the mock resetConfig restores effective → default. */
    await page.getByRole('button', { name: /^Revert$/i }).click();

    /* The Revert button should disappear (no longer overridden). */
    await expect(page.getByRole('button', { name: /^Revert$/i })).not.toBeVisible({
      timeout: 5_000,
    });
  });

  test('editing a restart-sidecar knob shows the amber restart banner', async ({ page }) => {
    await page.goto('/#/advanced');
    await waitForRouteReady(page);

    /* KOKORO_SAMPLE_RATE is the first integer knob in the TTS section and has
       apply:restart-sidecar.  SEG_QA_MAX_RERECORDS is second (apply:live).
       Use the first number input. */
    const firstInput = page.locator('input[type="number"]').first();
    await expect(firstInput).toBeVisible({ timeout: 10_000 });

    await firstInput.click({ clickCount: 3 });
    await firstInput.fill('16000');
    await firstInput.press('Tab');

    /* After committing a restart-sidecar knob the RestartSidecarBanner
       should appear with the sidecar restart prompt text. */
    await expect(
      page.getByText(/Voice-engine setting changed.*restart the sidecar/i),
    ).toBeVisible({ timeout: 5_000 });

    /* The "Restart sidecar" CTA button should also be visible. */
    await expect(page.getByRole('button', { name: /Restart sidecar/i })).toBeVisible();
  });
});
