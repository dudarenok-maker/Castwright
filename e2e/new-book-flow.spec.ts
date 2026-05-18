/* Browser-level golden path for the highest-blast-radius user journey:
 * cold boot → upload (paste) → confirm metadata → analysing → confirm
 * cast → ready. Runs against Vite in mock mode (`.env.e2e`) so it needs
 * no sidecar. Wall-clock budget: <30 s on a warm cache (the mock
 * analysing stream takes ~7.6 s on its own per ANALYSIS_NORTHERN_STAR
 * in src/mocks/canned-data.ts).
 *
 * Adds per-stage Redux assertions on top of the URL+visibility checks
 * already in place. The store is exposed on `window.__store__` in DEV
 * + e2e builds (see src/main.tsx) so the spec can read `ui.stage.kind`
 * after each transition and a final refresh-restores-stage check that
 * pins the redux-persist wiring shipped 2026-05-17.
 *
 * Pairs with docs/features/37-e2e-playwright.md. */

import { test, expect, type Page } from '@playwright/test';

/* Read `ui.stage.kind` from the live Redux store. The store is exposed
   on `window.__store__` only in DEV + e2e Vite modes (see src/main.tsx). */
async function getStageKind(page: Page): Promise<string> {
  return page.evaluate(() => {
    const s = (
      window as unknown as { __store__?: { getState: () => { ui: { stage: { kind: string } } } } }
    ).__store__;
    if (!s)
      throw new Error('window.__store__ is not exposed — main.tsx DEV/e2e gate may have regressed');
    return s.getState().ui.stage.kind;
  });
}

/* Plan 58 — un-quarantined 2026-05-19. Earlier quarantine was a
   parallel-worker contention problem: SSE phase transitions in this
   long cold-boot walk could miss their event window when other
   workers' Vite/SSE traffic backed up. file-level serial mode keeps
   this spec in one worker while other spec files still parallelise. */
test.describe.configure({ mode: 'serial' });

test.describe('new book flow', () => {
  test('cold boot → upload → analysing → confirm → ready', async ({ page }) => {
    /* Step 1: cold boot lands on the library. */
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    /* Step 2: click "Start a new book" to enter the upload route. */
    await page
      .getByRole('button', { name: /Start a new book/i })
      .first()
      .click();
    await expect(page).toHaveURL(/#\/new$/);
    expect(await getStageKind(page)).toBe('upload');

    /* Step 3: open the paste affordance and drop a tiny manuscript.
       The H1 is what mockImportManuscript reads to derive the title;
       author/series stay null (filename has no series pattern) so we
       fill them on the confirm-metadata step below. */
    await page.getByRole('button', { name: /Paste text/i }).click();
    await page
      .locator('textarea')
      .fill(
        '# The E2E Test Book\n\n# Chapter 1\n\nA tiny test paragraph.\n\n' +
          '# Chapter 2\n\nA second paragraph.\n',
      );
    await page.getByRole('button', { name: /Upload pasted text/i }).click();

    /* Step 4: confirm-metadata view replaces the upload view in-place
       (UploadRoute renders ConfirmMetadataView when an import candidate
       lands in redux — no URL change). Fill the required fields and
       submit. The mock confirmBook returns a synthesized bookId. */
    await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('E2E Author');
    /* The mock candidate yields series=null, so the standalone box is
       already checked by default — no further field touches needed. */
    await page.getByRole('button', { name: /Save book and start analysis/i }).click();

    /* Step 5: confirmBook → manuscriptUploaded → routes to
       #/books/:bookId/analysing. The analyser view waits for an
       explicit Start click — the previous auto-fire path was hard to
       reason about (see views/analysing.tsx:443). */
    await expect(page).toHaveURL(/#\/books\/.+\/analysing$/, { timeout: 5_000 });
    expect(await getStageKind(page)).toBe('analysing');
    await expect(page.getByRole('button', { name: /Start analysis/i })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole('button', { name: /Start analysis/i }).click();

    /* Step 6: mock analysis streams 4 phases in ~7.6 s
       (ANALYSIS_NORTHERN_STAR). onComplete fires uiActions.analysisComplete
       which advances the stage to confirm. Give it 15 s to absorb mock
       jitter on slower CI workers. */
    await expect(page).toHaveURL(/#\/books\/.+\/confirm$/, { timeout: 15_000 });
    expect(await getStageKind(page)).toBe('confirm');

    /* Step 7: confirm-cast view — click the primary CTA to advance to
       the ready stage. confirmCast dispatches set the stage to
       { kind: 'ready', view: 'manuscript', currentChapterId: 3, ... }
       which the router serialises to #/books/:bookId/manuscript. */
    await expect(
      page.getByRole('button', { name: /Confirm cast and review manuscript/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();

    await expect(page).toHaveURL(/#\/books\/.+\/manuscript/, { timeout: 5_000 });
    expect(await getStageKind(page)).toBe('ready');

    /* Step 8: refresh-restores-stage. The redux-persist wiring shipped
       2026-05-17 should restore the ready stage + the same hash after
       reload — without it, refresh kicks the user back to the library
       and the URL drops the bookId. Deleting `ui` from the persist
       whitelist in src/store/index.ts would now fail this assertion. */
    const hashBefore = await page.evaluate(() => location.hash);
    await page.reload();
    /* Wait for hydration before re-reading the store — `reload` does not
       wait for React to mount, and reading `__store__` too early returns
       the freshly-constructed initial state before redux-persist
       finishes its async rehydrate pass. The hash itself stabilises
       within the load event, but the stage kind needs a beat. */
    await page.waitForLoadState('domcontentloaded');
    await expect.poll(async () => getStageKind(page), { timeout: 5_000 }).toBe('ready');
    const hashAfter = await page.evaluate(() => location.hash);
    expect(hashAfter).toBe(hashBefore);
  });
});
