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
   PDFs with a clean outline) safely. */

import pdfParse from 'pdf-parse';
import { parseText } from './text.js';
import type { ParsedManuscript } from './text.js';
import { isLikelyFrontMatterTitle } from './front-matter.js';

interface OutlineEntry {
  title?: unknown;
  items?: unknown;
}

/* Pull the top-level outline titles via pdfjs-dist. Returns null on any
   failure (no outline, parse error, unexpected shape) — caller treats
   null as "no outline available, fall back to parseText titles". */
async function readPdfOutlineTitles(buffer: Buffer): Promise<string[] | null> {
  try {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    /* pdfjs mutates the input buffer (transferable-friendly). Pass a
       copy via Uint8Array to keep pdf-parse's earlier read untouched. */
    const data = new Uint8Array(buffer);
    const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: false }).promise;
    try {
      const outline = (await doc.getOutline()) as OutlineEntry[] | null;
      if (!Array.isArray(outline) || outline.length === 0) return null;
      const titles: string[] = [];
      for (const entry of outline) {
        const t = typeof entry.title === 'string' ? entry.title.trim() : '';
        if (!t) continue;
        if (isLikelyFrontMatterTitle(t)) continue;
        titles.push(t);
      }
      return titles.length > 0 ? titles : null;
    } finally {
      await doc.destroy();
    }
  } catch {
    return null;
  }
}

export async function parsePdf(
  buffer: Buffer,
  opts: { fileName?: string },
): Promise<ParsedManuscript> {
  const { text, info } = await pdfParse(buffer);
  const parsed = parseText(text, { fileName: opts.fileName, format: 'plaintext' });
  const meta = info as { Title?: string; Author?: string } | undefined;
  const metaTitle = meta?.Title?.trim();
  const metaAuthor = meta?.Author?.trim();

  /* Outline-based title replacement: only when the count of
     front-matter-filtered top-level outline entries equals the parsed
     chapter count. Mismatches are conservative — we keep parseText
     titles rather than risk labelling chapter 5's audio as "The
     Beginning". */
  const outlineTitles = await readPdfOutlineTitles(buffer);
  let chapters = parsed.chapters;
  if (outlineTitles && outlineTitles.length === chapters.length) {
    chapters = chapters.map((c, i) => ({ ...c, title: outlineTitles[i] }));
  }

  return {
    ...parsed,
    chapters,
    format: 'pdf',
    title: metaTitle || parsed.title,
    author: metaAuthor || parsed.author,
  };
}
