/* Plain text + Markdown parser. Splits chapters on Markdown headings
   (#, ##) or "Chapter N" lines; falls back to one chapter holding everything. */

import type { ChapterHint, ManuscriptFormat } from '../store/manuscripts.js';
import { tagMarkdownEmphasis, tagShoutingDialog } from './audio-tags.js';

const CHAPTER_HEADING_RE = /^(?:#{1,2}\s+|chapter\s+[ivxlcdm\d]+[:\s—.-]*)/i;

/* Filename pattern used to auto-detect Author / Series / Position / Title.
   Matches `Author - Series 01 - Title.ext` and a few common variants. */
const FILENAME_RE = /^(?<author>.+?)\s+-\s+(?<series>.+?)\s+(?<pos>\d+)\s+-\s+(?<title>.+)$/;

export interface ParsedManuscript {
  format: ManuscriptFormat;
  title: string;
  sourceText: string;
  chapters: ChapterHint[];
  /** Best-effort metadata detected from filename / EPUB OPF. Null when not found. */
  author: string | null;
  series: string | null;
  seriesPosition: number | null;
}

/** Pull `Author - Series N - Title` out of a filename. Returns nulls when the
    filename doesn't match. */
export function parseFilenameMetadata(fileName?: string): {
  author: string | null;
  series: string | null;
  seriesPosition: number | null;
  title: string | null;
} {
  if (!fileName) return { author: null, series: null, seriesPosition: null, title: null };
  const stem = fileName.replace(/\.[^.]+$/, '').trim();
  const m = FILENAME_RE.exec(stem);
  if (!m?.groups) return { author: null, series: null, seriesPosition: null, title: null };
  return {
    author: m.groups.author?.trim() || null,
    series: m.groups.series?.trim() || null,
    seriesPosition: m.groups.pos ? parseInt(m.groups.pos, 10) : null,
    title: m.groups.title?.trim() || null,
  };
}

export function parseText(text: string, opts: { fileName?: string; format: 'markdown' | 'plaintext' }): ParsedManuscript {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const chapters: ChapterHint[] = [];
  let buf: string[] = [];
  let currentTitle = '';

  function flush() {
    const rawBody = buf.join('\n').trim();
    if (rawBody.length > 0) {
      const body = tagShoutingDialog(tagMarkdownEmphasis(rawBody));
      chapters.push({ id: chapters.length + 1, title: currentTitle || `Chapter ${chapters.length + 1}`, body });
    }
    buf = [];
  }

  for (const raw of lines) {
    const line = raw.trim();

    // First H1 captures the book title.
    if (!title && /^#\s+\S/.test(line)) {
      title = line.replace(/^#\s+/, '').trim();
      continue;
    }

    if (CHAPTER_HEADING_RE.test(line)) {
      flush();
      currentTitle = line.replace(/^#{1,2}\s+/, '').replace(/^chapter\s+[ivxlcdm\d]+[:\s—.-]*/i, '').trim() || `Chapter ${chapters.length + 1}`;
      continue;
    }

    buf.push(raw);
  }
  flush();

  if (chapters.length === 0) {
    // No headings at all — treat the whole thing as one chapter.
    const body = tagShoutingDialog(tagMarkdownEmphasis(text.trim()));
    chapters.push({ id: 1, title: title || (opts.fileName ?? 'Chapter 1'), body });
  }

  const fileMeta = parseFilenameMetadata(opts.fileName);

  if (!title) {
    title = fileMeta.title || opts.fileName?.replace(/\.[^.]+$/, '') || 'Untitled manuscript';
  }

  const sourceText = chapters.map(c => c.body).join('\n\n');
  return {
    format: opts.format,
    title,
    sourceText,
    chapters,
    author: fileMeta.author,
    series: fileMeta.series,
    seriesPosition: fileMeta.seriesPosition,
  };
}
