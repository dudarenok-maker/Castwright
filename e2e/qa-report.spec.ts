import { test, expect } from '@playwright/test';
import { waitForListenViewReady } from './helpers';

/* fs-51 — per-book performance-QA report card e2e coverage. The mock API
   surface (`src/lib/api.ts`, `VITE_USE_MOCKS=true`) returns MOCK_QA_REPORT
   (a clean, fully-covered book — see `src/data/qa-report.ts`) for any
   bookId, so the Solway Bay ("sb") Listen view already has real content
   to render under mocks with no extra wiring. */
test.describe('QA report card', () => {
  test('renders and exports on the Listen view', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);

    await expect(page.getByText(/quality gate/i)).toBeVisible();
    await expect(page.getByText(/every line/i)).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /download as text/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/qa-report\.txt$/);

    const [jsonDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /download as json/i }).click(),
    ]);
    expect(jsonDownload.suggestedFilename()).toMatch(/qa-report\.json$/);
  });
});
