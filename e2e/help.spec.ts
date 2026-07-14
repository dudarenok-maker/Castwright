/* fe-29 — Help view golden path: persistent affordance opens it, the three
   sections render, troubleshooting groups + search + wiki link work, and a
   ?code= deep-link lands focused. */

import { test, expect } from '@playwright/test';

test('top-bar ? opens Help with all three sections', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('topbar-help').click();
  await page.getByRole('menuitem', { name: /^help$/i }).click();
  await expect(page).toHaveURL(/#\/help$/);
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Troubleshooting' })).toBeVisible();
  // Groups are collapsed by default (setup open); open Performance & GPU to see its content.
  await page.getByRole('button', { name: /performance & gpu/i }).click();
  await expect(page.getByText('GPU out of memory (VRAM)')).toBeVisible();
});

test('?code= deep-link focuses the matching entry', async ({ page }) => {
  await page.goto('/#/help?code=vram-spill');
  await expect(page.locator('#vram-spill')).toHaveAttribute('data-focused', 'true');
  await expect(page.locator('#vram-spill')).toBeInViewport();
});

test('search filters the troubleshooting list', async ({ page }) => {
  await page.goto('/#/help');
  await page.getByRole('searchbox', { name: /search troubleshooting/i }).fill('vram');
  await expect(page.getByText('GPU out of memory (VRAM)')).toBeVisible();
  await expect(page.getByText("The app won't start")).toHaveCount(0);
});

test('help exposes a wiki link (href only, no navigation)', async ({ page }) => {
  await page.goto('/#/help');
  const link = page.getByRole('link', { name: /read more on the wiki/i }).first();
  await expect(link).toHaveAttribute('href', /github\.com\/.+\/wiki\//);
});
