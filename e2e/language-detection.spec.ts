/* Browser-level golden path for fs-2 language auto-detection on the
 * confirm-metadata view. Mocks the import path (mock importManuscript echoes
 * the pasted text as sourceText), so detectLanguage runs over the real
 * manuscript text in the browser:
 *   - a Cyrillic manuscript → the Language selector auto-selects Russian and
 *     shows the "Auto-detected Russian — verify" chip + the Qwen-voices note;
 *     overriding to English clears the chip.
 *   - an English manuscript → the selector stays English, no Russian chrome.
 *
 * Mock-mode only — mirrors the series-from-title.spec.ts wrapper.
 * Wall-clock budget: <12 s warm. */

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function pasteAndConfirm(page: import('@playwright/test').Page, body: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
    timeout: 10_000,
  });
  await page
    .getByRole('button', { name: /Start a new book/i })
    .first()
    .click();
  await expect(page).toHaveURL(/#\/new$/);
  await page.getByRole('button', { name: /Paste text/i }).click();
  await page.locator('textarea').fill(body);
  await page.getByRole('button', { name: /Upload pasted text/i }).click();
  await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
    timeout: 5_000,
  });
}

test.describe('fs-2 language auto-detection on confirm', () => {
  test('a Cyrillic manuscript auto-selects Russian + shows the chip, clears on override', async ({
    page,
  }) => {
    await pasteAndConfirm(
      page,
      '# Хамелеон\n\n' +
        '# Глава 1\n\nЧерез базарную площадь идёт полицейский надзиратель Очумелов в новой шинели.\n\n' +
        '# Глава 2\n\nВокруг него собралась толпа любопытных, и каждый что-то говорил.\n',
    );

    const language = page.getByTestId('confirm-language');
    await expect(language).toHaveValue('ru');
    await expect(page.getByText(/Auto-detected Russian/i)).toBeVisible();
    await expect(page.getByText(/designed Qwen voices/i)).toBeVisible();

    /* Overriding to English clears the auto-detected chip. */
    await language.selectOption('en');
    await expect(page.getByText(/Auto-detected Russian/i)).toBeHidden();
  });

  test('an English manuscript stays English with no Russian chrome', async ({ page }) => {
    await pasteAndConfirm(
      page,
      '# A Wizard of Earthsea\n\n' +
        '# Chapter 1\n\nThe island of Gont, a single mountain that lifts its peak above the storm-racked sea.\n\n' +
        '# Chapter 2\n\nHe learned the names of every herb and the use of every craft.\n',
    );

    const language = page.getByTestId('confirm-language');
    await expect(language).toHaveValue('en');
    await expect(page.getByText(/Auto-detected Russian/i)).toBeHidden();
  });
});
