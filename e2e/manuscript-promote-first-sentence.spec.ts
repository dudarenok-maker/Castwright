/* PR-gate review finding 4 (2026-07-01) — the "Use first line as title"
 * trigger in the manuscript header lets the user promote a chapter's first
 * sentence into its title (api.renameChapter + manuscriptActions.
 * promoteSentenceToTitle). Mirrors manuscript-detect-emotions.spec.ts
 * (button → confirm popover → action → result) and listen-rename-chapter.
 * spec.ts (rename flow assertions).
 *
 * The canned mock analysis (ANALYSIS_NORTHERN_STAR) puts every sentence
 * under chapter 3 ("What the Captain Knew") — and `ui-slice`'s
 * READY_DEFAULTS lands the manuscript view on chapter 3 by default, so no
 * extra chapter navigation is needed to reach a chapter with sentences. */

import { test, expect } from '@playwright/test';
import { goToConfirm } from './helpers';

const FIRST_SENTENCE =
  'The wind had turned by the time Halloran reached the wheelhouse';

test.describe('manuscript — promote first sentence to title (PR-gate finding 4)', () => {
  test('confirm renames the chapter to the first sentence and removes it from narration', async ({
    page,
  }) => {
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

    const button = page.getByTestId('promote-first-sentence-button');
    await expect(button).toBeVisible({ timeout: 5_000 });
    await expect(button).toBeEnabled();

    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Use first line as title' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(FIRST_SENTENCE);

    await page.getByTestId('promote-first-sentence-confirm').click();

    // Popover closes once the (mock) rename resolves.
    await expect(dialog).toHaveCount(0, { timeout: 3_000 });

    // The chapter heading now shows the promoted sentence as its title.
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toContainText(FIRST_SENTENCE, { timeout: 3_000 });

    // The promoted sentence is gone from the manuscript body — only the
    // heading shows it now, not the article text.
    const article = page.locator('article');
    await expect(article).not.toContainText(FIRST_SENTENCE);
  });

  test('cancel closes the popover with no title change', async ({ page }) => {
    await goToConfirm(page);
    await page.getByRole('button', { name: /Confirm cast and review manuscript/i }).click();
    await expect(page).toHaveURL(/#\/books\/.+\/manuscript$/, { timeout: 5_000 });

    const button = page.getByTestId('promote-first-sentence-button');
    await expect(button).toBeVisible({ timeout: 5_000 });
    await expect(button).toBeEnabled();

    const heading = page.getByRole('heading', { level: 1 });
    const originalHeadingText = (await heading.textContent()) ?? '';

    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Use first line as title' });
    await expect(dialog).toBeVisible();

    await page.getByText('Cancel', { exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // No rename happened — heading text is unchanged, and the promoted
    // sentence is still present in the manuscript body.
    await expect(heading).toHaveText(originalHeadingText);
    await expect(page.locator('article')).toContainText(FIRST_SENTENCE);
  });
});
