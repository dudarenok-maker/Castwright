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

  /* #3680 — the mock API returns a fixed clean report, which never has a
     character awaiting a re-render, so the "Needs re-render" listing cannot
     be reached without forcing the report shape. `mockGetQaReport` reads
     `window.__mockQaReportOverride` (same seam as
     generation-scoring-progress.spec.ts); it must be seeded before
     navigation because the Listen view fetches the report on mount. */
  test('lists characters that need a re-render on the Listen view', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockQaReportOverride: unknown }).__mockQaReportOverride = {
        bookId: 'sb',
        generatedAt: '2026-07-08T00:00:00.000Z',
        chaptersRendered: 2,
        chaptersTotal: 2,
        totalLines: 40,
        acoustic: { linesChecked: 40, linesRerecorded: 0, chaptersFlagged: 0 },
        asr: { linesVerified: 40, linesFlaggedDrift: 0 },
        voiceDrift: {
          attribution: 'full',
          chaptersEligible: 2,
          chaptersScored: 2,
          chaptersEmbedFailed: 0,
          charactersOnRoster: 2,
          charactersChecked: 2,
          charactersPending: [],
          charactersNeedingRerender: ['halloran'],
          mismatches: [],
          inconclusiveCount: 0,
          uncheckedCharacterIds: [],
        },
        configDrift: { counts: { mild: 0, moderate: 0, severe: 0 }, events: [] },
      };
    });

    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);

    const listing = page.getByTestId('qa-needs-rerender');
    await expect(listing).toBeVisible();

    /* The mock Solway Bay book has no on-disk cast, so a direct load leaves
       the cast slice empty and the card falls back to the raw id. Hydrate the
       roster the way the layout's getBookState handler does (a non-persisted
       `cast/hydrateCharacters`) and assert the card resolves the NAME. */
    await page.evaluate(() => {
      const w = window as unknown as {
        __store__: { dispatch: (a: { type: string; payload: unknown }) => void };
      };
      w.__store__.dispatch({
        type: 'cast/hydrateCharacters',
        payload: [
          { id: 'narrator', name: 'Narrator' },
          { id: 'halloran', name: 'Captain Halloran' },
        ],
      });
    });
    await expect(listing).toContainText('Captain Halloran');
    await expect(listing).toContainText('Needs re-render');
    await expect(page.getByRole('button', { name: 'Resume scoring', exact: true })).toHaveCount(0);
  });
});
