import { test, expect } from '@playwright/test';

test('boot gate redirects to #/setup when not ready', async ({ page }) => {
  await page.goto('/#/?setup=notready');
  await expect(page).toHaveURL(/#\/setup/);
  await expect(page.getByRole('heading', { name: /set up castwright/i })).toBeVisible();
});

test('boot gate stays out of the way when ready', async ({ page }) => {
  await page.goto('/#/');
  await expect(page).not.toHaveURL(/#\/setup/);
});
