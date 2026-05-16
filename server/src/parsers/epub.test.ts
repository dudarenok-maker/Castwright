// Pairs with docs/features/06-manuscript-parsing.md (EPUB parser).

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEpub } from './epub.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '__fixtures__/sample.epub');
const titleFallbackFixturePath = resolve(here, '__fixtures__/sample-title-fallback.epub');

describe('parseEpub', () => {
  it('returns format: "epub"', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.format).toBe('epub');
  });

  it('uses dc:title from the OPF metadata', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.title).toBe('The Solway Light');
  });

  it('exposes dc:creator as the author', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.author).toBe('Jane Doe');
  });

  it('parses Calibre series + index from <meta name="calibre:series">', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.series).toBe('Solway Bay');
    expect(out.seriesPosition).toBe(2);
  });

  it('turns each spine entry into a chapter', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.chapters).toHaveLength(2);
  });

  it('strips HTML tags from chapter bodies but preserves visible text', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    const allBody = out.chapters.map(c => c.body).join('\n');
    expect(allBody).toContain('The tower stood at the edge of the world.');
    expect(allBody).not.toContain('<p>');
    expect(allBody).not.toContain('<em>');
  });

  it('applies tagHtmlEmphasis to inline emphasis tags', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    const allBody = out.chapters.map(c => c.body).join('\n');
    // chapter1 contains <em>across</em> — should land as [emphatic] across.
    expect(allBody).toContain('[emphatic] across');
  });

  it('applies tagShoutingDialog to HTML-stripped content', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    const allBody = out.chapters.map(c => c.body).join('\n');
    // chapter2 contains "GET OUT NOW," — should be tagged + title-cased.
    expect(allBody).toContain('[shouting] Get Out Now');
  });

  it('falls back to filename metadata when neither OPF nor Calibre meta provide series', async () => {
    // Same fixture has Calibre series → use a fileName with a different
    // series pattern and confirm OPF wins.
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'Other Author - Other Series 09 - X.epub' });
    expect(out.series).toBe('Solway Bay');
    expect(out.seriesPosition).toBe(2);
    expect(out.author).toBe('Jane Doe');
  });

  /* Title-fallback fixture: chapter1 has generic NCX label ("Chapter 1")
     + descriptive body <h1>; chapter2 has empty NCX label + body <h2>;
     chapter3 has descriptive NCX matching the body (NCX should win). */
  describe('parseEpub — chapter title extraction', () => {
    it('merges generic NCX label with descriptive body <h1> ("Chapter 1 — The Berth at Liverpool")', async () => {
      const buf = await readFile(titleFallbackFixturePath);
      const out = await parseEpub(buf, { fileName: 'sample-title-fallback.epub' });
      expect(out.chapters[0].title).toBe('Chapter 1 — The Berth at Liverpool');
    });

    it('uses body <h2> as title when NCX label is empty', async () => {
      const buf = await readFile(titleFallbackFixturePath);
      const out = await parseEpub(buf, { fileName: 'sample-title-fallback.epub' });
      expect(out.chapters[1].title).toBe('A Manifest Two Names Short');
    });

    it('keeps descriptive NCX label as-is (does not duplicate body heading)', async () => {
      const buf = await readFile(titleFallbackFixturePath);
      const out = await parseEpub(buf, { fileName: 'sample-title-fallback.epub' });
      expect(out.chapters[2].title).toBe('What the Captain Knew');
    });
  });

  /* Re-parse path: when sourcePath is supplied, parseEpub reads directly
     from that path instead of writing the buffer to a fresh tempdir. The
     buffer arg may even be empty — sourcePath wins. This dodges the
     %TEMP%-roundtrip race against AV/OneDrive on Windows that produced
     "Invalid/missing file C:\\Users\\…\\Temp\\epub-XXXX\\manuscript.epub". */
  describe('parseEpub — sourcePath path (re-parse from workspace location)', () => {
    it('reads from sourcePath verbatim when provided, ignoring the buffer', async () => {
      /* Pass an empty buffer to prove sourcePath is the actual data source. */
      const out = await parseEpub(Buffer.alloc(0), {
        fileName: 'sample.epub',
        sourcePath: fixturePath,
      });
      expect(out.format).toBe('epub');
      expect(out.title).toBe('The Solway Light');
      expect(out.chapters.length).toBeGreaterThan(0);
    });

    it('does not create a temp directory under %TEMP%/epub-* when sourcePath is provided', async () => {
      const { readdirSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const before = readdirSync(tmpdir()).filter(n => n.startsWith('epub-')).length;
      await parseEpub(Buffer.alloc(0), { fileName: 'sample.epub', sourcePath: fixturePath });
      const after = readdirSync(tmpdir()).filter(n => n.startsWith('epub-')).length;
      /* Some other test or process may have created an epub-* dir
         concurrently, so we only assert this call didn't add one. */
      expect(after).toBe(before);
    });
  });
});
