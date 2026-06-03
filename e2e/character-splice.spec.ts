import { test, expect, type Page } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

/**
 * fs-26 — per-character "Fix audio" (loudness / re-record splice).
 *
 * Two specs:
 *  1. Seam — the cast profile drawer carries the "Fix … audio" affordance and
 *     opens the modal with its mode toggles + loudness slider (confirm-cast has
 *     no rendered chapters, so this exercises the controls + empty candidate set).
 *  2. Full run — on a book whose cast has rendered chapters, Apply drives the
 *     background splice runner to completion and lands pending A/B revisions.
 *
 * Why browser-level: the button lives on the shared <Layout/> ProfileDrawer and
 * opens a modal keyed by the open character; the run crosses the splice-runner
 * middleware → revisions/chapters slices. The mock `api.streamSplice` resolves
 * the splice_complete arc synchronously, so no backend / sidecar is needed.
 */

type StoreWin = {
  __store__?: {
    getState: () => {
      chapters: { chapters: Array<{ id: number; characters: Record<string, string> }> };
      revisions: { pending: Array<{ chapterId: number }> };
    };
    dispatch: (a: unknown) => void;
  };
};

test.describe('cast profile drawer → Fix audio modal', () => {
  test('opens the Fix audio modal with loudness/re-record controls', async ({ page }) => {
    await goToConfirm(page);
    await waitForRouteReady(page);

    const card = page.getByRole('button', { name: /Open profile for Captain Halloran/i });
    await expect(card).toBeVisible({ timeout: 10_000 });
    await card.click();

    /* The drawer mounted (evidence section proves hydration). */
    await expect(page.getByText(/Evidence from the manuscript/i)).toBeVisible({ timeout: 10_000 });

    /* The fs-26 affordance. */
    const fixBtn = page.getByRole('button', { name: /Fix .*audio \(loudness \/ re-record\)/i });
    await expect(fixBtn).toBeVisible();
    await fixBtn.click();

    /* Modal opens with both modes + the loudness slider (remix is default).
       Assert on modal-unique copy so we don't collide with the drawer behind. */
    await expect(page.getByText(/Boost a too-quiet voice/i)).toBeVisible();
    await expect(page.getByText(/Re-synthesise the lines/i)).toBeVisible();
    await expect(page.getByLabel(/Loudness boost in decibels/i)).toBeVisible();
  });
});

/** Stamp every chapter rendered (done + an engine) so the Fix-audio modal
    treats the character's chapters as candidates. Preserves the per-chapter
    speaker maps so the character→chapter filter still resolves. */
async function markChaptersRendered(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = (window as unknown as StoreWin).__store__;
    if (!s) throw new Error('window.__store__ not exposed (e2e gate regressed)');
    const chapters = s.getState().chapters.chapters;
    s.dispatch({
      type: 'chapters/setChapters',
      payload: chapters.map((c) => ({ ...c, state: 'done', progress: 1, audioModelKey: 'kokoro-v1' })),
    });
  });
}

test.describe('Fix audio — full run', () => {
  test("loudness boost across a character's rendered chapters lands pending revisions", async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });
    /* Carrick's Compass ('cc') — the mock book whose cast (Eliza) speaks in
       real chapters (CH1/2/3). */
    await page.goto('/#/books/cc/cast');

    await expect(page.getByTestId('cast-row-eliza_cc')).toBeVisible({ timeout: 10_000 });
    await markChaptersRendered(page);

    await page.getByTestId('cast-row-eliza_cc').click();
    const fixBtn = page.getByRole('button', { name: /Fix Eliza.*audio \(loudness \/ re-record\)/i });
    await expect(fixBtn).toBeVisible({ timeout: 10_000 });
    await fixBtn.click();

    await expect(page.getByLabel(/Loudness boost in decibels/i)).toBeVisible();
    /* Dismiss the drawer behind the modal so its footer can't overlap Apply. */
    await page.evaluate(() => {
      (window as unknown as StoreWin).__store__?.dispatch({ type: 'ui/setOpenProfileId', payload: null });
    });

    const apply = page.getByRole('button', { name: /Apply to \d+ chapters?/i });
    await expect(apply).toBeEnabled();
    await apply.click();

    await expect(page.getByTestId('fix-audio-summary')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('fix-audio-summary')).toContainText(/chapters? updated/i);

    const pendingCount = await page.evaluate(
      () => (window as unknown as StoreWin).__store__?.getState().revisions.pending.length ?? 0,
    );
    expect(pendingCount).toBeGreaterThan(0);
  });
});
