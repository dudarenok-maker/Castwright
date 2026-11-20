import { test, expect, type Page } from '@playwright/test';
import { goToAnalysing } from '../helpers';

const snap = (page: Page) =>
  page.evaluate(() => {
    const vv = window.visualViewport;
    const a = document.activeElement;
    return JSON.stringify({
      scrollY: window.scrollY,
      offsetTop: vv?.offsetTop,
      pageTop: vv?.pageTop,
      height: vv?.height,
      scale: vv?.scale,
      innerH: window.innerHeight,
      active: a ? `${a.tagName}#${a.id}` : null,
    });
  });

test('diag viewport', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible();
  console.log('DIAG library', await snap(page));
  await page.getByRole('button', { name: /Start a new book/i }).first().click();
  await page.getByRole('button', { name: /Paste text/i }).click();
  console.log('DIAG new-paste', await snap(page));
  await page.locator('textarea').fill('Chapter 1\n\nHello world.\n\nChapter 2\n\nMore text.');
  console.log('DIAG after-textarea-fill', await snap(page));
  await page.getByRole('button', { name: /Upload pasted text/i }).click();
  await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible();
  console.log('DIAG meta-form', await snap(page));
  await page.getByPlaceholder(/Ursula K\. Le Guin/i).fill('E2E Author');
  console.log('DIAG after-author-fill', await snap(page));
  await page.getByRole('button', { name: /Save book and start analysis/i }).click();
  await expect(page).toHaveURL(/#\/books\/.+\/analysing$/);
  for (const ms of [0, 300, 700, 2000]) {
    if (ms) await page.waitForTimeout(ms);
    console.log('DIAG analysing+', ms, await snap(page));
  }
  // full helper once more for control
  await goToAnalysing(page);
  console.log('DIAG helper-final', await snap(page));
});
