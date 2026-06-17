/* EPUB parser. Primary path is the epub2 library (walks the spine via
   `epub.flow` + `getChapter`, strips HTML to plain text). When epub2 yields
   zero chapters — or throws — we fall back to a yauzl-based raw-zip parser
   (`parseEpubRawZip`) that reads META-INF/container.xml → OPF → manifest +
   spine ourselves with namespace-prefix-tolerant regex. epub2's OPF walker
   only recognises UNPREFIXED element names, so publisher EPUBs that namespace
   every package element with an `opf:` prefix (`<opf:manifest>`, `<opf:item>`,
   `<opf:spine>`, `<opf:itemref>`) parse to an empty flow under epub2 — the
   fallback recovers them. The book's dc:title becomes the manuscript title. */

import { EPub } from 'epub2';
import { writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { safeSegment } from '../util/safe-path.js';
import { fromBuffer as yauzlFromBuffer, type ZipFile, type Entry } from 'yauzl';
import type { ChapterHint } from '../store/manuscripts.js';
import type { ParsedManuscript } from './text.js';
import { parseFilenameMetadata, parseSeriesFromTitle } from './text.js';
import { tagExcitedDialog, tagHesitantDialog, tagShoutingDialog } from './audio-tags.js';
import { stripHtml, extractFirstHeading, GENERIC_NCX_RE } from './html-utils.js';
import { UnusableMediaError } from './errors.js';

type EpubOpts = { fileName?: string; sourcePath?: string };

/** Raw metadata both parse paths produce before the shared title/series
    resolution in {@link assembleManuscript}. */
interface RawMeta {
  title: string;
  author: string | null;
  series: string | null;
  seriesPosition: number | null;
}

/** Thrown when neither the epub2 path nor the raw-zip fallback can extract
    any text. Carries a classified, actionable message (DRM / image-only /
    no-spine) so the route can surface it instead of the cryptic generic.
    The route maps it to HTTP 415 ("we understood the EPUB format but can't
    use this particular file") via the shared UnusableMediaError base.
    Mirrors `DrmProtectedError` in `mobi.ts`. */
export class UnusableEpubError extends UnusableMediaError {
  constructor(message: string) {
    super(message);
    this.name = 'UnusableEpubError';
  }
}

export async function parseEpub(buffer: Buffer, opts: EpubOpts): Promise<ParsedManuscript> {
  /* When the caller already has the EPUB on disk (re-parse path: workspace
     book directory), read it straight from there. The temp-roundtrip path
     below was originally needed because epub2's createAsync only accepts a
     file path, but on Windows the mkdtemp+writeFile+createAsync sequence
     races against AV / OneDrive scanners that touch %TEMP% as soon as a
     new file appears, producing intermittent "Invalid/missing file" errors.
     Direct path is also one fewer copy. */
  let filePath: string;
  let tmp: string | null = null;
  if (opts.sourcePath) {
    filePath = opts.sourcePath;
  } else {
    tmp = await mkdtemp(join(tmpdir(), 'epub-'));
    filePath = join(tmp, safeSegment(basename(opts.fileName ?? 'book.epub')));
    await writeFile(filePath, buffer);
  }
  try {
    const viaEpub2 = await tryEpub2Parse(filePath, opts);
    if (viaEpub2) return viaEpub2;
    /* epub2 found no extractable chapters (commonly a namespace-prefixed OPF
       it can't walk). Fall back to the raw-zip parser, reading the same
       bytes — from disk when sourcePath was given, otherwise the in-memory
       buffer (which may be empty when sourcePath wins). yauzl reads the
       Buffer directly, so no second temp file is needed. */
    const bytes = opts.sourcePath ? await readFile(filePath) : buffer;
    return await parseEpubRawZip(bytes, opts);
  } finally {
    /* Only clean up the tempdir we created. When sourcePath was given we
       did not create one. */
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

/** Resolve a chapter title from its NCX/spine label and the body's first
    heading. NCX/spine entry.title is the primary source, but many EPUBs ship
    generic labels ("Chapter 1") even when the chapter HTML body has a
    descriptive <h1> ("The Berth at Liverpool"):

    - NCX missing → use the body heading if any, else "Chapter N".
    - NCX descriptive → keep NCX (don't override authored metadata).
    - NCX generic ("Chapter 1") + body heading also generic → keep NCX
        (no information gained from merging two generics).
    - NCX generic + body heading descriptive → merge as
        "Chapter 1 — The Berth at Liverpool".

    Shared by the epub2 primary path and the raw-zip fallback so both title
    chapters identically. */
function mergeChapterTitle(
  ncxTitle: string,
  bodyHeading: string | null,
  oneBasedIndex: number,
): string {
  if (!ncxTitle) return bodyHeading || `Chapter ${oneBasedIndex}`;
  if (GENERIC_NCX_RE.test(ncxTitle) && bodyHeading && !GENERIC_NCX_RE.test(bodyHeading)) {
    return `${ncxTitle} — ${bodyHeading}`;
  }
  return ncxTitle;
}

/** epub2 primary path. Returns null (rather than throwing) when epub2 can't
    open the file or yields zero chapters, so the caller falls back to the
    raw-zip parser instead of failing. */
async function tryEpub2Parse(filePath: string, opts: EpubOpts): Promise<ParsedManuscript | null> {
  let epub: EPub;
  try {
    // epub2's createAsync returns the parsed EPub instance.
    epub = await EPub.createAsync(filePath);
  } catch {
    return null;
  }
  try {
    const m = epub.metadata as unknown as Record<string, string | undefined>;
    // Calibre stores series in the `calibre:series` meta entry, surfaced by
    // epub2 under different keys across versions — check the common ones.
    const posRaw = (m['calibre:series_index'] ?? m.series_index ?? '') as string;
    const meta: RawMeta = {
      title: (m.title ?? '').trim(),
      author: (m.creator ?? '').trim() || null,
      series: ((m['calibre:series'] ?? m.series ?? '') as string).trim() || null,
      seriesPosition: posRaw ? parseFloat(posRaw) : null,
    };

    const chapters: ChapterHint[] = [];
    for (let i = 0; i < epub.flow.length; i++) {
      const entry = epub.flow[i];
      if (!entry?.id) continue;
      const html = await new Promise<string>((resolve, reject) => {
        epub.getChapter(entry.id!, (err: Error | null, text?: string) =>
          err ? reject(err) : resolve(text ?? ''),
        );
      });
      const body = tagHesitantDialog(tagExcitedDialog(tagShoutingDialog(stripHtml(html))));
      if (!body) continue;

      // Title from the epub2-supplied NCX/spine label, merged with the body
      // heading via the shared resolver (see {@link mergeChapterTitle}).
      const chTitle = mergeChapterTitle(
        entry.title?.trim() ?? '',
        extractFirstHeading(html),
        chapters.length + 1,
      );
      chapters.push({ id: chapters.length + 1, title: chTitle, body });
    }

    if (chapters.length === 0) return null;
    return assembleManuscript(meta, chapters, opts);
  } catch {
    /* epub2 choked mid-walk (e.g. a getChapter threw). Defer to the raw-zip
       fallback, which re-parses the whole archive from scratch. */
    return null;
  }
}

/** Raw-zip fallback: unzip the EPUB and parse the OPF ourselves, tolerant of
    namespace-prefixed package elements that defeat epub2. */
async function parseEpubRawZip(bytes: Buffer, opts: EpubOpts): Promise<ParsedManuscript> {
  const entries = await readAllZipEntries(bytes);

  /* 1. Locate the OPF via META-INF/container.xml (defensive fallback: the
        first *.opf entry). */
  let opfPath: string | undefined;
  const containerKey = findKeyCI(entries, 'META-INF/container.xml');
  if (containerKey) {
    const container = entries.get(containerKey)!.toString('utf8');
    opfPath = /<rootfile\b[^>]*\bfull-path="([^"]+)"/i.exec(container)?.[1];
  }
  if (!opfPath || !entries.has(opfPath)) {
    opfPath = [...entries.keys()].find((k) => /\.opf$/i.test(k));
  }
  if (!opfPath || !entries.has(opfPath)) {
    throw new UnusableEpubError("Could not locate readable text in this EPUB's package document.");
  }

  const opf = entries.get(opfPath)!.toString('utf8');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  /* 2. Manifest: id → { href, media-type }. `(?:\w+:)?` tolerates an `opf:`
        (or any) namespace prefix on the element name. */
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const m of opf.matchAll(/<(?:\w+:)?item\b([^>]*)>/gi)) {
    const attrs = m[1];
    const id = /\bid="([^"]+)"/i.exec(attrs)?.[1];
    const href = /\bhref="([^"]+)"/i.exec(attrs)?.[1];
    const mediaType = /\bmedia-type="([^"]+)"/i.exec(attrs)?.[1] ?? '';
    if (id && href) manifest.set(id, { href, mediaType });
  }

  /* 3. Spine, in document order. */
  const spine: string[] = [];
  for (const m of opf.matchAll(/<(?:\w+:)?itemref\b[^>]*\bidref="([^"]+)"/gi)) {
    spine.push(m[1]);
  }

  /* 4. Metadata, for parity with the epub2 path. */
  const meta: RawMeta = {
    title: decodeEntities(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1] ?? ''),
    author: decodeEntities(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf)?.[1] ?? '') || null,
    series: readCalibreMeta(opf, 'calibre:series'),
    seriesPosition: ((): number | null => {
      const raw = readCalibreMeta(opf, 'calibre:series_index');
      return raw ? parseFloat(raw) : null;
    })(),
  };

  /* 4b. NCX navMap titles, keyed by the content doc's zip path. Empty when no
        NCX is present — chapters then fall back to body headings, identical to
        the prior behaviour (srv-13: NCX parity with the epub2 path). */
  const ncxTitleByPath = parseNcxTitles(opf, manifest, opfDir, entries);

  /* 5. Resolve spine → chapters. Only XHTML/HTML/SVG docs carry prose; skip
        cover images, CSS, the NCX, etc. `linear="no"` is NOT filtered (the
        epub2 path doesn't either, and front matter holds real prose). */
  const HTML_TYPES = new Set(['application/xhtml+xml', 'text/html', 'image/svg+xml']);
  const chapters: ChapterHint[] = [];
  let resolvedHtmlDocs = 0;
  for (const idref of spine) {
    const item = manifest.get(idref);
    if (!item || !HTML_TYPES.has(item.mediaType)) continue;
    const buf = resolveEntry(entries, opfDir, item.href);
    if (!buf) continue;
    resolvedHtmlDocs += 1;
    /* Extract the <body> first — unlike epub2's getChapter, we have the full
       document, so <head>/<title>/<style> text would otherwise leak into the
       prose. */
    const bodyHtml = htmlBodyOnly(buf.toString('utf8'));
    const body = tagHesitantDialog(tagExcitedDialog(tagShoutingDialog(stripHtml(bodyHtml))));
    if (!body) continue;
    /* Title from the NCX navLabel (parity with the epub2 path), merged with
       the body heading. Try the raw and URL-decoded chapter paths — mirrors
       resolveEntry, since the NCX src and the manifest href may differ in
       %-encoding. Empty NCX → body heading, else a numbered label. */
    const chapterPath = normalizeZipPath(
      opfDir ? `${opfDir}/${item.href.split('#')[0]}` : item.href.split('#')[0],
    );
    let ncxTitle = ncxTitleByPath.get(chapterPath) ?? '';
    if (!ncxTitle) {
      try {
        ncxTitle = ncxTitleByPath.get(decodeURIComponent(chapterPath)) ?? '';
      } catch {
        /* malformed %-escape — keep the empty NCX title */
      }
    }
    const chTitle = mergeChapterTitle(ncxTitle, extractFirstHeading(bodyHtml), chapters.length + 1);
    chapters.push({ id: chapters.length + 1, title: chTitle, body });
  }

  /* 6. Still nothing → classify why so the user gets an actionable message. */
  if (chapters.length === 0) {
    if (findKeyCI(entries, 'META-INF/encryption.xml')) {
      throw new UnusableEpubError(
        'This EPUB is DRM-protected. Convert it to a DRM-free EPUB with Calibre first, then re-import.',
      );
    }
    if (resolvedHtmlDocs > 0) {
      throw new UnusableEpubError(
        'This EPUB appears to be image-only (scanned) with no extractable text.',
      );
    }
    throw new UnusableEpubError("Could not locate readable text in this EPUB's package document.");
  }

  return assembleManuscript(meta, chapters, opts);
}

/** Shared title/series resolution + ParsedManuscript assembly used by both
    parse paths. */
function assembleManuscript(
  meta: RawMeta,
  chapters: ChapterHint[],
  opts: EpubOpts,
): ParsedManuscript {
  let { title, series, seriesPosition } = meta;
  /* Bug B: when Calibre metadata is absent (common in non-Calibre-produced
     EPUBs) but the dc:title carries the series info in a parenthetical like
     "The Tidewatcher’s Oath (The Hollow Tide Book 3)", split it off so the saved
     book has clean title + populated series fields. The frontend surfaces an
     "auto-extracted from title — verify" chip when this fires. */
  let seriesFromTitle = false;
  if (!series && title) {
    const fromTitle = parseSeriesFromTitle(title);
    if (fromTitle.series) {
      title = fromTitle.title;
      series = fromTitle.series;
      seriesPosition = fromTitle.seriesPosition;
      seriesFromTitle = true;
    }
  }

  const sourceText = chapters.map((c) => c.body).join('\n\n');
  const fileMeta = parseFilenameMetadata(opts.fileName);
  return {
    format: 'epub',
    title: title || fileMeta.title || opts.fileName?.replace(/\.[^.]+$/, '') || 'Untitled EPUB',
    sourceText,
    chapters,
    author: meta.author || fileMeta.author,
    series: series || fileMeta.series,
    seriesPosition:
      seriesPosition != null && !Number.isNaN(seriesPosition)
        ? seriesPosition
        : fileMeta.seriesPosition,
    seriesFromTitle,
  };
}

/* ── raw-zip helpers ─────────────────────────────────────────────────── */

/** Read every entry of a zip Buffer into memory. Mirrors the pattern in
    `import/scan-import-folder.ts` (duplicated here rather than imported, to
    keep the parsers loosely coupled — same rationale as html-utils.ts's
    self-contained GENERIC_NCX_RE). EPUBs are bounded by the 50 MB upload
    limit, so loading the whole archive into RAM keeps this simple. */
function readAllZipEntries(bytes: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzlFromBuffer(bytes, { lazyEntries: true }, (err, zipFile) => {
      if (err || !zipFile) return reject(err ?? new Error('yauzl: empty zipFile'));
      const out = new Map<string, Buffer>();
      const z = zipFile as ZipFile;
      z.on('error', reject);
      z.on('end', () => resolve(out));
      z.on('entry', (entry: Entry) => {
        if (entry.fileName.endsWith('/')) {
          z.readEntry();
          return;
        }
        z.openReadStream(entry, (rsErr, rs) => {
          if (rsErr || !rs) return reject(rsErr ?? new Error('yauzl: empty read stream'));
          const chunks: Buffer[] = [];
          rs.on('data', (c: Buffer) => chunks.push(c));
          rs.on('end', () => {
            out.set(entry.fileName, Buffer.concat(chunks));
            z.readEntry();
          });
          rs.on('error', reject);
        });
      });
      z.readEntry();
    });
  });
}

/** Return the inner HTML of <body> (epub2's getChapter does this for us on
    the primary path; the raw-zip path has the whole document). Drops
    <script>/<style> blocks whose text content would otherwise leak into the
    stripped prose. Falls back to the whole input when there's no <body>. */
function htmlBodyOnly(html: string): string {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  let body = m ? m[1] : html;
  // Replace-until-stable: a single pass can leave a reconstructed script/style tag.
  let prev: string;
  do {
    prev = body;
    body = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  } while (body !== prev);
  return body;
}

/** Parse the NCX navMap into a map of (normalised zip path of the content
    doc) → navLabel text, so the raw-zip fallback can title chapters from the
    authored navLabels the way the epub2 path does (srv-13). Namespace-prefix
    tolerant and entity-decoded. Returns an empty map when no NCX is found —
    callers then fall back to body headings. EPUB3-only nav docs (nav.xhtml)
    are out of scope: epub2's own flow titles don't read them either. */
function parseNcxTitles(
  opf: string,
  manifest: Map<string, { href: string; mediaType: string }>,
  opfDir: string,
  entries: Map<string, Buffer>,
): Map<string, string> {
  const titles = new Map<string, string>();

  /* Locate the NCX: spine toc="<id>" → manifest href, else the manifest item
     whose media-type is the NCX type, else any *.ncx entry. */
  let ncxHref: string | undefined;
  const tocId = /<(?:\w+:)?spine\b[^>]*\btoc="([^"]+)"/i.exec(opf)?.[1];
  if (tocId) ncxHref = manifest.get(tocId)?.href;
  if (!ncxHref) {
    for (const item of manifest.values()) {
      if (item.mediaType === 'application/x-dtbncx+xml') {
        ncxHref = item.href;
        break;
      }
    }
  }

  let ncxBuf: Buffer | undefined;
  let ncxPath: string | undefined;
  if (ncxHref) {
    const clean = ncxHref.split('#')[0];
    ncxBuf = resolveEntry(entries, opfDir, ncxHref);
    ncxPath = normalizeZipPath(opfDir ? `${opfDir}/${clean}` : clean);
  }
  if (!ncxBuf) {
    const key = [...entries.keys()].find((k) => /\.ncx$/i.test(k));
    if (key) {
      ncxBuf = entries.get(key);
      ncxPath = key;
    }
  }
  if (!ncxBuf || !ncxPath) return titles;

  /* NCX `content src` is relative to the NCX file's own directory, not the
     OPF's (they often differ). */
  const ncxDir = ncxPath.includes('/') ? ncxPath.slice(0, ncxPath.lastIndexOf('/')) : '';
  const ncx = ncxBuf.toString('utf8');

  /* Each navPoint pairs a <navLabel><text> with a <content src>. navLabel
     precedes content within a navPoint (standard NCX ordering), so a
     non-greedy text-then-src match pairs them even for nested navMaps. Store
     both raw and URL-decoded keys so a chapter lookup hits regardless of which
     side carries the %-encoding (mirrors resolveEntry). First entry wins. */
  for (const m of ncx.matchAll(
    /<(?:\w+:)?navPoint\b[\s\S]*?<(?:\w+:)?text>([\s\S]*?)<\/(?:\w+:)?text>[\s\S]*?<(?:\w+:)?content\b[^>]*\bsrc="([^"]+)"/gi,
  )) {
    const label = decodeEntities(m[1]);
    const src = m[2].split('#')[0];
    if (!label || !src) continue;
    const key = normalizeZipPath(ncxDir ? `${ncxDir}/${src}` : src);
    if (!titles.has(key)) titles.set(key, label);
    try {
      const decoded = decodeURIComponent(key);
      if (decoded !== key && !titles.has(decoded)) titles.set(decoded, label);
    } catch {
      /* malformed %-escape — the raw key still got stored above */
    }
  }
  return titles;
}

/** Case-insensitive zip-key lookup (META-INF casing can drift). */
function findKeyCI(entries: Map<string, Buffer>, target: string): string | undefined {
  if (entries.has(target)) return target;
  const lower = target.toLowerCase();
  for (const k of entries.keys()) if (k.toLowerCase() === lower) return k;
  return undefined;
}

/** Resolve a manifest href (relative to the OPF's directory) to a zip entry,
    trying both the raw and URL-decoded path. EPUB hrefs use forward slashes. */
function resolveEntry(
  entries: Map<string, Buffer>,
  opfDir: string,
  href: string,
): Buffer | undefined {
  const cleanHref = href.split('#')[0];
  const normalized = normalizeZipPath(opfDir ? `${opfDir}/${cleanHref}` : cleanHref);
  const candidates = [normalized];
  try {
    candidates.push(decodeURIComponent(normalized));
  } catch {
    /* malformed %-escape — the raw candidate still gets a shot */
  }
  for (const c of candidates) {
    const hit = entries.get(c);
    if (hit) return hit;
  }
  return undefined;
}

/** Collapse `.`/`..` segments and normalise slashes in a zip-relative path. */
function normalizeZipPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/** Read a Calibre `<meta name="…" content="…">` value, tolerant of attribute
    order. Returns null when absent. */
function readCalibreMeta(opf: string, name: string): string | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m =
    new RegExp(`<(?:\\w+:)?meta\\b[^>]*\\bname="${esc}"[^>]*\\bcontent="([^"]+)"`, 'i').exec(opf) ??
    new RegExp(`<(?:\\w+:)?meta\\b[^>]*\\bcontent="([^"]+)"[^>]*\\bname="${esc}"`, 'i').exec(opf);
  return m ? decodeEntities(m[1]) : null;
}

/** Decode the small entity set the parsers care about (matches stripHtml). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Decode &amp; LAST so `&amp;lt;` -> `&lt;`, not `<` (double-unescaping).
    .replace(/&amp;/g, '&')
    .trim();
}
