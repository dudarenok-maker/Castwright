/* Admin / Account UI polish — crosses the router/redux/layout seam, so it earns
   a Playwright spec per CLAUDE.md's e2e bar. Runs against Vite in mock mode,
   where GET /api/diagnostics returns a board that now carries the ASR row + the
   "Voice engine" rename, and the throughput/telemetry mocks ship 7 rows so both
   Admin tables actually render their scroll regions.

   Covers:
     - the "TTS sidecar" → "Voice engine" rename in the health board,
     - the new ASR (Whisper) row sitting directly below the Voice engine row,
     - both Admin tables scrolling inside the inset thin-scrollbar utility with a
       sticky column header pinned INSIDE the scroller (the header-alignment fix),
     - the Account "Open Model Manager" button staying readable in dark mode
       (dark text on the inverted-ink pill, not white-on-near-white). */

import { test, expect } from '@playwright/test';

test.describe('Admin watch console — voice-engine rename + ASR row', () => {
  test('labels the sidecar row "Voice engine" and drops the "TTS sidecar" jargon', async ({
    page,
  }) => {
    await page.goto('/#/admin');
    const sidecarRow = page.getByTestId('health-row-sidecar');
    await expect(sidecarRow).toBeVisible({ timeout: 10_000 });
    await expect(sidecarRow).toContainText('Voice engine');
    await expect(page.getByTestId('health-board')).not.toContainText('TTS sidecar');
  });

  test('renders the ASR (Whisper) row directly below the Voice engine row', async ({ page }) => {
    await page.goto('/#/admin');
    await expect(page.getByTestId('health-row-asr')).toBeVisible({ timeout: 10_000 });
    const ids = await page
      .getByTestId('health-board')
      .locator('[data-testid^="health-row-"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(ids.indexOf('health-row-asr')).toBe(ids.indexOf('health-row-sidecar') + 1);
  });
});

test.describe('Admin tables — scroll region + sticky header alignment', () => {
  test('generation throughput scrolls in the inset thin-scrollbar with a sticky header inside', async ({
    page,
  }) => {
    await page.goto('/#/admin');
    const scroll = page.getByTestId('generation-throughput-scroll');
    await expect(scroll).toBeVisible({ timeout: 10_000 });
    await expect(scroll).toHaveClass(/scrollbar-thin/);
    await expect(scroll).toHaveClass(/overflow-y-auto/);
    // The column header is the first child of the scroller and is sticky, so it
    // shares the reserved gutter with the rows it sits above.
    const headerPosition = await scroll
      .locator(':scope > div')
      .first()
      .evaluate((el) => getComputedStyle(el).position);
    expect(headerPosition).toBe('sticky');
    // Rows live in the same scroller.
    await expect(scroll.locator('[data-testid^="throughput-row-"]').first()).toBeVisible();
  });

  test('resource trends scrolls in the inset thin-scrollbar with a sticky header inside', async ({
    page,
  }) => {
    await page.goto('/#/admin');
    const scroll = page.getByTestId('resource-trends-scroll');
    await expect(scroll).toBeVisible({ timeout: 10_000 });
    await expect(scroll).toHaveClass(/scrollbar-thin/);
    const headerPosition = await scroll
      .locator(':scope > div')
      .first()
      .evaluate((el) => getComputedStyle(el).position);
    expect(headerPosition).toBe('sticky');
    await expect(scroll.locator('[data-testid^="resource-row-"]').first()).toBeVisible();
  });
});

test.describe('Account — Open Model Manager button in dark mode', () => {
  test('paints dark text on the inverted-ink pill so it stays readable', async ({ page }) => {
    await page.goto('/#/account');
    // Force the dark theme the same way main.tsx does (data-theme on <html>).
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const button = page.getByTestId('account-model-manager-pointer');
    await expect(button).toBeVisible({ timeout: 10_000 });
    // In dark mode --canvas is near-black, so text-canvas must resolve to a DARK
    // colour. The shipped bug used text-white (near-white) → invisible pill.
    const luminance = await button.evaluate((el) => {
      const rgb = getComputedStyle(el)
        .color.match(/\d+/g)!
        .map(Number);
      return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    });
    expect(luminance).toBeLessThan(80);
  });
});
