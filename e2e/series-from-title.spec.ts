/* Browser-level golden path for Bug B + chip on confirm-metadata.
 * Mocks the import path so the heuristic parses "(Series Book N)" off
 * the title and surfaces an "Auto-extracted from title" chip on the
 * confirm screen.
 *
 * Walks: cold boot → upload (paste H1 carrying series-in-title) →
 * confirm-metadata renders with split fields + chip → editing series
 * clears the chip → submit reaches analysing.
 *
 * Mock-mode only — mirrors the new-book-flow.spec.ts wrapper.
 * Wall-clock budget: <12 s warm. */

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test.describe('series-from-title heuristic + chip', () => {
  test('paste manuscript with (Series Book N) suffix → confirm shows split fields, chip, and clears on edit', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    await page
      .getByRole('button', { name: /Start a new book/i })
      .first()
      .click();
    await expect(page).toHaveURL(/#\/new$/);

    /* Paste a markdown manuscript whose H1 carries the series in a
       trailing parenthetical. The mock importManuscript mirrors the
       server's parseSeriesFromTitle so the candidate lands with
       title='Saltgrave', series='The Hollow Tide',
       seriesPosition=3, seriesFromTitle=true. */
    await page.getByRole('button', { name: /Paste text/i }).click();
    await page
      .locator('textarea')
      .fill(
        '# Saltgrave (The Hollow Tide Book 3)\n\n' +
          '# Chapter 1\n\nThe flame was tinged with blue.\n\n' +
          '# Chapter 2\n\nIt grew.\n',
      );
    await page.getByRole('button', { name: /Upload pasted text/i }).click();

    /* Confirm-metadata view loads; the standalone checkbox must be
       UNCHECKED because series was populated. */
    await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible({
      timeout: 5_000,
    });
    const standalone = page.getByRole('checkbox', { name: /This is a standalone/i });
    await expect(standalone).not.toBeChecked();

    /* Series field carries the extracted series name. */
    const seriesInput = page.getByPlaceholder('e.g. Earthsea');
    await expect(seriesInput).toHaveValue('The Hollow Tide');

    /* Book # carries the extracted position. */
    const bookNum = page.getByPlaceholder('1');
    await expect(bookNum).toHaveValue('3');

    /* Title was stripped of the parenthetical. */
    const titleInput = page.getByPlaceholder(/Wizard of Earthsea/i);
    await expect(titleInput).toHaveValue('Saltgrave');

    /* The "auto-extracted from title" chip is visible. */
    const chip = page.getByText(/Auto-extracted from title/i);
    await expect(chip).toBeVisible();

    /* Editing the series field clears the chip — the value is no
       longer purely heuristic, user has explicitly verified or
       corrected it. */
    await seriesInput.click();
    await page.keyboard.press('End');
    await page.keyboard.press('!');
    await expect(chip).toBeHidden();
  });
});
