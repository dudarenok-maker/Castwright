/* Browser-level golden path for the highest-blast-radius user journey:
 * cold boot → upload (paste) → confirm metadata → analysing → confirm
 * cast → ready. Runs against Vite in mock mode (`.env.e2e`) so it needs
 * no sidecar. Wall-clock budget: <30 s on a warm cache (the mock
 * analysing stream takes ~7.6 s on its own per ANALYSIS_NORTHERN_STAR
 * in src/mocks/canned-data.ts).
 *
 * Pairs with docs/features/37-e2e-playwright.md. */

import { test, expect } from '@playwright/test';

test.describe('new book flow', () => {
  test('cold boot → upload → analysing → confirm → ready', async ({ page }) => {
    /* Step 1: cold boot lands on the library. */
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first())
      .toBeVisible({ timeout: 10_000 });

    /* Step 2: click "Start a new book" to enter the upload route. */
    await page.getByRole('button', { name: /Start a new book/i }).first().click();
    await expect(page).toHaveURL(/#\/new$/);

    /* Step 3: open the paste affordance and drop a tiny manuscript.
       The H1 is what mockImportManuscript reads to derive the title;
       author/series stay null (filename has no series pattern) so we
       fill them on the confirm-metadata step below. */
    await page.getByRole('button', { name: /Paste text/i }).click();
    await page.locator('textarea').fill(
      '# The E2E Test Book\n\n# Chapter 1\n\nA tiny test paragraph.\n\n' +
      '# Chapter 2\n\nA second paragraph.\n',
    );
    await page.getByRole('button', { name: /Upload pasted text/i }).click();

    /* Step 4: confirm-metadata view replaces the upload view in-place
       (UploadRoute renders ConfirmMetadataView when an import candidate
       lands in redux — no URL change). Fill the required fields and
       submit. The mock confirmBook returns a synthesized bookId. */
    await expect(page.getByRole('button', { name: /Save book and start analysis/i }))
      .toBeVisible({ timeout: 5_000 });
    await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('E2E Author');
    /* The mock candidate yields series=null, so the standalone box is
       already checked by default — no further field touches needed. */
    await page.getByRole('button', { name: /Save book and start analysis/i }).click();

    /* Step 5: confirmBook → manuscriptUploaded → routes to
       #/books/:bookId/analysing. The analyser view waits for an
       explicit Start click — the previous auto-fire path was hard to
       reason about (see views/analysing.tsx:443). */
    await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
    await expect(page.getByRole('button', { name: /Start analysis/i }))
      .toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /Start analysis/i }).click();

    /* Step 6: mock analysis streams 4 phases in ~7.6 s
       (ANALYSIS_NORTHERN_STAR). onComplete fires uiActions.analysisComplete
       which advances the stage to confirm. Give it 15 s to absorb mock
       jitter on slower CI workers. */
    await expect(page).toHaveURL(/#\/books\/.+\/confirm$/, { timeout: 15_000 });

    /* Step 7: confirm-cast view — click the primary CTA to advance to
       the ready stage. confirmCast dispatches set the stage to
       { kind: 'ready', view: 'manuscript', currentChapterId: 3, ... }
       which the router serialises to #/books/:bookId/manuscript. */
    await expect(page.getByRole('button', { name: /Confirm cast and review manuscript/i }))
      .toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();

    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
  });
});
