import { test, expect, type Page } from '@playwright/test';

/* finding 11 — the production path: a preview render with a recorded server
 * entry (not the stub). `openPreviewPlayerRecorded` and `hasElizaRegenLog` are
 * copies of profile-regen-preview.spec.ts's helpers, plus a seed line so the
 * previewed chapter already has live audio recorded server-side.
 */

test.describe.configure({ mode: 'serial' });

type StoreWin = {
  __store__?: {
    getState: () => {
      chapters: { chapters: Array<{ id: number; state: string; progress: number }> };
      ui: { previewRegen: unknown; openRevision: { kind: string } | null };
      changeLog: { events: Array<{ type: string; title: string }> };
    };
    dispatch: (a: unknown) => void;
  };
};

async function chapterState(page: Page, id: number): Promise<string | undefined> {
  return page.evaluate((cid) => {
    const s = (window as unknown as StoreWin).__store__;
    return s?.getState().chapters.chapters.find((c) => c.id === cid)?.state;
  }, id);
}

/* Bump the in-flight preview chapter near-complete so the next mock tick emits
   chapter_complete (the mock derives progress from this same slice). */
async function fastForward(page: Page, id: number): Promise<void> {
  await page.evaluate((cid) => {
    const s = (window as unknown as StoreWin).__store__;
    if (!s) throw new Error('window.__store__ is not exposed (main.tsx DEV/e2e gate regressed)');
    const chapters = s.getState().chapters.chapters;
    s.dispatch({
      type: 'chapters/setChapters',
      payload: chapters.map((c) => (c.id === cid ? { ...c, progress: 0.99 } : c)),
    });
  }, id);
}

async function hasElizaRegenLog(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const s = (window as unknown as StoreWin).__store__;
    return (s?.getState().changeLog.events ?? []).some(
      (e) => e.type === 'regenerate' && /Regenerated Eliza/i.test(e.title),
    );
  });
}

/* Walk cast → drawer → regenerate modal → Preview, seeding a recorded server
   entry for the preview chapter first, and wait for the A/B player to
   auto-open in preview mode on that server entry. Returns the player locator. */
async function openPreviewPlayerRecorded(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __mockGenConcurrency?: number }).__mockGenConcurrency = 1;
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
    timeout: 10_000,
  });
  await page.goto('/#/books/cc/cast');

  await page.getByTestId('cast-row-eliza_cc').click({ timeout: 10_000 });
  await page.getByRole('button', { name: /Regenerate Eliza's lines/i }).click();
  await expect(page.getByTestId('regen-character-preview')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    const s = (window as unknown as StoreWin).__store__;
    s?.dispatch({ type: 'ui/setOpenProfileId', payload: null });
    s?.dispatch({ type: 'revisions/rejectAllPending' });
  });
  await page.evaluate(() =>
    (window as unknown as { __mockRevisions: { seed: (b: string, s: unknown) => void } }).__mockRevisions.seed('cc', { liveChapterIds: [1, 2, 3] }));
  await page.getByTestId('regen-character-preview').click();

  await expect.poll(() => chapterState(page, 1), { timeout: 15_000 }).toBe('in_progress');
  await fastForward(page, 1);

  const player = page.getByTestId('revision-diff-player');
  await expect(player).toBeVisible({ timeout: 15_000 });
  await expect(player).toHaveAttribute('data-mode', 'preview');
  return player;
}

test('a preview render with a recorded entry opens on that server entry; Approve accepts it before fanning out', async ({ page }) => {
  test.setTimeout(45_000);
  const player = await openPreviewPlayerRecorded(page);
  await expect(player).toHaveAttribute('data-mode', 'preview');
  const openRevision = await page.evaluate(() => (window as unknown as { __store__: { getState: () => { ui: { openRevision: { kind: string } | null } } } }).__store__.getState().ui.openRevision);
  expect(openRevision?.kind).toBe('server');
  await player.getByRole('button', { name: /Approve.*regenerate the rest/i }).click();
  await expect(player).toBeHidden({ timeout: 10_000 });
  await expect.poll(() => hasElizaRegenLog(page), { timeout: 10_000 }).toBe(true);
  const timeline = await page.evaluate(() => (window as unknown as { __mockRevisions: { get: (b: string) => { timeline: Record<string, Array<{ eventKind: string }>> } } }).__mockRevisions.get('cc').timeline);
  expect(timeline['1'].map((t) => t.eventKind)).toEqual(['accepted']);
});
