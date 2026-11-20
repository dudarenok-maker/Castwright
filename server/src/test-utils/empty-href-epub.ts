/* Synthetic EPUBs for the parser and import-route tests.
   `buildEmptyHrefEpub`'s chapter contains <a href=""> — epub2's getChapter
   throws on it from inside an async zip callback (#4239).
   `buildSingleChapterEpub` takes any chapter XHTML (the parity fixture);
   `buildEpub` takes several chapters and can store the entries uncompressed. */
import { ZipFile } from 'yazl';

export function buildEmptyHrefEpub(): Promise<Buffer> {
  return buildSingleChapterEpub(
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>Some prose with an <a href="">empty link</a> in it.</p></body></html>',
  );
}

const ORDINARY_CHAPTER =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body><p>Some ordinary prose with no links in it.</p></body></html>';

/* An OPF cut off mid-<manifest> with an unclosed <item tag (#4289). */
export function buildBrokenOpfEpub(): Promise<Buffer> {
  return buildEpub([ORDINARY_CHAPTER], {
    opfXml:
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:creator>A</dc:creator></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="c1" href="c1.xhtml" media-type="applic',
  });
}

/* The OPF and spine still name toc.ncx, but the entry is absent (#4289). */
export function buildMissingNcxTargetEpub(): Promise<Buffer> {
  return buildEpub([ORDINARY_CHAPTER], { omitNcx: true });
}

/* A two-chapter epub cut to its first half (#4289). */
export async function buildTruncatedEpub(): Promise<Buffer> {
  const full = await buildEpub([ORDINARY_CHAPTER, ORDINARY_CHAPTER]);
  return full.subarray(0, Math.floor(full.length / 2));
}

export function buildSingleChapterEpub(chapterXhtml: string, navLabel = 'One'): Promise<Buffer> {
  return buildEpub([chapterXhtml], { navLabels: [navLabel] });
}

/* `compress: false` stores every entry uncompressed, which makes adm-zip answer
   a chapter read synchronously (only DEFLATED entries go through the async
   inflater) — the shape in which epub2's throw is catchable by the caller.
   `fileNames` overrides the chapter file names (real names; written XML-escaped
   in the OPF and NCX), e.g. `Part 1 & More.xhtml`. */
export function buildEpub(
  chapterXhtmls: string[],
  opts: { navLabels?: string[]; compress?: boolean; fileNames?: string[]; opfXml?: string; omitNcx?: boolean } = {},
): Promise<Buffer> {
  const compress = opts.compress ?? true;
  const fileName = (i: number) => opts.fileNames?.[i] ?? `c${i + 1}.xhtml`;
  const xmlName = (i: number) => fileName(i).replace(/&/g, '&amp;');
  const items = chapterXhtmls
    .map((_, i) => `<item id="c${i + 1}" href="${xmlName(i)}" media-type="application/xhtml+xml"/>`)
    .join('');
  const refs = chapterXhtmls.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('');
  const nav = chapterXhtmls
    .map(
      (_, i) =>
        `<navPoint id="np${i + 1}" playOrder="${i + 1}"><navLabel><text>${opts.navLabels?.[i] ?? `Part ${i + 1}`}</text></navLabel><content src="${xmlName(i)}"/></navPoint>`,
    )
    .join('');
  return new Promise((resolveBuf, reject) => {
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from('application/epub+zip'), 'mimetype', { compress: false });
    zip.addBuffer(
      Buffer.from(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      'META-INF/container.xml',
      { compress },
    );
    const defaultOpf =
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:creator>A</dc:creator><dc:identifier id="id">x</dc:identifier><dc:language>en</dc:language></metadata><manifest><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' +
          items +
          '</manifest><spine toc="ncx">' +
          refs +
          '</spine></package>';
    zip.addBuffer(Buffer.from(opts.opfXml ?? defaultOpf), 'OEBPS/content.opf', { compress });
    if (!opts.omitNcx) {
    zip.addBuffer(
      Buffer.from(
        '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="x"/></head><docTitle><text>T</text></docTitle><navMap>' +
          nav +
          '</navMap></ncx>',
      ),
      'OEBPS/toc.ncx',
      { compress },
    );
    }
    chapterXhtmls.forEach((x, i) => zip.addBuffer(Buffer.from(x), `OEBPS/${fileName(i)}`, { compress }));
    zip.end();
    const chunks: Buffer[] = [];
    zip.outputStream
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', () => resolveBuf(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

/* Chapter for the extraction-parity test: three things epub2's `getChapter`
   does that a plain body trim does not, each of which moves persisted sentence
   offsets or the chapter title in an already-imported book.
   1. U+2029 in the body — getChapter's `.`-based body regex cannot cross it, so
      the whole document goes through and the <head><title> text leads the body.
   2. "Even one = better" — its `on…=` handler rewrite turns it into "skip-one".
   3. A heading whose inner markup is 397 chars raw (inside FIRST_HEADING_RE's
      400 bound) but 413 once the self-link's href is rewritten under /links/.
      With the navLabel `Chapter 3` (generic, so the heading is consulted),
      getChapter's text leaves the heading unfound: title `Chapter 3`, heading
      kept in the body. A raw-text path finds it: `Chapter 3 — Chapter 3
      SUBTITLE [4]`. Use `PARITY_NAV_LABEL` as the navLabel. */
export const PARITY_NAV_LABEL = 'Chapter 3';
const PARITY_FOOTNOTE = 'x'.repeat(325);
export const PARITY_CHAPTER_XHTML =
  '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head><title>Head Title Text</title></head>\n<body>\n' +
  `<h1>Chapter 3<br/>SUBTITLE<a href="c1.xhtml#n_4" title="${PARITY_FOOTNOTE}"><sup>[4]</sup></a></h1>\n` +
  '<p>First line\u2029second line.</p>\n<p>Even one = better than none.</p>\n</body>\n</html>';
