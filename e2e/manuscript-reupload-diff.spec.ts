/* Browser-level coverage for the manuscript re-upload diff modal
 * (plan 74). Drives the user flow that closes the gap "re-upload
 * shows no indication of what changed": open an existing book →
 * Replace manuscript → paste a revised text → assert the diff modal
 * surfaces the changed sentence → click Apply → modal closes + slice
 * commits.
 *
 * Pairs with docs/features/archive/74-manuscript-diff-on-reupload.md. */

import { test, expect, type Page } from '@playwright/test';

/* Read manuscript.pendingReupload + manuscript.sourceText from the
   live Redux store. The store is exposed on `window.__store__` only in
   DEV + e2e Vite modes (see src/main.tsx). */
async function getManuscriptState(page: Page): Promise<{
  pendingReupload: { bookId: string } | null;
  sourceText: string | null;
}> {
  return page.evaluate(() => {
    const s = (
      window as unknown as {
        __store__?: {
          getState: () => {
            manuscript: {
              pendingReupload: { bookId: string } | null;
              sourceText: string | null;
            };
          };
        };
      }
    ).__store__;
    if (!s) throw new Error('window.__store__ is not exposed');
    return {
      pendingReupload: s.getState().manuscript.pendingReupload,
      sourceText: s.getState().manuscript.sourceText,
    };
  });
}

/* file-level serial: this spec exercises the same paste-text affordance
   the new-book-flow spec uses; running them in parallel competes for the
   Vite SSR. */
test.describe.configure({ mode: 'serial' });

test.describe('manuscript re-upload diff (plan 74)', () => {
  test('Replace manuscript → diff modal → Apply commits the new text', async ({ page }) => {
    /* Step 1: open the Solway Bay listen view (mock seed). The
       chapter list takes a moment to hydrate — wait for the
       "Play from the start" button to enable as the readiness
       signal (same pattern as listen-playback.spec.ts) before
       hunting for the Replace manuscript button. */
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: /Play from the start/i })).toBeEnabled({
      timeout: 10_000,
    });

    /* Step 2: click "Replace manuscript" — flips ui-slice into
       reupload mode and navigates to /new. */
    const replaceBtn = page.getByTestId('listen-replace-manuscript');
    await expect(replaceBtn).toBeVisible({ timeout: 10_000 });
    await replaceBtn.click();
    await expect(page).toHaveURL(/#\/new$/);
    await expect(page.getByTestId('reupload-book-title')).toHaveText('Solway Bay');

    /* Step 3: paste a revised manuscript. */
    await page.getByRole('button', { name: /Paste text/i }).click();
    await page
      .locator('textarea')
      .fill(
        'A revised first paragraph for the manuscript.\n\n' +
          'A second paragraph that was not there before.\n',
      );
    await page.getByRole('button', { name: /Upload pasted text/i }).click();

    /* Step 4: diff modal opens with the diff entries. */
    await expect(page.getByTestId('manuscript-diff-modal')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('diff-title')).toContainText(/Solway Bay/);
    /* The OLD manuscript slice (under mocks) hydrates to the demo
       fixture sentences from src/data/sentences.ts. Diff rows show
       up either way — we only require at least one non-equal row. */
    const insertRows = page.getByTestId('diff-row-insert');
    const replaceRows = page.getByTestId('diff-row-replace');
    const deleteRows = page.getByTestId('diff-row-delete');
    /* At least one structural diff row must be present — any of
       insert / replace / delete proves the diff engine ran. */
    const total =
      (await insertRows.count()) + (await replaceRows.count()) + (await deleteRows.count());
    expect(total).toBeGreaterThan(0);

    /* Step 5: Apply commits the new manuscript into the slice and
       navigates back to the listen view. */
    await page.getByTestId('diff-apply').click();
    await expect(page).toHaveURL(/#\/books\/sb\/listen/, { timeout: 5_000 });
    await expect(page.getByTestId('manuscript-diff-modal')).not.toBeVisible();
    /* Slice's sourceText should now reflect the pasted text. */
    await expect
      .poll(async () => (await getManuscriptState(page)).sourceText, { timeout: 3_000 })
      .toContain('revised first paragraph');
    /* And pendingReupload is cleared. */
    await expect
      .poll(async () => (await getManuscriptState(page)).pendingReupload, { timeout: 3_000 })
      .toBeNull();
  });

  test('Discard returns to the book without committing the new text', async ({ page }) => {
    await page.goto('/#/books/sb/listen');
    await expect(page.getByRole('heading', { name: /Solway Bay/i, level: 1 })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: /Play from the start/i })).toBeEnabled({
      timeout: 10_000,
    });
    /* Snapshot the original sourceText (likely null under mocks; the
       check is just that Discard doesn't replace it with the new text). */
    const beforeText = (await getManuscriptState(page)).sourceText;

    await expect(page.getByTestId('listen-replace-manuscript')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('listen-replace-manuscript').click();
    await expect(page).toHaveURL(/#\/new$/);
    await page.getByRole('button', { name: /Paste text/i }).click();
    await page
      .locator('textarea')
      .fill('A totally different manuscript that the user will reject.');
    await page.getByRole('button', { name: /Upload pasted text/i }).click();

    await expect(page.getByTestId('manuscript-diff-modal')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('diff-discard').click();

    await expect(page).toHaveURL(/#\/books\/sb\/listen/, { timeout: 5_000 });
    /* Slice retains the pre-upload sourceText (Discard rolls back). */
    const afterText = (await getManuscriptState(page)).sourceText;
    expect(afterText).toBe(beforeText);
  });
});
