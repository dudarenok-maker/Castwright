/* Shared Playwright helpers for the e2e spec suite.
 *
 * Extracted from `e2e/new-book-flow.spec.ts` so multiple specs can drive
 * the same new-book flow without re-implementing the click chain. Today's
 * callers: `e2e/new-book-flow.spec.ts` (depth assertions) +
 * `e2e/visual.spec.ts` (per-stage baselines).
 *
 * The mock backend in `src/lib/api.ts` is the contract these helpers
 * exercise; if you change the click affordances they target, update the
 * helper here in one place rather than every spec. */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

const PASTED_MANUSCRIPT =
  '# The E2E Test Book\n\n# Chapter 1\n\nA tiny test paragraph.\n\n' +
  '# Chapter 2\n\nA second paragraph.\n';

/* Drive from cold boot to the analysing route, stopping BEFORE the user
 * clicks "Start analysis" — the view is then in its deterministic
 * "ready to fire" state with no live phase progress, ideal for visual
 * regression baselines and as a jumping-off point for spec assertions.
 *
 * Returns once the URL matches `#/books/:id/analysing` and the Start
 * button is visible + enabled. */
export async function goToAnalysing(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i }).first())
    .toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: /Start a new book/i }).first().click();
  await expect(page).toHaveURL(/#\/new$/);

  await page.getByRole('button', { name: /Paste text/i }).click();
  await page.locator('textarea').fill(PASTED_MANUSCRIPT);
  await page.getByRole('button', { name: /Upload pasted text/i }).click();

  await expect(page.getByRole('button', { name: /Save book and start analysis/i }))
    .toBeVisible({ timeout: 5_000 });
  await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('E2E Author');
  await page.getByRole('button', { name: /Save book and start analysis/i }).click();

  await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
  await expect(page.getByRole('button', { name: /Start analysis/i }))
    .toBeVisible({ timeout: 5_000 });
}

/* Continue from `goToAnalysing` through the analysis stream to the
 * confirm-cast route. The mock SSE takes ~7.6 s (ANALYSIS_NORTHERN_STAR),
 * so the URL wait gets a 15 s budget to absorb jitter. */
export async function goToConfirm(page: Page): Promise<void> {
  await goToAnalysing(page);
  await page.getByRole('button', { name: /Start analysis/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/confirm$/, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: /Confirm cast and review manuscript/i }))
    .toBeVisible({ timeout: 5_000 });
}
