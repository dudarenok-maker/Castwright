/* #3435 — opening an analysed book re-runs emotion detection in the background
 * only when its prosodyAnnotated watermark is explicitly `false` (a run that
 * started and did not finish). A book with the watermark unset (analysed before
 * fs-65, or only ever run by hand) is NOT retro-annotated.
 *
 * This crosses the router → layout effect → redux seam, which jsdom can
 * misreport. The mock honours `window.__SEED_PROSODY_ANNOTATED__` (see
 * `mockGetBookState` in src/lib/api.ts), primed with `addInitScript` before the
 * app boots so the layout's first read already sees it. The observable is the
 * redux `prosody.activeStreams` entry: a store spy, installed the moment
 * `window.__store__` is assigned, records every book that ever held an entry
 * (the mock run lasts only ~2.5 s, so polling the final state could miss it).
 *
 * What this cannot show: mock mode has no real analyzer, so "the requests
 * stop" is the on-box register row (B106), not this spec. */

import { test, expect, type Page } from '@playwright/test';

type Seen = Array<{ bookId: string; background: boolean | undefined }>;

async function installStreamSpy(page: Page, watermark: Record<string, boolean>) {
  await page.addInitScript((seed) => {
    const w = window as unknown as {
      __SEED_PROSODY_ANNOTATED__: Record<string, boolean>;
      __prosodySeen: Seen;
      __store__?: unknown;
    };
    w.__SEED_PROSODY_ANNOTATED__ = seed;
    w.__prosodySeen = [];
    let store: unknown;
    Object.defineProperty(window, '__store__', {
      configurable: true,
      get: () => store,
      set: (v: {
        subscribe: (fn: () => void) => void;
        getState: () => {
          prosody: { activeStreams: Record<string, { background?: boolean }> };
        };
      }) => {
        store = v;
        v.subscribe(() => {
          for (const [bookId, e] of Object.entries(v.getState().prosody.activeStreams)) {
            w.__prosodySeen.push({ bookId, background: e.background });
          }
        });
      },
    });
  }, watermark);
}

const seen = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prosodySeen: Seen }).__prosodySeen);

test('opening a book marked unfinished (prosodyAnnotated: false) re-runs emotion detection in the background', async ({
  page,
}) => {
  await installStreamSpy(page, { sb: false });
  await page.goto('/#/books/sb/generate');
  await expect(page.getByTestId('chapter-row-1-reanalyse')).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(async () => (await seen(page)).some((e) => e.bookId === 'sb' && e.background === true), {
      timeout: 8_000,
    })
    .toBe(true);
});

test('opening a book whose watermark is unset does NOT re-run emotion detection', async ({
  page,
}) => {
  await installStreamSpy(page, {});
  await page.goto('/#/books/sb/generate');
  await expect(page.getByTestId('chapter-row-1-reanalyse')).toBeVisible({ timeout: 10_000 });

  /* Long enough for the open trigger's getBookState read (60 ms in the mock)
     and effect to have run if it were going to. */
  await page.waitForTimeout(2_000);
  expect(await seen(page)).toEqual([]);
});
