/* fs-58 Unit B (#1122) — an excluded (flag_nonstory) line offers no split/
 * reassign affordance. jsdom can't drive getSelection/elementFromPoint, so the
 * gate is proven here. */
import { test, expect } from '@playwright/test';

type Store = { dispatch: (a: unknown) => void };

async function selectSentenceText(page: import('@playwright/test').Page, sentenceId: number) {
  await page.evaluate((id) => {
    const inner = document.querySelector(`[data-sentence-id="${id}"] [data-text-offset]`);
    const textNode = inner?.firstChild;
    if (!textNode) throw new Error(`no text node for sentence ${id}`);
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, (textNode as Text).length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, sentenceId);
}

test.describe('fs-58 Unit B — excluded line: no edit affordance', () => {
  test.describe.configure({ mode: 'serial' });

  test('no selection popover on an excluded line; present on a normal line', async ({ page }) => {
    await page.goto('/#/books/sb/manuscript');
    await expect(page.getByRole('heading', { name: /^Chapter \d+/i, level: 1 })).toBeVisible({ timeout: 10_000 });

    // Mark sentence id:1 in the current chapter (3) excluded via the store.
    await page.evaluate(() => {
      const store = (window as unknown as { __store__: Store }).__store__;
      store.dispatch({ type: 'manuscript/setSentenceExcluded', payload: { chapterId: 3, sentenceId: 1, excluded: true } });
    });
    await expect(page.locator('[data-sentence-id="1"]').first()).toHaveClass(/line-through/);

    // (a) Selecting the excluded line shows NO popover.
    await selectSentenceText(page, 1);
    await expect(page.getByText('Assign selection to')).not.toBeVisible();

    // Positive control: a normal line (id:3 is a seeded ch3 sentence) DOES show it.
    await selectSentenceText(page, 3);
    await expect(page.getByText('Assign selection to')).toBeVisible();
  });
});
