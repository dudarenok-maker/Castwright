import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { parsePdf, extractOutlineTitles } from './pdf.js';

/* Un-mocked guard for the pdf-parse 2 + bundled-pdfjs upgrade (deps round 3).

   pdf.test.ts vi.mock()s pdf-parse, so it would stay green even if the real
   v2 ESM import, getText page-joining, or getInfo().outline wiring broke. This
   spec drives the REAL pdf-parse 2 against a committed fixture (a loose,
   recovery-mode body with a 2-entry bookmark outline) to prove:
     1. parsePdf runs end-to-end without throwing,
     2. getText({pageJoiner:''}) does NOT leak the '-- N of M --' page marker
        pdf-parse 2 appends by default (which would pollute chapter detection),
     3. getInfo().outline — the bookmark source extractOutlineTitles consumes,
        now that the separate pdfjs-dist reader is gone — reads the real titles. */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, '__fixtures__', 'outline-sample.pdf'));

describe('real pdf-parse 2 — parsePdf end-to-end', () => {
  it('parses the fixture without crashing and returns a pdf manuscript', async () => {
    const out = await parsePdf(fixture, { fileName: 'outline-sample.pdf' });
    expect(out.format).toBe('pdf');
    expect(out.chapters.length).toBeGreaterThanOrEqual(1);
  });

  it('suppresses pdf-parse 2 default per-page "-- N of M --" markers in the body', async () => {
    const out = await parsePdf(fixture, { fileName: 'outline-sample.pdf' });
    const joined = out.chapters.map((c) => c.body).join('\n');
    expect(joined).not.toMatch(/--\s*\d+\s+of\s+\d+\s*--/);
  });

  it('reads the bookmark outline via getInfo().outline (extractOutlineTitles source)', async () => {
    const parser = new PDFParse({ data: new Uint8Array(fixture) });
    try {
      const { outline } = await parser.getInfo();
      expect(extractOutlineTitles(outline)).toEqual([
        'The Berth at Liverpool',
        'A Manifest Two Names Short',
      ]);
    } finally {
      await parser.destroy();
    }
  });
});
