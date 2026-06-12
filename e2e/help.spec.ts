/* fe-29 — Help view golden path: persistent affordance opens it, the three
   sections render, and a ?code= deep-link lands focused. */

import { test, expect } from '@playwright/test';

test('top-bar ? opens Help with all three sections', async ({ page }) => {
  await page.goto('/#/');
  await page.getByTestId('topbar-help').click();
  await page.getByRole('menuitem', { name: /^help$/i }).click();
  await expect(page).toHaveURL(/#\/help$/);
  await expect(page.getByRole('heading', { name: 'Getting started' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  /* Troubleshooting h2 renders as Trouble<span>shooting</span> — the
     accessible name collapses to "Troubleshooting" so the exact match works. */
  await expect(page.getByRole('heading', { name: 'Troubleshooting' })).toBeVisible();
  await expect(page.getByText('GPU out of memory (VRAM)')).toBeVisible();
});

test('?code= deep-link focuses the matching entry', async ({ page }) => {
  await page.goto('/#/help?code=vram-spill');
  await expect(page.locator('#vram-spill')).toHaveAttribute('data-focused', 'true');
  await expect(page.locator('#vram-spill')).toBeInViewport();
});
