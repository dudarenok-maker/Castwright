// Pairs with docs/features/archive/116-epub-parsing.md (EPUB parser).

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEpub, UnusableEpubError } from './epub.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '__fixtures__/sample.epub');
const titleFallbackFixturePath = resolve(here, '__fixtures__/sample-title-fallback.epub');
const seriesFromTitleFixturePath = resolve(here, '__fixtures__/sample-title-no-calibre.epub');
const opfPrefixedFixturePath = resolve(here, '__fixtures__/sample-opf-prefixed.epub');
const opfPrefixedTitlesFixturePath = resolve(here, '__fixtures__/sample-opf-prefixed-titles.epub');
const drmFixturePath = resolve(here, '__fixtures__/sample-epub-drm.epub');
const imageOnlyFixturePath = resolve(here, '__fixtures__/sample-epub-image-only.epub');

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
    /* Authoritative Calibre meta wins — heuristic flag stays false. */
    expect(out.seriesFromTitle).toBe(false);
  });

  /* Bug B regression: EPUB with `dc:title` = "The Tidewatcher’s Oath (The Hollow
     Tide Book 3)" and NO Calibre series tags. The parser should
     split the parenthetical off and populate series + seriesPosition
     from the heuristic, and mark `seriesFromTitle: true`. */
  describe('parseEpub — series-from-title fallback when Calibre meta absent', () => {
    it('extracts series + position from the dc:title parenthetical', async () => {
      const buf = await readFile(seriesFromTitleFixturePath);
      const out = await parseEpub(buf, { fileName: 'sample-title-no-calibre.epub' });
      expect(out.title).toBe('The Tidewatcher’s Oath');
      expect(out.series).toBe('The Hollow Tide');
      expect(out.seriesPosition).toBe(3);
      expect(out.seriesFromTitle).toBe(true);
    });
  });

  it('turns each spine entry into a chapter', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.chapters).toHaveLength(2);
  });

  it('strips HTML tags from chapter bodies but preserves visible text', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    const allBody = out.chapters.map((c) => c.body).join('\n');
    expect(allBody).toContain('The tower stood at the edge of the world.');
    expect(allBody).not.toContain('<p>');
    expect(allBody).not.toContain('<em>');
  });

  it('applies tagHtmlEmphasis to inline emphasis tags', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    const allBody = out.chapters.map((c) => c.body).join('\n');
    // chapter1 contains <em>across</em> — should land as [emphatic] across.
    expect(allBody).toContain('[emphatic] across');
  });

  it('applies tagShoutingDialog to HTML-stripped content', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    const allBody = out.chapters.map((c) => c.body).join('\n');
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
      const before = readdirSync(tmpdir()).filter((n) => n.startsWith('epub-')).length;
      await parseEpub(Buffer.alloc(0), { fileName: 'sample.epub', sourcePath: fixturePath });
      const after = readdirSync(tmpdir()).filter((n) => n.startsWith('epub-')).length;
      /* Some other test or process may have created an epub-* dir
         concurrently, so we only assert this call didn't add one. */
      expect(after).toBe(before);
    });
  });
});

/* Regression: namespace-prefixed OPF (plan 116). Publisher EPUBs (e.g. Simon
   & Schuster's "The Drowning Bell") namespace every package element with an `opf:`
   prefix (`<opf:manifest>`, `<opf:item>`, `<opf:spine>`, `<opf:itemref>`).
   epub2's manifest/spine walker only recognises UNPREFIXED names, so the
   primary path extracts zero chapters and — before this fix — threw "EPUB had
   no extractable text in its spine." (HTTP 500). The yauzl-based raw-zip
   fallback recovers the text. Chapters in this fixture live at
   OEBPS/text/chapterN.xhtml (deeper than the OPF) to exercise
   href-relative-to-OPF-dir resolution. */
describe('parseEpub — namespace-prefixed OPF fallback (raw-zip parser)', () => {
  it('recovers chapters epub2 cannot walk', async () => {
    const buf = await readFile(opfPrefixedFixturePath);
    const out = await parseEpub(buf, { fileName: 'sample-opf-prefixed.epub' });
    expect(out.format).toBe('epub');
    expect(out.chapters.length).toBe(2);
    const allBody = out.chapters.map((c) => c.body).join('\n');
    expect(allBody).toContain('The tower stood at the edge of the world.');
  });

  it('carries metadata + Calibre series through the fallback', async () => {
    const buf = await readFile(opfPrefixedFixturePath);
    const out = await parseEpub(buf, { fileName: 'sample-opf-prefixed.epub' });
    expect(out.title).toBe('The Solway Light');
    expect(out.author).toBe('Jane Doe');
    expect(out.series).toBe('Solway Bay');
    expect(out.seriesPosition).toBe(2);
    expect(out.seriesFromTitle).toBe(false);
  });

  it('runs the same audio-tag pipeline as the primary path', async () => {
    const buf = await readFile(opfPrefixedFixturePath);
    const out = await parseEpub(buf, { fileName: 'sample-opf-prefixed.epub' });
    const allBody = out.chapters.map((c) => c.body).join('\n');
    expect(allBody).toContain('[emphatic] across');
    expect(allBody).toContain('[shouting] Get Out Now');
  });

  it('reads from sourcePath verbatim (re-parse path) without a temp dir', async () => {
    const { readdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('epub-')).length;
    const out = await parseEpub(Buffer.alloc(0), {
      fileName: 'sample-opf-prefixed.epub',
      sourcePath: opfPrefixedFixturePath,
    });
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith('epub-')).length;
    expect(out.chapters.length).toBe(2);
    expect(after).toBe(before);
  });
});

/* srv-13: the raw-zip fallback now reads chapter titles from the NCX navMap
   (parity with the epub2 path), not just the body <h1>. This prefixed-OPF
   fixture carries the same three NCX-vs-body scenarios as the unprefixed
   sample-title-fallback.epub, so the fallback must produce identical titles.
   The merged "Chapter 1 — …" title is only reachable if the NCX was parsed —
   body headings alone would yield "The Berth at Liverpool". */
describe('parseEpub — NCX titles through the raw-zip fallback (srv-13)', () => {
  it('merges generic NCX label with descriptive body <h1>', async () => {
    const buf = await readFile(opfPrefixedTitlesFixturePath);
    const out = await parseEpub(buf, { fileName: 'sample-opf-prefixed-titles.epub' });
    expect(out.chapters[0].title).toBe('Chapter 1 — The Berth at Liverpool');
  });

  it('uses body <h2> as title when the NCX label is empty', async () => {
    const buf = await readFile(opfPrefixedTitlesFixturePath);
    const out = await parseEpub(buf, { fileName: 'sample-opf-prefixed-titles.epub' });
    expect(out.chapters[1].title).toBe('A Manifest Two Names Short');
  });

  it('keeps a descriptive NCX label as-is', async () => {
    const buf = await readFile(opfPrefixedTitlesFixturePath);
    const out = await parseEpub(buf, { fileName: 'sample-opf-prefixed-titles.epub' });
    expect(out.chapters[2].title).toBe('What the Captain Knew');
  });

  it('matches the titles the epub2 path produces for the unprefixed equivalent', async () => {
    const [prefixed, plain] = await Promise.all([
      readFile(opfPrefixedTitlesFixturePath),
      readFile(titleFallbackFixturePath),
    ]);
    const fromFallback = await parseEpub(prefixed, {
      fileName: 'sample-opf-prefixed-titles.epub',
    });
    const fromEpub2 = await parseEpub(plain, { fileName: 'sample-title-fallback.epub' });
    expect(fromFallback.chapters.map((c) => c.title)).toEqual(
      fromEpub2.chapters.map((c) => c.title),
    );
  });
});

/* Regression: when even the fallback finds no extractable text, parseEpub
   throws UnusableEpubError (mapped to HTTP 415 by the route) with a classified
   message rather than the cryptic generic. */
describe('parseEpub — unusable-EPUB diagnostics', () => {
  it('reports DRM when META-INF/encryption.xml is present', async () => {
    const buf = await readFile(drmFixturePath);
    await expect(parseEpub(buf, { fileName: 'sample-epub-drm.epub' })).rejects.toThrow(
      UnusableEpubError,
    );
    await expect(parseEpub(buf, { fileName: 'sample-epub-drm.epub' })).rejects.toThrow(/DRM/i);
  });

  it('reports image-only when spine docs resolve but hold no text', async () => {
    const buf = await readFile(imageOnlyFixturePath);
    await expect(parseEpub(buf, { fileName: 'sample-epub-image-only.epub' })).rejects.toThrow(
      UnusableEpubError,
    );
    await expect(parseEpub(buf, { fileName: 'sample-epub-image-only.epub' })).rejects.toThrow(
      /image-only/i,
    );
  });
});
