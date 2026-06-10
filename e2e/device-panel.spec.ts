/* side-14 — the fs-43 "Will it run on my machine?" panel lives on the Model
   Manager view (#/models, per fs-43's "first-run / Account → Models"
   placement). Mock mode ships a ready devices map (kokoro active on cuda),
   so the ground-truth headline + per-engine rows must render there. */

import { test, expect } from '@playwright/test';

test('#/models device panel shows the ground-truth device line', async ({ page }) => {
  await page.goto('/#/models');

  const panel = page.getByTestId('device-panel');
  await expect(panel.getByText('Currently running on:', { exact: false })).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByText('NVIDIA GPU (CUDA)', { exact: false }).first()).toBeVisible();
});
