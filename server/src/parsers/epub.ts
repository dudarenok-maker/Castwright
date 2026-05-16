/* EPUB parser via epub2. Joins each spine entry as a chapter, stripping HTML
   tags to plain text. The book's dc:title becomes the manuscript title. */

import { EPub } from 'epub2';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChapterHint } from '../store/manuscripts.js';
import type { ParsedManuscript } from './text.js';
import { parseFilenameMetadata } from './text.js';
import { tagExcitedDialog, tagHesitantDialog, tagHtmlEmphasis, tagShoutingDialog } from './audio-tags.js';

function stripHtml(html: string): string {
  return tagHtmlEmphasis(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* Pull the first h1/h2/h3 text from chapter HTML so we have a fallback
   when the NCX entry's title is missing or generic. Strips inline tags
   (`<em>`, `<strong>`, `<span>`) from the heading text and collapses
   whitespace. Returns null when no heading is present in the first ~8 KB
   of the document. */
const FIRST_HEADING_RE = /<h[1-3][^>]*>([\s\S]{0,400}?)<\/h[1-3]>/i;
function extractFirstHeading(html: string): string | null {
  const m = FIRST_HEADING_RE.exec(html);
  if (!m) return null;
  const raw = m[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (raw.length === 0 || raw.length > 200) return null;
  return raw;
}

/* "Chapter 1" / "Chapter IV" / "Chapter Twelve" with nothing else.
   Used to detect generic NCX titles that should be augmented with the
   body's <h1>. Mirrors the bare-numbered-heading test in text.ts but
   self-contained here to keep the parsers loosely coupled. */
const GENERIC_NCX_RE = /^chapter\s+(?:[ivxlcdm\d]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?\s*$/i;

export async function parseEpub(buffer: Buffer, opts: { fileName?: string; sourcePath?: string }): Promise<ParsedManuscript> {
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
    filePath = join(tmp, opts.fileName ?? 'book.epub');
    await writeFile(filePath, buffer);
  }
  try {
    // epub2's createAsync returns the parsed EPub instance.
    const epub = await EPub.createAsync(filePath);
    const meta = epub.metadata as unknown as Record<string, string | undefined>;
    const title = (meta.title ?? '').trim();
    const author = (meta.creator ?? '').trim() || null;
    // Calibre stores series in the `calibre:series` meta entry, surfaced by
    // epub2 under different keys across versions — check the common ones.
    const series = ((meta['calibre:series'] ?? meta.series ?? '') as string).trim() || null;
    const posRaw = (meta['calibre:series_index'] ?? meta.series_index ?? '') as string;
    const seriesPosition = posRaw ? parseFloat(posRaw) : null;
    const chapters: ChapterHint[] = [];

    for (let i = 0; i < epub.flow.length; i++) {
      const entry = epub.flow[i];
      if (!entry?.id) continue;
      const html = await new Promise<string>((resolve, reject) => {
        epub.getChapter(entry.id!, (err: Error | null, text?: string) => err ? reject(err) : resolve(text ?? ''));
      });
      const body = tagHesitantDialog(tagExcitedDialog(tagShoutingDialog(stripHtml(html))));
      if (!body) continue;

      /* Title resolution — NCX/spine entry.title is the primary source,
         but many EPUBs ship generic labels ("Chapter 1") even when the
         chapter HTML body has a descriptive <h1> ("The Berth at
         Liverpool"). Pull the first h1/h2/h3 as a fallback or merge.

         - NCX missing → use body heading if any, else "Chapter N".
         - NCX descriptive → keep NCX (don't override authored metadata).
         - NCX generic ("Chapter 1") + body heading is also generic →
             keep NCX (no information gained from merging two generics).
         - NCX generic + body heading is descriptive → merge as
             "Chapter 1 — The Berth at Liverpool". */
      const ncxTitle = entry.title?.trim() ?? '';
      const bodyHeading = extractFirstHeading(html);
      let chTitle: string;
      if (!ncxTitle) {
        chTitle = bodyHeading || `Chapter ${chapters.length + 1}`;
      } else if (GENERIC_NCX_RE.test(ncxTitle) && bodyHeading && !GENERIC_NCX_RE.test(bodyHeading)) {
        chTitle = `${ncxTitle} — ${bodyHeading}`;
      } else {
        chTitle = ncxTitle;
      }
      chapters.push({ id: chapters.length + 1, title: chTitle, body });
    }

    if (chapters.length === 0) {
      throw new Error('EPUB had no extractable text in its spine.');
    }

    const sourceText = chapters.map(c => c.body).join('\n\n');
    const fileMeta = parseFilenameMetadata(opts.fileName);
    return {
      format: 'epub',
      title: title || fileMeta.title || opts.fileName?.replace(/\.[^.]+$/, '') || 'Untitled EPUB',
      sourceText,
      chapters,
      author: author || fileMeta.author,
      series: series || fileMeta.series,
      seriesPosition: seriesPosition != null && !Number.isNaN(seriesPosition)
        ? seriesPosition
        : fileMeta.seriesPosition,
    };
  } finally {
    /* Only clean up the tempdir we created. When sourcePath was given we
       did not create one. */
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}
