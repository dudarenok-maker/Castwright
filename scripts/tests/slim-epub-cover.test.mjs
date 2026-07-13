/* Unit tests for the pure epub cover-slim core. Builds a synthetic Calibre-
   shaped epub in memory, swaps the cover, and asserts the swap is correct AND
   that the manuscript content entry survives byte-for-byte (the property that
   makes slimming a captured sample safe for its attribution). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { findOpfPath, findCover, slimEpubBuffer } from '../lib/slim-epub-cover.mjs';

const CONTENT_HTML =
  '<html><body><p>"Run, you fools," said Tam.</p></body></html>';

function buildEpub({ opfDir = '' } = {}) {
  const p = (name) => (opfDir ? `${opfDir}/${name}` : name);
  const opf = [
    '<?xml version="1.0"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="2.0">',
    '  <metadata><meta name="cover" content="cover"/></metadata>',
    '  <manifest>',
    '    <item id="cover" href="cover.png" media-type="image/png"/>',
    '    <item id="title" href="titlepage.xhtml" media-type="application/xhtml+xml"/>',
    '    <item id="c1" href="index_split_000.html" media-type="application/xhtml+xml"/>',
    '  </manifest>',
    '  <spine><itemref idref="title"/><itemref idref="c1"/></spine>',
    '</package>',
  ].join('\n');
  const titlepage =
    '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
    '<image xlink:href="cover.png"/></svg></body></html>';
  const container =
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">' +
    `<rootfiles><rootfile full-path="${p('content.opf')}" media-type="application/oebps-package+xml"/></rootfiles></container>`;
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    [p('content.opf')]: strToU8(opf),
    [p('titlepage.xhtml')]: strToU8(titlepage),
    [p('index_split_000.html')]: strToU8(CONTENT_HTML),
    [p('cover.png')]: new Uint8Array(4096).fill(7), // stand-in for the fat PNG
  });
}

const FAKE_JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]); // tiny stand-in

test('findOpfPath reads the rootfile', () => {
  assert.equal(findOpfPath(unzipSync(buildEpub())), 'content.opf');
});

test('findCover locates the <meta name="cover"> manifest item', () => {
  const c = findCover(unzipSync(buildEpub()));
  assert.equal(c.coverHref, 'cover.png');
  assert.equal(c.coverPath, 'cover.png');
});

test('slim swaps cover.png → cover.jpg in the zip', () => {
  const out = unzipSync(slimEpubBuffer(buildEpub(), FAKE_JPG));
  assert.ok(out['cover.jpg'], 'cover.jpg present');
  assert.ok(!out['cover.png'], 'cover.png dropped');
  assert.deepEqual(out['cover.jpg'], FAKE_JPG);
});

test('slim retargets the opf manifest href + media-type', () => {
  const opf = strFromU8(unzipSync(slimEpubBuffer(buildEpub(), FAKE_JPG))['content.opf']);
  assert.match(opf, /<item id="cover" href="cover\.jpg" media-type="image\/jpeg"\/>/);
  assert.ok(!opf.includes('cover.png'));
});

test('slim rewrites the titlepage cover reference', () => {
  const tp = strFromU8(unzipSync(slimEpubBuffer(buildEpub(), FAKE_JPG))['titlepage.xhtml']);
  assert.ok(tp.includes('xlink:href="cover.jpg"'));
  assert.ok(!tp.includes('cover.png'));
});

test('slim preserves the manuscript content entry byte-for-byte', () => {
  const src = unzipSync(buildEpub());
  const out = unzipSync(slimEpubBuffer(buildEpub(), FAKE_JPG));
  assert.deepEqual(out['index_split_000.html'], src['index_split_000.html']);
  assert.equal(strFromU8(out['index_split_000.html']), CONTENT_HTML);
});

test('mimetype is re-emitted first and stored (uncompressed)', () => {
  const zip = slimEpubBuffer(buildEpub(), FAKE_JPG);
  // First local file header (sig PK\x03\x04) must be the mimetype entry with
  // compression method 0 (stored). Offsets per the ZIP local-header layout.
  assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const method = zip[8] | (zip[9] << 8);
  assert.equal(method, 0, 'mimetype stored');
  const nameLen = zip[26] | (zip[27] << 8);
  const name = strFromU8(zip.slice(30, 30 + nameLen));
  assert.equal(name, 'mimetype');
});

test('works when the opf lives in a subdirectory (OEBPS/)', () => {
  const out = unzipSync(slimEpubBuffer(buildEpub({ opfDir: 'OEBPS' }), FAKE_JPG));
  assert.ok(out['OEBPS/cover.jpg'], 'nested cover.jpg present');
  assert.ok(!out['OEBPS/cover.png'], 'nested cover.png dropped');
  const opf = strFromU8(out['OEBPS/content.opf']);
  assert.match(opf, /href="cover\.jpg" media-type="image\/jpeg"/);
});

test('slimEpubBuffer rejects empty cover bytes', () => {
  assert.throws(() => slimEpubBuffer(buildEpub(), new Uint8Array()), /coverJpgBytes is required/);
});

// Build a minimal epub with a caller-supplied opf + titlepage, reusing the
// standard container/content/cover so edge cases can be exercised precisely.
function epubWith({ opf, titlepage }) {
  const container =
    '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">' +
    '<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(container),
    'content.opf': strToU8(opf),
    'titlepage.xhtml': strToU8(titlepage),
    'index_split_000.html': strToU8(CONTENT_HTML),
    'cover.png': new Uint8Array(4096).fill(7),
    'backcover.png': new Uint8Array(2048).fill(9),
  });
}

const OPF_STD =
  '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0">' +
  '<metadata><meta name="cover" content="cover"/></metadata>' +
  '<manifest><item id="cover" href="cover.png" media-type="image/png"/>' +
  '<item id="bc" href="backcover.png" media-type="image/png"/>' +
  '<item id="t" href="titlepage.xhtml" media-type="application/xhtml+xml"/></manifest>' +
  '<spine><itemref idref="t"/></spine></package>';

test('slim does NOT rewrite a sibling whose name merely contains the cover basename', () => {
  const tp =
    '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
    '<img src="cover.png"/><img src="backcover.png"/></body></html>';
  const out = unzipSync(slimEpubBuffer(epubWith({ opf: OPF_STD, titlepage: tp }), FAKE_JPG));
  const html = strFromU8(out['titlepage.xhtml']);
  assert.ok(html.includes('src="cover.jpg"'), 'cover rewritten');
  assert.ok(html.includes('src="backcover.png"'), 'backcover left intact');
  assert.ok(out['backcover.png'], 'backcover.png entry untouched');
});

test('findCover tolerates reversed meta attribute order (content before name)', () => {
  const opf = OPF_STD.replace('<meta name="cover" content="cover"/>', '<meta content="cover" name="cover"/>');
  const tp = '<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="cover.png"/></body></html>';
  const out = unzipSync(slimEpubBuffer(epubWith({ opf, titlepage: tp }), FAKE_JPG));
  assert.ok(out['cover.jpg'], 'cover.jpg present despite reversed attr order');
  assert.ok(!out['cover.png'], 'cover.png dropped');
});
