/* Plan 58 — binary-upload coverage for EPUB / PDF / MOBI / AZW3.
 * Plan 60 — MOBI/AZW3 cases load REAL Calibre-generated fixtures.
 *
 * Walks the upload flow once per binary extension to confirm the
 * router's BINARY_EXT_RE branch is wired and the mock upload api
 * routes the parsed candidate into the confirm-metadata view.
 *
 * Under VITE_USE_MOCKS=true the mock api.uploadManuscript accepts any
 * file — it doesn't try to parse it. EPUB + PDF use small dummy buffers
 * (the upload UI's extension-routing seam is what we're locking).
 *
 * MOBI + AZW3 load the real Calibre-generated fixtures from
 * server/src/parsers/__fixtures__/ when present. Calibre is a
 * per-developer install (`scripts/gen-parser-fixtures.mjs` writes the
 * fixtures when `ebook-convert` is on PATH); when the fixtures are
 * missing the cases skip with a clear "Calibre required" message so a
 * fresh-clone dev environment still passes `npm run verify`. The
 * strongest real-parser assertion lives in the server-side Vitest
 * spec at `server/src/parsers/mobi-real-fixtures.test.ts` — that suite
 * also skips when the fixtures are absent.
 *
 * Pairs with docs/features/archive/66-real-binary-parser-fixtures.md +
 * docs/features/archive/58-e2e-coverage-refresh.md +
 * docs/features/archive/52-mobi-parsing.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { waitForRouteReady } from './helpers';

test.describe.configure({ mode: 'serial' });

const here = dirname(fileURLToPath(import.meta.url));
const mobiFixturePath = resolve(here, '../server/src/parsers/__fixtures__/sample.mobi');
const azw3FixturePath = resolve(here, '../server/src/parsers/__fixtures__/sample.azw3');

interface FormatCase {
  ext: 'epub' | 'pdf' | 'mobi' | 'azw3';
  mimeType: string;
  /* When present, load the real Calibre-generated fixture from disk
     instead of synthesising a dummy buffer. The case skips cleanly
     when the path doesn't exist — Calibre is a per-developer install. */
  realFixturePath?: string;
}

const FORMATS: FormatCase[] = [
  { ext: 'epub', mimeType: 'application/epub+zip' },
  { ext: 'pdf', mimeType: 'application/pdf' },
  { ext: 'mobi', mimeType: 'application/x-mobipocket-ebook', realFixturePath: mobiFixturePath },
  { ext: 'azw3', mimeType: 'application/vnd.amazon.ebook', realFixturePath: azw3FixturePath },
];

test.describe('plan 58 — binary upload (mock)', () => {
  for (const { ext, mimeType, realFixturePath } of FORMATS) {
    test(`uploads a .${ext} and lands on the confirm-metadata view`, async ({ page }) => {
      /* Plan 60 — when the case is real-fixture-backed but Calibre
         hasn't been run on this machine, skip with a clear message
         rather than fall back to a dummy buffer. The dummy-buffer
         path was the plan 58 default; plan 60 raises the bar to real
         binaries (which then exercise the parser's magic-byte +
         PalmDOC-header detection in any future real-api swap). */
      if (realFixturePath && !existsSync(realFixturePath)) {
        test.skip(
          true,
          `Calibre required for real ${ext.toUpperCase()} fixture — run ` +
            `\`node scripts/gen-parser-fixtures.mjs\` after installing Calibre ` +
            `(https://calibre-ebook.com/download).`,
        );
        return;
      }

      await page.goto('/#/new');
      await waitForRouteReady(page);
      await expect(page).toHaveURL(/#\/new$/);

      /* Locate the hidden file input. The Upload view's <input> has
         accept="...,.{ext}" — the browser DOES enforce accept on file
         pickers, but setInputFiles bypasses that to simulate a drag-
         drop drop. The buffer is either the real Calibre-generated
         binary (MOBI/AZW3) or a tiny synthetic dummy (EPUB/PDF). */
      const fileInput = page.locator('input[type="file"]');
      const buffer = realFixturePath
        ? readFileSync(realFixturePath)
        : Buffer.from('binary fixture content for plan 58 e2e');
      await fileInput.setInputFiles({
        name: `sample.${ext}`,
        mimeType,
        buffer,
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
