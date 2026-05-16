/* Regenerate the binary EPUB fixture under server/src/parsers/__fixtures__/.
   Run from the repo root:  node scripts/gen-parser-fixtures.mjs

   Requires adm-zip (currently transitively available via server's
   pdf-parse). If npm pulls a tree without it, install with:
       cd server && npm i -D adm-zip

   Note: there is no PDF fixture here. parsePdf is a thin wrapper over
   pdf-parse, so its test (pdf.test.ts) mocks pdf-parse rather than
   hand-crafting a PDF that pdfjs's strict xref parser will accept.
   End-to-end PDF coverage comes from the canonical e2e manuscript run. */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
