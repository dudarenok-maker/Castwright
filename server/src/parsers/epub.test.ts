// Pairs with docs/features/archive/116-epub-parsing.md (EPUB parser).

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import {
  buildEmptyHrefEpub,
  buildEpub,
  buildSingleChapterEpub,
  PARITY_CHAPTER_XHTML,
  PARITY_NAV_LABEL,
} from '../test-utils/empty-href-epub.js';
import { parseEpub, UnusableEpubError, decodeEntities, decodeXmlEntities, mergeChapterTitle } from './epub.js';

const { mkdtempSpy } = vi.hoisted(() => ({ mkdtempSpy: vi.fn() }));

/* #2100 — the "no temp dir created when sourcePath is provided" tests need
   to observe whether parseEpub CALLS mkdtemp, not whether a directory is
   left behind afterward: parseEpub's own `finally` removes any tempdir it
   creates before returning, so scanning the filesystem post-call (even a
   directory the test privately owns, scoped away from the shared %TEMP%
   namespace) can only ever detect a LEAKED tempdir — create AND skip
   cleanup, a two-part mutation — not the one-part defect this test exists
   to catch (create a tempdir at all on the sourcePath path). Spying on
   mkdtemp observes the call directly; everything else passes through to
   the real implementation unchanged. */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdtemp: (...args: Parameters<typeof actual.mkdtemp>) => {
      mkdtempSpy(...args);
      return actual.mkdtemp(...args);
    },
  };
});

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
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample.epub' });
    expect(out.format).toBe('epub');
  });

  it('neutralizes a traversal upload filename (basenamed, stays in temp dir)', async () => {
    const buf = await readFile(fixturePath);
    // `../../evil.epub` -> basename `evil.epub` -> safeSegment passes -> parses normally,
    // never writing outside the mkdtemp dir.
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: '../../evil.epub' });
    expect(out.format).toBe('epub');
  });

  it('decodeEntities decodes &amp; last (no double-unescaping)', () => {
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&amp;amp;lt;')).toBe('&amp;lt;');
  });

  /* #2310: decodeEntities now shares stripHtml's rules — decodeNamedEntities
     runs before decodeNumericEntities. That reorders this specific case:
     the named pass decodes `&amp;` to `&` first, turning `&amp;#39;` into
     `&#39;`, and the numeric pass that follows then decodes THAT to `'`.
     Previously this returned the literal `&#39;` — no named pass ran ahead
     of the numeric one to expose it. Deliberate consequence of sharing
     stripHtml's rules; pinned at its actual new value since the retained
     case above (`&amp;amp;lt;`) never reaches this reordering. */
  it('#2310: decodeEntities on &amp;#39; now fully decodes (named-before-numeric reorder)', () => {
    expect(decodeEntities('&amp;#39;')).toBe("'");
  });

  it('#2310: decodeEntities decodes the full named set (titles carry them too)', () => {
    expect(decodeEntities('L&rsquo;&Eacute;t&eacute; &mdash; Tome I')).toBe('L’Été — Tome I');
  });
  it('#2310: decodeEntities decodes hex numeric refs (the Coalfall gap, never fixed here)', () => {
    expect(decodeEntities("Oduvan&#x27;s Forge")).toBe("Oduvan's Forge");
  });
  it('#2310: decodeEntities leaves a bare ampersand alone', () => {
    expect(decodeEntities('Smith &amp; Sons, AT&T')).toBe('Smith & Sons, AT&T');
  });

  it('uses dc:title from the OPF metadata', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample.epub' });
    expect(out.title).toBe('The Solway Light');
  });

  it('exposes dc:creator as the author', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample.epub' });
    expect(out.author).toBe('Jane Doe');
  });

  it('parses Calibre series + index from <meta name="calibre:series">', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample.epub' });
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
      const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-title-no-calibre.epub' });
      expect(out.title).toBe('The Tidewatcher’s Oath');
      expect(out.series).toBe('The Hollow Tide');
      expect(out.seriesPosition).toBe(3);
      expect(out.seriesFromTitle).toBe(true);
    });
  });

  it('turns each spine entry into a chapter', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample.epub' });
    expect(out.chapters).toHaveLength(2);
  });

  it('strips HTML tags from chapter bodies but preserves visible text', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample.epub' });
    const allBody = out.chapters.map((c) => c.body).join('\n');
    expect(allBody).toContain('The tower stood at the edge of the world.');
    expect(allBody).not.toContain('<p>');
    expect(allBody).not.toContain('<em>');
  });

  it('applies tagHtmlEmphasis to inline emphasis tags', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample.epub' });
    const allBody = out.chapters.map((c) => c.body).join('\n');
    // chapter1 contains <em>across</em> — should land as [emphatic] across.
    expect(allBody).toContain('[emphatic] across');
  });

  it('applies tagShoutingDialog to HTML-stripped content', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample.epub' });
    const allBody = out.chapters.map((c) => c.body).join('\n');
    // chapter2 contains "GET OUT NOW," — should be tagged + title-cased.
    expect(allBody).toContain('[shouting] Get Out Now');
  });

  it('falls back to filename metadata when neither OPF nor Calibre meta provide series', async () => {
    // Same fixture has Calibre series → use a fileName with a different
    // series pattern and confirm OPF wins.
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'Other Author - Other Series 09 - X.epub' });
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
      const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-title-fallback.epub' });
      expect(out.chapters[0].title).toBe('Chapter 1 — The Berth at Liverpool');
    });

    it('uses body <h2> as title when NCX label is empty', async () => {
      const buf = await readFile(titleFallbackFixturePath);
      const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-title-fallback.epub' });
      expect(out.chapters[1].title).toBe('A Manifest Two Names Short');
    });

    it('keeps descriptive NCX label as-is (does not duplicate body heading)', async () => {
      const buf = await readFile(titleFallbackFixturePath);
      const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-title-fallback.epub' });
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
      const out = await parseEpub(Buffer.alloc(0), { extractorVersion: 1,
        fileName: 'sample.epub',
        sourcePath: fixturePath,
      });
      expect(out.format).toBe('epub');
      expect(out.title).toBe('The Solway Light');
      expect(out.chapters.length).toBeGreaterThan(0);
    });

    it('does not create a temp directory under %TEMP%/epub-* when sourcePath is provided', async () => {
      mkdtempSpy.mockClear();
      await parseEpub(Buffer.alloc(0), { extractorVersion: 1, fileName: 'sample.epub', sourcePath: fixturePath });
      expect(mkdtempSpy).not.toHaveBeenCalled();
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
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-opf-prefixed.epub' });
    expect(out.format).toBe('epub');
    expect(out.chapters.length).toBe(2);
    const allBody = out.chapters.map((c) => c.body).join('\n');
    expect(allBody).toContain('The tower stood at the edge of the world.');
  });

  it('carries metadata + Calibre series through the fallback', async () => {
    const buf = await readFile(opfPrefixedFixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-opf-prefixed.epub' });
    expect(out.title).toBe('The Solway Light');
    expect(out.author).toBe('Jane Doe');
    expect(out.series).toBe('Solway Bay');
    expect(out.seriesPosition).toBe(2);
    expect(out.seriesFromTitle).toBe(false);
  });

  it('runs the same audio-tag pipeline as the primary path', async () => {
    const buf = await readFile(opfPrefixedFixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-opf-prefixed.epub' });
    const allBody = out.chapters.map((c) => c.body).join('\n');
    expect(allBody).toContain('[emphatic] across');
    expect(allBody).toContain('[shouting] Get Out Now');
  });

  it('reads from sourcePath verbatim (re-parse path) without a temp dir', async () => {
    mkdtempSpy.mockClear();
    const out = await parseEpub(Buffer.alloc(0), { extractorVersion: 1,
      fileName: 'sample-opf-prefixed.epub',
      sourcePath: opfPrefixedFixturePath,
    });
    expect(out.chapters.length).toBe(2);
    expect(mkdtempSpy).not.toHaveBeenCalled();
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
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-opf-prefixed-titles.epub' });
    expect(out.chapters[0].title).toBe('Chapter 1 — The Berth at Liverpool');
  });

  it('uses body <h2> as title when the NCX label is empty', async () => {
    const buf = await readFile(opfPrefixedTitlesFixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-opf-prefixed-titles.epub' });
    expect(out.chapters[1].title).toBe('A Manifest Two Names Short');
  });

  it('keeps a descriptive NCX label as-is', async () => {
    const buf = await readFile(opfPrefixedTitlesFixturePath);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'sample-opf-prefixed-titles.epub' });
    expect(out.chapters[2].title).toBe('What the Captain Knew');
  });

  it('matches the titles the epub2 path produces for the unprefixed equivalent', async () => {
    const [prefixed, plain] = await Promise.all([
      readFile(opfPrefixedTitlesFixturePath),
      readFile(titleFallbackFixturePath),
    ]);
    const fromFallback = await parseEpub(prefixed, { extractorVersion: 1,
      fileName: 'sample-opf-prefixed-titles.epub',
    });
    const fromEpub2 = await parseEpub(plain, { extractorVersion: 1, fileName: 'sample-title-fallback.epub' });
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
    await expect(parseEpub(buf, { extractorVersion: 1, fileName: 'sample-epub-drm.epub' })).rejects.toThrow(
      UnusableEpubError,
    );
    await expect(parseEpub(buf, { extractorVersion: 1, fileName: 'sample-epub-drm.epub' })).rejects.toThrow(/DRM/i);
  });

  it('reports image-only when spine docs resolve but hold no text', async () => {
    const buf = await readFile(imageOnlyFixturePath);
    await expect(parseEpub(buf, { extractorVersion: 1, fileName: 'sample-epub-image-only.epub' })).rejects.toThrow(
      UnusableEpubError,
    );
    await expect(parseEpub(buf, { extractorVersion: 1, fileName: 'sample-epub-image-only.epub' })).rejects.toThrow(
      /image-only/i,
    );
  });
});

describe('mergeChapterTitle — titleSynthesized (#3628)', () => {
  it('flags the made-up "Chapter N" when there is no NCX label and no body heading', () => {
    expect(mergeChapterTitle('', null, 3)).toEqual({ title: 'Chapter 3', synthesized: true });
  });

  it('does not flag a generic NCX label such as "Chapter 1"', () => {
    expect(mergeChapterTitle('Chapter 1', null, 1)).toEqual({
      title: 'Chapter 1',
      synthesized: false,
    });
  });

  it('does not flag an empty NCX label that falls back to a body heading', () => {
    expect(mergeChapterTitle('', 'The Berth', 2)).toEqual({
      title: 'The Berth',
      synthesized: false,
    });
  });

  it('does not flag a generic NCX label merged with a descriptive body heading', () => {
    expect(mergeChapterTitle('Chapter 1', 'The Berth', 1)).toEqual({
      title: 'Chapter 1 — The Berth',
      synthesized: false,
    });
  });
});

/* #3628 — call-site wiring: parseEpub must put `titleSynthesized` on the chapters
   it makes up a title for, on both parse paths (epub2 and the raw-zip fallback).
   The pure mergeChapterTitle tests above cannot see a dropped spread. */
describe('parseEpub — titleSynthesized wiring (#3628)', () => {
  function buildEpub(prefixed: boolean): Promise<Buffer> {
    return new Promise((resolveBuf, reject) => {
      const zip = new ZipFile();
      const p = prefixed ? 'opf:' : '';
      zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', { compress: false });
      zip.addBuffer(
        Buffer.from(
          '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        ),
        'META-INF/container.xml',
      );
      zip.addBuffer(
        Buffer.from(
          `<?xml version="1.0"?><${p}package xmlns${prefixed ? ':opf' : ''}="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><${p}metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:creator>A</dc:creator><dc:identifier id="id">x</dc:identifier><dc:language>en</dc:language></${p}metadata><${p}manifest><${p}item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><${p}item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></${p}manifest><${p}spine><${p}itemref idref="c1"/><${p}itemref idref="c2"/></${p}spine></${p}package>`,
        ),
        'content.opf',
      );
      const doc = (inner: string) =>
        `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${inner}</body></html>`;
      zip.addBuffer(Buffer.from(doc('<p>Just some prose here.</p>')), 'c1.xhtml');
      zip.addBuffer(Buffer.from(doc('<h1>Real Heading</h1><p>More prose here.</p>')), 'c2.xhtml');
      zip.end();
      const chunks: Buffer[] = [];
      zip.outputStream
        .on('data', (c: Buffer) => chunks.push(c))
        .on('end', () => resolveBuf(Buffer.concat(chunks)))
        .on('error', reject);
    });
  }

  for (const [label, prefixed] of [
    ['epub2 path', false],
    ['raw-zip path (namespace-prefixed OPF)', true],
  ] as const) {
    it(`${label}: flags the chapter with no heading, not the one with a heading`, async () => {
      const out = await parseEpub(await buildEpub(prefixed), { extractorVersion: 1, fileName: 'x.epub' });
      expect(out.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Real Heading']);
      expect(out.chapters[0].titleSynthesized).toBe(true);
      expect('titleSynthesized' in out.chapters[1]).toBe(false);
    });
  }
});

/* #4239 — epub2's getChapter rewrites every `href` inside a zip callback and
   throws `linkparts.shift is not a function` on `<a href="">`. A throw there
   is an uncaughtException no await can catch, which kills the server. The
   parser runs getChapter's transform over the raw text in its own stack, where
   the throw is catchable; when it throws, the whole book goes to the raw-zip
   reader, the same path the older code took whenever the throw was catchable. */
describe('parseEpub — empty href does not crash (#4239)', () => {
  it('parses a chapter containing <a href=""> instead of throwing out of a zip callback', async () => {
    const buf = await buildEmptyHrefEpub();
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'empty-href.epub' });
    expect(out.chapters).toHaveLength(1);
    /* Exact, so the fallback's body trimming is pinned: the <title>x</title> in
       the head must not lead the prose. */
    expect(out.chapters[0].body).toBe('Some prose with an empty link in it.');
  });
});

/* #4239 — books that imported fine before must extract byte-identically: the
   sentence offsets persisted for them derive from this text. The expected
   strings are what the pre-#4239 getChapter path produced for this fixture
   (generated by running the merge-base parser over it). The fixture's heading
   markup is 397 chars raw and 413 once rewritten, and its navLabel is generic,
   so a raw-text path (htmlBodyOnly for every chapter) gives a different title
   and body — this pins that a book with no throwing chapter keeps getChapter's
   text. */
describe('parseEpub — getChapter parity (#4239)', () => {
  it('keeps getChapter output for U+2029, `on…=` prose and a length-bounded heading', async () => {
    const buf = await buildSingleChapterEpub(PARITY_CHAPTER_XHTML, PARITY_NAV_LABEL);
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'parity.epub' });
    expect(out.chapters).toHaveLength(1);
    // The head <title> leads (U+2029 defeats getChapter's body regex), the prose
    // reads `skip-one` (handler rewrite), the heading stays in the body and the
    // title stays the NCX label (the rewritten href pushes it past the bound).
    expect(out.chapters[0].title).toBe('Chapter 3');
    expect(out.chapters[0].body).toBe(
      'Head Title Text\n\nChapter 3\nSUBTITLE[4]\nFirst line\u2029second line.\n\nEven skip-one = better than none.',
    );
  });
});

/* #4239 — with STORED zip entries adm-zip answers a chapter read synchronously,
   so on the older code epub2's `<a href="">` throw was already catchable: it
   rejected the epub2 walk and the whole book went to the raw-zip reader. A
   book like that must keep reading that way — chapter 2 here is extracted with
   no getChapter quirks (no head <title> lead, no `on…=` rewrite). */
describe('parseEpub — a throwing chapter sends the whole book to the raw-zip reader (#4239)', () => {
  it('reads a stored two-chapter book the way the older fallback did', async () => {
    const quirk =
      '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>Head Title Text</title></head>\n<body>\n' +
      '<h1>Chapter 2</h1>\n<p>First line\u2029second line.</p>\n<p>Even one = better than none.</p>\n</body>\n</html>';
    const buf = await buildEpub(
      [
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>Some prose with an <a href="">empty link</a> in it.</p></body></html>',
        quirk,
      ],
      { compress: false },
    );
    const out = await parseEpub(buf, { extractorVersion: 1, fileName: 'stored.epub' });
    expect(out.chapters).toHaveLength(2);
    expect(out.chapters[1].body).toBe('Chapter 2\nFirst line\u2029second line.\n\nEven one = better than none.');
  });
});

/* #4217 — under extractorVersion 2 the `</div>` closers break paragraphs on
   both EPUB paths; version 1 keeps them glued. E1 mutation: call stripHtml at
   epub.ts:163 without the version. E2 mutation: same at epub.ts:307. */
describe('parseEpub — block-closer paragraphs by extractorVersion (#4217)', () => {
  const divs = (extra: string) =>
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><div>Alpha${extra}</div><div>Beta</div></body></html>`;

  it('E1: <div> paragraphs are split at version 2 and glued at version 1', async () => {
    const buf = await buildEpub([divs('')]);
    const v2 = await parseEpub(buf, { fileName: 'divs.epub', extractorVersion: 2 });
    const v1 = await parseEpub(buf, { fileName: 'divs.epub', extractorVersion: 1 });
    expect(v2.chapters[0].body).toContain('Alpha\n\nBeta');
    expect(v1.chapters[0].body).toContain('AlphaBeta');
    expect(v1.chapters[0].body).not.toContain('\n\n');
  });

  it('E2: the same through the raw-zip path (<a href="">) splits at 2, not at 1', async () => {
    const buf = await buildEpub([divs(' <a href="">link</a>')]);
    const v2 = await parseEpub(buf, { fileName: 'divs-raw.epub', extractorVersion: 2 });
    const v1 = await parseEpub(buf, { fileName: 'divs-raw.epub', extractorVersion: 1 });
    expect(v2.chapters[0].body).toContain('Alpha link\n\nBeta');
    expect(v1.chapters[0].body).toContain('Alpha linkBeta');
    expect(v1.chapters[0].body).not.toContain('\n\n');
  });
});

/* #4217 — under extractorVersion 2 the raw-zip reader decodes XML entities in
   manifest hrefs and NCX srcs. */
describe('decodeXmlEntities (#4217)', () => {
  /* X1 mutation (M4): implement it as `decodeEntities` — `&amp;#38;` is then
     double-unescaped to `&`, and `&nbsp;` is folded to a space. */
  it('X1: decodes the five XML names and numeric refs exactly once; leaves the rest as typed', () => {
    expect(decodeXmlEntities('A &amp; B')).toBe('A & B');
    expect(decodeXmlEntities('&amp;#38;')).toBe('&#38;');
    expect(decodeXmlEntities('&#38;')).toBe('&');
    expect(decodeXmlEntities('&#x26;')).toBe('&');
    expect(decodeXmlEntities('&lt;&gt;&quot;&apos;')).toBe(`<>"'`);
    expect(decodeXmlEntities('&nbsp;')).toBe('&nbsp;');
    expect(decodeXmlEntities('AT&T')).toBe('AT&T');
    expect(decodeXmlEntities('&#xZZ;')).toBe('&#xZZ;');
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;');
  });
});

/* X2 mutations: M1 (drop the decode in the manifest) turns the version-2
   case into a rejection; M3 (decode at every version) makes the version-1
   case resolve instead of rejecting. X3 mutation M2 (drop the decode on the
   NCX src) loses the NCX titles. */
describe('parseEpub — XML-entity hrefs in the raw-zip reader (#4217)', () => {
  const plain =
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>Plain prose, nothing odd.</p></body></html>';
  const emptyHref =
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>Some prose with an <a href="">empty link</a> in it.</p></body></html>';
  const fileNames = ['Part 1 & More.xhtml', 'Part 2 & More.xhtml'];

  it('X2: version 1 rejects, version 2 finds the chapter files', async () => {
    const buf = await buildEpub([plain, emptyHref], { fileNames });
    await expect(parseEpub(buf, { fileName: 'amp.epub', extractorVersion: 1 })).rejects.toThrow(UnusableEpubError);
    await expect(parseEpub(buf, { fileName: 'amp.epub', extractorVersion: 1 })).rejects.toThrow(/readable text/);
    const v2 = await parseEpub(buf, { fileName: 'amp.epub', extractorVersion: 2 });
    expect(v2.chapters.map((c) => c.title)).toEqual(['Part 1', 'Part 2']);
    expect(v2.chapters.map((c) => c.body)).toEqual(['Plain prose, nothing odd.', 'Some prose with an empty link in it.']);
  });

  it('X3: NCX labels still match the decoded chapter paths at version 2', async () => {
    const buf = await buildEpub([plain, emptyHref], { fileNames, navLabels: ['Opening', 'Closing'] });
    const v2 = await parseEpub(buf, { fileName: 'amp.epub', extractorVersion: 2 });
    expect(v2.chapters.map((c) => c.title)).toEqual(['Opening', 'Closing']);
  });
});
