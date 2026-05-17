import { test, expect } from '@playwright/test';

/**
 * Golden-path smoke test — first Playwright spec.
 *
 * Goal: prove the e2e harness wiring (dev server + mocks + Playwright
 * browser) works end-to-end. Asserts behaviour that the hash router and
 * the books stage both have to get right; if either is wedged this fails
 * before any deeper test does.
 *
 * Does NOT exercise the analysis pipeline, TTS sidecar, or generation —
 * those are out of scope until visual-regression baselines are captured
 * (see docs/features/37-e2e-playwright.md for the rollout plan).
 */
test.describe('golden path', () => {
  test('cold boot lands on books library and "New book" routes to /new', async ({ page }) => {
    await page.goto('/');

    /* Library skeleton or library content — either is fine on first paint;
       what we assert is that we are NOT stuck on a blank shell. */
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    /* URL has resolved to a books-stage hash (either `#/` or empty hash). */
    const hash = await page.evaluate(() => window.location.hash);
    expect(hash === '' || hash === '#/' || hash === '#').toBe(true);

    await page
      .getByRole('button', { name: /Start a new book/i })
      .first()
      .click();

    await expect(page).toHaveURL(/#\/new$/);
  });
});
