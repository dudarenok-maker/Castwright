/* Version-1 extraction parity (#4217).

   Pins what EPUB/MOBI extraction produced BEFORE #4217: an unstamped book's
   implicit re-reads (hydrate and the like) must stay byte-identical, because
   persisted sentence offsets index into this text. The expected values below
   were recorded from the code at BASE, before #4217 changed anything, by one
   `-u` run of this file with no source file edited. They are the contract now:
   never re-run this file with `-u`.

   Every case passes `extractorVersion: 1` explicitly: there is no default (see (d)).  */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildEpub } from '../test-utils/empty-href-epub.js';
import { stripHtml } from './html-utils.js';
import { parseEpub } from './epub.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const REAL_EPUBS = [
  'server/src/parsers/__fixtures__/sample-epub-drm.epub',
  'server/src/parsers/__fixtures__/sample-epub-image-only.epub',
  'server/src/parsers/__fixtures__/sample-opf-prefixed-titles.epub',
  'server/src/parsers/__fixtures__/sample-opf-prefixed.epub',
  'server/src/parsers/__fixtures__/sample-title-fallback.epub',
  'server/src/parsers/__fixtures__/sample-title-no-calibre.epub',
  'server/src/parsers/__fixtures__/sample.epub',
  'samples/the-coalfall-commission/manuscript.epub',
  'samples/the-coalfall-commission-de/manuscript.epub',
  'samples/the-coalfall-commission-es/manuscript.epub',
  'samples/the-coalfall-commission-fr/manuscript.epub',
  'samples/the-coalfall-commission-ru/manuscript.epub',
];

type Opts = { extractorVersion: number };

async function parseOrErr(
  buf: Buffer,
  fileName: string,
  opts: Opts,
): Promise<{ sourceText: string; titles: string[] } | string> {
  try {
    const r = await parseEpub(buf, { fileName, ...opts });
    return { sourceText: r.sourceText, titles: r.chapters.map((c) => c.title) };
  } catch (e) {
    const err = e as Error;
    return `ERR:${err.name}:${err.message}`;
  }
}

async function realDigests(opts: Opts): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of REAL_EPUBS) {
    const p = join(REPO_ROOT, rel);
    try {
      const r = await parseEpub(readFileSync(p), { fileName: basename(p), ...opts });
      out[relative(REPO_ROOT, p).replace(/\\/g, '/')] = createHash('sha256')
        .update(JSON.stringify(r))
        .digest('hex');
    } catch (e) {
      const err = e as Error;
      out[rel] = `ERR:${err.name}:${err.message}`;
    }
  }
  return out;
}

const HTML_OPEN = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>';
const HTML_CLOSE = '</body></html>';
const chapter = (body: string) => `${HTML_OPEN}${body}${HTML_CLOSE}`;

const MIXED_BODY =
  '<blockquote><p>“A,” she said.</p>\n   <p>“B.”</p></blockquote>\n  ' +
  '<ul><li>one</li>\n  <li>two</li></ul>\r\n  ' +
  '<h2>Part Two</h2>\n  ' +
  '<dl><dt>Term</dt>\n  <dd>Def</dd></dl>\n  ' +
  '<section><article><div><p>Nested</p></div></article></section>';

interface SyntheticCase {
  buf: () => Promise<Buffer>;
}
const SYNTHETIC: Record<string, SyntheticCase> = {
  div: {
    buf: () =>
      buildEpub([
        chapter('<div class="p">First para one.</div><div class="p">First para two.</div>'),
        chapter('<div class="p">Second para one.</div><div class="p">Second para two.</div>'),
        chapter('<div class="p">Third para one.</div><div class="p">Third para two.</div>'),
      ]),
  },
  mixed: { buf: () => buildEpub([chapter(MIXED_BODY)]) },
  'mixed-stored': { buf: () => buildEpub([chapter(MIXED_BODY)], { compress: false }) },
  'amp-names': {
    buf: () =>
      buildEpub(
        [
          chapter('<p>Plain chapter one.</p>'),
          chapter('<p>Chapter two has an <a href="">empty link</a>.</p>'),
        ],
        { fileNames: ['Part 1 & More.xhtml', 'Part 2 & More.xhtml'] },
      ),
  },
  'amp-names-plain': {
    buf: () =>
      buildEpub([chapter('<p>Plain chapter one.</p>'), chapter('<p>Plain chapter two.</p>')], {
        fileNames: ['Part 1 & More.xhtml', 'Part 2 & More.xhtml'],
      }),
  },
};

async function syntheticResults(opts: Opts): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(SYNTHETIC)) {
    out[name] = await parseOrErr(await c.buf(), `${name}.epub`, opts);
  }
  return out;
}

const HTML_SNIPPETS: Record<string, string> = {
  div: 'alpha</div>beta',
  li: 'alpha</li>beta',
  blockquote: 'alpha</blockquote>beta',
  h1: 'alpha</h1>beta',
  h2: 'alpha</h2>beta',
  h3: 'alpha</h3>beta',
  h4: 'alpha</h4>beta',
  h5: 'alpha</h5>beta',
  h6: 'alpha</h6>beta',
  dd: 'alpha</dd>beta',
  dt: 'alpha</dt>beta',
  section: 'alpha</section>beta',
  article: 'alpha</article>beta',
  'upper-case spaced closer': 'alpha</DIV >beta',
  'whitespace-only div': 'alpha<div> </div>beta',
  'nested blocks':
    '<section><article><div><p>Nested</p></div></article></section>\n  <p>After</p>',
  'blockquote of paragraphs': MIXED_BODY.slice(0, MIXED_BODY.indexOf('<ul>')),
  'list with crlf': '<ul><li>one</li>\n  <li>two</li></ul>\r\n  <p>after</p>',
  'definition list': '<dl><dt>Term</dt>\n  <dd>Def</dd></dl>',
  'mid-body heading': '<p>before</p>\n  <h2>Part Two</h2>\n  <p>after</p>',
};

function snippetResults(version: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, html] of Object.entries(HTML_SNIPPETS)) {
    out[name] = stripHtml(html, version);
  }
  return out;
}

describe('version-1 extraction parity (#4217)', () => {
  it('(a) real EPUBs: digest of the whole parse result', async () => {
    expect(await realDigests({ extractorVersion: 1 })).toMatchInlineSnapshot(`
      {
        "samples/the-coalfall-commission-de/manuscript.epub": "b24f41075b11d2050557707aacfa1cb20bf53b48930f675f53da574bfb4e0bfa",
        "samples/the-coalfall-commission-es/manuscript.epub": "1748c6767ab80d576a9657ff79e9820b97593f3f0426b82382d1a0b9b2b442a5",
        "samples/the-coalfall-commission-fr/manuscript.epub": "5bc786a631d54ef9afbb25577fb70823a48d657f0619dc3dce5c4912a72aa9a3",
        "samples/the-coalfall-commission-ru/manuscript.epub": "8b5961c3398aa662af1ae0f487766f0b04f2ff603c7b849a203361c01da66404",
        "samples/the-coalfall-commission/manuscript.epub": "ca90c47b2bf7c458b790182464cb9b33bd8ae74672f785409e4e01d1c4b9a34b",
        "server/src/parsers/__fixtures__/sample-epub-drm.epub": "ERR:UnusableEpubError:This EPUB is DRM-protected. Convert it to a DRM-free EPUB with Calibre first, then re-import.",
        "server/src/parsers/__fixtures__/sample-epub-image-only.epub": "ERR:UnusableEpubError:This EPUB appears to be image-only (scanned) with no extractable text.",
        "server/src/parsers/__fixtures__/sample-opf-prefixed-titles.epub": "8be86703c28a6e75a7de7c90dce59fd43b5728c7dfe32c3d24ad4f98b97ead71",
        "server/src/parsers/__fixtures__/sample-opf-prefixed.epub": "5ccb99c2356b7f29a72a953cca93d7b0415a6f6942e6ce740ef8854e36bd9d93",
        "server/src/parsers/__fixtures__/sample-title-fallback.epub": "8be86703c28a6e75a7de7c90dce59fd43b5728c7dfe32c3d24ad4f98b97ead71",
        "server/src/parsers/__fixtures__/sample-title-no-calibre.epub": "3060900d22dbbb29059d88347dd173134d54af1348e0a6afb083cdb046c491fb",
        "server/src/parsers/__fixtures__/sample.epub": "5ccb99c2356b7f29a72a953cca93d7b0415a6f6942e6ce740ef8854e36bd9d93",
      }
    `);
  });

  it('(b) synthetic EPUBs: sourceText and chapter titles', async () => {
    expect(await syntheticResults({ extractorVersion: 1 })).toMatchInlineSnapshot(`
      {
        "amp-names": "ERR:UnusableEpubError:Could not locate readable text in this EPUB's package document.",
        "amp-names-plain": {
          "sourceText": "Plain chapter one.

      Plain chapter two.",
          "titles": [
            "Part 1",
            "Part 2",
          ],
        },
        "div": {
          "sourceText": "First para one.First para two.

      Second para one.Second para two.

      Third para one.Third para two.",
          "titles": [
            "Part 1",
            "Part 2",
            "Part 3",
          ],
        },
        "mixed": {
          "sourceText": "“A,” she said.

         “B.”

        one
        two
        Part Two
        Term
        Def
        Nested",
          "titles": [
            "Part 1",
          ],
        },
        "mixed-stored": {
          "sourceText": "“A,” she said.

         “B.”

        one
        two
        Part Two
        Term
        Def
        Nested",
          "titles": [
            "Part 1",
          ],
        },
      }
    `);
  });

  it('(c) stripHtml on block closers and nesting shapes', () => {
    expect(snippetResults(1)).toMatchInlineSnapshot(`
      {
        "article": "alphabeta",
        "blockquote": "alphabeta",
        "blockquote of paragraphs": "“A,” she said.

         “B.”",
        "dd": "alphabeta",
        "definition list": "Term
        Def",
        "div": "alphabeta",
        "dt": "alphabeta",
        "h1": "alphabeta",
        "h2": "alphabeta",
        "h3": "alphabeta",
        "h4": "alphabeta",
        "h5": "alphabeta",
        "h6": "alphabeta",
        "li": "alphabeta",
        "list with crlf": "one
        two
        after",
        "mid-body heading": "before

        Part Two
        after",
        "nested blocks": "Nested

        After",
        "section": "alphabeta",
        "upper-case spaced closer": "alphabeta",
        "whitespace-only div": "alpha beta",
      }
    `);
  });

  /* There is no default version any more (#4217 pass 1): a layer that drops it
     must fail typecheck, not extract at v1 under a book stamped 2. */
  it("(d) the version is required at every parser layer (compile-time guard)", () => {
    const never = () => {
      // @ts-expect-error -- extractorVersion is required
      void stripHtml("<p>x</p>");
      // @ts-expect-error -- extractorVersion is required
      void parseEpub(Buffer.alloc(0), { fileName: "x.epub" });
    };
    expect(never).toBeTypeOf("function");
  });
});
