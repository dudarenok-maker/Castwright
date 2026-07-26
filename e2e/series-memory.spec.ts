/* Golden-path e2e for the series-memory feature (fe-40).
 *
 * Exercises: library → series-memory chip → reveal dialog →
 * "Share this cast" → share card.
 *
 * Mock mode (port 5174) — the "Northern Coast Trilogy" series in
 * MOCK_LIBRARY carries a `seriesMemory` summary, and
 * MOCK_SERIES_MEMORY["Marin Vale::Northern Coast Trilogy"] supplies the
 * detail payload that the reveal dialog fetches via api.getSeriesMemory.
 */

import { test, expect } from '@playwright/test';

test.describe('series-memory: chip → reveal → share card', () => {
  test('library shows chip, chip opens reveal, reveal shows headline, share card contains castwright.ai', async ({
    page,
  }) => {
    await page.goto('/');

    /* Wait for the library to hydrate — "Start a new book" CTA is the
       standard hydration signal (matches waitForLibraryViewReady). */
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });

    /* The series-memory chip renders in the Northern Coast Trilogy series
       row. Playwright auto-scrolls to visible elements, so no manual
       scrollIntoView is needed — but give the chip a 10 s budget to
       account for cold-load contention. */
    const chip = page.getByTestId('series-memory-chip').first();
    await expect(chip).toBeVisible({ timeout: 10_000 });

    /* Chip copy: "Your cast · N voices, N books" */
    await expect(chip).toContainText('Your cast ·');

    /* Click the chip — opens the series-memory reveal dialog. */
    await chip.click();

    /* The reveal renders as a role="dialog". */
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    /* Headline: "{spell(bookCount)} books in, and the cast carries through."
       bookCount = 3 → "Three books in, and the cast carries through." */
    await expect(dialog.getByText(/the cast carries through/i)).toBeVisible({ timeout: 5_000 });

    /* "Share this cast" button is inside the reveal. */
    await dialog.getByText('Share this cast').click();

    /* Share card appears (series-share-card.tsx). */
    const shareCard = page.getByTestId('series-share-card');
    await expect(shareCard).toBeVisible({ timeout: 5_000 });

    /* Footer of the share card carries the branding. */
    await expect(shareCard.getByText('castwright.ai')).toBeVisible();
  });

  test('share card exports a PNG download', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('series-memory-chip').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByText('Share this cast').click();
    await expect(page.getByTestId('series-share-card')).toBeVisible({ timeout: 5_000 });

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /download image \(\.png\)/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
  });
});

/* The pinned-dark accent (see --color-magenta-on-dark in src/styles.css).
 *
 * These surfaces hardcode a #1b1714 background that never follows the app
 * theme, but their accent used to resolve through the theme-flipping
 * --magenta. On the light theme that gave #A43C6C — 2.9:1 on that surface,
 * failing WCAG AA as text — and the share card is EXPORTED as a PNG, so a
 * light-theme user shipped the low-contrast version to wherever the card
 * travelled.
 *
 * Asserting "identical across themes" rather than a literal is the point: the
 * bug wasn't a wrong colour, it was a colour that moved when the surface it
 * sat on didn't. A jsdom test can't catch this — the tokens only resolve in a
 * real engine. */
test.describe('series-memory: pinned-dark surfaces do not follow the app theme', () => {
  const RELATIVE_LUMINANCE = (rgb: string) => {
    const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map(Number);
    const lin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [RELATIVE_LUMINANCE(a), RELATIVE_LUMINANCE(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  async function sampleCard(page: import('@playwright/test').Page) {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i }).first()).toBeVisible({
      timeout: 10_000,
    });
    await page.getByTestId('series-memory-chip').first().click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 5_000 });
    await page.getByText('Share this cast').click();
    const card = page.getByTestId('series-share-card');
    await expect(card).toBeVisible({ timeout: 5_000 });
    return card.evaluate((el) => ({
      surface: getComputedStyle(el).backgroundColor,
      // The "Series memory · <name>" label — the accent as text.
      accent: getComputedStyle(el.querySelector('p')!).color,
    }));
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`the exported card's accent clears WCAG AA on the ${scheme} theme`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const { surface, accent } = await sampleCard(page);
      expect(contrast(accent, surface)).toBeGreaterThanOrEqual(4.5);
    });
  }

  test('the card renders identically whichever theme the app is on', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await sampleCard(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await sampleCard(page);
    expect(light).toEqual(dark);
  });
});
