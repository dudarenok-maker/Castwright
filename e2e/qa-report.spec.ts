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
          speakerCheckEnabled: true,
          attribution: 'full',
          chaptersEligible: 2,
          chaptersScored: 2,
          chaptersEmbedFailed: 0,
          charactersOnRoster: 2,
          charactersChecked: 1,
          charactersPending: ['narrator'],
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
    /* A genuinely pending character keeps its Resume action beside the listing: the listing
       never stands in for it (and the count is 1, not 0, so this can actually go red). */
    await expect(page.getByRole('button', { name: 'Resume scoring', exact: true })).toHaveCount(1);
  });

  /* #4454 — with render-integrity QA switched off nothing is "pending": the card
     must say so and offer no Resume (the server would answer 409). Same
     `__mockQaReportOverride` seam as the test above. */
  test('says render-integrity QA is off and offers no Resume when the gate is off', async ({ page }) => {
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
          speakerCheckEnabled: false,
          attribution: 'full',
          chaptersEligible: 2,
          chaptersScored: 0,
          chaptersEmbedFailed: 0,
          charactersOnRoster: 2,
          charactersChecked: 0,
          charactersPending: ['narrator', 'halloran'],
          charactersNeedingRerender: [],
          mismatches: [],
          inconclusiveCount: 0,
          uncheckedCharacterIds: [],
        },
        configDrift: { counts: { mild: 0, moderate: 0, severe: 0 }, events: [] },
      };
    });

    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);

    const off = page.getByTestId('qa-speaker-check-off');
    await expect(off).toBeVisible();
    await expect(off).toContainText('Render-integrity QA (voice match) is off');
    await expect(page.getByRole('button', { name: 'Resume scoring', exact: true })).toHaveCount(0);
  });

  /* #4454 — check off but chapters already scored: the past result stays (it is true for the
     audio scored) with a "now off" suffix, no gate-off row, and still no Resume. Shape the real
     builder emits: chapter 1 fully scored, chapter 2's only roster character still pending. */
  test('keeps the past voice-match result with a "now off" note when the gate is off after scoring', async ({ page }) => {
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
          speakerCheckEnabled: false,
          attribution: 'full',
          chaptersEligible: 2,
          chaptersScored: 1,
          chaptersEmbedFailed: 0,
          charactersOnRoster: 2,
          charactersChecked: 1,
          charactersPending: ['narrator'],
          charactersNeedingRerender: [],
          mismatches: [],
          inconclusiveCount: 0,
          uncheckedCharacterIds: [],
        },
        configDrift: { counts: { mild: 0, moderate: 0, severe: 0 }, events: [] },
      };
    });

    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);

    await expect(page.getByText("1 of 2 eligible chapters scored (0 couldn't be embedded), 0 mismatches · Render-integrity QA is now off")).toBeVisible();
    await expect(page.getByTestId('qa-speaker-check-off')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume scoring', exact: true })).toHaveCount(0);
  });

  /* #4454 — a pending character speaks in every eligible chapter, so the server zeroes both chapter
     counts however much was checked (pinned by the buildAudioQaReport test of that name): the
     checked characters and the standing mismatch stay, no gate-off row, no Resume. */
  test('keeps the checked-so-far result when a pending character zeroes both chapter counts and the gate is off', async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __mockQaReportOverride: unknown }).__mockQaReportOverride = {
        bookId: 'sb',
        generatedAt: '2026-07-08T00:00:00.000Z',
        chaptersRendered: 1,
        chaptersTotal: 1,
        totalLines: 20,
        acoustic: { linesChecked: 20, linesRerecorded: 0, chaptersFlagged: 0 },
        asr: { linesVerified: 20, linesFlaggedDrift: 0 },
        voiceDrift: {
          speakerCheckEnabled: false,
          attribution: 'full',
          chaptersEligible: 1,
          chaptersScored: 0,
          chaptersEmbedFailed: 0,
          charactersOnRoster: 2,
          charactersChecked: 2,
          charactersPending: ['ren'],
          charactersNeedingRerender: [],
          mismatches: [{ characterId: 'narrator', fixable: true }],
          inconclusiveCount: 0,
          uncheckedCharacterIds: [],
        },
        configDrift: { counts: { mild: 0, moderate: 0, severe: 0 }, events: [] },
      };
    });

    await page.goto('/#/books/sb/listen');
    await waitForListenViewReady(page, /Solway Bay/i);

    await expect(page.getByText('2 of 2 characters checked so far, 1 mismatches · Render-integrity QA is now off')).toBeVisible();
    await expect(page.getByTestId('qa-speaker-check-off')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume scoring', exact: true })).toHaveCount(0);
  });
});
