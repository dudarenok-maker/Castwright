/* Dispatch by mime / extension to the right parser. Returns ParsedManuscript
   ({ format, title, sourceText, chapters }). Throws on unsupported formats —
   the route layer maps that to a 415. */

import { parseText, type ParsedManuscript } from './text.js';
import { parsePdf } from './pdf.js';
import { parseEpub } from './epub.js';

export type { ParsedManuscript };

const EXT_TO_FORMAT: Record<string, 'markdown' | 'plaintext' | 'pdf' | 'epub'> = {
  md: 'markdown', markdown: 'markdown',
  txt: 'plaintext', text: 'plaintext',
  pdf: 'pdf',
  epub: 'epub',
};

function extOf(fileName?: string): string | null {
  if (!fileName) return null;
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : null;
}

export async function parseManuscript(input: {
  buffer?: Buffer;
  text?: string;
  fileName?: string;
  mimeType?: string;
  /** When the manuscript already lives on disk (re-parse against the
      workspace book directory), pass the absolute path here so the EPUB
      parser can read it directly instead of round-tripping through %TEMP%
      — the temp roundtrip races against AV/OneDrive scanners on Windows
      and produces sporadic "Invalid/missing file" errors. Other parsers
      ignore this field. */
  sourcePath?: string;
}): Promise<ParsedManuscript> {
  if (input.text !== undefined && !input.buffer) {
    const ext = extOf(input.fileName);
    const format = ext === 'md' || ext === 'markdown' ? 'markdown' : 'plaintext';
    return parseText(input.text, { fileName: input.fileName, format });
  }

  if (!input.buffer) throw new UnsupportedFormatError('No file or text provided.');

  const ext = extOf(input.fileName);
  const format = ext ? EXT_TO_FORMAT[ext] : undefined;

  if (format === 'pdf' || input.mimeType === 'application/pdf') {
    return parsePdf(input.buffer, { fileName: input.fileName });
  }
  if (format === 'epub' || input.mimeType === 'application/epub+zip') {
    return parseEpub(input.buffer, { fileName: input.fileName, sourcePath: input.sourcePath });
  }
  if (format === 'markdown' || format === 'plaintext') {
    return parseText(input.buffer.toString('utf8'), { fileName: input.fileName, format });
  }

  throw new UnsupportedFormatError(`Unsupported manuscript format: ${ext ?? input.mimeType ?? 'unknown'}.`);
}

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}
