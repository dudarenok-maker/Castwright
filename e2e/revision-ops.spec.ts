import { test, expect, type Page } from '@playwright/test';
test.describe.configure({ mode: 'serial' });

type Win = {
  __mockRevisions?: { get: (b: string) => { pending: Array<{ id: string }>; timeline: Record<string, Array<{ eventKind: string }>>; dismissed: string[] } };
  __store__?: { getState: () => { revisions: { pending: unknown[]; drift: Array<{ id: string; bookId: string; characterId: string }> } } };
};

async function openSbPlayer(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });
  await page.getByText(/Solway Bay/i).first().click({ timeout: 10_000 });
  await page.getByTestId('status-pill').click();
  const open = page.getByTestId('status-popover-revisions').getByRole('button', { name: /\d+ revisions?/i });
  await expect(open).toBeVisible({ timeout: 10_000 });
  await open.click();
  const player = page.getByTestId('revision-diff-player');
  await expect(player).toBeVisible({ timeout: 10_000 });
  return player;
}

test('Commit selection accepts through the server and records history', async ({ page }) => {
  const player = await openSbPlayer(page);
  await player.getByRole('button', { name: /Commit selection/i }).click();
  await expect(player).toBeHidden({ timeout: 10_000 });
  const disk = await page.evaluate(() => (window as unknown as Win).__mockRevisions!.get('sb'));
  expect(disk.pending).toEqual([]);
  expect(disk.timeline['3'].map((t) => t.eventKind)).toEqual(['accepted']);
  await expect.poll(() => page.evaluate(() => (window as unknown as Win).__store__!.getState().revisions.pending.length)).toBe(0);
});

test('Reject draft rejects through the server and records history', async ({ page }) => {
  const player = await openSbPlayer(page);
  await player.getByRole('button', { name: /Reject draft/i }).click();
  await expect(player).toBeHidden({ timeout: 10_000 });
  const disk = await page.evaluate(() => (window as unknown as Win).__mockRevisions!.get('sb'));
  expect(disk.timeline['3'].map((t) => t.eventKind)).toEqual(['rejected']);
});

test('Dismissing a drift group posts to its book and the events stay gone after the next poll', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({ timeout: 10_000 });
  await page.getByText(/Solway Bay/i).first().click({ timeout: 10_000 });
  await page.goto('/#/books/sb/cast');
  const banner = page.getByText(/Voice drift detected in \d+ chapters?/i);
  await expect(banner).toBeVisible({ timeout: 10_000 });
  const elizaIds = await page.evaluate(() =>
    (window as unknown as Win).__store__!.getState().revisions.drift.filter((d) => d.bookId === 'sb' && d.characterId === 'eliza').map((d) => d.id));
  expect(elizaIds.length).toBeGreaterThan(0);
  await banner.click();
  await page.getByTestId(/^drift-group-dismiss-all-/).first().click();
  await expect.poll(() => page.evaluate((ids) => {
    const dismissed = (window as unknown as Win).__mockRevisions!.get('sb').dismissed;
    return ids.every((id) => dismissed.includes(id));
  }, elizaIds), { timeout: 10_000 }).toBe(true);
  // Force a fresh poll: leave the book and come back (the active poll fires on arrival).
  await page.goto('/#/');
  await page.goto('/#/books/sb/cast');
  await expect.poll(() => page.evaluate((ids) =>
    (window as unknown as Win).__store__!.getState().revisions.drift.filter((d) => ids.includes(d.id)).length, elizaIds), { timeout: 10_000 }).toBe(0);
});
