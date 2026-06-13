/* Regenerate the binary EPUB fixture under server/src/parsers/__fixtures__/.
   Run from the repo root:  node scripts/gen-parser-fixtures.mjs

   Requires adm-zip (currently transitively available via server's
   pdf-parse). If npm pulls a tree without it, install with:
       cd server && npm i -D adm-zip

   Note: there is no PDF fixture here. parsePdf is a thin wrapper over
   pdf-parse, so its test (pdf.test.ts) mocks pdf-parse rather than
   hand-crafting a PDF that pdfjs's strict xref parser will accept.
   End-to-end PDF coverage comes from the canonical e2e manuscript run. */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, '../server/src/parsers/__fixtures__');
mkdirSync(fixturesDir, { recursive: true });

// adm-zip lives in server/node_modules — resolve from there.
const requireFromServer = createRequire(resolve(here, '../server/package.json'));
const AdmZip = requireFromServer('adm-zip');

/* EPUB 2 minimal structure:
     mimetype                       (stored, no compression — must be first)
     META-INF/container.xml         (points at content.opf)
     OEBPS/content.opf              (manifest + spine + dc:title etc.)
     OEBPS/toc.ncx                  (navmap)
     OEBPS/chapter1.xhtml
     OEBPS/chapter2.xhtml

   Calibre series meta included so the test can pin series metadata. */
function buildEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Solway Light</dc:title>
    <dc:creator opf:role="aut">Jane Doe</dc:creator>
    <dc:identifier id="bookid">urn:uuid:fixture-0001</dc:identifier>
    <dc:language>en</dc:language>
    <meta name="calibre:series" content="Solway Bay"/>
    <meta name="calibre:series_index" content="2"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:fixture-0001"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>The Solway Light</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Opening</text></navLabel><content src="chapter1.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>Returning</text></navLabel><content src="chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>`;

  const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Opening</title></head>
<body>
  <h1>Opening</h1>
  <p>The tower stood at the edge of the world.</p>
  <p>She yelled <em>across</em> the cold water.</p>
</body>
</html>`;

  const chapter2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Returning</title></head>
<body>
  <h1>Returning</h1>
  <p>"GET OUT NOW," she shouted.</p>
  <p>The wick guttered.</p>
</body>
</html>`;

  const zip = new AdmZip();
  // mimetype MUST be first, stored (no deflate), per EPUB spec.
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), '', 0);
  zip.addFile('META-INF/container.xml', Buffer.from(containerXml, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(contentOpf, 'utf8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(tocNcx, 'utf8'));
  zip.addFile('OEBPS/chapter1.xhtml', Buffer.from(chapter1, 'utf8'));
  zip.addFile('OEBPS/chapter2.xhtml', Buffer.from(chapter2, 'utf8'));
  return zip.toBuffer();
}

const epubPath = resolve(fixturesDir, 'sample.epub');
writeFileSync(epubPath, buildEpub());
console.log(`wrote ${epubPath}`);

/* Second fixture: exercises the title-extraction fallback paths.
   - chapter1 has a GENERIC NCX label ("Chapter 1") and a DESCRIPTIVE
     body <h1> ("The Berth at Liverpool") — parseEpub should merge into
     "Chapter 1 — The Berth at Liverpool".
   - chapter2 has NO NCX label (empty <text/>) and a descriptive body
     <h2> ("A Manifest Two Names Short") — parseEpub should use the
     body heading verbatim.
   - chapter3 has a descriptive NCX label and a descriptive body — NCX
     should win unchanged (don't override authored metadata). */
function buildTitleFallbackEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Northern Star</dc:title>
    <dc:creator opf:role="aut">Jane Doe</dc:creator>
    <dc:identifier id="bookid">urn:uuid:fixture-tfb-0001</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch3" href="chapter3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
    <itemref idref="ch3"/>
  </spine>
</package>`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:fixture-tfb-0001"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>The Northern Star</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="chapter1.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text> </text></navLabel><content src="chapter2.xhtml"/></navPoint>
    <navPoint id="np3" playOrder="3"><navLabel><text>What the Captain Knew</text></navLabel><content src="chapter3.xhtml"/></navPoint>
  </navMap>
</ncx>`;

  const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>The Berth at Liverpool</h1>
  <p>The gangplank groaned beneath her boots.</p>
</body>
</html>`;

  const chapter2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
  <h2>A Manifest Two Names Short</h2>
  <p>The clerk frowned at the ledger.</p>
</body>
</html>`;

  const chapter3 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>What the Captain Knew</title></head>
<body>
  <h1>What the Captain Knew</h1>
  <p>He did not, in fact, know.</p>
</body>
</html>`;

  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), '', 0);
  zip.addFile('META-INF/container.xml', Buffer.from(containerXml, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(contentOpf, 'utf8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(tocNcx, 'utf8'));
  zip.addFile('OEBPS/chapter1.xhtml', Buffer.from(chapter1, 'utf8'));
  zip.addFile('OEBPS/chapter2.xhtml', Buffer.from(chapter2, 'utf8'));
  zip.addFile('OEBPS/chapter3.xhtml', Buffer.from(chapter3, 'utf8'));
  return zip.toBuffer();
}

const titleFallbackPath = resolve(fixturesDir, 'sample-title-fallback.epub');
writeFileSync(titleFallbackPath, buildTitleFallbackEpub());
console.log(`wrote ${titleFallbackPath}`);

/* Third fixture (Bug B): EPUB with series info baked into the dc:title
   parenthetical and NO Calibre series metadata. Exercises the
   parseSeriesFromTitle fallback in parseEpub. */
function buildSeriesFromTitleEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Tidewatcher’s Oath (The Hollow Tide Book 3)</dc:title>
    <dc:creator opf:role="aut">Della Renwick</dc:creator>
    <dc:identifier id="bookid">urn:uuid:fixture-sft-0001</dc:identifier>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
  </spine>
</package>`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:fixture-sft-0001"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>The Tidewatcher’s Oath</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Prologue</text></navLabel><content src="chapter1.xhtml"/></navPoint>
  </navMap>
</ncx>`;

  const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Prologue</title></head>
<body>
  <h1>Prologue</h1>
  <p>The flame was tinged with blue.</p>
</body>
</html>`;

  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), '', 0);
  zip.addFile('META-INF/container.xml', Buffer.from(containerXml, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(contentOpf, 'utf8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(tocNcx, 'utf8'));
  zip.addFile('OEBPS/chapter1.xhtml', Buffer.from(chapter1, 'utf8'));
  return zip.toBuffer();
}

const seriesFromTitlePath = resolve(fixturesDir, 'sample-title-no-calibre.epub');
writeFileSync(seriesFromTitlePath, buildSeriesFromTitleEpub());
console.log(`wrote ${seriesFromTitlePath}`);

/* Fourth fixture (plan 116): an EPUB whose OPF namespaces EVERY package
   element with an explicit `opf:` prefix (`<opf:package>`, `<opf:manifest>`,
   `<opf:item>`, `<opf:spine>`, `<opf:itemref>`, `<opf:meta>`). epub2's
   manifest/spine walker only recognises UNPREFIXED names, so it yields an
   empty flow and the primary path extracts zero chapters — the raw-zip
   fallback (parseEpubRawZip) must recover the text. Same prose as
   sample.epub (so audio-tag + Calibre-series assertions carry over), but the
   chapters live one level DEEPER (`OEBPS/text/chapterN.xhtml`) so the
   href-relative-to-OPF-dir resolution path is exercised. Real-world source:
   Simon & Schuster publisher EPUBs (e.g. "The Drowning Bell"). */
function buildOpfPrefixedEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" unique-identifier="bookid" version="2.0">
  <opf:metadata>
    <dc:title>The Solway Light</dc:title>
    <dc:creator opf:role="aut">Jane Doe</dc:creator>
    <dc:identifier id="bookid">urn:uuid:fixture-opfpfx-0001</dc:identifier>
    <dc:language>en</dc:language>
    <opf:meta name="calibre:series" content="Solway Bay"/>
    <opf:meta name="calibre:series_index" content="2"/>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <opf:item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
  </opf:manifest>
  <opf:spine toc="ncx">
    <opf:itemref idref="ch1"/>
    <opf:itemref idref="ch2"/>
  </opf:spine>
</opf:package>`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:fixture-opfpfx-0001"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>The Solway Light</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Opening</text></navLabel><content src="text/chapter1.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text>Returning</text></navLabel><content src="text/chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>`;

  const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Opening</title></head>
<body>
  <h1>Opening</h1>
  <p>The tower stood at the edge of the world.</p>
  <p>She yelled <em>across</em> the cold water.</p>
</body>
</html>`;

  const chapter2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Returning</title></head>
<body>
  <h1>Returning</h1>
  <p>"GET OUT NOW," she shouted.</p>
  <p>The wick guttered.</p>
</body>
</html>`;

  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), '', 0);
  zip.addFile('META-INF/container.xml', Buffer.from(containerXml, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(contentOpf, 'utf8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(tocNcx, 'utf8'));
  zip.addFile('OEBPS/text/chapter1.xhtml', Buffer.from(chapter1, 'utf8'));
  zip.addFile('OEBPS/text/chapter2.xhtml', Buffer.from(chapter2, 'utf8'));
  return zip.toBuffer();
}

const opfPrefixedPath = resolve(fixturesDir, 'sample-opf-prefixed.epub');
writeFileSync(opfPrefixedPath, buildOpfPrefixedEpub());
console.log(`wrote ${opfPrefixedPath}`);

/* srv-13 fixture: like buildOpfPrefixedEpub (namespace-prefixed OPF → the
   raw-zip fallback runs, since epub2 yields an empty flow) but with the three
   NCX-vs-body title scenarios from buildTitleFallbackEpub. Proves the fallback
   now reads navLabels from toc.ncx — the merged "Chapter 1 — …" title is only
   reachable if the NCX was parsed. The unprefixed equivalent is
   sample-title-fallback.epub; both should yield identical titles.
   - chapter1: generic NCX "Chapter 1" + descriptive body <h1> → merge.
   - chapter2: empty NCX label + descriptive body <h2> → body heading verbatim.
   - chapter3: descriptive NCX + body <h1> → NCX kept unchanged.
   Chapters live under OEBPS/text/ while toc.ncx is at OEBPS/, so the NCX
   `content src` (relative to the NCX dir) resolution path is exercised. */
function buildOpfPrefixedTitleFallbackEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" unique-identifier="bookid" version="2.0">
  <opf:metadata>
    <dc:title>The Northern Star</dc:title>
    <dc:creator opf:role="aut">Jane Doe</dc:creator>
    <dc:identifier id="bookid">urn:uuid:fixture-opfpfx-tfb-0001</dc:identifier>
    <dc:language>en</dc:language>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <opf:item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="ch2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="ch3" href="text/chapter3.xhtml" media-type="application/xhtml+xml"/>
  </opf:manifest>
  <opf:spine toc="ncx">
    <opf:itemref idref="ch1"/>
    <opf:itemref idref="ch2"/>
    <opf:itemref idref="ch3"/>
  </opf:spine>
</opf:package>`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:fixture-opfpfx-tfb-0001"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>The Northern Star</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="text/chapter1.xhtml"/></navPoint>
    <navPoint id="np2" playOrder="2"><navLabel><text> </text></navLabel><content src="text/chapter2.xhtml"/></navPoint>
    <navPoint id="np3" playOrder="3"><navLabel><text>What the Captain Knew</text></navLabel><content src="text/chapter3.xhtml"/></navPoint>
  </navMap>
</ncx>`;

  const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>The Berth at Liverpool</h1>
  <p>The gangplank groaned beneath her boots.</p>
</body>
</html>`;

  const chapter2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title></head>
<body>
  <h2>A Manifest Two Names Short</h2>
  <p>The clerk frowned at the ledger.</p>
</body>
</html>`;

  const chapter3 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>What the Captain Knew</title></head>
<body>
  <h1>What the Captain Knew</h1>
  <p>He did not, in fact, know.</p>
</body>
</html>`;

  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), '', 0);
  zip.addFile('META-INF/container.xml', Buffer.from(containerXml, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(contentOpf, 'utf8'));
  zip.addFile('OEBPS/toc.ncx', Buffer.from(tocNcx, 'utf8'));
  zip.addFile('OEBPS/text/chapter1.xhtml', Buffer.from(chapter1, 'utf8'));
  zip.addFile('OEBPS/text/chapter2.xhtml', Buffer.from(chapter2, 'utf8'));
  zip.addFile('OEBPS/text/chapter3.xhtml', Buffer.from(chapter3, 'utf8'));
  return zip.toBuffer();
}

const opfPrefixedTitlesPath = resolve(fixturesDir, 'sample-opf-prefixed-titles.epub');
writeFileSync(opfPrefixedTitlesPath, buildOpfPrefixedTitleFallbackEpub());
console.log(`wrote ${opfPrefixedTitlesPath}`);

/* Fifth fixture (plan 116): DRM diagnostic. Prefixed OPF (so the fallback
   runs) + a META-INF/encryption.xml entry + a content doc with no extractable
   text. The fallback finds zero chapters and, seeing encryption.xml, throws
   UnusableEpubError with the DRM-specific message. */
function buildDrmEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const encryptionXml = `<?xml version="1.0" encoding="UTF-8"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
    <CipherData><CipherReference URI="OEBPS/text/chapter1.xhtml"/></CipherData>
  </EncryptedData>
</encryption>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" unique-identifier="bookid" version="2.0">
  <opf:metadata>
    <dc:title>A Locked Book</dc:title>
    <dc:creator opf:role="aut">Jane Doe</dc:creator>
    <dc:identifier id="bookid">urn:uuid:fixture-drm-0001</dc:identifier>
    <dc:language>en</dc:language>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="ch1" href="text/chapter1.xhtml" media-type="application/xhtml+xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="ch1"/>
  </opf:spine>
</opf:package>`;

  /* Stand-in for an encrypted content doc: a valid XHTML shell with no text
     in its body (decryption would be needed to reveal any). */
  const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Locked</title></head>
<body></body>
</html>`;

  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), '', 0);
  zip.addFile('META-INF/container.xml', Buffer.from(containerXml, 'utf8'));
  zip.addFile('META-INF/encryption.xml', Buffer.from(encryptionXml, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(contentOpf, 'utf8'));
  zip.addFile('OEBPS/text/chapter1.xhtml', Buffer.from(chapter1, 'utf8'));
  return zip.toBuffer();
}

const drmPath = resolve(fixturesDir, 'sample-epub-drm.epub');
writeFileSync(drmPath, buildDrmEpub());
console.log(`wrote ${drmPath}`);

/* Sixth fixture (plan 116): image-only diagnostic. Prefixed OPF (so the
   fallback runs), no encryption.xml, and the single spine doc's body holds
   only an <img> — no text. The fallback resolves the doc but extracts no
   body, so it throws UnusableEpubError with the image-only message. */
function buildImageOnlyEpub() {
  const containerXml = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" unique-identifier="bookid" version="2.0">
  <opf:metadata>
    <dc:title>A Picture Book</dc:title>
    <dc:creator opf:role="aut">Jane Doe</dc:creator>
    <dc:identifier id="bookid">urn:uuid:fixture-img-0001</dc:identifier>
    <dc:language>en</dc:language>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="page1" href="text/page1.xhtml" media-type="application/xhtml+xml"/>
    <opf:item id="img1" href="images/page1.jpg" media-type="image/jpeg"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="page1"/>
  </opf:spine>
</opf:package>`;

  const page1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Page 1</title></head>
<body><img src="../images/page1.jpg" alt=""/></body>
</html>`;

  const zip = new AdmZip();
  zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'), '', 0);
  zip.addFile('META-INF/container.xml', Buffer.from(containerXml, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(contentOpf, 'utf8'));
  zip.addFile('OEBPS/text/page1.xhtml', Buffer.from(page1, 'utf8'));
  // 1x1 grey JPEG stand-in — content doesn't matter, only that it's not text.
  zip.addFile('OEBPS/images/page1.jpg', Buffer.from('\xff\xd8\xff\xd9', 'binary'));
  return zip.toBuffer();
}

const imageOnlyPath = resolve(fixturesDir, 'sample-epub-image-only.epub');
writeFileSync(imageOnlyPath, buildImageOnlyEpub());
console.log(`wrote ${imageOnlyPath}`);

/* MOBI + AZW3 fixtures (plan 60 — real-binary parser fixtures).
 *
 * Calibre's `ebook-convert` is the canonical tool for producing real
 * Mobipocket / KF8 binaries from an EPUB source. We use the
 * already-generated `sample.epub` (Jane Doe / "The Solway Light", with
 * Calibre series meta) as the input so the resulting MOBI/AZW3 carry
 * the same dc:title/dc:creator the EPUB tests assert on.
 *
 * Calibre is a per-developer install, not bundled with this repo. When
 * it's missing from PATH we print a clear warning and exit success —
 * fresh-clone dev environments still pass `npm run verify` because the
 * MOBI/AZW3 e2e cases + the server's real-fixture integration test
 * both detect the missing files and skip with a "Calibre required"
 * message. EPUB + PDF fixtures (above) stay generated unconditionally.
 *
 * Pairs with docs/features/archive/66-real-binary-parser-fixtures.md.
 */

function findCalibre() {
  /* `where.exe` on Windows / `which` elsewhere. spawnSync returns
     status 0 + the path on stdout when found, non-zero otherwise. */
  const cmd = platform() === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(cmd, ['ebook-convert'], { encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) {
    /* `where.exe` may return multiple paths (one per line); take the
       first. POSIX `which` returns just one. */
    return result.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

function generateMobiFixture(epubInput, calibrePath) {
  const out = resolve(fixturesDir, 'sample.mobi');
  /* `--mobi-file-type=old` produces a legacy Mobipocket (initMobiFile)
     binary rather than dual-format. Keeps the file small (~5 KB) and
     exercises the parser's legacy path explicitly. */
  const result = spawnSync(
    calibrePath,
    [epubInput, out, '--mobi-file-type=old'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.warn(`[gen-parser-fixtures] ebook-convert failed for MOBI (status ${result.status})`);
    return null;
  }
  return out;
}

function generateAzw3Fixture(epubInput, calibrePath) {
  const out = resolve(fixturesDir, 'sample.azw3');
  /* AZW3 is KF8 — ebook-convert dispatches on the output extension. */
  const result = spawnSync(calibrePath, [epubInput, out], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.warn(`[gen-parser-fixtures] ebook-convert failed for AZW3 (status ${result.status})`);
    return null;
  }
  return out;
}

const calibrePath = findCalibre();
if (!calibrePath) {
  console.warn(
    '[gen-parser-fixtures] Calibre (ebook-convert) not found on PATH — ' +
      'skipping MOBI + AZW3 fixtures.\n' +
      '  Install Calibre from https://calibre-ebook.com/download to enable ' +
      'real-binary integration tests for @lingo-reader/mobi-parser.\n' +
      '  Without Calibre, the MOBI/AZW3 e2e cases skip cleanly and EPUB + PDF ' +
      'paths still run.',
  );
} else {
  if (!existsSync(epubPath)) {
    console.warn(`[gen-parser-fixtures] EPUB source missing at ${epubPath}; cannot derive MOBI/AZW3`);
  } else {
    console.log(`[gen-parser-fixtures] using Calibre at ${calibrePath}`);
    const mobiOut = generateMobiFixture(epubPath, calibrePath);
    if (mobiOut) console.log(`wrote ${mobiOut}`);
    const azw3Out = generateAzw3Fixture(epubPath, calibrePath);
    if (azw3Out) console.log(`wrote ${azw3Out}`);
  }
}
