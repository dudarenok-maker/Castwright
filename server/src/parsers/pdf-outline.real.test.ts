import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPdfOutlineTitles } from './pdf.js';

/* srv-26 — un-mocked guard for the pdfjs-dist 5 upgrade.

   pdf.test.ts vi.mock()s `pdfjs-dist/legacy/build/pdf.mjs`, so it would stay
   green even if the real v5 ESM import or worker wiring broke. This spec loads
   a committed fixture PDF (a loose, recovery-mode body with a 2-entry outline)
   through the REAL pdfjs v5 getDocument/getOutline/destroy path, proving the
   import resolves and the outline reads in-process with no worker setup. */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, '__fixtures__', 'outline-sample.pdf'));

describe('readPdfOutlineTitles — real pdfjs-dist v5', () => {
  it('loads a fixture PDF and returns its top-level outline titles', async () => {
    const titles = await readPdfOutlineTitles(fixture);
    expect(titles).toEqual(['The Berth at Liverpool', 'A Manifest Two Names Short']);
  });
});
