/* PDF parser — extracts text via pdf-parse, then runs through the text parser
   so chapter detection logic is shared. PDF metadata title takes precedence.
   Audio-tag note: pdf-parse strips all formatting, so only the all-caps
   dialogue heuristic in parseText can introduce `[shouting]` tags from PDFs;
   italic/bold emphasis cues are unrecoverable here.

   Outline note: when the PDF has a top-level bookmark tree, we use it to
   replace parseText-derived chapter titles (which are often just
   "Chapter N" because pdf-parse strips styled headings). Splitting by
   outline page destinations is intentionally out of scope — page-to-
   text-offset mapping is fragile under running headers / multi-column
   layouts. Title-only replacement covers the common case (well-authored
   PDFs with a clean outline) safely.

   One pdfjs: pdf-parse 2 bundles its own pdfjs and exposes the bookmark
   tree via getInfo().outline, so text, metadata, AND outline all come from a
   single PDFParse instance / single document load. We deliberately do NOT
   also import pdfjs-dist directly — two pdfjs copies in one process share
   global worker state and collide (an "API vN does not match Worker vM"
   crash under tsx/dev), so the separate outline reader was removed in the
   deps round-3 migration. */

import { PDFParse } from 'pdf-parse';
import { parseText, parseSeriesFromTitle } from './text.js';
import type { ParsedManuscript } from './text.js';
import { isLikelyFrontMatterTitle } from './front-matter.js';

interface OutlineEntry {
  title?: unknown;
}

/* Top-level chapter titles from a pdf-parse 2 outline tree (getInfo().outline,
   the same bookmark structure pdfjs' getOutline() returns). Returns null when
   there's no usable outline — the caller treats null as "fall back to the
   parseText-derived titles". Front-matter entries (Copyright, Dedication, …)
   are filtered before the caller aligns the count against the chapter count.
   Pure + exported so pdf.test.ts and pdf-real.test.ts can drive it directly. */
export function extractOutlineTitles(outline: unknown): string[] | null {
  if (!Array.isArray(outline) || outline.length === 0) return null;
  const titles: string[] = [];
  for (const entry of outline as OutlineEntry[]) {
    const t = typeof entry?.title === 'string' ? entry.title.trim() : '';
    if (!t) continue;
    if (isLikelyFrontMatterTitle(t)) continue;
    titles.push(t);
  }
  return titles.length > 0 ? titles : null;
}

export async function parsePdf(
  buffer: Buffer,
  opts: { fileName?: string },
): Promise<ParsedManuscript> {
  /* pdf-parse 2 is class-based: construct with the binary data, pull text +
     the Info dict + outline, then always destroy() to free the pdfjs document.
     Pass a Uint8Array COPY — pdfjs takes ownership of the array (transfers it
     to its worker) — so the caller's `buffer` is never detached. */
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text: string;
  let info: unknown;
  let outline: unknown;
  try {
    /* pageJoiner:'' suppresses pdf-parse 2's default '-- N of M --' per-page
       marker, which would otherwise be appended to every page and pollute
       chapter detection (pdf-parse 1 used bare form-feed page breaks). */
    text = (await parser.getText({ pageJoiner: '' })).text;
    /* getInfo().info is the raw PDF Info dictionary — the same Title/Author
       keys pdf-parse 1 returned as `info`. .outline is the bookmark tree. */
    const infoResult = await parser.getInfo();
    info = infoResult.info;
    outline = infoResult.outline;
  } finally {
    await parser.destroy();
  }
  const parsed = parseText(text, { fileName: opts.fileName, format: 'plaintext' });
  const meta = info as { Title?: string; Author?: string } | undefined;
  const metaTitle = meta?.Title?.trim();
  const metaAuthor = meta?.Author?.trim();

  /* Outline-based title replacement: only when the count of
     front-matter-filtered top-level outline entries equals the parsed
     chapter count. Mismatches are conservative — we keep parseText
     titles rather than risk labelling chapter 5's audio as "The
     Beginning". */
  const outlineTitles = extractOutlineTitles(outline);
  let chapters = parsed.chapters;
  if (outlineTitles && outlineTitles.length === chapters.length) {
    chapters = chapters.map((c, i) => ({ ...c, title: outlineTitles[i] }));
  }

  /* If PDF metadata Title beats the parseText-derived one AND parseText
     hadn't already extracted a series from a title parenthetical, take
     one more pass at the PDF title to support cases like a Calibre-
     produced PDF whose info.Title carries "Title (Series Book N)" but
     whose filename + body lack series hints. */
  let finalTitle = metaTitle || parsed.title;
  let finalSeries = parsed.series;
  let finalSeriesPosition = parsed.seriesPosition;
  let finalSeriesFromTitle = parsed.seriesFromTitle;
  if (!finalSeries && metaTitle) {
    const fromTitle = parseSeriesFromTitle(metaTitle);
    if (fromTitle.series) {
      finalTitle = fromTitle.title;
      finalSeries = fromTitle.series;
      finalSeriesPosition = fromTitle.seriesPosition;
      finalSeriesFromTitle = true;
    }
  }

  return {
    ...parsed,
    chapters,
    format: 'pdf',
    title: finalTitle,
    author: metaAuthor || parsed.author,
    series: finalSeries,
    seriesPosition: finalSeriesPosition,
    seriesFromTitle: finalSeriesFromTitle,
  };
}
