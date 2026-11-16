/* Synthetic EPUB whose only chapter contains <a href=""> — epub2's getChapter
   throws on it from inside an async zip callback (#4239). Shared by the parser
   and import-route tests. */
import { ZipFile } from 'yazl';

export function buildEmptyHrefEpub(): Promise<Buffer> {
  return new Promise((resolveBuf, reject) => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', { compress: false });
    zip.addBuffer(
      Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      'META-INF/container.xml',
    );
    zip.addBuffer(
      Buffer.from(
        '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:creator>A</dc:creator><dc:identifier id="id">x</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/></spine></package>',
      ),
      'OEBPS/content.opf',
    );
    zip.addBuffer(
      Buffer.from(
        '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="x"/></head><docTitle><text>T</text></docTitle><navMap><navPoint id="np1" playOrder="1"><navLabel><text>One</text></navLabel><content src="c1.xhtml"/></navPoint></navMap></ncx>',
      ),
      'OEBPS/toc.ncx',
    );
    zip.addBuffer(
      Buffer.from(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>Some prose with an <a href="">empty link</a> in it.</p></body></html>',
      ),
      'OEBPS/c1.xhtml',
    );
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', () => resolveBuf(Buffer.concat(chunks)))
      .on('error', reject);
  });
}
