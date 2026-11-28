/* #3519 - the loaded-book edit gate, in a real browser.
 *
 * The stage names a new book at once; the cast, chapters and manuscript slices
 * move to it only when its read lands. Until then, on Confirm and Ready, the
 * routed view is `inert` under the `book-loading` overlay, so an edit cannot be
 * made over the previous book's slices (the persistence gate would drop it,
 * #3624).
 *
 * The mock seam this relies on (src/lib/api.ts): `mockGetBookState` waits on
 * `window.__castwrightMockBookStateHold[bookId]` when a spec sets it, which
 * holds that one book's read open.
 *
 * Switching books, the Confirm and Ready routes show their own placeholder under
 * the overlay, so no control is there to try. After a reload the restored
 * manuscript fields name the book and its view renders, controls and all, before
 * the read lands: that is where the input block is exercised.
 *
 * Why browser-level: only a real browser enforces `inert` (focus and pointer
 * input), which the jsdom specs can check as an attribute only, and the gate
 * crosses the router, the layout's read, the loaded-book slice and the
 * persistence middleware. */

import { test, expect, type Page } from '@playwright/test';
import { waitForRouteReady } from './helpers';

type MockCall = {
  bookId: string;
  req: { slice: string; patch: { characters?: Array<{ id: string; name: string }> } };
};
type Win = {
  __store__: {
    getState: () => {
      ui: { stage: { kind: string; bookId?: string; openProfileId?: string | null } };
      loadedBook: { loadedBookId: string | null };
    };
  };
  __castwrightMockCalls?: MockCall[];
  __castwrightMockBookStateHold?: Record<string, Promise<void>>;
  __castwrightReleaseBookRead?: () => void;
  __bookLoadingSeen?: boolean;
};

/* Two seeded mock books, and a cast row only that book has. */
const NORTHERN_STAR = { id: 'ns', row: 'cast-row-halloran' };
const CARRICKS_COMPASS = { id: 'cc', row: 'cast-row-greene' };

/* Which book the stage names, and which one the slices hold. */
const books = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as Win).__store__.getState();
    return { stage: s.ui.stage.kind, named: s.ui.stage.bookId, held: s.loadedBook.loadedBookId };
  });

/* Cold-load a book's Cast view and wait until the slices hold it. */
async function openCast(page: Page, book: { id: string; row: string }) {
  await page.goto(`/#/books/${book.id}/cast`);
  await waitForRouteReady(page);
  await expect(page.getByTestId(book.row)).toBeVisible();
  await expect.poll(() => books(page)).toEqual({ stage: 'ready', named: book.id, held: book.id });
  await expect(page.getByTestId('book-loading')).toHaveCount(0);
}

/* Runs in the page: hold the next reads of one book until `releaseBookRead`. */
function holdBookRead(bookId: string) {
  const w = window as unknown as Win;
  w.__castwrightMockBookStateHold = {
    [bookId]: new Promise<void>((resolve) => {
      w.__castwrightReleaseBookRead = resolve;
    }),
  };
}

/* Move to another book's Cast view in the same app session, its read held. */
async function switchWithReadHeld(page: Page, bookId: string) {
  await page.evaluate(holdBookRead, bookId);
  await page.evaluate((id) => {
    location.hash = `#/books/${id}/cast`;
  }, bookId);
}

const releaseBookRead = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__castwrightReleaseBookRead?.());

/* Record whether the loading state is ever added to the page, however briefly. */
async function watchForBookLoading(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as Win;
    const selector = '[data-testid="book-loading"]';
    w.__bookLoadingSeen = !!document.querySelector(selector);
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && (node.matches(selector) || node.querySelector(selector)))
            w.__bookLoadingSeen = true;
    }).observe(document.body, { childList: true, subtree: true });
  });
}

const bookLoadingWasSeen = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__bookLoadingSeen);

test.describe('loaded-book edit gate', () => {
  /* Each test cold-loads the app, which on a busy box can outlast 30 s. */
  test.describe.configure({ timeout: 60_000 });

  test('while the slices do not hold the named book, a loading state shows and the view takes no input', async ({
    page,
  }) => {
    await openCast(page, NORTHERN_STAR);
    await switchWithReadHeld(page, CARRICKS_COMPASS.id);

    const loading = page.getByTestId('book-loading');
    await expect(loading).toBeVisible();
    await expect(loading.getByText('Loading this book…')).toBeVisible();
    expect(await books(page)).toEqual({
      stage: 'ready',
      named: CARRICKS_COMPASS.id,
      held: NORTHERN_STAR.id,
    });

    /* The routed view is inert, and the previous book's rows are not in it. */
    const view = page.locator('[inert]');
    await expect(view).toHaveAttribute('inert', '');
    await expect(view).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByTestId(NORTHERN_STAR.row)).toHaveCount(0);

    /* Let the read land and the restored fields reach storage, then reload the
       same book with its read held: now the view renders under the overlay. */
    await releaseBookRead(page);
    await expect(loading).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('persist:manuscript')))
      .toContain('mns_cc');
    await page.addInitScript(holdBookRead, CARRICKS_COMPASS.id);
    await page.reload();
    await expect(loading).toBeVisible();

    /* A control in the view cannot take keyboard focus... */
    const next = page.locator('button', { hasText: 'Continue to manuscript' });
    await expect(next).toBeVisible();
    await next.focus();
    await expect(next).not.toBeFocused();

    /* ...and a real pointer click on it does nothing. */
    const box = (await next.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
    expect(page.url()).toContain(`#/books/${CARRICKS_COMPASS.id}/cast`);
    await expect(loading).toBeVisible();

    /* The same control works once the read lands. */
    await releaseBookRead(page);
    await expect(loading).toHaveCount(0);
    await next.focus();
    await expect(next).toBeFocused();
    await next.click();
    await expect(page).toHaveURL(new RegExp(`#/books/${CARRICKS_COMPASS.id}/manuscript`));
  });

  test("once the new book's read lands, the loading state clears and an edit saves to that book", async ({
    page,
  }) => {
    await openCast(page, NORTHERN_STAR);
    await watchForBookLoading(page);
    await switchWithReadHeld(page, CARRICKS_COMPASS.id);

    const loading = page.getByTestId('book-loading');
    await expect(loading).toBeVisible();
    /* The watcher the next test relies on does see the loading state. */
    expect(await bookLoadingWasSeen(page)).toBe(true);

    await releaseBookRead(page);
    await expect(loading).toHaveCount(0);
    expect(await books(page)).toEqual({
      stage: 'ready',
      named: CARRICKS_COMPASS.id,
      held: CARRICKS_COMPASS.id,
    });
    await expect(page.locator('[inert]')).toHaveCount(0);

    await page.getByTestId(CARRICKS_COMPASS.row).click();
    const drawer = page.getByRole('complementary').filter({ hasText: 'Also known as' });
    await drawer.getByRole('button', { name: 'Rename character' }).click();
    const input = drawer.getByRole('textbox', { name: 'Character name' });
    await input.fill('Mate Greene');
    await input.press('Enter');
    await expect(drawer.getByRole('heading', { name: 'Mate Greene' })).toBeVisible();

    /* The edit commits: it is saved, and only into the book now on screen. */
    const booksSavedWithTheName = () =>
      page.evaluate(() => [
        ...new Set(
          ((window as unknown as Win).__castwrightMockCalls ?? [])
            .filter(
              (c) =>
                c.req.slice === 'cast' &&
                (c.req.patch.characters ?? []).some((ch) => ch.name === 'Mate Greene'),
            )
            .map((c) => c.bookId),
        ),
      ]);
    await expect.poll(booksSavedWithTheName).toEqual([CARRICKS_COMPASS.id]);
  });

  test("a profile link to a book still being read opens no drawer over the held book's character", async ({
    page,
  }) => {
    await openCast(page, NORTHERN_STAR);
    await page.evaluate(holdBookRead, CARRICKS_COMPASS.id);
    /* The held book has a `narrator`, so its row could answer the new book's link. */
    await page.evaluate((id) => {
      location.hash = `#/books/${id}/cast?profile=narrator`;
    }, CARRICKS_COMPASS.id);

    const loading = page.getByTestId('book-loading');
    await expect(loading).toBeVisible();
    const openProfile = () =>
      page.evaluate(() => (window as unknown as Win).__store__.getState().ui.stage.openProfileId);
    await expect.poll(openProfile).toBe('narrator');
    expect(await books(page)).toEqual({
      stage: 'ready',
      named: CARRICKS_COMPASS.id,
      held: NORTHERN_STAR.id,
    });
    const drawer = page.getByRole('complementary').filter({ hasText: 'Also known as' });
    await expect(drawer).toHaveCount(0);

    /* This book has no narrator, so there is still nothing to open once it is read... */
    await releaseBookRead(page);
    await expect(loading).toHaveCount(0);
    await expect(page.getByTestId(CARRICKS_COMPASS.row)).toBeVisible();
    await expect(drawer).toHaveCount(0);

    /* ...and a link to a character it does have opens the drawer on it. */
    await page.evaluate((id) => {
      location.hash = `#/books/${id}/cast?profile=greene`;
    }, CARRICKS_COMPASS.id);
    await expect(drawer.getByRole('heading', { name: 'First Mate Greene' })).toBeVisible();
  });

  test('moving between views of one book never shows the loading state', async ({ page }) => {
    await openCast(page, CARRICKS_COMPASS);
    await watchForBookLoading(page);

    const castRow = page.getByTestId(CARRICKS_COMPASS.row);
    const views = [
      {
        tab: 'Generate',
        path: 'generate',
        shows: page.getByRole('heading', { name: "Generating Carrick's Compass" }),
      },
      { tab: 'Cast', path: 'cast', shows: castRow },
      {
        tab: 'Manuscript',
        path: 'manuscript',
        shows: page.getByRole('heading', { name: /The Lee Shore/, level: 1 }),
      },
      { tab: 'Cast', path: 'cast', shows: castRow },
    ];
    for (const view of views) {
      await page.getByRole('banner').getByRole('button', { name: view.tab, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#/books/${CARRICKS_COMPASS.id}/${view.path}`));
      await waitForRouteReady(page);
      await expect(view.shows).toBeAttached();
      await expect(page.getByTestId('book-loading')).toHaveCount(0);
    }

    expect(await bookLoadingWasSeen(page)).toBe(false);
  });
});
