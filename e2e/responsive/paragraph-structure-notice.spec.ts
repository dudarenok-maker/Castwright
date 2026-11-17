/* #2254 — browser-level check of notice A (the confirm-view "Heads-up" for a
 * book whose imported paragraphs have merged dialogue turns), per
 * docs/superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md
 * §3.1 "Tests" and "Mobile/touch".
 *
 * Mock-mode only: mockImportManuscript sets `paragraphsMerged` on its single
 * chapter when the pasted text is >= 30% Cyrillic and one line holds >= 10
 * `[.!?…:] — Upper` turn openers.
 *
 * Lives under e2e/responsive/ so the mobile-chrome and tablet-chrome projects
 * pick it up at release time (playwright.config.ts testMatch). PR CI runs the
 * chromium project only, so the phone-width describe forces a 375 x 812
 * viewport on chromium: that is the PR-time phone check. */

import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function pasteAndConfirm(page: Page, body: string) {
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

const TURN = 'Он кивнул. — Да.';
const NARRATION = 'Ночь была тихой, и ветер почти не шевелил занавески в окне.';

/* One paragraph holding 12 mid-paragraph turn openers. */
const MERGED = `# Ночной тест\n\n# Глава 1\n\n${NARRATION} ${Array(12).fill(TURN).join(' ')}\n`;
/* The same turns, one per line. */
const CLEAN = `# Ночной тест\n\n# Глава 1\n\n${NARRATION}\n${Array(12).fill(TURN).join('\n')}\n`;

const NOTICE_TEXT = /ten or more places where a line of dialogue begins mid-paragraph/;

test.describe('#2254 paragraph-structure notice A on the confirm view', () => {
  test('merged turns in a Russian book show the Heads-up', async ({ page }) => {
    await pasteAndConfirm(page, MERGED);
    const notice = page.getByTestId('confirm-paragraph-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(NOTICE_TEXT);
  });

  test('overriding the language to English hides it', async ({ page }) => {
    await pasteAndConfirm(page, MERGED);
    await expect(page.getByTestId('confirm-paragraph-notice')).toBeVisible();
    await page.getByTestId('confirm-language').selectOption('en');
    await expect(page.getByTestId('confirm-paragraph-notice')).toHaveCount(0);
  });

  test('the same turns one per line show no notice', async ({ page }) => {
    await pasteAndConfirm(page, CLEAN);
    await expect(page.getByTestId('confirm-language')).toHaveValue('ru');
    await expect(page.getByTestId('confirm-paragraph-notice')).toHaveCount(0);
  });
});

/* Phone width, chromium only: the mobile projects already run at phone width. */
test.describe('#2254 notice A at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the Heads-up shows and the page does not scroll sideways', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'mobile projects already run at phone width');
    await pasteAndConfirm(page, MERGED);
    await expect(page.getByTestId('confirm-paragraph-notice')).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(375);
  });
});

/* Notice B: the manuscript caption. mockGetBookState reads the e2e seam
 * `__SEED_PARAGRAPHS_MERGED__` (bookId -> chapter ids); the Solway Bay (sb)
 * fixture has 18 chapters that open straight in the manuscript view. */
const CAPTION = /ten or more places where a line of dialogue begins mid-paragraph/;

async function openManuscript(page: Page, seed: number[] | null) {
  if (seed) {
    await page.addInitScript((ids) => {
      (
        globalThis as unknown as { __SEED_PARAGRAPHS_MERGED__?: Record<string, number[]> }
      ).__SEED_PARAGRAPHS_MERGED__ = { sb: ids };
    }, seed);
  }
  await page.goto('/#/books/sb/manuscript');
  /* The book opens on its first chapter with low-confidence lines (ch3); step
     back with Prev to chapter 1 so the walk starts there. */
  await expect(page.getByRole('heading', { name: /^Chapter 3\b/i, level: 1 })).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole('button', { name: 'Previous chapter' }).click();
  await page.getByRole('button', { name: 'Previous chapter' }).click();
  await expect(page.getByRole('heading', { name: /^Chapter 1\b/i, level: 1 })).toBeVisible();
}

async function walkChapters(page: Page) {
  const caption = page.getByTestId('manuscript-paragraph-notice');
  await expect(caption).toHaveCount(0);
  await page.getByRole('button', { name: 'Next chapter' }).click();
  await expect(page.getByRole('heading', { name: /^Chapter 2\b/i, level: 1 })).toBeVisible();
  await expect(caption).toBeVisible();
  await expect(caption).toContainText(CAPTION);
  await page.getByRole('button', { name: 'Previous chapter' }).click();
  await expect(page.getByRole('heading', { name: /^Chapter 1\b/i, level: 1 })).toBeVisible();
  await expect(caption).toHaveCount(0);
}

test.describe('#2254 paragraph-structure notice B on the manuscript view', () => {
  test('a flagged chapter shows the caption; its neighbours do not', async ({ page }) => {
    await openManuscript(page, [2]);
    await walkChapters(page);
  });

  test('with no seed no chapter shows the caption', async ({ page }) => {
    await openManuscript(page, null);
    await page.getByRole('button', { name: 'Next chapter' }).click();
    await expect(page.getByRole('heading', { name: /^Chapter 2\b/i, level: 1 })).toBeVisible();
    await expect(page.getByTestId('manuscript-paragraph-notice')).toHaveCount(0);
  });
});

test.describe('#2254 notice B at phone width', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('the caption walk works and the page does not scroll sideways', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'mobile projects already run at phone width');
    await openManuscript(page, [2]);
    await walkChapters(page);
    await page.getByRole('button', { name: 'Next chapter' }).click();
    await expect(page.getByTestId('manuscript-paragraph-notice')).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(375);
  });
});
