/* Browser-level golden path for fs-41/fs-50 server-driven language detection
 * on the confirm-metadata view. Mock importManuscript mirrors the server's
 * Cyrillic-ratio heuristic and sets language/languageSupported/supportedLanguages
 * on the candidate so the confirm selector is server-driven even in mock mode:
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
      '# Дело о Коалфолле\n\n' +
        '# Глава 1\n\nГорн остыл до цвета подёрнутого пеплом заката, и Рен выскребала последнюю окалину, когда раздался стук.\n\n' +
        '# Глава 2\n\nДверь всё равно отворилась. Мэйрин, староста, просунула голову внутрь, и вместе с ней вошёл холод.\n',
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
      '# The Coalfall Commission\n\n' +
        '# Chapter 1\n\nThe forge had gone the colour of a banked sunset, and Wren was scraping the last of the clinker when the knocking started.\n\n' +
        '# Chapter 2\n\nThe door opened anyway. Maerin the reeve put her head in, and the cold came with her.\n',
    );

    const language = page.getByTestId('confirm-language');
    await expect(language).toHaveValue('en');
    await expect(page.getByText(/Auto-detected Russian/i)).toBeHidden();
  });
});
