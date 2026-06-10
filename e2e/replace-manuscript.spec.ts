/* Replace manuscript golden path — browser-level coverage for the
   "Replace manuscript…" affordance added to the library card menu.

   Flow:
     library landing → "Book options" menu → "Replace manuscript…"
     → set file on the hidden input → confirm destructive dialog
     → assert the "Manuscript replaced" result dialog appears.

   Under VITE_USE_MOCKS=true, api.replaceManuscript resolves immediately
   with { chapterCount: 0, … } so the result dialog body reads
   "Re-detected 0 chapters." We assert on the dialog title only since
   the chapter count is mock-stable. */

import { test, expect } from '@playwright/test';

/* File-level serial mode — mirrors cover-framing.spec.ts and
   cover-picker.spec.ts: menu-open + file-upload flows flake under
   parallel-worker contention on Windows. */
test.describe.configure({ mode: 'serial' });

test.describe('replace manuscript (library card menu)', () => {
  test('menu → pick file → confirm shows replaced dialog', async ({ page }) => {
    /* Library landing — a BookCard is guaranteed under mocks. */
    await page.goto('/');
    await expect(page.getByRole('button', { name: /Start a new book/i })).toBeVisible({
      timeout: 10_000,
    });

    /* Scope all card-level interactions to the first BookCard article.
       There are multiple cards under mocks (and therefore multiple
       replace-manuscript-input instances — one per card), so we must
       scope to one card throughout. */
    const firstCard = page.getByRole('article').first();

    /* Open the per-card "..." menu.  The trigger is opacity-0 by default
       (group-hover reveals it) but is always in the DOM; clicking it works
       in headless Chromium without needing hover. */
    await firstCard.getByRole('button', { name: /Book options/i }).click();

    /* Click "Replace manuscript…" — this calls replaceInputRef.current.click()
       which would ordinarily open a file picker.  Playwright intercepts the
       filechooser instead (we use setInputFiles directly on the hidden input
       below), so we don't need to suppress the native dialog. */
    await page.getByRole('button', { name: 'Replace manuscript…' }).click();

    /* The hidden <input type="file" data-testid="replace-manuscript-input">
       receives the file directly — no click needed, setInputFiles works on
       hidden inputs.  Scoped to the first card so strict mode doesn't see
       the other cards' inputs. */
    await firstCard
      .getByTestId('replace-manuscript-input')
      .setInputFiles({
        name: 'revised.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('## New Chapter\n\nHello.'),
      });

    /* After the file is set, the ConfirmDialog (confirmReplace=true) renders.
       The confirm button text is "Replace manuscript" (no trailing ellipsis).
       Use exact: true to distinguish it from the menu item still in the DOM.
       The ConfirmDialog renders as a plain div (no role="dialog"), so we
       scope by button name only — exact match is sufficient because the menu
       is now closed. */
    await page.getByRole('button', { name: 'Replace manuscript', exact: true }).click();

    /* After confirming, api.replaceManuscript resolves (mock, ~120 ms) and
       showInfo fires with title "Manuscript replaced".  The ConfirmDialog
       info-mode renders it as an h3 inside the result overlay. */
    await expect(page.getByText('Manuscript replaced')).toBeVisible({ timeout: 5_000 });

    /* Optionally confirm the body copy that the mock produces. */
    await expect(page.getByText(/Designed voices were preserved/i)).toBeVisible();
  });
});
