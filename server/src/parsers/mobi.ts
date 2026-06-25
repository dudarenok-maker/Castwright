/* MOBI / AZW3 (KF8) parser via @lingo-reader/mobi-parser. Mirrors the EPUB
   parser shape: spine entries → HTML body → stripHtml + audio tags → ChapterHint[].

   Two file flavors handled:
   - `.mobi` (legacy Mobipocket / PalmDOC) — `initMobiFile`. Dual-format MOBI
     files that also contain a KF8 section have their legacy section
     extracted; the KF8 boundary record is ignored. Text content is usually
     identical between the two so this is a safe default.
   - `.azw3` (KF8) — `initKf8File`. The modern Amazon Kindle format.

   DRM detection runs FIRST, before invoking the parser. The PalmDOC header
   carries an "Encryption Type" byte at offset 0x0C inside the first record
   payload. Non-zero values (1 = old Mobipocket DRM, 2 = Mobipocket/Kindle
   DRM, including all Kindle-Store purchases) throw DrmProtectedError which
   the route layer maps to 415. We cannot legally decrypt these. */

import { initMobiFile, initKf8File } from '@lingo-reader/mobi-parser';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChapterHint } from '../store/manuscripts.js';
import type { ParsedManuscript } from './text.js';
import { parseFilenameMetadata, parseSeriesFromTitle } from './text.js';
import { tagExcitedDialog, tagHesitantDialog, tagShoutingDialog } from './audio-tags.js';
import { stripHtml, extractFirstHeading, stripTitleHeading, GENERIC_NCX_RE } from './html-utils.js';
import { UnusableMediaError } from './errors.js';

/* Thrown when the MOBI / AZW3 file is DRM-protected. Both upload routes map
   this to HTTP 415: `/api/import` with a `{ error: 'drm_protected', message }`
   body (so the frontend can surface a specific "Convert with Calibre first"
   prompt), `/api/manuscripts` via the shared UnusableMediaError base. */
export class DrmProtectedError extends UnusableMediaError {
  constructor(message: string) {
    super(message);
    this.name = 'DrmProtectedError';
  }
}

/* Read the PalmDOC encryption byte. PDB header is 78 bytes; record 0
   offset is at byte 78 (u32 big-endian). Encryption type sits at
   record0Offset + 0x0C (u16 big-endian).

   Returns 0 (no encryption) on any unexpected shape rather than throwing —
   the underlying parser will fail with a clearer error if the file is
   genuinely malformed. We only want this check to FIRE on the specific
   case of "file is structurally a MOBI but flagged DRM". */
function readMobiEncryptionType(buffer: Buffer): number {
  if (buffer.length < 78 + 4 + 0x0E) return 0;
  const record0Offset = buffer.readUInt32BE(78);
  if (record0Offset + 0x0E > buffer.length) return 0;
  return buffer.readUInt16BE(record0Offset + 0x0C);
}

/* Resolve a chapter id to its TOC label. The library's spine entries
   carry only an `id` (no title); the TOC carries `label` + `href` where
   the `href` is the chapter id or a fragment inside it (e.g. `chap1` or
   `chap1#section`). Walk the TOC recursively and match the leading
   chapter id segment. */
interface TocItem {
  label: string;
  href: string;
  children?: TocItem[];
}
function buildTocLabelMap(toc: TocItem[]): Map<string, string> {
  const map = new Map<string, string>();
  function walk(items: TocItem[]): void {
    for (const item of items) {
      if (item.href && item.label) {
        // Strip any anchor fragment so `chap1#section` maps to `chap1`.
        const id = item.href.split('#')[0]?.split('/').pop() ?? '';
        if (id && !map.has(id)) map.set(id, item.label.trim());
      }
      if (item.children?.length) walk(item.children);
    }
  }
  walk(toc);
  return map;
}

interface MobiLikeParser {
  getMetadata(): {
    title?: string;
    author?: string[];
    publisher?: string;
    language?: string;
    description?: string;
  };
  getSpine(): Array<{ id: string }>;
  getToc(): TocItem[];
  loadChapter(id: string): { html: string } | undefined;
  destroy(): void;
}

export async function parseMobi(
  buffer: Buffer,
  opts: { fileName?: string },
): Promise<ParsedManuscript> {
  /* DRM guard. Runs before any parser library call so we can surface a
     specific actionable error message. */
  const encryption = readMobiEncryptionType(buffer);
  if (encryption !== 0) {
    throw new DrmProtectedError(
      'This file is DRM-protected (likely a Kindle Store purchase). ' +
        'Convert it with Calibre to a non-DRM format first, or use a different source.',
    );
  }

  /* AZW3 extension → KF8 init. Plain .mobi (and unknown extensions that
     fall through here) → legacy MOBI init. Dual-format .mobi files
     extract their legacy section, which is fine for our text-only
     analysis use case. */
  const ext = opts.fileName?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const useKf8 = ext === 'azw3';

  /* The library writes any extracted image resources to disk. We don't
     need the images, but we want them landing in a temp dir we can clean
     up, not in the cwd's `./images`. */
  const resourceDir = await mkdtemp(join(tmpdir(), 'mobi-resources-'));
  let parser: MobiLikeParser | null = null;
  try {
    const data = new Uint8Array(buffer);
    parser = (
      useKf8 ? await initKf8File(data, resourceDir) : await initMobiFile(data, resourceDir)
    ) as unknown as MobiLikeParser;

    const meta = parser.getMetadata();
    const headerTitle = (meta.title ?? '').trim();
    const headerAuthor =
      Array.isArray(meta.author) && meta.author[0] ? meta.author[0].trim() : null;

    const tocLabels = buildTocLabelMap(parser.getToc() ?? []);
    const spine = parser.getSpine();
    const chapters: ChapterHint[] = [];

    for (let i = 0; i < spine.length; i++) {
      const entry = spine[i];
      if (!entry?.id) continue;
      const chapter = parser.loadChapter(entry.id);
      const html = chapter?.html ?? '';
      if (!html.trim()) continue;

      /* Title resolution mirrors the EPUB parser:
         - TOC label is the primary source.
         - Missing TOC entry → use the body's first <h1> as fallback, else
           "Chapter N".
         - TOC label generic ("Chapter 1") + body heading descriptive →
           merge as "Chapter 1 — The Real Title".
         - Both descriptive or both generic → keep TOC label as-is. */
      const tocTitle = tocLabels.get(entry.id)?.trim() ?? '';
      const bodyHeading = extractFirstHeading(html);
      let chTitle: string;
      if (!tocTitle) {
        chTitle = bodyHeading || `Chapter ${chapters.length + 1}`;
      } else if (
        GENERIC_NCX_RE.test(tocTitle) &&
        bodyHeading &&
        !GENERIC_NCX_RE.test(bodyHeading)
      ) {
        chTitle = `${tocTitle} — ${bodyHeading}`;
      } else {
        chTitle = tocTitle;
      }
      // Drop the leading title heading so it isn't spoken twice (title beat +
      // body opening line) — see {@link stripTitleHeading}.
      const body = tagHesitantDialog(
        tagExcitedDialog(tagShoutingDialog(stripHtml(stripTitleHeading(html, chTitle)))),
      );
      if (!body) continue;
      chapters.push({ id: chapters.length + 1, title: chTitle, body });
    }

    if (chapters.length === 0) {
      throw new Error('MOBI had no extractable text in its spine.');
    }

    const sourceText = chapters.map((c) => c.body).join('\n\n');
    const fileMeta = parseFilenameMetadata(opts.fileName);
    let resolvedTitle =
      headerTitle || fileMeta.title || opts.fileName?.replace(/\.[^.]+$/, '') || 'Untitled MOBI';
    let resolvedSeries = fileMeta.series;
    let resolvedSeriesPosition = fileMeta.seriesPosition;
    let seriesFromTitle = false;
    /* Bug B: MOBI metadata doesn't surface series fields, so when the
       filename pattern doesn't match either, fall back to splitting
       a `(Series Book N)` suffix off the title. */
    if (!resolvedSeries) {
      const fromTitle = parseSeriesFromTitle(resolvedTitle);
      if (fromTitle.series) {
        resolvedTitle = fromTitle.title;
        resolvedSeries = fromTitle.series;
        resolvedSeriesPosition = fromTitle.seriesPosition;
        seriesFromTitle = true;
      }
    }
    return {
      format: 'mobi',
      title: resolvedTitle,
      sourceText,
      chapters,
      author: headerAuthor || fileMeta.author,
      series: resolvedSeries,
      seriesPosition: resolvedSeriesPosition,
      seriesFromTitle,
    };
  } finally {
    /* Always destroy the parser instance (frees in-memory blob caches)
       and clean up the resource temp dir. */
    try {
      parser?.destroy();
    } catch {
      /* best-effort */
    }
    await rm(resourceDir, { recursive: true, force: true });
  }
}
