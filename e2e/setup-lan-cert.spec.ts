// e2e/setup-lan-cert.spec.ts
import { test, expect } from '@playwright/test';

test('first-run wizard surfaces the LAN-access cert step and can regenerate', async ({ page }) => {
  await page.goto('/#/?setup=notready'); // guided mode (default /#/setup is the checklist board)
  // environment→ffmpeg→models→defaults→lanCert = 4 Next clicks (Next is never gated).
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page.getByTestId('lan-cert-status-wizard')).toBeVisible();
  // Mock status is health:'missing' + requested:true → warning banner shows.
  await expect(page.getByTestId('lan-cert-warning-banner')).toBeVisible();
  // Repair button is present and clickable (mock regenerate resolves).
  await page.getByRole('button', { name: /set up lan certificate/i }).click();
});
