/* #4098 - the manuscript slice joins the per-book read-only era, in a real browser.
 *
 * While a book's re-analysis runs, a manuscript edit builds no save (the
 * persistence middleware's build-time gate, `selectCastReadOnly`) and raises the
 * read-only toast. When the run ends the cast gate's post-run re-read also
 * hydrates the manuscript slice from disk, so the refused edit is replaced by
 * what disk holds. After that, manuscript edits save again.
 *
 * Mirrors e2e/cast-analysis-lock.spec.ts. The mock seams (src/lib/api.ts):
 * `__castwrightMockAnalysisHold` / `__castwrightReleaseAnalysis` hold the mock
 * run open so busy stays `['analysis']`; `__castwrightMockCalls` records every
 * mock `putBookState` (filter on `req.slice === 'manuscript'`); `__store__`
 * lets the spec dispatch an edit straight at the store, bypassing the UI.
 *
 * Why browser-level: the held run -> era latch -> middleware drop -> busy poll ->
 * re-read -> hydrate chain crosses redux, the router, the stream middleware and
 * the persistence middleware's timers, which jsdom misreports. */

import { test, expect, type Page } from '@playwright/test';
import { goToConfirm, waitForRouteReady } from './helpers';

type MockCall = {
  name: string;
  bookId: string;
  req: { slice: string; patch: { sentences?: Array<{ chapterId: number; id: number; text: string }> } };
};
type Win = {
  __store__: {
    getState: () => {
      cast: { analysisEra?: Record<string, unknown> };
      manuscript: { sentences: Array<{ chapterId: number; id: number; text: string }> };
      notifications: { toasts: Array<{ dedupeKey?: string }> };
    };
    dispatch: (action: unknown) => void;
  };
  __castwrightMockCalls?: MockCall[];
  __castwrightMockAnalysisHold?: Promise<void>;
  __castwrightReleaseAnalysis?: () => void;
};

const BOOK = 'ns';

type Key = { chapterId: number; sentenceId: number };

const setText = (page: Page, key: Key, text: string) =>
  page.evaluate(
    ([k, t]) =>
      (window as unknown as Win).__store__.dispatch({
        type: 'manuscript/setSentenceText',
        payload: { chapterId: (k as Key).chapterId, sentenceId: (k as Key).sentenceId, text: t },
      }),
    [key, text] as const,
  );

const putCount = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__castwrightMockCalls?.length ?? 0);

/* Manuscript PUTs from index `from` on, each as the text of the keyed sentence. */
const manuscriptPutTexts = (page: Page, key: Key, from: number) =>
  page.evaluate(
    ([bookId, start, k]) =>
      ((window as unknown as Win).__castwrightMockCalls ?? [])
        .slice(start as number)
        .filter((c) => c.bookId === bookId && c.req.slice === 'manuscript')
        .map(
          (c) =>
            (c.req.patch.sentences ?? []).find(
              (s) => s.chapterId === (k as Key).chapterId && s.id === (k as Key).sentenceId,
            )?.text,
        ),
    [BOOK, from, key] as const,
  );

const sliceText = (page: Page, key: Key) =>
  page.evaluate(
    (k) =>
      (window as unknown as Win).__store__
        .getState()
        .manuscript.sentences.find((s) => s.chapterId === k.chapterId && s.id === k.sentenceId)?.text,
    key,
  );

const diskText = (page: Page, key: Key) =>
  page.evaluate(async (k) => {
    const { api } = await import('/src/lib/api.ts');
    const res = await api.getBookState('ns');
    return res?.manuscriptEdits?.sentences?.find(
      (s: { chapterId: number; id: number }) => s.chapterId === k.chapterId && s.id === k.sentenceId,
    )?.text;
  }, key);

test('while a re-analysis runs a manuscript edit is not saved; when it ends the slice re-reads from disk and edits save again', async ({
  page,
}) => {
  await goToConfirm(page);

  /* 2. Seed and control: a legitimate, ungated edit saves and lands on the mock disk. */
  const key = await page.evaluate(() => {
    const s = (window as unknown as Win).__store__.getState().manuscript.sentences[0];
    return { chapterId: s.chapterId, sentenceId: s.id };
  });
  await setText(page, key, 'Saved before the run');
  await expect
    .poll(async () => (await manuscriptPutTexts(page, key, 0)).includes('Saved before the run'), {
      timeout: 10_000,
    })
    .toBe(true);
  await expect.poll(() => diskText(page, key), { timeout: 10_000 }).toBe('Saved before the run');

  /* 3. A second run started from the analysing view, held open. */
  await page.evaluate((id) => {
    location.hash = `#/books/${id}/analysing`;
  }, BOOK);
  const start = page.getByRole('button', { name: /Start analysis/i });
  await expect(start).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    const w = window as unknown as Win;
    w.__castwrightMockAnalysisHold = new Promise<void>((resolve) => {
      w.__castwrightReleaseAnalysis = resolve;
    });
  });
  await start.click();
  await page.waitForFunction(
    (id) => {
      const era = (window as unknown as Win).__store__.getState().cast.analysisEra;
      return !!era && id in era;
    },
    BOOK,
    { timeout: 10_000 },
  );
  const putsAtRunStart = await putCount(page);

  /* 4. A manuscript edit dispatched straight at the store builds no save and
     raises the one read-only toast. */
  await page.evaluate((id) => {
    location.hash = `#/books/${id}/manuscript`;
  }, BOOK);
  await waitForRouteReady(page);
  await setText(page, key, 'Bypassed manuscript edit');
  await page.waitForFunction(() =>
    (window as unknown as Win).__store__
      .getState()
      .notifications.toasts.some((t) => t.dedupeKey === 'cast-read-only'),
    undefined,
    { timeout: 10_000 },
  );
  /* Two debounce windows: a save that was merely late would land here. */
  await page.waitForTimeout(1000);
  expect(await manuscriptPutTexts(page, key, putsAtRunStart)).toEqual([]);

  /* 5. Release the run; the era clears and the gate re-reads the slice. */
  await page.evaluate(() => (window as unknown as Win).__castwrightReleaseAnalysis?.());
  await page.waitForFunction(
    (id) => {
      const era = (window as unknown as Win).__store__.getState().cast.analysisEra;
      return !era || !(id in era);
    },
    BOOK,
    { timeout: 30_000 },
  );
  const disk = await diskText(page, key);
  expect(disk).not.toBe('Bypassed manuscript edit');
  await expect.poll(() => sliceText(page, key), { timeout: 10_000 }).toBe(disk);
  expect(await sliceText(page, key)).not.toBe('Bypassed manuscript edit');
  expect(await manuscriptPutTexts(page, key, putsAtRunStart)).not.toContain('Bypassed manuscript edit');

  /* 6. After the run, an edit saves again: exactly one new PUT carries it. */
  const putsAfterRun = await putCount(page);
  await setText(page, key, 'Saved after the run');
  await expect
    .poll(
      async () =>
        (await manuscriptPutTexts(page, key, putsAfterRun)).filter((t) => t === 'Saved after the run')
          .length,
      { timeout: 10_000 },
    )
    .toBe(1);
});
