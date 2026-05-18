/* Plan 58 — binary-upload coverage for EPUB / PDF / MOBI / AZW3.
 *
 * Walks the upload flow once per binary extension to confirm the
 * router's BINARY_EXT_RE branch is wired and the mock upload api
 * routes the parsed candidate into the confirm-metadata view.
 *
 * Under VITE_USE_MOCKS=true the mock api.uploadManuscript accepts any
 * file — it doesn't try to parse it. So we use small dummy buffers
 * with the right extensions to exercise the upload UI's
 * extension-routing seam without needing real MOBI/AZW3 fixtures
 * (those would need Calibre to generate — out of scope here).
 *
 * Pairs with docs/features/58-e2e-coverage-refresh.md +
 * docs/features/archive/52-mobi-parsing.md.
 */

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

const FORMATS: Array<{ ext: 'epub' | 'pdf' | 'mobi' | 'azw3'; mimeType: string }> = [
  { ext: 'epub', mimeType: 'application/epub+zip' },
  { ext: 'pdf', mimeType: 'application/pdf' },
  { ext: 'mobi', mimeType: 'application/x-mobipocket-ebook' },
  { ext: 'azw3', mimeType: 'application/vnd.amazon.ebook' },
];

test.describe('plan 58 — binary upload (mock)', () => {
  for (const { ext, mimeType } of FORMATS) {
    test(`uploads a .${ext} and lands on the confirm-metadata view`, async ({ page }) => {
      await page.goto('/#/new');
      await expect(page).toHaveURL(/#\/new$/);

      /* Locate the hidden file input. The Upload view's <input> has
         accept="...,.{ext}" — the browser DOES enforce accept on file
         pickers, but setInputFiles bypasses that to simulate a drag-
         drop drop. We submit a tiny dummy buffer with the right
         extension; the mock api routes purely on file.name. */
      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles({
        name: `sample.${ext}`,
        mimeType,
        // Non-empty buffer so the mock upload's byteSize > 0.
        buffer: Buffer.from('binary fixture content for plan 58 e2e'),
      });

      /* Mock-mode handleFile → guardedUpload → setImportCandidate →
         UploadRoute swaps in the confirm-metadata view. Same URL
         (#/new), different view. Assert the submit button visible. */
      await expect(page.getByRole('button', { name: /Save book and start analysis/i })).toBeVisible(
        { timeout: 5_000 },
      );
    });
  }
});
