/* PDF parser — extracts text via pdf-parse, then runs through the text parser
   so chapter detection logic is shared. PDF metadata title takes precedence. */

import pdfParse from 'pdf-parse';
import { parseText } from './text.js';
import type { ParsedManuscript } from './text.js';

export async function parsePdf(buffer: Buffer, opts: { fileName?: string }): Promise<ParsedManuscript> {
  const { text, info } = await pdfParse(buffer);
  const parsed = parseText(text, { fileName: opts.fileName, format: 'plaintext' });
  // PDF text rarely has Markdown-style headings; if we found none, override the title from PDF metadata.
  const metaTitle = (info as { Title?: string } | undefined)?.Title?.trim();
  return {
    ...parsed,
    format: 'pdf',
    title: metaTitle || parsed.title,
  };
}
