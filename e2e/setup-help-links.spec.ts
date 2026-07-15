import { test, expect } from '@playwright/test';

const WIKI = 'https://github.com/dudarenok-maker/Castwright/wiki';

test.describe('first-run wizard — help & wiki links (fe-52/fe-53)', () => {
  test('persistent footer + per-step Learn more', async ({ page }) => {
    await page.goto('/#/?setup=notready');
    await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();

    // fe-52 — Help & resources footer present on the first step
    await expect(page.getByText(/need help\?/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /report a problem/i })).toHaveAttribute(
      'href', 'https://github.com/dudarenok-maker/Castwright/issues',
    );

    // fe-53 — Environment maps to Installing-Castwright, which the footer already
    // links ("Install & setup"), so its contextual "Learn more" is suppressed.
    await expect(page.getByRole('link', { name: /learn more/i })).toHaveCount(0);

    // advance to the Analysis step (step 3) → unique page → contextual link shows
    await page.getByRole('button', { name: /next/i }).click();
    await page.getByRole('button', { name: /next/i }).click();
    await expect(page.getByRole('link', { name: /learn more/i })).toHaveAttribute(
      'href', `${WIKI}/Analysis-and-the-Analyzer`,
    );
  });

  test('help footer stays visible on a phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/#/?setup=notready');
    await expect(page.getByText(/need help\?/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /ask a question/i })).toBeVisible();
  });
});
