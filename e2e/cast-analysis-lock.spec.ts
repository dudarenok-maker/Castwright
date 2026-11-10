/* Plan 291 (#4031), Task 21 - the per-book cast gate, in a real browser.
 *
 * While a book's re-analysis runs, its cast is read-only: the paused banner
 * shows, the controls that would save a cast change are aria-disabled, and
 * nothing is PUT. When the run ends the cast is re-read from disk and edits save
 * again, carrying the whole roster.
 *
 * The mock seams this relies on (src/lib/api.ts): `mockAnalyseManuscript` emits
 * `onCastUpdate` roster frames and registers its book in `MOCK_RUNNING_ANALYSIS`,
 * `mockGetBookBusy` answers `['analysis']` for that book while it runs, and
 * `mockPutBookState` records every PUT on `window.__castwrightMockCalls`.
 *
 * Why browser-level: the frame -> gate -> disabled control -> busy poll ->
 * re-hydrate -> persisted rename chain crosses redux, the router, the stream
 * middleware and the persistence middleware's timers, which jsdom misreports.
 * The same chain is replayed against the recorded server frames in
 * src/store/cast-gate.replay.test.ts. */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

type MockCall = {
  name: string;
  bookId: string;
  req: { slice: string; patch: { characters?: Array<{ id: string; name: string }> } };
};
type Win = {
  __store__: {
    getState: () => {
      cast: { characters: Array<{ id: string; name: string }>; analysisEra?: Record<string, unknown> };
      notifications: { toasts: Array<{ dedupeKey?: string }> };
    };
    dispatch: (action: unknown) => void;
  };
  __castwrightMockCalls?: MockCall[];
  __castwrightMockAnalysisHold?: Promise<void>;
  __castwrightReleaseAnalysis?: () => void;
};

const BOOK = 'ns';

/* The PUT log from index `from` on, as `id:name` per cast row, cast PUTs only. */
const castPutsSince = (page: Page, from: number) =>
  page.evaluate(
    ([bookId, start]) =>
      ((window as unknown as Win).__castwrightMockCalls ?? [])
        .slice(start as number)
        .filter((c) => c.bookId === bookId && c.req.slice === 'cast')
        .map((c) => (c.req.patch.characters ?? []).map((ch) => `${ch.id}:${ch.name}`)),
    [BOOK, from] as const,
  );

const putCount = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__castwrightMockCalls?.length ?? 0);

test('while a re-analysis runs the cast is read-only and nothing is saved; when it ends the cast re-loads and a rename saves the whole roster once', async ({
  page,
}) => {
  /* A finished first run, then a second run started from the analysing view. */
  await goToConfirm(page);
  await page.evaluate((id) => {
    location.hash = `#/books/${id}/analysing`;
  }, BOOK);
  const start = page.getByRole('button', { name: /Start analysis/i });
  await expect(start).toBeVisible({ timeout: 10_000 });
  const putsBeforeRun = await putCount(page);
  /* Hold the finished mock run open (busy stays `['analysis']`) until the spec
     has made its during-run assertions; see the seam in mockAnalyseManuscript. */
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__castwrightMockAnalysisHold = new Promise<void>((resolve) => {
      w.__castwrightReleaseAnalysis = resolve;
    });
  });
  await start.click();

  /* The mock's roster frames reach the analysing view and latch the gate. */
  await page.waitForFunction(
    (id) => {
      const era = (window as unknown as Win).__store__.getState().cast.analysisEra;
      return !!era && id in era;
    },
    BOOK,
    { timeout: 10_000 },
  );

  /* Leave for the Cast view while the run is still going. */
  await page.evaluate((id) => {
    location.hash = `#/books/${id}/cast`;
  }, BOOK);
  await waitForRouteReady(page);
  const banner = page.getByTestId('cast-edits-paused-banner');
  await expect(banner.first()).toBeVisible({ timeout: 10_000 });

  /* The controls only stop OFFERING a change; the persistence middleware is
     what refuses it. A cast edit dispatched straight at the store (no control
     involved) builds no save and raises the one read-only toast. */
  await page.evaluate(() => {
    const w = window as unknown as Win;
    const target = w.__store__.getState().cast.characters[0];
    w.__store__.dispatch({
      type: 'cast/renameCharacter',
      payload: { characterId: target.id, name: 'Bypassed edit' },
    });
  });
  await page.waitForFunction(() =>
    (window as unknown as Win).__store__
      .getState()
      .notifications.toasts.some((t) => t.dedupeKey === 'cast-read-only'),
  );

  /* Voice-assign is disabled and does not start a tap-assign. */
  const assign = page.getByRole('button', { name: /^Assign .+ to a character$/ }).first();
  await expect(assign).toHaveAttribute('aria-disabled', 'true');
  /* Playwright treats aria-disabled as not actionable; force the click through. */
  await assign.click({ force: true });
  await expect(page.getByTestId('tap-assign-banner')).toHaveCount(0);

  /* Confirm opens the profile drawer from a card. Its Save and rename are
     disabled; clicking rename opens nothing. */
  await page.evaluate((id) => {
    location.hash = `#/books/${id}/confirm`;
  }, BOOK);
  await waitForRouteReady(page);
  await page.getByRole('button', { name: /Open profile for Captain Halloran/i }).click();
  const drawer = page.getByRole('complementary');
  const rename = drawer.getByRole('button', { name: 'Rename character' });
  await expect(rename).toHaveAttribute('aria-disabled', 'true');
  await expect(drawer.getByRole('button', { name: /^Save changes$/ })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await rename.click({ force: true });
  await expect(drawer.getByRole('textbox', { name: 'Character name' })).toHaveCount(0);

  /* Nothing was written while the run was live. */
  expect(await putCount(page)).toBe(putsBeforeRun);

  /* Let the mock run resolve: its busy clears, the gate re-reads the cast. */
  await page.evaluate(() => (window as unknown as Win).__castwrightReleaseAnalysis?.());
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
  await expect(rename).not.toHaveAttribute('aria-disabled', 'true', { timeout: 10_000 });
  await page.waitForFunction(
    (id) => {
      const era = (window as unknown as Win).__store__.getState().cast.analysisEra;
      return !era || !(id in era);
    },
    BOOK,
    { timeout: 10_000 },
  );
  const roster = await page.evaluate(() =>
    (window as unknown as Win).__store__.getState().cast.characters.map((c) => c.id),
  );
  expect(roster.length).toBeGreaterThanOrEqual(4);

  /* A rename now persists. The app's own post-load voice match may also write
     the roster unchanged; only the PUT carrying the new name is the edit. */
  await rename.click();
  const input = drawer.getByRole('textbox', { name: 'Character name' });
  await expect(input).toHaveValue('Captain Halloran');
  await input.fill('Admiral Halloran');
  await input.press('Enter');

  const renamedPuts = async () =>
    (await castPutsSince(page, putsBeforeRun)).filter((p) =>
      p.some((r) => r.endsWith(':Admiral Halloran')),
    );
  await expect.poll(async () => (await renamedPuts()).length, { timeout: 10_000 }).toBe(1);

  /* Every cast PUT since the run began carried every row of the re-read roster. */
  const puts = await castPutsSince(page, putsBeforeRun);
  for (const p of puts) expect(p.map((r) => r.split(':')[0])).toEqual(roster);
  expect(await renamedPuts()).toHaveLength(1);
});
