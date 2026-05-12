/* Plain text + Markdown parser. Splits chapters on Markdown headings
   (#, ##) or "Chapter N" lines; falls back to one chapter holding everything. */

import type { ChapterHint, ManuscriptFormat } from '../store/manuscripts.js';

const CHAPTER_HEADING_RE = /^(?:#{1,2}\s+|chapter\s+[ivxlcdm\d]+[:\s—.-]*)/i;

export interface ParsedManuscript {
  format: ManuscriptFormat;
  title: string;
  sourceText: string;
  chapters: ChapterHint[];
}

export function parseText(text: string, opts: { fileName?: string; format: 'markdown' | 'plaintext' }): ParsedManuscript {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const chapters: ChapterHint[] = [];
  let buf: string[] = [];
  let currentTitle = '';

  function flush() {
    const body = buf.join('\n').trim();
    if (body.length > 0) {
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
    const body = text.trim();
    chapters.push({ id: 1, title: title || (opts.fileName ?? 'Chapter 1'), body });
  }

  if (!title) {
    title = opts.fileName?.replace(/\.[^.]+$/, '') ?? 'Untitled manuscript';
  }

  const sourceText = chapters.map(c => c.body).join('\n\n');
  return { format: opts.format, title, sourceText, chapters };
}
