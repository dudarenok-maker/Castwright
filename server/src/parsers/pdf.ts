/* PDF parser — extracts text via pdf-parse, then runs through the text parser
   so chapter detection logic is shared. PDF metadata title takes precedence.
   Audio-tag note: pdf-parse strips all formatting, so only the all-caps
   dialogue heuristic in parseText can introduce `[shouting]` tags from PDFs;
   italic/bold emphasis cues are unrecoverable here. */

import pdfParse from 'pdf-parse';
import { parseText } from './text.js';
import type { ParsedManuscript } from './text.js';

export async function parsePdf(buffer: Buffer, opts: { fileName?: string }): Promise<ParsedManuscript> {
  const { text, info } = await pdfParse(buffer);
  const parsed = parseText(text, { fileName: opts.fileName, format: 'plaintext' });
  const meta = info as { Title?: string; Author?: string } | undefined;
  const metaTitle = meta?.Title?.trim();
  const metaAuthor = meta?.Author?.trim();
  return {
    ...parsed,
    format: 'pdf',
    title: metaTitle || parsed.title,
    author: metaAuthor || parsed.author,
  };
}
