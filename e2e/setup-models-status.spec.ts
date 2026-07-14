/* Wizard models-status single-source (#1612) — ready-state golden path.
 *
 * One models-status fetch (mockGetModelsStatus: kokoro `ready`, runtime
 * installedOnDisk/process `ready`) feeds BOTH the Voice step's runtime badge
 * and each install card's controlled `status` prop, so badge and card can
 * never disagree. This spec locks the cross-seam ready-state path only —
 * the weights-missing / starting / broken-coqui contradiction regressions
 * are covered at the RTL layer in step-voice.test.tsx (no mock hook exists
 * to drive those variants through Playwright without new plumbing; see
 * docs/features/258-wizard-models-status.md).
 *
 * Step order (setup-wizard.tsx): environment, ffmpeg, analysis, voice,
 * defaults, lanCert, finish — Voice is step 4 of 7.
 */

import { test, expect } from '@playwright/test';

test('Voice step: runtime badge and Kokoro card agree on ready state', async ({ page }) => {
  await page.goto('/#/?setup=notready');
  await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();

  const next = page.getByRole('button', { name: /^next$/i });
  await next.click(); // step 1 → ffmpeg (step 2)
  await next.click(); // step 2 → analysis (step 3)
  await next.click(); // step 3 → voice (step 4)
  await expect(page.getByText(/step 4 of 7/i)).toBeVisible();

  // Runtime badge: GREEN "Runtime installed", never amber "Runtime needed".
  const diskBadge = page.getByTestId('runtime-disk-badge');
  await expect(diskBadge).toBeVisible();
  await expect(diskBadge).toHaveAttribute('data-blocker-status', 'pass');
  await expect(diskBadge).toHaveText(/runtime installed/i);
  await expect(page.getByText(/runtime needed/i)).toHaveCount(0);

  // Kokoro card: "Kokoro is installed", not the not-installed empty state —
  // the badge/card-consistency invariant for the ready engine. (Qwen and
  // Coqui legitimately show "not installed" in this fixture — they aren't
  // ready — so the assertion is scoped to Kokoro's own card, not the page.)
  await expect(page.getByText(/kokoro is installed/i)).toBeVisible();
  await expect(page.getByText(/kokoro is not installed/i)).toHaveCount(0);
});
