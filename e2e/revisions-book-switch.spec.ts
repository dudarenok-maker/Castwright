import { test, expect, type Page } from '@playwright/test';
test.describe.configure({ mode: 'serial' });
type StoreWin = { __store__?: { getState: () => { chapters: { chapters: Array<{ id: number }> } }; dispatch: (a: unknown) => void } };

async function markChaptersRendered(page: Page) {
  await page.evaluate(() => {
    const s = (window as unknown as StoreWin).__store__;
    if (!s) throw new Error('window.__store__ not exposed (e2e gate regressed)');
    const chapters = s.getState().chapters.chapters;
    s.dispatch({ type: 'chapters/setChapters', payload: chapters.map((c) => ({ ...c, state: 'done', progress: 1, audioModelKey: 'kokoro-v1' })) });
  });
}

test('a Fix-audio take that finishes while on another book is a playable prompt on return', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => { (window as unknown as { __mockSpliceDelayMs?: number }).__mockSpliceDelayMs = 2500; });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });
  await page.goto('/#/books/cc/cast');
  await expect(page.getByTestId('cast-row-eliza_cc')).toBeVisible({ timeout: 10_000 });
  await markChaptersRendered(page);
  await page.getByTestId('cast-row-eliza_cc').click();
  await page.getByRole('button', { name: /Fix Eliza.*audio \(loudness \/ re-record\)/i }).click();
  await page.evaluate(() => (window as unknown as StoreWin).__store__?.dispatch({ type: 'ui/setOpenProfileId', payload: null }));
  await page.getByRole('button', { name: /Apply to \d+ chapters?/i }).click();
  // The Fix-audio modal keeps running in the background after Close (its own
  // copy says so); dismiss it so its backdrop doesn't block the rest of the
  // page once we navigate — the splice itself is unaffected.
  await page.getByRole('button', { name: 'Close' }).click();
  // Leave for another book before the first chapter's splice completes (2.5 s per step).
  await page.goto('/#/books/sb/listen');
  await expect(page.getByText(/Solway Bay/i).first()).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __mockRevisions: { get: (b: string) => { pending: unknown[] } } }).__mockRevisions.get('cc').pending.length), { timeout: 30_000 }).toBeGreaterThan(0);
  // Back to book A.
  await page.goto('/#/books/cc/cast');
  await page.getByTestId('status-pill').click();
  const open = page.getByTestId('status-popover-revisions').getByRole('button', { name: /\d+ revisions?/i });
  await expect(open).toBeVisible({ timeout: 10_000 });
  await open.click();
  const player = page.getByTestId('revision-diff-player');
  await expect(player).toBeVisible();
  await expect(player.getByText(/Rendering new take/i)).toHaveCount(0);
});
