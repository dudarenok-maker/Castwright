/* Dispatch by mime / extension to the right parser. Returns ParsedManuscript
   ({ format, title, sourceText, chapters }). Throws on unsupported formats —
   the route layer maps that to a 415. */

import { parseText, type ParsedManuscript } from './text.js';
import { parsePdf } from './pdf.js';
import { parseInWorker } from './parse-in-worker.js';

export type { ParsedManuscript };
export { UnusableMediaError } from './errors.js';
export { DrmProtectedError } from './mobi.js';
export { UnusableEpubError } from './epub.js';

const EXT_TO_FORMAT: Record<string, 'markdown' | 'plaintext' | 'pdf' | 'epub' | 'mobi'> = {
  md: 'markdown',
  markdown: 'markdown',
  txt: 'plaintext',
  text: 'plaintext',
  pdf: 'pdf',
  epub: 'epub',
  mobi: 'mobi',
  azw3: 'mobi',
};

/** Extensions parseManuscript accepts (lowercase, no dot). One list, so tooling
    such as the library scanner never keeps a second copy. */
export const SUPPORTED_MANUSCRIPT_EXTENSIONS: readonly string[] = Object.keys(EXT_TO_FORMAT);

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
  /** Which extraction behaviour to use for EPUB and MOBI. Required: every
      caller decides (#4217); see `parsers/version.ts`. `parseText` and
      `parsePdf` ignore it. */
  extractorVersion: number;
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
    return parseInWorker({
      format: 'epub',
      /* With sourcePath the parser reads from disk and never touches the
         buffer; don't clone the whole book into the worker for nothing. */
      buffer: input.sourcePath ? Buffer.alloc(0) : input.buffer,
      fileName: input.fileName,
      sourcePath: input.sourcePath,
      extractorVersion: input.extractorVersion,
    });
  }
  if (
    format === 'mobi' ||
    input.mimeType === 'application/x-mobipocket-ebook' ||
    input.mimeType === 'application/vnd.amazon.ebook'
  ) {
    return parseInWorker({
      format: 'mobi',
      buffer: input.buffer,
      fileName: input.fileName,
      extractorVersion: input.extractorVersion,
    });
  }
  if (format === 'markdown' || format === 'plaintext') {
    return parseText(input.buffer.toString('utf8'), { fileName: input.fileName, format });
  }

  throw new UnsupportedFormatError(
    `Unsupported manuscript format: ${ext ?? input.mimeType ?? 'unknown'}.`,
  );
}

export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFormatError';
  }
}
