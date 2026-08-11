/* LAN browser device-auth UI flow — mock mode only.
 *
 * This spec exercises the UI flow ONLY: Admin → Authorize a device → QR
 * appears, then the /pair page → Authorize button → library lands. It runs
 * against Vite in mock mode (VITE_USE_MOCKS=true) where
 * createDevicePairSession returns a fixed url/code (MOCKCODEMOCKCODE) and
 * redeemBrowserPair resolves immediately without a real server.
 *
 * The real cookie → guarded-GET auth chain is NOT exercised here; that path
 * is covered by the server supertest integration test
 * (server/src/routes/lan-cookie-integration.test.ts) + the manual acceptance
 * walkthrough in docs/superpowers/specs/2026-06-18-lan-browser-device-auth-design.md.
 */

import { test, expect } from '@playwright/test';

test.describe('LAN device-auth', () => {
  test('Admin → Authorize a device → QR appears', async ({ page }) => {
    await page.goto('/#/admin');

    // The LanAccessCard renders a "Device name" input and "Authorize a device" button.
    const labelInput = page.getByPlaceholder('Device name');
    await expect(labelInput).toBeVisible({ timeout: 10_000 });

    await labelInput.fill('My Laptop');

    await page.getByRole('button', { name: 'Authorize a device' }).click();

    // The mock returns url=https://mock.local:8443/#/pair?c=MOCKCODEMOCKCODE;
    // PairingQr encodes it into a data-URL and renders <img data-testid="pair-qr-image">.
    await expect(page.getByTestId('pair-qr-image')).toBeVisible({ timeout: 10_000 });
  });

  test('#/pair?c=MOCKCODEMOCKCODE → Authorize → library view renders', async ({ page }) => {
    // Navigate directly to the pair route with the mock code.
    await page.goto('/#/pair?c=MOCKCODEMOCKCODE');

    // PairShell renders "Authorize this browser?" and an Authorize button.
    await expect(
      page.getByRole('heading', { name: 'Authorize this browser?' }),
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Authorize' }).click();

    // mockRedeemBrowserPair resolves immediately; PairShell calls
    // window.history.replaceState + navigate('/') so the hash becomes #/.
    // The library must render its "Start a new book" CTA.
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    // Confirm we landed on the root hash (books library stage).
    await expect(page).toHaveURL(/#\/?$/);
  });

  test('#/pair?c=MOCKCODEMOCKCODE&self=1 → auto-redeems without a click', async ({ page }) => {
    // Navigate directly to the pair route with the self-bind flag set — this
    // is the desktop "Authorize this browser" hop (Task 4), which should not
    // wait for a click. (The button half of that flow is not e2e-testable
    // here: it navigates to an absolute castwright.local URL the mock server
    // on :5174 cannot resolve.)
    await page.goto('/#/pair?c=MOCKCODEMOCKCODE&self=1');

    // mockRedeemBrowserPair resolves immediately; PairShell auto-redeems on
    // mount and lands on the library without any interaction.
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    // Confirm we landed on the root hash (books library stage).
    await expect(page).toHaveURL(/#\/?$/);
  });
});
